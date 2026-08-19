import { Database } from "bun:sqlite"
import { betterAuth, type BetterAuthOptions } from "better-auth"
import {
	admin,
	anonymous,
	apiKey,
	emailOTP,
	jwt,
	magicLink,
	mcp,
	organization,
	username,
} from "better-auth/plugins"
import { sso } from "better-auth/plugins/sso"
import { actionEmail, sendEmail } from "./email"

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

// Google social login reuses the OAuth client already configured for the Drive connector.
// Add ${BASE_URL}/api/auth/callback/google to that client's authorized redirect URIs.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? ""
const socialProviders =
	GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
		? { google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } }
		: {}

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
		sendResetPassword: async ({ user, url }) => {
			await sendEmail({
				to: user.email,
				subject: "Redefinir sua senha — Supermemory",
				html: actionEmail({
					heading: "Redefinir sua senha",
					body: "Recebemos um pedido para redefinir a senha da sua conta. Clique abaixo para escolher uma nova senha. Se não foi você, ignore este e-mail.",
					buttonLabel: "Redefinir senha",
					url,
				}),
			})
		},
	},
	// Google "Sign in with Google" — registers /api/auth/callback/google.
	socialProviders,
	advanced: {
		// Must match the prefixes apps/web/middleware.ts checks for.
		cookiePrefix: "better-auth",
	},
	// jwt() exposes /api/auth/jwks (completes the OAuth AS metadata); mcp() wraps
	// oidcProvider to serve OAuth2 discovery, dynamic client registration, authorize/token
	// and /api/auth/mcp/* — making this backend the AS the official MCP Worker delegates to.
	// magicLink/emailOTP send email via Resend (email.ts); admin enables the admin panel APIs.
	plugins: [
		organization(),
		apiKey(),
		username(),
		anonymous(),
		jwt(),
		mcp({ loginPage: LOGIN_PAGE, resource: MCP_RESOURCE }),
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				await sendEmail({
					to: email,
					subject: "Seu link de acesso — Supermemory",
					html: actionEmail({
						heading: "Entrar no Supermemory",
						body: "Clique no botão abaixo para entrar. O link expira em alguns minutos.",
						buttonLabel: "Entrar",
						url,
					}),
				})
			},
		}),
		emailOTP({
			sendVerificationOTP: async ({ email, otp }) => {
				await sendEmail({
					to: email,
					subject: `Seu código: ${otp} — Supermemory`,
					html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px"><p>Seu código de verificação é:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${otp}</p><p style="color:#999;font-size:12px">Expira em alguns minutos.</p></body></html>`,
				})
			},
		}),
		admin(),
		// Enterprise SSO via OIDC — register an IdP with POST /api/auth/sso/register, then
		// sign in with /api/auth/sign-in/sso. (SAML would need @better-auth/sso + an upgrade.)
		sso(),
	],
} satisfies BetterAuthOptions

export const auth = betterAuth(authOptions)

export type Auth = typeof auth
