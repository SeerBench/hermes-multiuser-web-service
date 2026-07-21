# Database Design — fork control plane (unchanged by ddgs web_search slice)

This slice does **not** add migrations, schema changes, or per-user search key storage.

## Default (SQLite)

| Store | Path | Contents |
|-------|------|----------|
| Platform control plane | `$HERMES_HOME/platform.db` | users, workspaces, files metadata, sessions, RAG rows |
| Gateway legacy | `$HERMES_HOME/web_users.db` | API-key sessions (when not on platform DB) |
| Agent sessions | `$HERMES_HOME/state.db` | conversation history (per profile) |

## Web research keys

- **Not stored in DB.** `web_search` / `web_extract` use process-global config (`config.yaml` + `.env`) and the `ddgs` Python package.
- **LLM keys** remain per-user (`User.upstream_api_key_enc` / session rows) — separate from search providers.

## File content

- **Bytes on disk:** `$HERMES_HOME/web_workspaces/<user_id>/uploads/...` (local mode).
- **Platform metadata:** `files` table in `platform.db` (`storage_key`, `status`, …).
- **RAG chunks:** `document_chunks` (Files ingest) vs `knowledge_chunks` (Knowledge Center) — separate; agent `web_knowledge_search` uses Knowledge Center only.

## Tenant rule

All platform queries filter by `tenant_id` / `owner_id`; cross-tenant access returns 404.
