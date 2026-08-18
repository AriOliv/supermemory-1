import { Hono } from "hono"
import { cors } from "hono/cors"
import { auth } from "./auth"
import { connectors } from "./connectors"

/**
 * Compatibility backend for the Supermemory OSS console.
 *   /api/auth/*  → better-auth (auth.ts). Handles its own CORS via trustedOrigins.
 *   /v3/*, /v4/* → session-guarded proxy to the self-hosted lite supermemory-server,
 *                  with explicit stubs for endpoints the lite binary doesn't implement.
 *   /brain/*     → stubbed empty (Company Brain is out of the current scope).
 */

const ORIGINS = (process.env.SM_COMPAT_TRUSTED_ORIGINS ?? "http://localhost:3939")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
const LITE_URL = (process.env.SM_LITE_URL ?? "http://127.0.0.1:6767").replace(/\/+$/, "")
const LITE_KEY = process.env.SM_LITE_API_KEY ?? ""
const PORT = Number(process.env.PORT ?? 8080)

const app = new Hono()

// lightweight request log (live activity feed for monitoring)
app.use("*", async (c, next) => {
	const t = Date.now()
	await next()
	const p = new URL(c.req.url).pathname
	if (p !== "/") console.log(`${c.req.method} ${p} -> ${c.res.status} ${Date.now() - t}ms`)
})

const corsMw = cors({
	origin: (o) => (o && ORIGINS.includes(o) ? o : (ORIGINS[0] ?? "")),
	credentials: true,
	allowHeaders: ["Content-Type", "X-App-Source", "Authorization"],
	allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	maxAge: 600,
})
// Global CORS — MUST be registered before the routes so OPTIONS preflight is
// handled for every path, including /api/auth/* (better-auth only serves GET/POST).
app.use("*", corsMw)

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	})

// health
app.get("/", (c) => c.json({ ok: true, service: "supermemory-compat-backend" }))

// better-auth (own CORS via trustedOrigins)
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

// silence PostHog analytics beacons (the console proxies them via /orange/*)
app.all("/orange/*", () => json({}))
// Autumn billing is out of scope — return benign empties so the billing widgets don't crash.
app.all("/api/autumn/*", () => json({}))

async function getSession(c: { req: { raw: Request } }) {
	try {
		return await auth.api.getSession({ headers: c.req.raw.headers })
	} catch {
		return null
	}
}

// Endpoints the console calls on mount that the lite server does NOT implement.
// Minimal shapes so the UI renders; refined iteratively against the real console.
const STUBS: Record<string, () => Response> = {
	"GET /v3/mcp/has-login": () => json({ hasLogin: false }),
	"GET /v3/memory-of-day": () => json({ memory: null }),
	"POST /v3/space-highlights": () => json({ highlights: [] }),
	"GET /v3/analytics/memory": () => json({}),
	"GET /v3/analytics/chat": () => json({}),
	"GET /v3/analytics/usage": () => json({}),
	"GET /v3/auth/plugins": () => json({ plugins: [] }),
	"GET /v3/auth/keys": () => json({ keys: [] }),
	"GET /v3/auth/account/memberships": () => json({ memberships: [] }),
	"GET /v3/auth/org-summaries": () => json({ summaries: [] }),
	"GET /v3/waitlist/status": () => json({ status: "approved" }),
	"GET /v3/digests": () => json({ digests: [] }),
	"GET /v3/digests/preferences": () => json({ digestOptOut: false }),
}

async function proxyToLite(c: { req: { url: string; method: string; raw: Request; header: (k: string) => string | undefined } }) {
	const url = new URL(c.req.url)
	const path = url.pathname
	const method = c.req.method

	const stub = STUBS[`${method} ${path}`]
	if (stub) return stub()

	const target = `${LITE_URL}${path}${url.search}`
	const headers = new Headers()
	headers.set("authorization", `Bearer ${LITE_KEY}`)
	const ct = c.req.header("content-type")
	if (ct) headers.set("content-type", ct)
	const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method)
	const body = hasBody ? await c.req.raw.arrayBuffer() : undefined
	const resp = await fetch(target, { method, headers, body, redirect: "manual" })

	// Soft fallback: the console polls a single container-tag (e.g. its default space)
	// that the lite store may not have yet → return an empty profile instead of 404.
	if (
		resp.status === 404 &&
		method === "GET" &&
		/^\/v3\/container-tags\/[^/]+$/.test(path)
	) {
		return json({ containerTag: decodeURIComponent(path.split("/").pop() ?? ""), profile: null })
	}

	const outHeaders = new Headers(resp.headers)
	outHeaders.delete("content-encoding")
	outHeaders.delete("transfer-encoding")
	outHeaders.delete("content-length")
	return new Response(resp.body, { status: resp.status, headers: outHeaders })
}

const guarded = async (c: any) => {
	const session = await getSession(c)
	if (!session) return json({ error: "Unauthorized" }, 401)
	return proxyToLite(c)
}

// Knowledge-base connectors (Google Drive, ...) — real implementation, mounted
// before the generic proxy so /v3/connections/* is handled here, not proxied/stubbed.
app.route("/v3/connections", connectors)

app.all("/v3/*", guarded)
app.all("/v4/*", guarded)
app.all("/brain/*", async (c: any) => {
	const session = await getSession(c)
	if (!session) return json({ error: "Unauthorized" }, 401)
	return json({}) // Company Brain stubbed for now
})

console.log(`[compat] :${PORT}  lite=${LITE_URL}  origins=${ORIGINS.join(",")}`)
export default { port: PORT, fetch: app.fetch }
