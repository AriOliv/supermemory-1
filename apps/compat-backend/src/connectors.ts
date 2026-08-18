import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { auth } from "./auth"

/**
 * Knowledge-base connectors for the self-hosted console.
 *
 * Implements the /v3/connections/* surface the console expects, starting with
 * Google Drive (OAuth). Flow:
 *   POST /v3/connections/google-drive            → { authLink, id }  (console redirects the browser)
 *   GET  /v3/connections/google-drive/callback   → exchange code, store tokens, redirect back, kick off sync
 *   POST /v3/connections/google-drive/import     → trigger a sync
 *   GET  /v3/connections , POST /v3/connections/list , GET/DELETE /v3/connections/:id ,
 *   GET  /v3/connections/:id/sync-runs
 *
 * Sync reads Drive files, extracts text (Google Docs/Sheets/Slides via export; text/* via
 * download), and ingests each into the self-hosted lite server via POST /v3/documents.
 */

const DB_PATH = process.env.SM_COMPAT_DB ?? "compat.sqlite"
const BASE_URL = (process.env.SM_COMPAT_BASE_URL ?? "http://localhost:8790").replace(/\/+$/, "")
const LITE_URL = (process.env.SM_LITE_URL ?? "http://127.0.0.1:6767").replace(/\/+$/, "")
const LITE_KEY = process.env.SM_LITE_API_KEY ?? ""

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? ""
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS sm_connection (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    email TEXT,
    container_tags TEXT,
    document_limit INTEGER,
    redirect_url TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sm_sync_run (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    items_processed INTEGER NOT NULL DEFAULT 0,
    items_failed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
`)

const rid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`
const nowIso = () => new Date().toISOString()

type ConnRow = {
	id: string
	provider: string
	user_id: string
	status: string
	email: string | null
	container_tags: string | null
	document_limit: number | null
	redirect_url: string | null
	access_token: string | null
	refresh_token: string | null
	expires_at: number | null
	metadata: string | null
	created_at: string
}

// Public shape the console expects (packages/validation/api.ts ConnectionResponseSchema)
function toConnectionResponse(r: ConnRow) {
	return {
		id: r.id,
		provider: r.provider,
		createdAt: r.created_at,
		email: r.email ?? undefined,
		containerTags: r.container_tags ? JSON.parse(r.container_tags) : undefined,
		documentLimit: r.document_limit ?? undefined,
		expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
		metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
	}
}

// ---------- Google OAuth ----------
function googleAuthUrl(state: string): string {
	const redirectUri = `${BASE_URL}/v3/connections/google-drive/callback`
	const p = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: DRIVE_SCOPES.join(" "),
		access_type: "offline",
		include_granted_scopes: "true",
		prompt: "consent",
		state,
	})
	return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`
}

async function googleExchangeCode(code: string) {
	const redirectUri = `${BASE_URL}/v3/connections/google-drive/callback`
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}),
	})
	if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
	return (await res.json()) as {
		access_token: string
		refresh_token?: string
		expires_in: number
	}
}

async function googleRefresh(refreshToken: string) {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
			grant_type: "refresh_token",
		}),
	})
	if (!res.ok) throw new Error(`token refresh failed: ${res.status}`)
	return (await res.json()) as { access_token: string; expires_in: number }
}

async function freshAccessToken(r: ConnRow): Promise<string> {
	const skewMs = 60_000
	if (r.access_token && r.expires_at && r.expires_at - skewMs > Date.now()) {
		return r.access_token
	}
	if (!r.refresh_token) throw new Error("no refresh token; reconnect required")
	const t = await googleRefresh(r.refresh_token)
	const expiresAt = Date.now() + t.expires_in * 1000
	db.query("UPDATE sm_connection SET access_token=?, expires_at=? WHERE id=?").run(
		t.access_token,
		expiresAt,
		r.id,
	)
	return t.access_token
}

// ---------- Google Drive ----------
const EXPORT_MIME: Record<string, string> = {
	"application/vnd.google-apps.document": "text/plain",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
}

async function driveAbout(accessToken: string): Promise<string | undefined> {
	const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
		headers: { authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) return undefined
	const j = (await res.json()) as { user?: { emailAddress?: string } }
	return j.user?.emailAddress
}

async function driveListFiles(accessToken: string, limit: number) {
	const files: { id: string; name: string; mimeType: string; webViewLink?: string }[] = []
	let pageToken: string | undefined
	while (files.length < limit) {
		const p = new URLSearchParams({
			q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
			fields: "nextPageToken, files(id, name, mimeType, webViewLink)",
			pageSize: String(Math.min(100, limit - files.length)),
			orderBy: "modifiedTime desc",
		})
		if (pageToken) p.set("pageToken", pageToken)
		const res = await fetch(`https://www.googleapis.com/drive/v3/files?${p.toString()}`, {
			headers: { authorization: `Bearer ${accessToken}` },
		})
		if (!res.ok) throw new Error(`drive list failed: ${res.status}`)
		const j = (await res.json()) as {
			files?: { id: string; name: string; mimeType: string; webViewLink?: string }[]
			nextPageToken?: string
		}
		for (const f of j.files ?? []) files.push(f)
		pageToken = j.nextPageToken
		if (!pageToken) break
	}
	return files.slice(0, limit)
}

