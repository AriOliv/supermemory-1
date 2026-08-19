import { Database } from "bun:sqlite"
import { createHmac, timingSafeEqual } from "node:crypto"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { Hono } from "hono"
import { auth, authDb } from "./auth"

/**
 * Company Brain — Slack bot for the self-hosted console.
 *
 * The SaaS Company Brain Slack bot is not in the OSS repo; this rebuilds it against the
 * self-hosted lite store. Mounted at /brain/slack BEFORE the /brain/* session guard
 * (index.ts) because Slack's server-to-server calls (events, oauth callback) carry no
 * session cookie — this sub-app authenticates each route on its own terms:
 *   - session cookie   → /oauth/install, /status, /workspace  (browser, from the console)
 *   - HMAC signature   → /events                              (Slack Events API)
 *   - signed state     → /oauth/callback                      (stateless round-trip)
 *
 * Phase 1: install + status + events (public-channel extraction + @mention answers over the
 * org's shared brain space). Employee/private-channel memory and account-linking come next.
 *
 * Extraction is parameterizable via SLACK_EXTRACTION_MODE:
 *   - "durable"  (default): an LLM decides whether each message is worth remembering, then
 *                extracts the durable facts before ingesting.
 *   - "all":     ingest every (non-trivial) message verbatim.
 *   - "on-demand": never passive; only ingest on an explicit trigger (@bot save/lembra).
 */

// ---- config ----
const DB_PATH = process.env.SM_COMPAT_DB ?? "compat.sqlite"
const BASE_URL = (process.env.SM_COMPAT_BASE_URL ?? "http://localhost:8790").replace(/\/+$/, "")
const CONSOLE_ORIGIN = (process.env.SM_COMPAT_TRUSTED_ORIGINS ?? "http://localhost:3939")
	.split(",")[0]
	.trim()
const POST_INSTALL_REDIRECT = process.env.SM_SLACK_POST_INSTALL_REDIRECT ?? CONSOLE_ORIGIN
const SECRET =
	process.env.SM_COMPAT_AUTH_SECRET ?? "dev-only-insecure-secret-change-me-in-prod-0123456789"

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? ""
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? ""
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? ""
// Single-workspace shortcut: paste the bot token (xoxb-…) instead of running the OAuth
// "Add to Slack" flow. When set, the install row is auto-created for the org from the token
// (team + bot user resolved via auth.test). No Client ID/Secret or OAuth redirect needed.
// The App-Level token (xapp-…) is NOT used — that's only for Socket Mode; we use HTTP events.
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ""
const SLACK_ORG_ID = process.env.SLACK_ORG_ID ?? "" // optional; else the earliest org is used
// Bot scopes requested at install — MUST match the Slack app manifest.
const SLACK_SCOPES = [
	"app_mentions:read",
	"channels:history",
	"channels:read",
	"groups:history",
	"groups:read",
	"im:history",
	"chat:write",
	"users:read",
	"users:read.email",
	"team:read",
].join(",")

const EXTRACTION_MODE = (process.env.SLACK_EXTRACTION_MODE ?? "durable") as
	| "durable"
	| "all"
	| "on-demand"
// The org's shared Company Brain space (the same tag chat/MCP treat as the org brain).
const ORG_BRAIN_TAG = process.env.SM_BRAIN_CONTAINER_TAG ?? "sm_org_shared"

const LITE_URL = (process.env.SM_LITE_URL ?? "http://127.0.0.1:6767").replace(/\/+$/, "")
const LITE_KEY = process.env.SM_LITE_API_KEY ?? ""
const LLM_BASE_URL = (process.env.SM_LLM_BASE_URL ?? "https://proxy.avenia.tech/v1").replace(/\/+$/, "")
const LLM_KEY = process.env.SM_LLM_API_KEY ?? ""
const CHAT_MODEL = process.env.SM_CHAT_MODEL ?? "gemini-3.7-flash"
const llm = createOpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_KEY })

const REDIRECT_URI = `${BASE_URL}/brain/slack/oauth/callback`

