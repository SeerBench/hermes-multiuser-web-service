# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this repo is — IMPORTANT

This is **`SeerBench/hermes-multiuser-web-service`**, a **fork** of upstream
`NousResearch/hermes-agent`.  The fork adds a multi-user web chat platform
on top of the upstream agent.  Everything you'd expect of upstream
Hermes — `cli.py`, the agent loop, ~25 messaging platforms, the skill
system, memory providers, tool registry — is here untouched and works
identically.  What the fork adds:

| New thing | Lives at | Purpose |
|---|---|---|
| `web_chat` gateway platform | `gateway/platforms/web_chat.py` | HTTP + SSE multi-user surface |
| Multi-tenant control plane | `gateway/web/` | UserStore, auth, sandbox, quota, runner, sandboxed tools |
| React SPA | `web-chat/` (builds → `gateway/web/_static/`) | Browser UI |
| Operator guide | `docs/user-guide/web-chat.md` | Setup, HTTP surface, capacity, prod checklist |
| User-id propagation fix | 4 small upstream-file edits | Real bug fix in shared SessionDB infra |

**Default port for the multi-user web service: `:8643`.**  Different from
upstream's `api_server` platform (`:8642`, OpenAI-compatible) and the
local dashboard (`:9119`, single-user).

Project plan with rationale: `/home/sonic/.claude/plans/hermes-agent-web-web-ui-web-llm-base-inherited-kazoo.md`

---

## Strategy 2 — the rule that keeps this fork mergeable

The single most important thing to know about this repo.  We hold to:

> **Pay code duplication if it means upstream files don't get touched.**

**Files that must stay at zero changes** even when modifying them would be simpler:

```
gateway/platforms/api_server.py    ← mirror, don't refactor (web_chat duplicates ~150 LOC)
tools/file_operations.py           ← wrap, don't fork  (web_file_* calls upstream public API)
tools/file_tools.py                ← wrap, don't fork  (same)
tools/terminal_tool.py             ← wrap if we ever ship a sandboxed terminal
agent/memory_manager.py            ← isolate via HERMES_HOME ContextVar, not via code changes
cli.py                             ← never touched
hermes_cli/main.py                 ← never touched
```

**Files where small B-class edits are tolerated** (each is ≤10 lines, additive only,
backward-compatible — these are the named patches the rebase loop has to resolve):

- `run_agent.py:517` and `agent/conversation_compression.py:391` — propagate
  `agent._user_id` into `_session_db.create_session(...)`.  This is a real
  multi-tenant bug, slated for upstream PR.
- `gateway/run.py` — one `elif Platform.WEB_CHAT` branch in `_create_adapter`
  (~10 lines), and a 1-line `user_id=source.user_id` fix in the `/branch`
  command's `create_session` call.
- `gateway/config.py` — `Platform.WEB_CHAT = "web_chat"` in the enum plus
  one validator entry.
- `hermes_cli/platforms.py` — one `PlatformInfo` registration line.
- `toolsets.py` — `hermes-web-chat` toolset definition.
- `hermes_state.py` — `user_id` parameter added to `list_sessions_rich` and
  `search_messages` (purely additive — default `None` preserves old behavior).
- `pyproject.toml` — `[web-chat]` extra (cryptography + ddgs).
- `tools/web_tools.py` — 3 small fork-gated blocks registering the
  fork-bundled `http-fetch` backend: (1) its name in `_get_backend()`'s
  configured allow-set, (2) `_is_backend_available("http-fetch") -> True`,
  and (3) an auto-route in `_get_extract_backend()` that returns
  `http-fetch` when no `web.extract_backend` is configured and the shared
  fallback resolved to a search-only provider (ddgs/brave-free/searxng).
  Together these let deployments without a paid extract API
  (Firecrawl/Tavily/Exa/Parallel) get a working `web_extract` out of the
  box — no config needed — while explicit config and any extract-capable
  paid backend are left untouched.  All three branches are inert upstream
  (`http-fetch` is fork-only).  See `plugins/web/http_fetch/`.
- `tests/plugins/web/test_web_search_provider_plugins.py` — 1 additive filter
  in `test_all_seven_plugins_present_in_registry` excluding the fork-bundled
  `http-fetch` provider from the registry snapshot.  The upstream expected
  list (`brave-free`…`xai`) is left byte-identical, so upstream edits to that
  list never conflict with this filter on rebase.