async function driveFileText(
	accessToken: string,
	file: { id: string; name: string; mimeType: string; webViewLink?: string },
): Promise<string | null> {
	const exportMime = EXPORT_MIME[file.mimeType]
	let url: string
	if (exportMime) {
		url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`
	} else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
		url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
	} else {
		return null // binary/unsupported (pdf/img/etc.) — skipped in this MVP
	}
	const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
	if (!res.ok) return null
	const text = await res.text()
	return text.trim() ? text : null
}

// ---------- ingestion into the self-hosted lite server ----------
async function ingest(content: string, containerTags: string[], meta: Record<string, unknown>, customId: string) {
	const res = await fetch(`${LITE_URL}/v3/documents`, {
		method: "POST",
		headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ content, containerTags, metadata: meta, customId }),
	})
	if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`)
}

// ---------- sync orchestration ----------
async function runSync(connId: string, trigger: "manual" | "event" | "cron") {
	const r = db.query("SELECT * FROM sm_connection WHERE id=?").get(connId) as ConnRow | null
	if (!r || r.status !== "connected") return
	const runId = rid("run")
	db.query(
		"INSERT INTO sm_sync_run (id, connection_id, status, trigger_type, started_at, items_processed, items_failed) VALUES (?,?,?,?,?,0,0)",
	).run(runId, connId, "running", trigger, nowIso())

	let processed = 0
	let failed = 0
	try {
		const token = await freshAccessToken(r)
		const tags = r.container_tags ? (JSON.parse(r.container_tags) as string[]) : ["google-drive"]
		const limit = r.document_limit ?? 25
		const files = await driveListFiles(token, limit)
		for (const f of files) {
			try {
				const text = await driveFileText(token, f)
				if (!text) continue
				await ingest(
					text,
					tags,
					{
						source: "google-drive",
						fileId: f.id,
						name: f.name,
						mimeType: f.mimeType,
						// Surfaced as the citation link in chat/MCP answers.
						url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
					},
					`gdrive:${f.id}`,
				)
				processed++
			} catch (e) {
				failed++
				console.error(`[connector] file ${f.id} failed:`, e instanceof Error ? e.message : e)
			}
		}
		db.query(
			"UPDATE sm_sync_run SET status=?, completed_at=?, items_processed=?, items_failed=? WHERE id=?",
		).run("completed", nowIso(), processed, failed, runId)
		console.log(`[connector] sync ${connId} done: ${processed} ingested, ${failed} failed`)
	} catch (e) {
		db.query(
			"UPDATE sm_sync_run SET status=?, completed_at=?, items_processed=?, items_failed=?, error=? WHERE id=?",
		).run("failed", nowIso(), processed, failed, e instanceof Error ? e.message : String(e), runId)
		console.error(`[connector] sync ${connId} failed:`, e)
	}
}

// ---------- HTTP routes (mounted at /v3/connections) ----------
export const connectors = new Hono()

async function requireUser(c: { req: { raw: Request } }) {
	try {
		const s = await auth.api.getSession({ headers: c.req.raw.headers })
		return s?.user?.id ?? null
	} catch {
		return null
	}
}

const jsonError = (msg: string, status = 400) =>
	new Response(JSON.stringify({ message: msg }), { status, headers: { "content-type": "application/json" } })

// list (both GET / and POST /list)
async function listConnections(userId: string) {
	const rows = db
		.query("SELECT * FROM sm_connection WHERE user_id=? AND status='connected' ORDER BY created_at DESC")
		.all(userId) as ConnRow[]
	return rows.map(toConnectionResponse)
}

connectors.post("/list", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	return c.json(await listConnections(userId))
})

connectors.get("/", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	return c.json(await listConnections(userId))
})

