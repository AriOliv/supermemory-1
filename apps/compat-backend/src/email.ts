/**
 * Minimal transactional email transport for the self-hosted auth flows
 * (magic link, email OTP, password reset). Uses the Resend REST API directly
 * (Bun fetch, no SDK). If RESEND_API_KEY is unset, it no-ops with a log so dev
 * doesn't break — the email-based flows simply won't deliver until configured.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ""
const EMAIL_FROM = process.env.EMAIL_FROM ?? "Supermemory <onboarding@resend.dev>"

export async function sendEmail(opts: {
	to: string
	subject: string
	html: string
	text?: string
}): Promise<void> {
	if (!RESEND_API_KEY) {
		console.warn(
			`[email] RESEND_API_KEY not set — skipping email to ${opts.to} ("${opts.subject}")`,
		)
		return
	}
	try {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				authorization: `Bearer ${RESEND_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from: EMAIL_FROM,
				to: [opts.to],
				subject: opts.subject,
				html: opts.html,
				...(opts.text ? { text: opts.text } : {}),
			}),
		})
		if (!res.ok) {
			console.error(`[email] send failed ${res.status}: ${await res.text()}`)
		}
	} catch (e) {
		console.error("[email] send error:", e instanceof Error ? e.message : e)
	}
}

// Small shared HTML wrapper so the auth emails look consistent.
export function actionEmail(opts: {
	heading: string
	body: string
	buttonLabel: string
	url: string
}): string {
	return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #eee">
    <h1 style="font-size:18px;margin:0 0 12px">${opts.heading}</h1>
    <p style="color:#444;font-size:14px;line-height:1.5;margin:0 0 24px">${opts.body}</p>
    <a href="${opts.url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px">${opts.buttonLabel}</a>
    <p style="color:#999;font-size:12px;margin:24px 0 0;word-break:break-all">Ou copie e cole este link: ${opts.url}</p>
  </div>
</body></html>`
}