**Upstream sync workflow**: `git fetch upstream && git rebase upstream/main`.
If a conflict lands in one of the named patches above, resolve it by hand
(seconds-level work).  Conflicts in `gateway/web/`, `web-chat/`, or
`gateway/platforms/web_chat.py` are impossible — those paths don't exist
upstream.

---

## Where to look first — fork-specific routing

For anything multi-user web related.  For upstream concerns, see the
"Upstream routing" table further down.

| Need to… | Start at |
|---|---|
| Understand the web_chat HTTP surface | `gateway/platforms/web_chat.py` + `docs/user-guide/web-chat.md` |
| Touch account / quota / key / cookie logic | `gateway/web/users.py` |
| Touch auth middleware | `gateway/web/auth.py` |
| Touch the per-user filesystem sandbox | `gateway/web/sandbox.py` |
| Touch the quota gate | `gateway/web/quota.py` |
| Touch how AIAgent is spawned per request | `gateway/web/chat_runner.py` |
| Add or modify a sandboxed file tool | `gateway/web/tools/sandboxed_file_operations.py` |
| Touch the React SPA | `web-chat/src/` — see `web-chat/README.md` |
| Modify the `hermes-web-chat` toolset | `toolsets.py` |
| Rebuild the SPA | `cd web-chat && npm install && npm run build` (output: `gateway/web/_static/`) |

---

## Fork-specific patterns and gotchas

These bit us during development; future sessions should know them.

1. **Memory isolation is achieved via ContextVar, not via code changes to
   `MemoryManager`.**  `enter_user_context(user_id)` calls
   `hermes_constants.set_hermes_home_override(workspace_path)`; every
   memory provider already reads `get_hermes_home()`, so the override
   propagates everywhere automatically.  Don't try to add per-user
   parameters to `MemoryManager` — that's the wrong layer.

2. **Sandboxed tools call upstream `*_tool` functions, they don't
   re-implement them.**  `web_file_read` is a 10-line wrapper around
   `tools.file_tools.read_file_tool` that prefixes a `confine_path` check.
   Same for `web_file_write` / `web_file_patch` / `web_file_search`.
   If you need a new sandboxed tool, follow that pattern — never copy
   the upstream implementation.

3. **`confine_path()` raises `RuntimeError` outside a user context** —
   not the milder `PathSandboxViolation`.  This is deliberate: silent
   fallback to "no sandbox" would defeat the security property.  If a
   test fails with "confine_path called outside a web user context",
   the test forgot `enter_user_context(user_id)`.

4. **`ContextVars` do NOT propagate into `loop.run_in_executor` by
   default — you must wrap with `contextvars.copy_context().run`.**
   This was a load-bearing wrong claim in an earlier revision of this
   doc.  `asyncio.create_task` and `asyncio.to_thread` copy the
   current context for you, but the lower-level
   `loop.run_in_executor(None, fn)` does not.  Without `ctx.run`
   wrapping, every ContextVar read inside the worker thread returns
   its default — and the user's encrypted upstream API key silently
   fell back to the global `"no-key-required"` placeholder, producing
   `HTTP 401: Invalid token` on every chat turn.
   `WebChatAgentRunner.run` therefore does:
   ```python
   ctx = contextvars.copy_context()
   return await loop.run_in_executor(None, ctx.run, _run)
   ```
   The same fix carries the workspace + `HERMES_HOME` override into
   the agent thread.  If you add another `run_in_executor` call inside
   the web_chat path, wrap it the same way.

5. **SSE event ordering: don't push `done` via `call_soon_threadsafe`.**
   Token / tool callbacks fire from the executor thread and must use
   `loop.call_soon_threadsafe(queue.put_nowait, ev)`.  But the terminal
   `done` event is emitted from the main event loop — if you wrap it in
   `call_soon_threadsafe` it gets scheduled async, the sentinel `None`
   you push next runs synchronously, and the SSE writer exits before
   `done` ever reaches the client.  Use `event_queue.put_nowait(...)`
   directly for `done`.  This bug was caught by stage-8 E2E tests; see
   commit `19308b974` for the fix.

6. **Quota is recorded in a `finally` block.**  Even if the client
   aborts mid-stream, `gateway/platforms/web_chat.py::_handle_chat`
   pulls `agent.session_total_tokens` and records it.  Partial usage
   counts.  Don't move quota recording out of `finally`.

