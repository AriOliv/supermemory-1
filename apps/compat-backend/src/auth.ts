import { Database } from "bun:sqlite"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import {
	anonymous,
	apiKey,
	jwt,
	mcp,
	organization,
	username,
} from "better-auth/plugins"

/**
 * Self-hosted compatibility auth server for the Supermemory OSS console.
 *
 * The console (`apps/web`) is a better-auth client (see packages/lib/auth.ts).
 * The lite `supermemory-server` binary ships with NO `/api/auth/*`, so this
 * server provides exactly the better-auth surface the console calls:
 *   - core email + password (+ session)  → sign-in/up, get-session, sign-out
 *   - organization plugin                → onboarding / EnsureWorkspace gate
 *   - apiKey plugin                      → settings / integrations (keys for external tools)
 *   - username plugin                    → onboarding updateUser({username})
 *   - anonymous plugin                   → guest sign-in
 *
 * cookiePrefix MUST be "better-auth" so apps/web/middleware.ts finds the session.
 */

const DB_PATH = process.env.SM_COMPAT_DB ?? "compat.sqlite"
const BASE_URL = process.env.SM_COMPAT_BASE_URL ?? "http://localhost:8080"
const SECRET =
	process.env.SM_COMPAT_AUTH_SECRET ??
	"dev-only-insecure-secret-change-me-in-prod-0123456789"
const TRUSTED_ORIGINS = (process.env.SM_COMPAT_TRUSTED_ORIGINS ?? "http://localhost:3939")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
// OAuth authorize flow sends unauthenticated users here to log in (the console),
// then back to complete the MCP client's authorization.
const LOGIN_PAGE = process.env.SM_COMPAT_LOGIN_PAGE ?? "http://localhost:3939/login"
// The MCP resource identifier advertised in OAuth discovery (the Worker's public /mcp URL).
const MCP_RESOURCE = process.env.SM_MCP_RESOURCE ?? "http://localhost:8788/mcp"

// Exported so the proxy can resolve a bearer user's organization directly from the
// better-auth tables (getMcpSession returns only userId; org isn't in the opaque token).
export const authDb = new Database(DB_PATH)

export const authOptions = {
	database: authDb,
	baseURL: BASE_URL,
	secret: SECRET,
	trustedOrigins: TRUSTED_ORIGINS,
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: false,
		autoSignIn: true,
	},
	advanced: {
		// Must match the prefixes apps/web/middleware.ts checks for.
		cookiePrefix: "better-auth",
	},
	// jwt() exposes /api/auth/jwks (completes the OAuth AS metadata); mcp() wraps
	// oidcProvider to serve OAuth2 discovery, dynamic client registration, authorize/token
	// and /api/auth/mcp/* — making this backend the AS the official MCP Worker delegates to.
	plugins: [
		organization(),
		apiKey(),
		username(),
		anonymous(),
		jwt(),
		mcp({ loginPage: LOGIN_PAGE, resource: MCP_RESOURCE }),
	],
} satisfies BetterAuthOptions

export const auth = betterAuth(authOptions)

export type Auth = typeof auth
