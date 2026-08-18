import { useCustomer } from "autumn-js/react"
import { hasActivePlan } from "@lib/queries"
import { useHasCompanyBrain } from "@/hooks/use-company-brain"

// Connector entitlement (pro tier or company_brain) — mirrors backend canAccessConnector. Not for plugins.
export function useConnectorAccess(opts?: { enabled?: boolean }) {
	const enabled = opts?.enabled ?? true
	const autumn = useCustomer({ queryOptions: { enabled } })
	const hasCompanyBrain = useHasCompanyBrain()
	// Self-hosted (Avenia): no billing/Autumn, so unlock all pro-tier entitlements
	// instead of gating connectors/plugins behind an "upgrade" prompt. Set
	// NEXT_PUBLIC_SELF_HOSTED_UNLOCK=false to restore upstream plan gating.
	if (process.env.NEXT_PUBLIC_SELF_HOSTED_UNLOCK !== "false") {
		return {
			hasPro: true,
			hasMax: true,
			hasScale: true,
			hasCompanyBrain,
			connectorAccess: true,
			loading: false,
		}
	}
	const hasPro = enabled && hasActivePlan(autumn.data?.subscriptions, "api_pro")
	const hasMax = enabled && hasActivePlan(autumn.data?.subscriptions, "api_max")
	const hasScale =
		enabled && hasActivePlan(autumn.data?.subscriptions, "api_scale")
	return {
		hasPro,
		hasMax,
		hasScale,
		hasCompanyBrain,
		connectorAccess: hasPro || hasCompanyBrain,
		loading: enabled && autumn.isLoading,
	}
}
