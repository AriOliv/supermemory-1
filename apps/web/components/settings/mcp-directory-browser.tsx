"use client"

import { cn } from "@lib/utils"
import { ChevronDown, Laptop, Loader2, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { dmSans125ClassName } from "@/lib/fonts"
import type { McpDirectoryEntry } from "@/lib/mcp-directory"
import { brainConnectorIcon } from "../brain-connector-icons"

const PAGE_SIZE = 48
let directoryCache: McpDirectoryEntry[] | null = null

const AVAILABILITY_LABEL = {
	fixed: "Remote URL",
	tenant: "Custom URL",
	unavailable: "URL unavailable",
	local: "Desktop only",
} as const

function isDirectoryEntry(value: unknown): value is McpDirectoryEntry {
	if (!value || typeof value !== "object") return false
	const entry = value as Partial<McpDirectoryEntry>
	return (
		typeof entry.id === "string" &&
		typeof entry.name === "string" &&
		(entry.type === "remote" || entry.type === "local") &&
		(entry.url === null || typeof entry.url === "string") &&
		typeof entry.auth === "string" &&
		(entry.note === null || typeof entry.note === "string") &&
		Array.isArray(entry.categories) &&
		entry.categories.every((category) => typeof category === "string") &&
		typeof entry.popularity === "number" &&
		["fixed", "tenant", "unavailable", "local"].includes(
			entry.availability ?? "",
		)
	)
}

function parseDirectory(value: unknown) {
	if (!value || typeof value !== "object") throw new Error("invalid catalog")
	const entries = (value as { entries?: unknown }).entries
	if (!Array.isArray(entries) || !entries.every(isDirectoryEntry)) {
		throw new Error("invalid catalog")
	}
	return entries
}

async function loadDirectory(signal: AbortSignal) {
	if (directoryCache) return directoryCache
	const response = await fetch("/mcp-directory.json", {
		signal,
		cache: "default",
	})
	if (!response.ok) throw new Error("catalog request failed")
	directoryCache = parseDirectory(await response.json())
	return directoryCache
}

function categoryLabel(value: string) {
	return value
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")
}

function entrySlug(entry: McpDirectoryEntry) {
	return entry.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
}

export function McpDirectoryBrowser({
	builtInSlugs,
	onSetUp,
}: {
	builtInSlugs: Set<string>
	onSetUp: (entry: McpDirectoryEntry) => void
}) {
	const [query, setQuery] = useState("")
	const [entries, setEntries] = useState<McpDirectoryEntry[]>([])
	const [loadError, setLoadError] = useState(false)
	const [category, setCategory] = useState("all")
	const [availability, setAvailability] = useState("all")
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

	useEffect(() => {
		const controller = new AbortController()
		void loadDirectory(controller.signal)
			.then((data) => {
				setEntries(data)
				setLoadError(false)
			})
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return
				setLoadError(true)
			})
		return () => controller.abort()
	}, [])

	const categories = useMemo(
		() =>
			[...new Set(entries.flatMap((entry) => entry.categories))].sort((a, b) =>
				categoryLabel(a).localeCompare(categoryLabel(b)),
			),
		[entries],
	)

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase()
		return entries.filter((entry) => {
			if (category !== "all" && !entry.categories.includes(category))
				return false
			if (availability !== "all" && entry.availability !== availability)
				return false
			if (!needle) return true
			return [entry.name, entry.url, entry.note, ...entry.categories]
				.filter(Boolean)
				.some((value) => value?.toLowerCase().includes(needle))
		})
	}, [availability, category, entries, query])

	const visible = filtered.slice(0, visibleCount)

	return (
		<section className="space-y-4 pt-3">
			<div className="flex flex-col gap-1">
				<div className="flex items-baseline justify-between gap-4">
					<h2
						className={cn(
							dmSans125ClassName(),
							"font-semibold text-[17px] tracking-[-0.25px] text-[#FAFAFA]",
						)}
					>
						MCP directory
					</h2>
					<span className="shrink-0 text-[12px] font-medium text-[#737373]">
						{entries.length > 0
							? `${filtered.length.toLocaleString()} of ${entries.length.toLocaleString()}`
							: "654 servers"}
					</span>
				</div>
				<p className="max-w-2xl text-[13px] font-medium leading-5 text-[#737373]">
					Browse remote and desktop MCP servers. Remote entries open a setup
					form so you can confirm OAuth or API-key authentication before
					connecting.
				</p>
			</div>

			<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
				<label className="relative">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#737373]" />
					<input
						value={query}
						onChange={(event) => {
							setQuery(event.target.value)
							setVisibleCount(PAGE_SIZE)
						}}
						placeholder="Search MCPs"
						className="h-10 w-full rounded-xl border border-[#252B34] bg-[#111419] pr-3 pl-9 text-[13px] font-medium text-[#FAFAFA] outline-none placeholder:text-[#5F6673] focus:border-[#3A4150]"
					/>
				</label>
				<label className="relative">
					<select
						aria-label="Filter by category"
						value={category}
						onChange={(event) => {
							setCategory(event.target.value)
							setVisibleCount(PAGE_SIZE)
						}}
						className="h-10 w-full appearance-none rounded-xl border border-[#252B34] bg-[#111419] px-3 pr-8 text-[13px] font-medium text-[#D4D4D8] outline-none focus:border-[#3A4150]"
					>
						<option value="all">All categories</option>
						{categories.map((value) => (
							<option key={value} value={value}>
								{categoryLabel(value)}
							</option>
						))}
					</select>
					<ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[#737373]" />
				</label>
				<label className="relative">
					<select
						aria-label="Filter by availability"
						value={availability}
						onChange={(event) => {
							setAvailability(event.target.value)
							setVisibleCount(PAGE_SIZE)
						}}
						className="h-10 w-full appearance-none rounded-xl border border-[#252B34] bg-[#111419] px-3 pr-8 text-[13px] font-medium text-[#D4D4D8] outline-none focus:border-[#3A4150]"
					>
						<option value="all">All availability</option>
						<option value="fixed">Remote URL</option>
						<option value="tenant">Custom URL</option>
						<option value="unavailable">URL unavailable</option>
						<option value="local">Desktop only</option>
					</select>
					<ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[#737373]" />
				</label>
			</div>

			{loadError ? (
				<div className="rounded-xl border border-[#252B34] border-dashed px-4 py-10 text-center text-[13px] font-medium text-[#737373]">
					The MCP directory couldn't be loaded. Refresh to try again.
				</div>
			) : entries.length === 0 ? (
				<div className="flex items-center justify-center gap-2 rounded-xl border border-[#252B34] border-dashed px-4 py-10 text-[13px] font-medium text-[#737373]">
					<Loader2 className="size-4 animate-spin" />
					Loading MCP directory
				</div>
			) : visible.length > 0 ? (
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{visible.map((entry) => {
						const builtIn = builtInSlugs.has(entrySlug(entry))
						const canSetUp =
							!builtIn &&
							entry.auth !== "no_auth" &&
							!entry.note
								?.toLowerCase()
								.includes("register your own oauth client") &&
							(entry.availability === "fixed" ||
								entry.availability === "tenant")
						const subtitle =
							entry.categories.length > 0
								? entry.categories.map(categoryLabel).join(" · ")
								: entry.type === "local"
									? "Local desktop extension"
									: "Other"
						return (
							<div
								key={entry.id}
								className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-[#20252D] bg-[#111419] p-3.5 transition-colors hover:border-[#2E3642]"
							>
								<div className="flex min-w-0 items-start gap-3">
									<div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-[#080B0F]">
										{entry.type === "local" ? (
											<Laptop className="size-4 text-[#A1A1AA]" />
										) : (
											brainConnectorIcon(entrySlug(entry), entry.name, "size-4")
										)}
									</div>
									<div className="min-w-0">
										<p className="truncate text-[13px] font-semibold text-[#FAFAFA]">
											{entry.name}
										</p>
										<p className="mt-0.5 line-clamp-1 text-[11px] font-medium text-[#737373]">
											{subtitle}
										</p>
									</div>
								</div>
								<div className="flex items-center justify-between gap-2 border-[#20252D] border-t pt-2.5">
									<span className="truncate text-[11px] font-medium text-[#6B7280]">
										{builtIn
											? "Built in above"
											: entry.auth === "no_auth"
												? "No-auth servers aren't supported yet"
												: entry.note
															?.toLowerCase()
															.includes("register your own oauth client")
													? "Requires your own OAuth client"
													: AVAILABILITY_LABEL[entry.availability]}
									</span>
									{canSetUp ? (
										<button
											type="button"
											onClick={() => onSetUp(entry)}
											className="shrink-0 cursor-pointer rounded-full bg-[#1B2028] px-3 py-1.5 text-[11px] font-semibold text-[#FAFAFA] transition-colors hover:bg-[#252C37]"
										>
											Set up
										</button>
									) : null}
								</div>
							</div>
						)
					})}
				</div>
			) : (
				<div className="rounded-xl border border-[#252B34] border-dashed px-4 py-10 text-center text-[13px] font-medium text-[#737373]">
					No MCPs match these filters.
				</div>
			)}

			{visibleCount < filtered.length ? (
				<button
					type="button"
					onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
					className="mx-auto flex h-9 cursor-pointer items-center rounded-full border border-[#2A313C] px-5 text-[12px] font-semibold text-[#D4D4D8] transition-colors hover:border-[#3A4150] hover:text-[#FAFAFA]"
				>
					Show {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more
				</button>
			) : null}
		</section>
	)
}