// ---- storage (shares the better-auth sqlite file → JOINable with member/user/organization) ----
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS sm_slack_install (
    team_id TEXT PRIMARY KEY,
    bot_token TEXT NOT NULL,
    bot_user_id TEXT,
    team_name TEXT,
    org_id TEXT NOT NULL,
    installed_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sm_slack_link (
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    console_user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, slack_user_id)
  );
  CREATE TABLE IF NOT EXISTS sm_slack_link_token (
    token TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    slack_email TEXT,
    slack_name TEXT,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sm_slack_channel (
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    name TEXT,
    is_private INTEGER NOT NULL DEFAULT 0,
    container_tag TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    created_at TEXT NOT NULL,
    PRIMARY KEY (team_id, channel_id)
  );
`)

const nowIso = () => new Date().toISOString()

type Install = {
	team_id: string
	bot_token: string
	bot_user_id: string | null
	team_name: string | null
	org_id: string
	installed_by: string | null
	created_at: string
}

function installForOrg(orgId: string): Install | null {
	return (db
		.query("SELECT * FROM sm_slack_install WHERE org_id=? ORDER BY created_at DESC LIMIT 1")
		.get(orgId) as Install | null) ?? null
}
function installForTeam(teamId: string): Install | null {
	return (db.query("SELECT * FROM sm_slack_install WHERE team_id=?").get(teamId) as Install | null) ?? null
}

// The org to attach a direct-token install to (single-workspace mode): SLACK_ORG_ID if given,
// else the earliest organization in the DB (there's one for a single-org test).
function defaultOrgId(): string | null {
	if (SLACK_ORG_ID) return SLACK_ORG_ID
	try {
		const row = authDb.query("SELECT id FROM organization ORDER BY createdAt ASC LIMIT 1").get() as
			| { id?: string }
			| undefined
		return row?.id ?? null
	} catch {
		return null
	}
}

// When SLACK_BOT_TOKEN is set (paste-the-token mode), auto-register the install once by
// resolving the team/bot-user from the token via auth.test. Idempotent; safe to call often.
let directInstallDone = false
export async function ensureDirectInstall(): Promise<void> {
	if (directInstallDone || !SLACK_BOT_TOKEN) return
	directInstallDone = true // optimistic; reset on failure so a later call retries
	try {
		const test = await slackCall<{ ok?: boolean; team_id?: string; team?: string; user_id?: string }>(
			SLACK_BOT_TOKEN,
			"auth.test",
			{},
		)
		if (!test?.ok || !test.team_id) {
			directInstallDone = false
			return
		}
		const orgId = defaultOrgId()
		if (!orgId) {
			console.warn("[slack] SLACK_BOT_TOKEN set but no organization found to attach to")
			return
		}
		db.query(
			`INSERT INTO sm_slack_install (team_id, bot_token, bot_user_id, team_name, org_id, installed_by, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(team_id) DO UPDATE SET bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id,
         team_name=excluded.team_name, org_id=excluded.org_id`,
		).run(test.team_id, SLACK_BOT_TOKEN, test.user_id ?? null, test.team ?? null, orgId, "direct-token", nowIso())
		console.log(`[slack] direct-token install for team ${test.team} (${test.team_id}) → org ${orgId}`)
	} catch (e) {
		directInstallDone = false
		console.error("[slack] ensureDirectInstall failed:", e instanceof Error ? e.message : e)
	}
}

// ---- org resolution (mirrors index.ts) ----
function firstOrgId(userId: string): string | null {
	try {
		const row = authDb
			.query("SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt ASC LIMIT 1")
			.get(userId) as { organizationId?: string } | undefined
		return row?.organizationId ?? null
	} catch {
		return null
	}
}
async function sessionOrg(c: { req: { raw: Request } }): Promise<{ userId: string; orgId: string } | null> {
	try {
		const s = await auth.api.getSession({ headers: c.req.raw.headers })
		if (!s?.user) return null
		const orgId = s.session?.activeOrganizationId ?? firstOrgId(s.user.id) ?? s.user.id
		return { userId: s.user.id, orgId }
	} catch {
		return null
	}
}
function isOrgAdmin(userId: string, orgId: string): boolean {
	try {
		const row = authDb
			.query("SELECT role FROM member WHERE userId=? AND organizationId=? LIMIT 1")
			.get(userId, orgId) as { role?: string } | undefined
		const role = row?.role ?? ""
		return role.includes("owner") || role.includes("admin")
	} catch {
		return false
	}
}

// ---- signed OAuth state (tamper-proof, short-lived; avoids a DB round-trip) ----
function b64url(s: string) {
	return Buffer.from(s).toString("base64url")
}
function signState(payload: object): string {
	const body = b64url(JSON.stringify(payload))
	const sig = createHmac("sha256", SECRET).update(body).digest("base64url")
	return `${body}.${sig}`
}
function verifyState(state: string): { orgId: string; userId: string; ts: number } | null {
	const [body, sig] = state.split(".")
	if (!body || !sig) return null
	const expected = createHmac("sha256", SECRET).update(body).digest("base64url")
	if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
		return null
	}
	try {
		const p = JSON.parse(Buffer.from(body, "base64url").toString()) as {
			orgId: string
			userId: string
			ts: number
		}
		if (!p.orgId || Date.now() - p.ts > 10 * 60_000) return null // 10-min window
		return p
	} catch {
		return null
	}
}

// ---- Slack signature verification (Events API) ----
function verifySlackSignature(raw: string, signature: string | undefined, timestamp: string | undefined): boolean {
	if (!SLACK_SIGNING_SECRET || !signature || !timestamp) return false
	const ts = Number(timestamp)
	if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false // 5-min replay window
	const base = `v0:${timestamp}:${raw}`
	const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex")}`
	if (signature.length !== expected.length) return false
	return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

// ---- Slack Web API ----
async function slackCall<T = any>(botToken: string, method: string, body: Record<string, unknown>): Promise<T | null> {
	try {
		const res = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		})
		const data = (await res.json()) as { ok?: boolean }
		if (!data.ok) console.error(`[slack] ${method} not ok:`, (data as any).error)
		return data as T
	} catch (e) {
		console.error(`[slack] ${method} failed:`, e instanceof Error ? e.message : e)
		return null
	}
}
async function postMessage(inst: Install, channel: string, text: string, threadTs?: string) {
	await slackCall(inst.bot_token, "chat.postMessage", {
		channel,
		text,
		...(threadTs ? { thread_ts: threadTs } : {}),
		unfurl_links: false,
	})
}
async function channelName(inst: Install, channel: string): Promise<string | undefined> {
	const r = await slackCall<{ channel?: { name?: string } }>(inst.bot_token, "conversations.info", {
		channel,
	})
	return r?.channel?.name
}
async function permalink(inst: Install, channel: string, ts: string): Promise<string | undefined> {
	const r = await slackCall<{ permalink?: string }>(inst.bot_token, "chat.getPermalink", {
		channel,
		message_ts: ts,
	})
	return r?.permalink
}
async function userName(inst: Install, userId: string): Promise<string | undefined> {
	const r = await slackCall<{ user?: { real_name?: string; name?: string } }>(inst.bot_token, "users.info", {
		user: userId,
	})
	return r?.user?.real_name ?? r?.user?.name
}

