import type { JWTVerifyGetKey } from "jose"
import { sessionInfoSchema, type SessionInfo } from "../../shared/types"

const FETCH_TIMEOUT_MS = 30_000

export interface AuthUser {
	userId: string
	organizationId: string
	bearerToken: string
	oauthClientId?: string
	scopes: string[]
	expiresAt?: number
}

export async function fetchSession(
	bearerToken: string,
	apiUrl: string,
): Promise<SessionInfo> {
	const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v3/session`, {
		method: "GET",
		headers: { Authorization: `Bearer ${bearerToken}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})

	if (!response.ok) {
		throw Object.assign(
			new Error(`Session request failed with status ${response.status}`),
			{ status: response.status },
		)
	}

	const result = sessionInfoSchema.safeParse(await response.json())
	if (!result.success) {
		throw new Error("Invalid session response")
	}

	return result.data
}

// Self-hosted validation. better-auth's mcp plugin issues OPAQUE access tokens (DB rows),
// not JWTs, so there is nothing to verify against JWKS. Instead we introspect the token by
// calling the backend's GET /v3/session with it as a bearer; that endpoint resolves the user
// and their organization. Signature kept (audience/keySet unused) so callers/tests still compile.
export async function validateOAuthToken(
	token: string,
	apiUrl: string,
	_audience: string,
	_keySet?: JWTVerifyGetKey,
): Promise<AuthUser | null> {
	try {
		const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v3/session`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
		if (!response.ok) return null

		const data = (await response.json()) as {
			user?: { id?: string }
			organization_id?: string
			scope?: unknown
			scopes?: unknown
		}
		const userId = data.user?.id
		const organizationId = data.organization_id
		if (typeof userId !== "string" || userId.length === 0) return null
		if (typeof organizationId !== "string" || organizationId.length === 0) {
			return null
		}

		const rawScopes = data.scope ?? data.scopes
		const scopes = Array.isArray(rawScopes)
			? rawScopes.filter((scope): scope is string => typeof scope === "string")
			: typeof rawScopes === "string"
				? rawScopes.split(/\s+/).filter(Boolean)
				: []

		return { userId, organizationId, bearerToken: token, scopes }
	} catch (error) {
		console.error("OAuth token introspection error:", error)
		return null
	}
}