7. **The chat handler must wrap the runner call in `enter_user_context`.**
   Outside that context manager, every per-user mechanism (memory,
   sandbox, session writes) silently falls back to global state.
   The contextvar binding is the single point where `user_id` becomes
   "the active user" for this request.

---

## Testing

**Fork tests** live in two places:

- `tests/hermes_state/test_user_id_filtering.py` — 12 cases for the stage-1 `user_id` propagation fix
- `tests/gateway/test_web_*.py` — 8 files, 150 cases for the multi-user infrastructure

**Run them with the project test wrapper** (CI-parity hermetic env):

```bash
scripts/run_tests.sh tests/gateway/test_web_*.py tests/hermes_state/test_user_id_filtering.py
```

`scripts/run_tests.sh` enforces hermetic env (`env -i`), `TZ=UTC`,
`LANG=C.UTF-8`, blanked credential vars, and per-file subprocess
isolation via `scripts/run_tests_parallel.py`.  Don't call `pytest`
directly — that diverges from CI in ways that have caused "works
locally, fails in CI" incidents.

**For browser UI testing**, `/tmp/run_web_chat_server.py` (committed to
`.gitignore`-ed tree, see commit message for `19308b974`) starts a
real `aiohttp` gateway with a deterministic `FakeRunner` (no upstream
LLM key needed).  Combined with the `browse` skill, walks through
register → SSE chat → tool events → settings → logout.

---

## Common workflows

### Add a new sandboxed tool

1. In `gateway/web/tools/sandboxed_file_operations.py`, add a
   `_handle_web_xyz(args, **kw)` that calls the upstream `*_tool`
   function with paths passed through `_confine_or_error(...)`.
2. Add a `_WEB_XYZ_SCHEMA` dict in the same file.
3. Add to `_REGISTRATIONS` tuple at the bottom of the file.
4. Add the tool name to the `hermes-web-chat` toolset in `toolsets.py`.

Do **not** copy upstream tool implementations into the fork.  Always
call them via their public functions.

### Add a new HTTP endpoint

1. Add the route in `gateway/platforms/web_chat.py::_wire_routes`.
2. Add the handler method beside the existing ones.  Reach into
   `get_request_user_id(request)` to get the authenticated `user_id`.
3. If the endpoint touches per-user state, do it inside
   `enter_user_context(user_id):` — even for read-only access if it
   needs to read `MEMORY.md` or `state.db`.
4. Add E2E coverage in `tests/gateway/test_web_chat_platform.py`.

### Add a column to UserStore

1. Edit the `users` / `api_keys` / `web_sessions` schema in
   `gateway/web/users.py::_SCHEMA`.
2. SQLite's `CREATE TABLE IF NOT EXISTS` won't add columns to existing
   databases — write an explicit `ALTER TABLE` in a small migration
   function called from `_init_schema`.
3. Touch the relevant `UserStore` methods.
4. Add tests in `tests/gateway/test_web_users.py`.

### Rebuild the SPA

```bash
cd web-chat
npm install        # only the first time
npm run build      # outputs to ../gateway/web/_static/
```

`gateway/web/_static/` is `.gitignore`'d.  Production deployments
build at deploy time; the SPA placeholder is what users see if you
forget to build.

### Deploy / update a running server

`update-web.sh` (repo root) is the one-command native-box updater:
activate venv → `git pull --ff-only` from the SeerBench fork → rebuild
the SPA → restart the gateway → health-check `/api/healthz`.  Use it (or
follow it manually) instead of an ad-hoc `git pull`, because of two
deploy facts that bite every time:

1. **The SPA bundle is `.gitignore`'d**, so `git pull` never refreshes
   the UI — you must rebuild `gateway/web/_static/`.  `startweb.sh` only
   auto-builds when the bundle is *missing*, not when it's stale.
2. **Schema changes are automatic; deps are not.**  New tables (e.g.
   `conversation_flags` in `web_users.db`) come up via
   `CREATE TABLE IF NOT EXISTS` on startup — no migration.  But
   `pyproject.toml`/`uv.lock` changes need `uv pip install -e ".[web-chat]"`,
   and `web-chat/package*.json` changes need `npm ci` before the build.
   `update-web.sh` reinstalls npm deps only when those manifests changed,
   and restores the repo-root `package.json` after npm's camofox
   postinstall dirties it (a known `npm install` side effect in this repo).