// ---- lite store: ingest + search (mirrors connectors.ts / chat.ts) ----
async function ingest(content: string, containerTags: string[], meta: Record<string, unknown>, customId: string) {
	const res = await fetch(`${LITE_URL}/v3/documents`, {
		method: "POST",
		headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ content, containerTags, metadata: meta, customId }),
	})
	if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`)
}

type Retrieved = { text: string; name?: string; url?: string; similarity: number }
async function searchMemories(query: string, tag: string): Promise<Retrieved[]> {
	try {
		const res = await fetch(`${LITE_URL}/v4/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ q: query, containerTags: [tag], limit: 8 }),
		})
		if (!res.ok) return []
		const data = (await res.json()) as {
			results?: Array<{ memory?: string; content?: string; similarity?: number; metadata?: { name?: string; url?: string } | null }>
		}
		return (data.results ?? [])
			.map((r) => ({ text: r.memory ?? r.content ?? "", name: r.metadata?.name, url: r.metadata?.url, similarity: r.similarity ?? 0 }))
			.filter((r) => r.text)
	} catch {
		return []
	}
}
async function searchDocuments(query: string, tag: string): Promise<Retrieved[]> {
	try {
		const res = await fetch(`${LITE_URL}/v3/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ q: query, containerTags: [tag], limit: 6 }),
		})
		if (!res.ok) return []
		const data = (await res.json()) as {
			results?: Array<{ chunks?: Array<{ content?: string; isRelevant?: boolean }>; metadata?: { name?: string; url?: string } | null; score?: number; title?: string }>
		}
		return (data.results ?? [])
			.map((r) => {
				const chunks = r.chunks ?? []
				const relevant = chunks.filter((c) => c.isRelevant && c.content)
				const picked = (relevant.length ? relevant : chunks).slice(0, 2)
				const text = picked.map((c) => c.content).filter(Boolean).join(" … ").trim()
				return { text, name: r.metadata?.name ?? r.title ?? undefined, url: r.metadata?.url, similarity: r.score ?? 0 }
			})
			.filter((r) => r.text)
	} catch {
		return []
	}
}
// Retrieve grounding context across the given spaces (lite /v4 treats multi-tags as AND → per-tag).
async function retrieveContext(query: string, tags: string[]): Promise<Retrieved[]> {
	if (!query || tags.length === 0) return []
	const batches = await Promise.all(tags.flatMap((t) => [searchMemories(query, t), searchDocuments(query, t)]))
	const merged = batches.flat().sort((a, b) => b.similarity - a.similarity)
	const seen = new Set<string>()
	const out: Retrieved[] = []
	for (const r of merged) {
		const key = r.text.slice(0, 120).toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(r)
		if (out.length >= 8) break
	}
	return out
}

// ---- LLM: durability judgment + answer ----
async function extractDurable(text: string): Promise<{ durable: boolean; facts: string }> {
	if (!LLM_KEY) return { durable: false, facts: "" }
	try {
		const { text: out } = await generateText({
			model: llm.chat(CHAT_MODEL),
			system:
				"You triage team chat for a shared knowledge base. Decide if a message contains durable knowledge worth remembering (decisions, facts, how-tos, owners, links, definitions) vs. transient chatter (greetings, reactions, scheduling noise). If durable, rewrite the key facts as one or two concise standalone sentences (self-contained, no pronouns). Reply ONLY with strict JSON: {\"durable\": boolean, \"facts\": string}.",
			prompt: text,
		})
		const m = out.match(/\{[\s\S]*\}/)
		if (!m) return { durable: false, facts: "" }
		const parsed = JSON.parse(m[0]) as { durable?: boolean; facts?: string }
		return { durable: Boolean(parsed.durable), facts: (parsed.facts ?? "").trim() }
	} catch (e) {
		console.error("[slack] extractDurable failed:", e instanceof Error ? e.message : e)
		return { durable: false, facts: "" }
	}
}
async function answer(question: string, memories: Retrieved[]): Promise<string> {
	if (!LLM_KEY) return "O assistente não está configurado (falta a chave do LLM)."
	const ctx = memories
		.map((m, i) => {
			const src = m.name || m.url ? ` — fonte: ${m.name ?? "documento"}${m.url ? ` (${m.url})` : ""}` : ""
			return `[${i + 1}] ${m.text}${src}`
		})
		.join("\n")
	const system = memories.length
		? `You are Supermemory, the company's brain in Slack. Answer the question using the team memories below as your primary source. Be concise (Slack-friendly, a few sentences). Cite sources inline as [n] and, when a memory has a link, include it. If the answer isn't in the memories, say so briefly and answer from general knowledge, flagging it.\n\n--- MEMORIES ---\n${ctx}\n--- END MEMORIES ---`
		: "You are Supermemory, the company's brain in Slack. No team memory matched this question — say so briefly and answer from general knowledge, keeping it concise."
	try {
		const { text } = await generateText({ model: llm.chat(CHAT_MODEL), system, prompt: question })
		return text.trim() || "Não consegui gerar uma resposta agora."
	} catch (e) {
		console.error("[slack] answer failed:", e instanceof Error ? e.message : e)
		return "Tive um erro ao consultar a memória. Tente de novo em instantes."
	}
}

// ---- event processing ----
const SAVE_RE = /^\s*(save|lembra|lembre|guarda|guarde|remember|salva|salve)\b[:,]?\s*/i
const processed = new Set<string>() // dedupe Slack retries within the process lifetime

function stripMention(text: string, botUserId: string | null): string {
	let t = text ?? ""
	if (botUserId) t = t.replace(new RegExp(`<@${botUserId}>`, "g"), " ")
	return t.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim()
}

async function saveToBrain(inst: Install, channel: string, ts: string, content: string, authorId?: string) {
	if (!content.trim()) return
	const [name, link, author] = await Promise.all([
		channelName(inst, channel).catch(() => undefined),
		permalink(inst, channel, ts).catch(() => undefined),
		authorId ? userName(inst, authorId).catch(() => undefined) : Promise.resolve(undefined),
	])
	await ingest(
		content,
		[ORG_BRAIN_TAG],
		{
			source: "slack",
			name: name ? `Slack #${name}` : "Slack",
			channel,
			channelName: name,
			author,
			authorId,
			url: link,
			ts,
		},
		`slack:${inst.team_id}:${channel}:${ts}`,
	)
	console.log(`[slack] saved to brain (${ORG_BRAIN_TAG}) from #${name ?? channel}`)
}

