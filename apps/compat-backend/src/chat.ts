import { createOpenAI } from "@ai-sdk/openai"
import { streamText, type UIMessage } from "ai"
import { Hono } from "hono"
import { auth } from "./auth"

type ModelMessage = { role: "system" | "user" | "assistant"; content: string }

// Hand-convert UIMessages -> ModelMessages (ai@6's convertToModelMessages misbehaves under Bun).
function toModelMessages(uiMessages: UIMessage[]): ModelMessage[] {
	const out: ModelMessage[] = []
	for (const m of uiMessages) {
		if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue
		const parts = (m.parts ?? []) as Array<{ type: string; text?: string }>
		const content = parts
			.filter((p) => p.type === "text" && p.text)
			.map((p) => p.text as string)
			.join("\n")
			.trim()
		if (content) out.push({ role: m.role, content })
	}
	return out
}

/**
 * Chat for the self-hosted console.
 *
 * The console uses @ai-sdk/react `useChat` (AI SDK v6) which POSTs to `${BACKEND}/chat`
 * with { messages: UIMessage[], metadata } and expects a UI-message stream back.
 *
 * We do RAG: retrieve relevant memories from the self-hosted lite server (search) and
 * feed them as context to the user's own LiteLLM proxy (OpenAI-compatible), streaming the
 * answer in the exact format `useChat` consumes.
 *
 * Threads/attachments are stubbed (no server-side history yet).
 */

const LITE_URL = (process.env.SM_LITE_URL ?? "http://127.0.0.1:6767").replace(/\/+$/, "")
const LITE_KEY = process.env.SM_LITE_API_KEY ?? ""
const LLM_BASE_URL = (process.env.SM_LLM_BASE_URL ?? "https://proxy.avenia.tech/v1").replace(/\/+$/, "")
const LLM_KEY = process.env.SM_LLM_API_KEY ?? ""
const CHAT_MODEL = process.env.SM_CHAT_MODEL ?? "gemini-3.7-flash"

const llm = createOpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_KEY })

const jsonError = (msg: string, status = 400) =>
	new Response(JSON.stringify({ message: msg }), { status, headers: { "content-type": "application/json" } })

function lastUserText(messages: UIMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.role !== "user") continue
		const parts = (m.parts ?? []) as Array<{ type: string; text?: string }>
		const text = parts
			.filter((p) => p.type === "text" && p.text)
			.map((p) => p.text)
			.join("\n")
			.trim()
		if (text) return text
	}
	return ""
}

// List the user's container tags from the lite server (for "auto" space discovery).
async function allContainerTags(): Promise<string[]> {
	try {
		const res = await fetch(`${LITE_URL}/v3/container-tags/list`, {
			headers: { authorization: `Bearer ${LITE_KEY}` },
		})
		if (!res.ok) return []
		const data = (await res.json()) as Array<{ containerTag?: string }> | { containerTags?: any[] }
		const arr = Array.isArray(data) ? data : ((data as any).containerTags ?? [])
		return arr.map((t: any) => t.containerTag ?? t.tag ?? t).filter(Boolean)
	} catch {
		return []
	}
}

type Retrieved = { text: string; name?: string; url?: string; similarity: number }

// Search a single container tag. Each result's metadata (set by the connectors, e.g. Google
// Drive) carries the source file name + link, which we surface so the model can cite it.
async function searchOne(query: string, containerTag: string): Promise<Retrieved[]> {
	try {
		const res = await fetch(`${LITE_URL}/v4/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ q: query, containerTags: [containerTag], limit: 8 }),
		})
		if (!res.ok) return []
		const data = (await res.json()) as {
			results?: Array<{
				memory?: string
				content?: string
				similarity?: number
				metadata?: { name?: string; url?: string; source?: string } | null
			}>
		}
		return (data.results ?? [])
			.map((r) => ({
				text: r.memory ?? r.content ?? "",
				name: r.metadata?.name,
				url: r.metadata?.url,
				similarity: r.similarity ?? 0,
			}))
			.filter((r) => r.text)
	} catch {
		return []
	}
}

// Document/chunk search (/v3) for a single tag. Unlike /v4 (extracted memories), this covers
// EVERY ingested document — including tabular/dense docs (e.g. spreadsheets) that don't
// extract into memories — so the chat can answer from them and cite the source file/link.
async function searchDocuments(query: string, containerTag: string): Promise<Retrieved[]> {
	try {
		const res = await fetch(`${LITE_URL}/v3/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ q: query, containerTags: [containerTag], limit: 6 }),
		})
		if (!res.ok) return []
		const data = (await res.json()) as {
			results?: Array<{
				chunks?: Array<{ content?: string; isRelevant?: boolean }>
				metadata?: { name?: string; url?: string } | null
				score?: number
				title?: string
			}>
		}
		return (data.results ?? [])
			.map((r) => {
				const chunks = r.chunks ?? []
				const relevant = chunks.filter((c) => c.isRelevant && c.content)
				const picked = (relevant.length ? relevant : chunks).slice(0, 2)
				const text = picked
					.map((c) => c.content)
					.filter(Boolean)
					.join(" … ")
					.trim()
				return {
					text,
					name: r.metadata?.name ?? r.title ?? undefined,
					url: r.metadata?.url,
					similarity: r.score ?? 0,
				}
			})
			.filter((r) => r.text)
	} catch {
		return []
	}
}

