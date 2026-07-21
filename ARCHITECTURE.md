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

## Web research (this change)

- **Search (`web_search`):** global zero-key **`ddgs`** (DuckDuckGo via `ddgs` package shipped in `[web-chat]` extra). Operator configures `web.search_backend: ddgs` in `config.yaml`; no per-user search API keys.
- **Extract (`web_extract`):** global zero-key **`http-fetch`** fallback when no paid extract backend is configured.
- **Tool exposure:** `hermes-web-chat` lists both tools; registry `check_fn` gates on resolved backend availability (`check_web_search_available` / `check_web_extract_available`).
- **Startup probe:** `gateway/web/web_research_status.py` logs INFO/WARNING at gateway connect time so operators see misconfiguration before users report missing tools.
- **LLM billing:** remains per-user via new-api; web search cost is operator-side (ddgs is free; VPS must reach DuckDuckGo).

## Web chat tools (prior slice)

- Composite toolset `hermes-web-chat` lists sandboxed fork tools (`web_file_*`, `web_skill_*`, …).
- Dynamic registry toolsets (`web_file`, `web_skill`, `web_memory`, `web_knowledge`) are registered at import time in `gateway/web/tools/`.
- `WebChatAgentRunner` must merge those dynamic toolsets into `enabled_toolsets`; generic `_get_platform_tools()` only knows static `TOOLSETS`.
- File reads: `web_file_read` confines paths then reads text or extracts PDF/Office via `platform_api.services.extract`.

## Out of scope (this MVP slice)

- Per-user search rate limits / QPS.
- Brave / Firecrawl / Tavily global key provisioning and billing.
- Changing upstream `DEFAULT_CONFIG["web"]` defaults in `hermes_cli/config.py`.
- MinIO `s3://` object reads in `web_file_read`.
- Unifying Files `DocumentChunk` ingest with Agent `web_knowledge_search`.
- Cross-turn attachment reference persistence in SPA history.