// OAuth callback — GET /:provider/callback
connectors.get("/:provider/callback", async (c) => {
	const provider = c.req.param("provider")
	const code = c.req.query("code")
	const state = c.req.query("state")
	if (provider !== "google-drive") return jsonError(`unsupported provider ${provider}`, 400)
	if (!code || !state) return jsonError("missing code/state", 400)
	const r = db.query("SELECT * FROM sm_connection WHERE id=?").get(state) as ConnRow | null
	if (!r) return jsonError("unknown connection state", 400)
	try {
		const t = await googleExchangeCode(code)
		const expiresAt = Date.now() + t.expires_in * 1000
		const email = await driveAbout(t.access_token)
		db.query(
			"UPDATE sm_connection SET status='connected', access_token=?, refresh_token=COALESCE(?, refresh_token), expires_at=?, email=? WHERE id=?",
		).run(t.access_token, t.refresh_token ?? null, expiresAt, email ?? null, r.id)
		// kick off an initial sync in the background
		runSync(r.id, "event").catch(() => {})
		const back = r.redirect_url || `${BASE_URL}/`
		return c.redirect(`${back}${back.includes("?") ? "&" : "?"}connected=google-drive`)
	} catch (e) {
		console.error("[connector] callback error:", e)
		const back = r.redirect_url || `${BASE_URL}/`
		return c.redirect(`${back}${back.includes("?") ? "&" : "?"}connect_error=google-drive`)
	}
})

// trigger sync — POST /:provider/import
connectors.post("/:provider/import", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	const provider = c.req.param("provider")
	const body = (await c.req.json().catch(() => ({}))) as { containerTags?: string[] }
	const rows = db
		.query("SELECT * FROM sm_connection WHERE user_id=? AND provider=? AND status='connected'")
		.all(userId, provider) as ConnRow[]
	if (rows.length === 0) return jsonError("no connected connection for provider", 404)
	for (const r of rows) {
		if (body.containerTags?.length) {
			db.query("UPDATE sm_connection SET container_tags=? WHERE id=?").run(
				JSON.stringify(body.containerTags),
				r.id,
			)
		}
		runSync(r.id, "manual").catch(() => {})
	}
	return c.json({ triggered: rows.length })
})

// create connection — POST /:provider
connectors.post("/:provider", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	const provider = c.req.param("provider")
	if (provider !== "google-drive") return jsonError(`unsupported provider ${provider}`, 400)
	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
		return jsonError("Google OAuth not configured on the server (GOOGLE_OAUTH_CLIENT_ID/SECRET)", 503)
	}
	const body = (await c.req.json().catch(() => ({}))) as {
		containerTags?: string[]
		documentLimit?: number
		redirectUrl?: string
		metadata?: Record<string, unknown>
	}
	const id = rid("conn")
	db.query(
		`INSERT INTO sm_connection (id, provider, user_id, status, container_tags, document_limit, redirect_url, metadata, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
	).run(
		id,
		provider,
		userId,
		"pending",
		body.containerTags ? JSON.stringify(body.containerTags) : JSON.stringify(["google-drive"]),
		body.documentLimit ?? null,
		body.redirectUrl ?? null,
		body.metadata ? JSON.stringify(body.metadata) : null,
		nowIso(),
	)
	return c.json({ id, authLink: googleAuthUrl(id), expiresIn: "600" })
})

// sync runs — GET /:id/sync-runs
connectors.get("/:id/sync-runs", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	const id = c.req.param("id")
	const conn = db.query("SELECT user_id FROM sm_connection WHERE id=?").get(id) as { user_id: string } | null
	if (!conn || conn.user_id !== userId) return c.json([])
	const runs = db
		.query("SELECT * FROM sm_sync_run WHERE connection_id=? ORDER BY started_at DESC LIMIT 20")
		.all(id) as any[]
	return c.json(
		runs.map((r) => ({
			id: r.id,
			connectionId: r.connection_id,
			status: r.status,
			triggerType: r.trigger_type,
			startedAt: r.started_at,
			completedAt: r.completed_at,
			itemsProcessed: r.items_processed,
			itemsFailed: r.items_failed,
			error: r.error,
		})),
	)
})

// get one — GET /:id
connectors.get("/:id", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	const id = c.req.param("id")
	const r = db.query("SELECT * FROM sm_connection WHERE id=? AND user_id=?").get(id, userId) as ConnRow | null
	if (!r) return jsonError("not found", 404)
	return c.json(toConnectionResponse(r))
})

// delete — DELETE /:id
connectors.delete("/:id", async (c) => {
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	const id = c.req.param("id")
	const r = db.query("SELECT provider FROM sm_connection WHERE id=? AND user_id=?").get(id, userId) as
		| { provider: string }
		| null
	if (!r) return jsonError("not found", 404)
	db.query("DELETE FROM sm_connection WHERE id=?").run(id)
	db.query("DELETE FROM sm_sync_run WHERE connection_id=?").run(id)
	return c.json({ id, provider: r.provider })
}
)
