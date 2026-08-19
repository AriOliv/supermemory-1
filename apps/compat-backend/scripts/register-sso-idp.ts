/**
 * Registra um IdP OIDC de SSO corporativo no compat backend (better-auth `sso` plugin).
 *
 * Uso (preencha as envs; nada fica hardcoded):
 *   cd apps/compat-backend
 *   SM_COMPAT_BASE_URL=http://localhost:8790 \
 *   ADMIN_EMAIL=voce@avenia.io ADMIN_PASSWORD='sua-senha' \
 *   SSO_PROVIDER_ID=avenia-idp \
 *   SSO_ISSUER=https://SEU-IDP/.../ \
 *   SSO_DOMAIN=avenia.io \
 *   SSO_CLIENT_ID=xxx SSO_CLIENT_SECRET=yyy \
 *   SSO_DISCOVERY=https://SEU-IDP/.well-known/openid-configuration \
 *   bun run scripts/register-sso-idp.ts
 *
 * - `SSO_DOMAIN` é o domínio de e-mail que roteia pro IdP (ex.: quem loga com @avenia.io vai pro SSO).
 * - Com `SSO_DISCOVERY` setado, os endpoints (authorization/token/userinfo/jwks) são auto-descobertos;
 *   senão, informe-os por SSO_AUTHZ_ENDPOINT / SSO_TOKEN_ENDPOINT / SSO_USERINFO_ENDPOINT / SSO_JWKS_ENDPOINT.
 * - Requer uma conta de admin no compat (email+senha) para autenticar a chamada de registro.
 * - No IdP, cadastre o redirect/callback: ${SM_COMPAT_BASE_URL}/api/auth/sso/callback/${SSO_PROVIDER_ID}
 *
 * Depois de registrar: set `NEXT_PUBLIC_SSO_ENABLED=true` no console e reinicie o `next dev`.
 */

const BASE = (process.env.SM_COMPAT_BASE_URL ?? "http://localhost:8790").replace(/\/+$/, "")

function req(name: string): string {
	const v = process.env[name]
	if (!v) {
		console.error(`Falta a env obrigatória: ${name}`)
		process.exit(1)
	}
	return v
}

const ADMIN_EMAIL = req("ADMIN_EMAIL")
const ADMIN_PASSWORD = req("ADMIN_PASSWORD")
const providerId = req("SSO_PROVIDER_ID")
const issuer = req("SSO_ISSUER")
const domain = req("SSO_DOMAIN")
const clientId = req("SSO_CLIENT_ID")
const clientSecret = req("SSO_CLIENT_SECRET")

// 1) autentica como admin para obter o cookie de sessão
const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
})
const cookie = (signIn.headers.getSetCookie?.() ?? [])
	.map((c) => c.split(";")[0])
	.join("; ")
if (!signIn.ok || !cookie) {
	console.error(`Login admin falhou: ${signIn.status} ${await signIn.text()}`)
	process.exit(1)
}

// 2) monta o corpo (discovery auto-descobre os endpoints; senão, informe-os por env)
const body: Record<string, unknown> = {
	providerId,
	issuer,
	domain,
	clientId,
	clientSecret,
	...(process.env.SSO_DISCOVERY ? { discoveryEndpoint: process.env.SSO_DISCOVERY } : {}),
	...(process.env.SSO_AUTHZ_ENDPOINT ? { authorizationEndpoint: process.env.SSO_AUTHZ_ENDPOINT } : {}),
	...(process.env.SSO_TOKEN_ENDPOINT ? { tokenEndpoint: process.env.SSO_TOKEN_ENDPOINT } : {}),
	...(process.env.SSO_USERINFO_ENDPOINT ? { userInfoEndpoint: process.env.SSO_USERINFO_ENDPOINT } : {}),
	...(process.env.SSO_JWKS_ENDPOINT ? { jwksEndpoint: process.env.SSO_JWKS_ENDPOINT } : {}),
	scopes: (process.env.SSO_SCOPES ?? "openid email profile").split(/\s+/).filter(Boolean),
	pkce: process.env.SSO_PKCE !== "false",
}

// 3) registra o provider
const res = await fetch(`${BASE}/api/auth/sso/register`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify(body),
})
const text = await res.text()
if (!res.ok) {
	console.error(`Registro falhou: ${res.status} ${text}`)
	process.exit(1)
}
console.log("SSO IdP registrado com sucesso:")
console.log(text)
console.log(
	`\nCallback a cadastrar no IdP: ${BASE}/api/auth/sso/callback/${providerId}` +
		`\nAgora set NEXT_PUBLIC_SSO_ENABLED=true no console e reinicie o next dev.`,
)
