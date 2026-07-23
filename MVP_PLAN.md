# MVP Plan — web_search Brave + ddgs hybrid

## Goal

Multi-user web chat uses global Brave when the user has quota, falls back to ddgs, shows usage notifications and searched URLs in the UI. Users cannot configure keys or limits.

## Deliverables

1. **Router:** `web_search_router` + `web_search_limits` + `sandboxed_web_search` override.
2. **Env limits:** `WEB_SEARCH_BRAVE_MAX_PER_USER`, `WEB_SEARCH_BRAVE_WINDOW_SECONDS`, global `BRAVE_SEARCH_API_KEY`.
3. **SSE feedback:** `status` message after each search; `tool_end.search_meta` for structured UI.
4. **SPA:** ToolEvent shows backend label + URL list; i18n zh/en.
5. **Tests:** Gateway sandbox routing, isolation, status message helper; frontend `extractWebSearchSummary`.

## Acceptance

```bash
scripts/run_tests.sh tests/gateway/test_web_sandboxed_web_search.py tests/gateway/test_web_chat_web_research.py
cd web-chat && npm test
```

Manual: user A exhausts Brave quota → auto ddgs; ActivityLog shows remaining count; ToolEvent lists URLs.

## Not in this slice

Brave+ddgs parallel merge, per-user Brave keys, SPA settings for search.