// Retrieve relevant context to ground the answer. Queries BOTH memory search (/v4, extracted
// facts) and document search (/v3, raw chunks) per space, since /v4 misses docs that don't
// extract into memories. The lite /v4/search also treats multiple containerTags as AND (0 hits
// across spaces), so each space is queried separately; results are merged and ranked, and each
// carries its source (file name + link) for citation.
async function retrieveContext(query: string, containerTags: string[]): Promise<Retrieved[]> {
	if (!query || containerTags.length === 0) return []
	const batches = await Promise.all(
		containerTags.flatMap((t) => [searchOne(query, t), searchDocuments(query, t)]),
	)
	const merged = batches.flat().sort((a, b) => b.similarity - a.similarity)
	const seen = new Set<string>()
	const out: Retrieved[] = []
	for (const r of merged) {
		const key = r.text.slice(0, 120).toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(r)
		if (out.length >= 10) break
	}
	return out
}

function systemPrompt(memories: Retrieved[], user?: { name?: string; email?: string }): string {
	const who =
		user?.name || user?.email
			? `\nThe person you are talking to is ${user?.name ?? "the user"}${user?.email ? ` (${user.email})` : ""}. Use this when they ask about themselves.`
			: ""
	if (memories.length === 0) {
		return `You are Supermemory, a helpful assistant with access to the user's personal knowledge base. No relevant memories were found for this question, so answer from general knowledge and say when you are unsure.${who}`
	}
	const ctx = memories
		.map((m, i) => {
			const src =
				m.name || m.url
					? ` — source: ${m.name ?? "document"}${m.url ? ` (${m.url})` : ""}`
					: ""
			return `[${i + 1}] ${m.text}${src}`
		})
		.join("\n")
	return `You are Supermemory, a helpful assistant that answers using the user's personal knowledge base (memories synced from their sources, e.g. Google Drive).

Use the memories below as your primary source. If the answer isn't in them, say so and answer from general knowledge, clearly flagging what came from the knowledge base vs. general knowledge. Be concise and cite memories inline as [n] when you use them. When a memory lists a source (a file name and link), name that source in your answer and, if it has a link, include it so the user can open the original.${who}

--- MEMORIES ---
${ctx}
--- END MEMORIES ---`
}

export const chat = new Hono()

async function requireUser(c: { req: { raw: Request } }) {
	try {
		const s = await auth.api.getSession({ headers: c.req.raw.headers })
		return s?.user?.id ?? null
	} catch {
		return null
	}
}

// Main chat endpoint — POST /chat
chat.post("/", async (c) => {
	const session = await auth.api
		.getSession({ headers: c.req.raw.headers })
		.catch(() => null)
	if (!session?.user) return jsonError("Unauthorized", 401)
	if (!LLM_KEY) return jsonError("LLM not configured (SM_LLM_API_KEY)", 503)
	const user = session.user as { name?: string; email?: string }

	const body = (await c.req.json().catch(() => ({}))) as {
		messages?: UIMessage[]
		metadata?: { projectId?: string; spaceMode?: string }
	}
	const messages = body.messages ?? []
	if (messages.length === 0) return jsonError("no messages", 400)

	// RAG scope: manual → the selected project/space; auto (or unset) → all the user's spaces.
	const projectId = body.metadata?.projectId
	const auto = !projectId || body.metadata?.spaceMode === "auto"
	let tags = auto ? await allContainerTags() : [projectId as string]
	if (tags.length === 0) tags = ["sm_project_default"]

	const memories = await retrieveContext(lastUserText(messages), tags)

	const result = streamText({
		model: llm.chat(CHAT_MODEL),
		system: systemPrompt(memories, user),
		messages: toModelMessages(messages),
	})
	return result.toUIMessageStreamResponse()
})

// Thread history — not persisted yet, so return empty.
chat.get("/threads", (c) => c.json({ threads: [] }))
chat.get("/threads/:id", (c) => c.json({ id: c.req.param("id"), messages: [] }))
chat.delete("/threads/:id", (c) => c.json({ ok: true, id: c.req.param("id") }))

// Attachments — out of scope for now.
chat.post("/attachments", () => jsonError("attachments not supported on the self-hosted backend yet", 501))
chat.all("/attachments/*", () => jsonError("attachments not supported", 501))
