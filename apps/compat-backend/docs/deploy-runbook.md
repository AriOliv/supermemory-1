# Deploy runbook (self-hosted lite + compat backend)

This fork runs the Supermemory **lite** server (`supermemory-server` binary) behind a
compat backend that adds auth, connectors (Slack, Granola) and chat. This repo is public:
host names, project ids, VM names and secret names are placeholders below. The operator
keeps the concrete values in a private runbook.

## Topology

| Unit (systemd) | Runs | Port | Public via reverse proxy |
|---|---|---|---|
| `supermemory.service` | `/opt/supermemory/bin/supermemory-server` (lite) | 6767 | no (localhost only) |
| `supermemory-compat.service` | `bun run src/index.ts` in `<app>/apps/compat-backend` | 8790 | `api.<domain>` |
| `supermemory-console.service` | `bun run start` in `<app>/apps/web` | 3939 | `<domain>` |
| `caddy.service` | TLS + reverse proxy | 80/443 | — |

- Lite config: `/etc/supermemory/env` (no secrets). The LLM gateway key is fetched from a
  secret manager at start (`ExecStartPre`) into `/run/supermemory/secret.env`.
- Lite data dir: `/var/lib/supermemory` on a dedicated disk. It holds `api-key`
  (the instance key the compat backend uses as `SM_LITE_API_KEY`), the encrypted DB (`data`)
  and `embedding-plan.json` (the embedding model lock, see below).
- Compat config: `<app>/apps/compat-backend/.env` (mode 600). Keys are listed in `.env.example`.
- MCP worker: `apps/mcp` deploys to Cloudflare Workers (`wrangler.jsonc`).

## Deploying compat-backend / console code

There is no CI deploy; the VM has a plain copy of the monorepo (not a git checkout).

1. Merge to `avenia-self-hosted-compat` first. Production must never run code that is not in git.
2. Copy only the changed files (IAP tunnel):
   `gcloud compute scp --tunnel-through-iap --zone <zone> --project <project> <files> <vm>:/tmp/`
   then `sudo install -o <app-user> -m 644 /tmp/<file> <app>/apps/compat-backend/src/<file>`.
3. If `package.json` changed: `bun install` at the monorepo root on the VM.
4. `sudo systemctl restart supermemory-compat` (or `supermemory-console`) and check
   `journalctl -u supermemory-compat -n 50`.
5. Drift check, which should print nothing:
   `sha256sum src/*.ts package.json` on the VM vs `shasum -a 256 src/*.ts package.json` locally.

MCP worker: `cd apps/mcp && bun run build:widget && wrangler deploy --minify`.

## Embedding model (lite)

The lite server records the embedding model in `<data dir>/embedding-plan.json`
(provider · model · dimensions · endpoint). On boot, if any chunk or memory already has a vector
and the configured model differs from the lock, **the server refuses to start**. Vectors from
different models are not comparable.

Facts that matter when changing or repairing embeddings:

- Search embeds the query with the same model. An embedding provider outage breaks
  **ingestion and search**, not just ingestion.
- `SUPERMEMORY_EMBEDDING_DIMENSIONS` must stay ≤ 2000 (pgvector HNSW). Changing the dimension
  is only allowed when the vector columns are empty (the server then reshapes them).
- For non-OpenAI models behind an OpenAI-compatible gateway, the lite server does **not** send
  the `dimensions` parameter. Pin the output dimension in the gateway's model definition
  (e.g. LiteLLM `litellm_params.dimensions: 1536`), otherwise e.g. `gemini-embedding-001` returns
  3072-d vectors and every vector upsert fails with `Failed to upsert chunk embeddings`.
- On every boot the server runs a **vector backfill**. It re-embeds, 16 rows per batch, every
  `chunk` whose `embedding IS NULL` (document status `done`) and every latest, non-forgotten
  `memory_entry` whose `memory_embedding IS NULL`. Documents with status `failed` are not
  covered; they need a reprocess.
- A fresh data dir generates a **new org id and API key** (copying `api-key` does not
  preserve them). That breaks the compat backend's `SM_LITE_API_KEY` and every stored org mapping,
  so "wipe and re-ingest" is not an option for this deployment.

### Switching the embedding model (full re-embed)

Destructive for search until the backfill finishes. Run in a window.

1. Snapshot the data disk, and back up `/etc/supermemory/env` and `embedding-plan.json`.
2. Add the new model to the gateway (pinned dimensions) and test it directly with the lite key.
3. Rehearse on a throwaway instance (copy env, `PORT=6768`, empty `SUPERMEMORY_DATA_DIR`,
   `systemd-run --unit=sm-rehearsal …`): ingest 2–3 docs and run `/v3/search` + `/v4/search`.
4. `systemctl stop supermemory`. Clear the old vectors (`chunk.embedding`, `memory_entry.memory_embedding`)
   and update `embedding-plan.json` to the new model. Set `SUPERMEMORY_EMBEDDING_MODEL` in `/etc/supermemory/env`.
   The DB is encrypted local storage with no SQL shell exposed, so the way to clear the vectors
   must be validated on a copy of the data disk first. Never do it in place without that.
5. Start. Follow `journalctl -u supermemory -f | grep vector-backfill` until
   `Restored search vectors for N chunk(s) and M memorie(s)`.
6. Reprocess documents in `failed` status, then validate one ingestion and one search end to end.

Rollback: stop the server and restore the data disk from the snapshot, together with the old env.
