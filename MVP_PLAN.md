# MVP Plan — Multi-user web_search default ddgs

## Goal

After installing `[web-chat]`, every authenticated web user can use `web_search` via the global zero-key **ddgs** backend without per-user search API keys.

## Deliverables

1. **Recommended config:** Operator `config.yaml` documents `web.search_backend: ddgs` (+ `http-fetch` extract fallback).
2. **Startup probe:** Gateway logs search/extract backend availability at connect time with actionable fix steps when unavailable.
3. **Tests:** Gateway web-research status helper + ddgs happy/edge paths; existing capability gating tests stay green.
4. **Deploy docs:** `DEPLOY-no-docker.md` covers install, config, self-check, and restart.

## Acceptance

```bash
uv pip install -e ".[web-chat,platform]"
scripts/run_tests.sh tests/gateway/test_web_chat_web_research.py tests/tools/test_web_capability_gating.py
```

Runtime self-check (venv):

```python
import tools.web_tools as w
assert w._ddgs_package_importable()
assert w._get_search_backend() == "ddgs"  # with recommended config
assert w.check_web_search_available()
```

Manual: gateway startup log shows `web_search=ddgs available=True`; chat turn exposes `web_search` to the model and returns DuckDuckGo results (VPS outbound to DuckDuckGo required).

## Not in this slice

Per-user search rate limits, Brave/Firecrawl global keys, upstream `DEFAULT_CONFIG` changes.
