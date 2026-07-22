# Hermes Multi-User Web Service — Architecture (fork layer)

## Sidecar layout

```
Browser SPA (web-chat/)
  → nginx
  → /api/v1/*     platform-api (:8700) — auth, workspaces, files, RAG metadata
  → /api/chat*    web_chat gateway (:8643) — SSE + WebChatAgentRunner
  → /             gateway/web/_static/
```

## Multi-tenant isolation

- **Identity:** platform UUID (register) or legacy `derive_user_id(api_key)`.
- **Workspace FS:** `$HERMES_HOME/web_workspaces/<user_id>/` via `enter_user_context`.
- **Control plane DB:** SQLite (default) or PostgreSQL via `PLATFORM_DATABASE_URL`.
- **Upstream LLM key:** per-user, encrypted; bound per request with `enter_upstream_key`.

## Web research (Brave + ddgs hybrid)

- **Routing:** `gateway/web/web_search_router.py` picks backend per user per call:
  - `brave-free` when global `BRAVE_SEARCH_API_KEY` is set and user has remaining Brave quota.
  - `ddgs` fallback when Brave quota exhausted, no key, or Brave unavailable.
- **Quota:** Operator-only via `.env` (`WEB_SEARCH_BRAVE_MAX_PER_USER`, `WEB_SEARCH_BRAVE_WINDOW_SECONDS`). Counts stored in `usage_records` (`type=tool`, `metadata.backend=brave-free`). Users cannot change limits or keys in UI.
- **Tool surface:** `gateway/web/tools/sandboxed_web_search.py` overrides upstream `web_search` at gateway import (`override=True`); `hermes-web-chat` toolset name unchanged.
- **Feedback:** Tool JSON includes `_meta` (backend, urls, brave_remaining); SSE `status` + enriched `tool_end.search_meta` for SPA ActivityLog and ToolEvent URL list.
- **LLM billing:** remains per-user via new-api; Brave/ddgs search cost is operator-side.

## Web chat tools (prior slices)

- Composite toolset `hermes-web-chat` lists sandboxed fork tools (`web_file_*`, `web_skill_*`, …).
- Dynamic registry toolsets registered at import in `gateway/web/tools/`.
- File reads: `web_file_read` confines paths then reads text or extracts PDF/Office.

## Out of scope

- Per-user Brave API keys; parallel merge of Brave + ddgs results in one call.
- Changing upstream `DEFAULT_CONFIG["web"]` or `tools/web_tools.py` dispatch.
- Global Brave monthly cap enforcement (upstream 429 only).