async function handleMention(inst: Install, event: any) {
	const text = stripMention(event.text ?? "", inst.bot_user_id)
	// Explicit save trigger (works in every extraction mode).
	if (SAVE_RE.test(text)) {
		const toSave = text.replace(SAVE_RE, "").trim()
		if (toSave) {
			await saveToBrain(inst, event.channel, event.ts, toSave, event.user)
			await postMessage(inst, event.channel, "✅ Guardei isso na memória da empresa.", event.thread_ts ?? event.ts)
		} else {
			await postMessage(
				inst,
				event.channel,
				"Me diga o que guardar, ex.: `@supermemory lembra: o deploy de prod é sexta às 14h`.",
				event.thread_ts ?? event.ts,
			)
		}
		return
	}
	if (!text) return
	const memories = await retrieveContext(text, [ORG_BRAIN_TAG])
	const reply = await answer(text, memories)
	await postMessage(inst, event.channel, reply, event.thread_ts ?? event.ts)
}

async function handlePublicMessage(inst: Install, event: any) {
	if (EXTRACTION_MODE === "on-demand") return // passive capture disabled
	const text = (event.text ?? "").trim()
	if (text.length < 12) return
	if (inst.bot_user_id && text.includes(`<@${inst.bot_user_id}>`)) return // mention → handled by app_mention
	let toIngest = text
	if (EXTRACTION_MODE === "durable") {
		const v = await extractDurable(text)
		if (!v.durable) return
		toIngest = v.facts || text
	}
	await saveToBrain(inst, event.channel, event.ts, toIngest, event.user)
}