Restart strategy flags: default background relaunch (foreground / tmux /
nohup), `--systemd <unit>` (systemd-managed — always use this if a unit
owns the process), `--restart-cmd '<cmd>'`, or `--no-restart`.  Full
operator walk-through: `docs/user-guide/web-chat.md` § "Updating a
deployment".

---

## Setup

```bash
./setup-hermes.sh                   # uv venv, installs .[all,dev]
source .venv/bin/activate
uv pip install -e ".[web-chat]"     # adds argon2-cffi for the fork
```

Multi-user web service requires the `[web-chat]` extra.  Without it,
`WebChatAdapter.connect` logs a friendly hint and refuses to start —
the failure is loud, not silent.

---

## Upstream routing (when the fork's docs don't cover it)

For anything **not** about the multi-user web layer, the upstream
guides are authoritative:

- **`AGENTS.md`** (~1100 lines) — upstream engineering guide: AIAgent
  loop, slash-command registry, TUI architecture, plugin system,
  skills authoring, profiles, dependency policy, testing, known
  pitfalls.  Read this before any non-trivial change to upstream
  code paths.
- **`CONTRIBUTING.md`** (~1300 lines) — upstream contributor guide:
  "skill or tool?" decision tree, skill PR salvage checklist,
  cross-platform rules, security considerations.

Upstream routing table (use only when the fork-specific table above
doesn't cover what you need):

| Need to… | Start at |
|---|---|
| Understand the agent loop | `run_agent.py` (`AIAgent.run_conversation`) |
| Add/modify a **core** tool | `tools/` then `toolsets.py` |
| Add a slash command | `hermes_cli/commands.py` → `cli.py` → `gateway/run.py` |
| Add a config key | `hermes_cli/config.py` (`DEFAULT_CONFIG`) |
| Add an `.env` secret var | `hermes_cli/config.py` (`OPTIONAL_ENV_VARS`) |
| Add a messaging platform | `gateway/platforms/` + `gateway/ADDING_A_PLATFORM.md` |
| Add a skill | `skills/<category>/<name>/` (heavy: `optional-skills/`) |
| Add a model provider | `plugins/model-providers/<name>/` |
| Touch the upstream TUI | `ui-tui/src/app.tsx` + `tui_gateway/server.py` |
| Touch the upstream local dashboard | `web/src/` (rebuild → `hermes_cli/web_dist/`) |

---

## Upstream non-obvious rules that still apply

These are upstream invariants that hold equally in the fork:

1. **Tools must be wired into a toolset to be exposed.**  The
   `hermes-web-chat` toolset in `toolsets.py` is the fork's single
   wire-up point.

2. **Always use `get_hermes_home()`, never hardcode `~/.hermes`.**
   The fork uses the ContextVar override mechanism on top of this —
   any hardcoded path defeats per-user isolation.

3. **Prompt caching must not break mid-conversation.**  The
   web_chat platform respects this — each user's session has stable
   toolsets / system prompt through the agent loop.

4. **Cross-platform — Windows is supported.**  `os.kill(pid, 0)` on
   Windows broadcasts Ctrl+C; use `psutil.pid_exists(pid)`.  See
   `CONTRIBUTING.md` § Cross-Platform Compatibility.

5. **Dependency pins are exact (`==X.Y.Z`), not ranges.**  Set after
   the litellm compromise and reinforced after the Mini Shai-Hulud
   worm (May 2026).  The `[web-chat]` extra pins `argon2-cffi==25.1.0`
   accordingly.

6. **Don't write change-detector tests.**  Tests asserting hardcoded
   model lists or `_config_version == 21` get rejected.  Test
   invariants (relationships between data), not snapshots.

Full rationale in `AGENTS.md`.

---

## Profiles

Upstream Hermes supports `hermes -p <name>` profiles — isolated
`HERMES_HOME` instances.  In the fork these still work, but
multi-user deployments typically run one process serving many
users.  Profiles and the web service are orthogonal — you can run
multiple profiles, each with its own multi-user web service on a
different port.

`_apply_profile_override()` in `hermes_cli/main.py` sets
`HERMES_HOME` before any imports, so module-level constants that
call `get_hermes_home()` resolve correctly.  Tests that mock
`Path.home()` must also `monkeypatch.setenv("HERMES_HOME", ...)`.
The web-chat sandbox's ContextVar override layers on top of this
without conflict.
