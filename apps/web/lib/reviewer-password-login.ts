export const MCP_REVIEWER_EMAIL = "test@supermemory.com"

export function normalizeReviewerPasswordEmail(value: unknown): string | null {
	if (typeof value !== "string") return null
	const normalized = value.trim().toLowerCase()
	return normalized || null
}

export function shouldUseReviewerPasswordLogin({
	submittedEmail,
}: {
	submittedEmail: string
}): boolean {
	// Self-hosted (Avenia): no SMTP, so email+password is the primary login method.
	// Show the password form for any valid email instead of only the reviewer backdoor.
	// Set NEXT_PUBLIC_PASSWORD_LOGIN_ENABLED=false to restore the upstream behavior.
	if (process.env.NEXT_PUBLIC_PASSWORD_LOGIN_ENABLED === "false") {
		return normalizeReviewerPasswordEmail(submittedEmail) === MCP_REVIEWER_EMAIL
	}
	return normalizeReviewerPasswordEmail(submittedEmail) !== null
}
