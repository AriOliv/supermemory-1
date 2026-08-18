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

// Retrieve relevant memories from the lite server to ground the answer.
async function retrieveContext(query: string, containerTags: string[]): Promise<string[]> {
	if (!query || containerTags.length === 0) return []
	try {
		const res = await fetch(`${LITE_URL}/v4/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${LITE_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ q: query, containerTags, limit: 8 }),
		})
		if (!res.ok) return []
		const data = (await res.json()) as { results?: Array<{ memory?: string; content?: string }> }
		return (data.results ?? [])
			.map((r) => r.memory ?? r.content ?? "")
			.filter(Boolean)
	} catch {
		return []
	}
}

function systemPrompt(memories: string[]): string {
	if (memories.length === 0) {
		return "You are Supermemory, a helpful assistant with access to the user's personal knowledge base. The knowledge base returned no relevant memories for this question, so answer from general knowledge and say when you are unsure."
	}
	const ctx = memories.map((m, i) => `[${i + 1}] ${m}`).join("\n")
	return `You are Supermemory, a helpful assistant that answers using the user's personal knowledge base (memories synced from their sources, e.g. Google Drive).

Use the memories below as your primary source. If the answer isn't in them, say so and answer from general knowledge, clearly flagging what came from the knowledge base vs. general knowledge. Be concise and cite memories inline as [n] when you use them.

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
	const userId = await requireUser(c)
	if (!userId) return jsonError("Unauthorized", 401)
	if (!LLM_KEY) return jsonError("LLM not configured (SM_LLM_API_KEY)", 503)

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
		system: systemPrompt(memories),
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