async function handleEvent(inst: Install, event: any) {
	// Skip the bot's own posts and non-message subtypes (edits, joins, etc.).
	if (!event || event.bot_id) return
	if (inst.bot_user_id && event.user === inst.bot_user_id) return
	if (event.type === "app_mention") return handleMention(inst, event)
	if (event.type === "message") {
		if (event.subtype) return // edited/deleted/system messages
		if (event.channel_type === "channel") return handlePublicMessage(inst, event)
		// private channels (group) + DMs (im) → phases 2/3
	}
}

// ---- HTTP routes (mounted at /brain/slack) ----
export const slack = new Hono()

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

// GET /brain/slack/status — { connected, teamName }
slack.get("/status", async (c) => {
	const sess = await sessionOrg(c)
	if (!sess) return json({ error: "Unauthorized" }, 401)
	await ensureDirectInstall()
	const inst = installForOrg(sess.orgId)
	return json({ connected: Boolean(inst), teamName: inst?.team_name ?? null })
})

// GET /brain/slack/oauth/install — 302 to Slack's authorize screen (browser nav w/ session cookie).
slack.get("/oauth/install", async (c) => {
	const sess = await sessionOrg(c)
	if (!sess) return json({ error: "Unauthorized" }, 401)
	if (!SLACK_CLIENT_ID) return json({ error: "Slack not configured (SLACK_CLIENT_ID)" }, 503)
	const state = signState({ orgId: sess.orgId, userId: sess.userId, ts: Date.now() })
	const p = new URLSearchParams({
		client_id: SLACK_CLIENT_ID,
		scope: SLACK_SCOPES,
		redirect_uri: REDIRECT_URI,
		state,
	})
	return c.redirect(`https://slack.com/oauth/v2/authorize?${p.toString()}`)
})

