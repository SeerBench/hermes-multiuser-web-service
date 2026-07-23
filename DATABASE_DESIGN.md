# Database Design — web_search Brave quota (no new tables)

## Brave usage counting

Uses existing **`usage_records`** table (Usage Center):

| Field | Value for Brave search |
|-------|------------------------|
| `type` | `tool` |
| `tool_name` | `web_search` |
| `user_id` | active web user |
| `metadata_json.backend` | `brave-free` |
| `metadata_json.query` | search query (truncated) |
| `metadata_json.urls` | hit URLs (capped list) |

Window count: `created_at >= now - WEB_SEARCH_BRAVE_WINDOW_SECONDS` filtered by `metadata.backend == "brave-free"`.

## No schema migration

No new columns or tables. Requires `PLATFORM_DATABASE_URL` for persistent Brave quota; without it, Brave quota check fails closed to ddgs.

## Other stores (unchanged)

| Store | Path | Contents |
|-------|------|----------|
| Platform | `$HERMES_HOME/platform.db` | users, workspaces, usage_records, RAG |
| Gateway legacy | `$HERMES_HOME/web_users.db` | sessions |
| Agent | `$HERMES_HOME/state.db` | conversations |

## Tenant rule

Usage queries always filter by `user_id`; cross-tenant access returns 404.
