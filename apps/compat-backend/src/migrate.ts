/**
 * Programmatic better-auth schema migration, run under Bun so bun:sqlite works
 * (the @better-auth/cli uses jiti in a Node context and can't load bun:sqlite).
 *   bun run src/migrate.ts
 */
import { getMigrations } from "better-auth/db"
import { authOptions } from "./auth"

const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(authOptions)
await runMigrations()
console.log(
	`[migrate] ok — tables created: ${toBeCreated.length}, altered: ${toBeAdded.length}`,
)
process.exit(0)