// GET /brain/slack/oauth/callback — exchange code, store the install, back to the console.
slack.get("/oauth/callback", async (c) => {
	const err = c.req.query("error")
	if (err) return c.redirect(`${POST_INSTALL_REDIRECT}/?slack_error=${encodeURIComponent(err)}`)
	const code = c.req.query("code")
	const state = c.req.query("state")
	const parsed = state ? verifyState(state) : null
	if (!code || !parsed) return c.redirect(`${POST_INSTALL_REDIRECT}/?slack_error=invalid_state`)
	try {
		const res = await fetch("https://slack.com/api/oauth.v2.access", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: SLACK_CLIENT_ID,
				client_secret: SLACK_CLIENT_SECRET,
				code,
				redirect_uri: REDIRECT_URI,
			}),
		})
		const data = (await res.json()) as {
			ok?: boolean
			error?: string
			access_token?: string
			bot_user_id?: string
			team?: { id?: string; name?: string }
			authed_user?: { id?: string }
		}
		if (!data.ok || !data.access_token || !data.team?.id) {
			console.error("[slack] oauth.v2.access failed:", data.error)
			return c.redirect(`${POST_INSTALL_REDIRECT}/?slack_error=${encodeURIComponent(data.error ?? "oauth_failed")}`)
		}
		db.query(
			`INSERT INTO sm_slack_install (team_id, bot_token, bot_user_id, team_name, org_id, installed_by, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(team_id) DO UPDATE SET bot_token=excluded.bot_token, bot_user_id=excluded.bot_user_id,
         team_name=excluded.team_name, org_id=excluded.org_id, installed_by=excluded.installed_by`,
		).run(
			data.team.id,
			data.access_token,
			data.bot_user_id ?? null,
			data.team.name ?? null,
			parsed.orgId,
			parsed.userId,
			nowIso(),
		)
		console.log(`[slack] installed for team ${data.team.name} (${data.team.id}) → org ${parsed.orgId}`)
		return c.redirect(`${POST_INSTALL_REDIRECT}/?slack=connected`)
	} catch (e) {
		console.error("[slack] callback error:", e)
		return c.redirect(`${POST_INSTALL_REDIRECT}/?slack_error=exception`)
	}
})

// POST /brain/slack/events — Slack Events API (signature-verified, ACK<3s, async processing).
slack.post("/events", async (c) => {
	const raw = await c.req.text()
	if (!verifySlackSignature(raw, c.req.header("x-slack-signature"), c.req.header("x-slack-request-timestamp"))) {
		return json({ error: "bad signature" }, 401)
	}
	let payload: any
	try {
		payload = JSON.parse(raw)
	} catch {
		return json({ error: "bad json" }, 400)
	}
	// URL verification handshake (when configuring the Events request URL).
	if (payload.type === "url_verification") return json({ challenge: payload.challenge })

	if (payload.type === "event_callback") {
		// Dedupe Slack retries (bounded set); ACK 200 immediately and process in the background.
		const evtId = payload.event_id as string | undefined
		if (evtId) {
			if (processed.has(evtId)) return json({ ok: true })
			processed.add(evtId)
			if (processed.size > 5000) processed.clear()
		}
		await ensureDirectInstall()
		const inst = installForTeam(payload.team_id)
		if (inst) {
			handleEvent(inst, payload.event).catch((e) =>
				console.error("[slack] handleEvent error:", e instanceof Error ? e.message : e),
			)
		}
	}
	return json({ ok: true })
})

// DELETE /brain/slack/workspace — disconnect (admin-only).
slack.delete("/workspace", async (c) => {
	const sess = await sessionOrg(c)
	if (!sess) return json({ error: "Unauthorized" }, 401)
	if (!isOrgAdmin(sess.userId, sess.orgId)) return json({ error: "forbidden" }, 403)
	const inst = installForOrg(sess.orgId)
	if (inst) {
		db.query("DELETE FROM sm_slack_install WHERE team_id=?").run(inst.team_id)
		db.query("DELETE FROM sm_slack_channel WHERE team_id=?").run(inst.team_id)
		db.query("DELETE FROM sm_slack_link WHERE team_id=?").run(inst.team_id)
	}
	return json({ ok: true })
})

// Account-linking (phase 2) — placeholder so the console page shows a clean error, not a crash.
slack.get("/account-link/:token", () => json({ status: "invalid" }))
slack.post("/account-link/:token", () => json({ status: "invalid" }))

// Overview helper for GET /brain/overview (index.ts).
export function slackStatusForOrg(orgId: string): { connected: boolean; teamName: string | null; rollout: null } {
	const inst = installForOrg(orgId)
	return { connected: Boolean(inst), teamName: inst?.team_name ?? null, rollout: null }
}

// Single-workspace bootstrap: if a bot token was pasted, register the install on startup so
// /status and /overview report connected without waiting for the first event.
ensureDirectInstall().catch(() => {})
