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

## Web chat tools (this change)

- Composite toolset `hermes-web-chat` lists sandboxed fork tools (`web_file_*`, `web_skill_*`, …).
- Dynamic registry toolsets (`web_file`, `web_skill`, `web_memory`, `web_knowledge`) are registered at import time in `gateway/web/tools/`.
- `WebChatAgentRunner` must merge those dynamic toolsets into `enabled_toolsets`; generic `_get_platform_tools()` only knows static `TOOLSETS`.
- File reads: `web_file_read` confines paths then reads text or extracts PDF/Office via `platform_api.services.extract`.

## Out of scope (this MVP slice)

- MinIO `s3://` object reads in `web_file_read`.
- Unifying Files `DocumentChunk` ingest with Agent `web_knowledge_search`.
- Cross-turn attachment reference persistence in SPA history.
