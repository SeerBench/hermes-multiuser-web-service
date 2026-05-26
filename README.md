<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-English-blue?style=for-the-badge" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/语言-中文-red?style=for-the-badge" alt="中文"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/Upstream-Hermes%20Agent-blueviolet?style=for-the-badge" alt="Upstream: Hermes Agent"></a>
</p>

# Hermes Multi-User Web Service

**A self-hosted, multi-tenant chat service built on top of [Nous Research's Hermes Agent](https://github.com/NousResearch/hermes-agent).** One Python process serves any number of users with isolated accounts, conversations, memory, filesystem workspaces, and per-user token quotas. Browser SPA over Server-Sent Events. Designed for a 2-core / 4 GB VPS to start, scales linearly until SQLite or the upstream LLM rate limit decides otherwise.

This is a **fork** of upstream Hermes, not a re-implementation. The agent loop, skill system, memory provider stack, model-provider plugins, and 25+ gateway adapters all come directly from upstream — untouched. What we add is a single new platform adapter (`web_chat`) and the multi-tenant primitives that go with it, packaged so `git pull upstream main` stays merge-conflict-free in perpetuity.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser SPA  ──cookie or Bearer──▶  gateway:8643                │
│                                          │                       │
│                                          ▼                       │
│  per-request:  auth → user_id → enter_user_context(user_id)      │
│                                          │                       │
│         ┌────────────────────────────────┘                       │
│         ▼                                                        │
│  AIAgent (upstream Hermes) inside loop.run_in_executor           │
│         │                                                        │
│         ├─ tools: web_search, memory, todo, skills, web_file_*   │
│         └─ upstream LLM (one shared key, per-user metered)       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Why this fork exists

Upstream Hermes Agent is a brilliant single-user CLI and single-tenant gateway. It does **not** ship a multi-user web product because that was never the upstream's goal. But the agent core — tools, skills, memory, model routing, sandboxed terminal backends — is exactly what you want for a self-hosted "ChatGPT-but-with-real-tools" service for a small team, a family, a community, or a research group. So this fork adds:

- **Per-user accounts** (email + password, Argon2id hashed) and **API keys** (`hermes_sk_...`, sha-256 stored)
- **Per-user conversations** (session DB filtered on `user_id`) and **memory** (`MEMORY.md`, `USER.md`, every memory provider's cache — all isolated)
- **Per-user filesystem workspaces** at `$HERMES_HOME/web_workspaces/<user_id>/`
- **Per-user token quota** (rolling 30-day window, auto-reset, configurable per user)
- A new gateway **HTTP adapter** (`gateway/platforms/web_chat.py`) on port 8643 with cookie + Bearer auth and SSE streaming
- A minimal **React SPA** (`web-chat/`) — 66 KB gzipped JS, no UI framework, no router library, no state-management lib
- **Sandboxed file tools** (`web_file_*`) that mirror upstream `read_file` / `write_file` / `patch` / `search_files` but reject any path that escapes the user's workspace

Everything else stays untouched. If upstream ships a new tool, a new skill, a new memory provider, a new model provider — you get it for free on the next `git pull upstream main`.

---

## Upstream compatibility — the core design decision

This is the single most important thing about the project. We hold to a strict rule:

> **Pay code duplication and verbosity if it means upstream files don't get touched.**

The forks that die are the ones that quietly rewrite half of upstream and then can't merge anything for six months. We refuse to be one of those. Concretely:

| Strategy | Where we use it | Why it works |
|---|---|---|
| **Sub-package isolation** | All multi-tenant code lives under `gateway/web/` (new directory), `gateway/platforms/web_chat.py` (new file), and `web-chat/` (new directory). | These paths don't exist upstream, so `git pull` never touches them. Conflict probability: 0. |
| **Mirror, not refactor** | `WebChatAgentRunner` (`gateway/web/chat_runner.py`) is a ~150-LOC parallel to `gateway/platforms/api_server.py`'s `_create_agent` / `_run_agent`. We don't refactor api_server.py to share code with us. | api_server.py is the most-edited gateway file upstream. Any shared module would be a permanent merge-conflict source. The duplication is paid once. |
| **Wrap, not fork** | `web_file_read` / `web_file_write` / `web_file_patch` / `web_file_search` call the upstream `read_file_tool` / `write_file_tool` / etc. via their public function signatures, prefixed by a `confine_path` check. We don't fork `tools/file_operations.py` (~2k LOC) or `tools/file_tools.py`. | Upstream is free to refactor tool internals. Only the public function names matter to us, and those have been stable for many releases. |
| **Surgical bug-fixes** in upstream files | Four small B-class edits: `run_agent.py:517` and `agent/conversation_compression.py:391` (1 line each — propagate `user_id` to SessionDB writes); `gateway/run.py:12869` (1 line — pass `user_id` through the `/branch` command) and a 10-line `elif Platform.WEB_CHAT` branch in `_create_adapter`; plus `user_id` parameter additions on two `hermes_state.py` query methods. All are pure bug fixes or additive parameters; default behavior unchanged. | These are real multi-tenant bugs — `agent._user_id` was being set in init but then hard-coded to `None` in `_ensure_db_session`. They're slated to be offered back to upstream as a PR. Until then, four conflict points that resolve in seconds. |
| **Opt-in extra** | `argon2-cffi` is in `[web-chat]` extras, not core. Installs without the extra fail loudly at adapter startup with a clear pip hint. | Doesn't bloat the upstream base install for users who never run the web service. |

**Files we deliberately did not touch**, even when it would have been simpler:

```
gateway/platforms/api_server.py    0 lines changed
tools/file_operations.py           0 lines changed
tools/file_tools.py                0 lines changed
tools/terminal_tool.py             0 lines changed
agent/memory_manager.py            0 lines changed
cli.py                             0 lines changed
hermes_cli/main.py                 0 lines changed
```

Memory isolation is achieved without touching `memory_manager.py` by overriding `HERMES_HOME` via a ContextVar — every memory provider already reads `get_hermes_home()`, so the override propagates everywhere automatically.

Maintenance loop: `git fetch upstream && git rebase upstream/main`. Conflicts, when they happen, are confined to the four named patches.

---

## Is this fork for you?

| Use case | Fit |
|---|---|
| **Self-host a chat service for a small team / community / family** with isolated accounts, conversations, and per-user usage tracking | ✅ Core use case — this *is* the project |
| **Replace OpenAI / Claude / etc. as "personal AI for N people" on a $5–$50 VPS** with a cloud LLM key the host pays for | ✅ Designed for this — single shared upstream credential, per-user metered with quota |
| **Run an internal tool inside a company** behind a reverse proxy (auth-gated network + per-user accounts as defense in depth) | ✅ Good fit; combine with TLS + SSO at the proxy layer |
| **Lab / study group / classroom shared agent** with per-user history, memory, and usage caps | ✅ Quota system was sized for exactly this |
| **A SaaS product with paid plans, billing integrations, multi-region** | ⚠️ Not out of scope, but you'll add a lot — Stripe / Postgres / Redis / k8s. The `web_users.db` control plane is a *starting point*, not a finished product |
| **Single-person CLI / local development tool** | ❌ Use upstream Hermes directly. `hermes` and `hermes dashboard` give you that without the multi-tenant overhead |
| **OpenAI-compatible API for external apps** (Open WebUI, LibreChat, OpenAI SDKs) | ❌ Use upstream's `api_server` platform (port 8642) — still works unmodified |
| **Untrusted users running arbitrary terminal commands** | ❌ Wrong tool — see "Security model". The web sandbox defends against accidental path traversal, not kernel exploits |

---

## Hardware sizing

Numbers assume the upstream LLM is **cloud-hosted** (Nous Portal, OpenRouter, OpenAI, Anthropic, etc. — not a local model). The bottleneck shifts depending on box size:

| Tier | RAM | CPU | Concurrent active agents | SPA users online | First bottleneck |
|---|---|---|---|---|---|
| **2c / 4 GB** | 4 GB | 2 vCPU | 10–15 | 80–150 | upstream LLM rate limit |
| **4c / 8 GB** ⭐ | 8 GB | 4 vCPU | 25–40 | 200–300 | upstream LLM + SQLite >5 RPS |
| **8c / 16 GB** | 16 GB | 8 vCPU | 60–100 | 500–1000 | SQLite — migrate to Postgres |
| Larger | — | — | — | — | not a single-box deployment — Postgres + Redis + multi-worker |

Disk: ~2 GB for the venv + code, then per-user data grows with use. 50 GB is comfortable for dozens of active users for a year.

**Active** = "in the middle of an agent loop right now". A user reading the assistant's reply or typing the next message is *online* but not active. Typical chat usage has a 1:5 to 1:10 active-to-online ratio.

Practical observations:

- **The first ceiling you hit on a small VPS is the upstream LLM rate limit**, not your hardware. OpenRouter's typical 60–500 RPM per key is the real cap on concurrent agents, not CPU.
- **Context compression** in the agent loop is a momentary CPU spike that briefly doubles RSS. Multiple users compressing simultaneously can OOM a 4 GB box if you don't cap concurrency. `WEB_CHAT_MAX_CONCURRENT_AGENTS` (default 12) is the safety valve.
- **SQLite is fine until ~5 RPS sustained**. WAL + jitter retry handles bursts. If you need more, the migration to Postgres is mostly schema-equivalent (no application-level joins to rewrite).

---

## Quick start

```bash
# 1. Clone + base install
git clone https://github.com/SeerBench/hermes-multiuser-web-service.git
cd hermes-multiuser-web-service
./setup-hermes.sh                                 # uv venv + .[all,dev]
source .venv/bin/activate
uv pip install -e ".[web-chat]"                   # adds argon2-cffi

# 2. Set the upstream LLM key
echo "OPENROUTER_API_KEY=sk-or-v1-..." >> ~/.hermes/.env
# (or NOUS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY — any provider Hermes supports)

# 3. Enable the platform — add to ~/.hermes/config.yaml:
cat >> ~/.hermes/config.yaml <<'YAML'
platforms:
  web_chat:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8643
      max_concurrent_agents: 12
      cookie_secure: false             # set true in production (HTTPS)
      cookie_ttl_seconds: 604800       # 7 days
YAML

# 4. Build the SPA (one-time, ~50 MB node_modules)
cd web-chat && npm install && npm run build && cd ..

# 5. Run
hermes gateway run
```

Open `http://127.0.0.1:8643/` in a browser, register an account, copy the one-time API key shown at registration, start chatting.

For production deployment: front the gateway with TLS (Caddy / nginx / Traefik), set `cookie_secure: true`, only then change `host: 0.0.0.0` — the adapter **refuses to start** if you skip TLS on a non-loopback bind. Full checklist in [`docs/user-guide/web-chat.md`](docs/user-guide/web-chat.md).

---

## HTTP surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | none | create account + initial API key + cookie |
| `POST` | `/api/auth/login` | none | verify password, set cookie |
| `POST` | `/api/auth/logout` | cookie | expire cookie + delete server-side row |
| `GET`  | `/api/keys` | yes | list user's keys (prefix only, no plaintext) |
| `POST` | `/api/keys` | yes | sign a new key — plaintext returned **once** |
| `DELETE` | `/api/keys/{key_id}` | yes | revoke a key |
| `GET`  | `/api/conversations` | yes | list user's sessions, filtered by `user_id` |
| `GET`  | `/api/usage` | yes | current quota state |
| `POST` | `/api/chat` | yes | **SSE stream** of agent response |
| `GET`  | `/api/healthz` | none | liveness probe |
| `GET`  | `/static/*` | none | SPA assets |
| `GET`  | `/` | none | SPA shell |

### SSE event protocol (`POST /api/chat`)

| event | payload | when |
|---|---|---|
| `token` | `{"text": "..."}` | streaming assistant token |
| `tool_start` | `{"tool": "...", "preview": "..."}` | tool call begins |
| `tool_end` | `{"tool": "...", "duration": 1.2, "error": false}` | tool call returns |
| `reasoning` | `{"text": "..."}` | model reasoning (provider-dependent) |
| `done` | `{"session_id": "...", "usage": {...}, "quota": {...}}` | terminal frame |
| `error` | `{"message": "...", "code": "..."}` | fatal mid-stream error |

`X-Quota-Used` / `X-Quota-Limit` / `X-Quota-Remaining` headers attach to every chat response so the SPA renders the meter without an extra poll. Aborting the SSE connection (`AbortController.abort()`) propagates to the server, which calls `agent.interrupt()` — **partial token usage is still recorded** against the user's quota in a `finally` block.

---

## Security model

**What's isolated by design:**

- **Conversations** — `sessions.user_id` filter on every `list_sessions_rich` / `search_messages` call.
- **Memory** — `enter_user_context` rebinds `HERMES_HOME` via ContextVar; `MemoryManager` and every provider read `get_hermes_home()` and write under `web_workspaces/<user_id>/memories/`. Zero-touch — no agent-internal code modified.
- **Filesystem (tools)** — `web_file_*` route every path through `confine_path` which rejects anything outside the user's workspace. V4A multi-file patches are **refused outright** because their inner file paths can't be inspected without parsing the V4A format.
- **Quota** — separate `web_users.db` row per user, rolling 30-day window, auto-reset on first request past the window (no cron needed).
- **Passwords** — Argon2id (OWASP 2024 parameters: t=2, m=64 MiB, p=2), auto-rehash on parameter changes, constant-ish-time verify (always runs the hasher even on unknown email to avoid timing leak).
- **API keys** — `sha256(plaintext)` stored, never the plaintext; revocation flag checked on every verify.
- **Cookie sessions** — `HttpOnly` + `SameSite=Lax` + optional `Secure`; server-side row in `web_sessions` enables instant revocation (logout invalidates the row, not just the cookie).

**What's NOT isolated** (deliberate scope decisions):

- **OS-level shell.** The default toolset excludes `terminal`, `process`, `code_execution`, `browser_*`, `computer_use`. If you grant `terminal_enabled = 1` for a specific user (admin SQL), that user effectively gets shell access as the gateway process user. For truly untrusted users, run upstream's `TERMINAL_ENV_TYPE=docker` backend (one container per user) — outside the multi-tenant scope this fork ships with.
- **Kernel exploits.** `confine_path` is a Python-layer guard against path traversal, not a defense against a compromised CPython or a kernel CVE.
- **Upstream $-cost overruns.** The token quota counts what the *agent* sees. Real $-cost depends on the upstream provider's model pricing and prompt-cache hit rate — cap usage at the provider's dashboard too.

---

## Testing & quality

This fork ships with **162 automated tests** across 9 files, all passing:

| Layer | File | Cases |
|---|---|---|
| User-id isolation in SessionDB | `tests/hermes_state/test_user_id_filtering.py` | 12 |
| UserStore (accounts / keys / quota) | `tests/gateway/test_web_users.py` | 32 |
| Sandbox + workspace contextvars | `tests/gateway/test_web_sandbox.py` | 14 |
| Quota gate | `tests/gateway/test_web_quota.py` | 9 |
| Auth middleware | `tests/gateway/test_web_auth_middleware.py` | 18 |
| Chat runner (AIAgent factory) | `tests/gateway/test_web_chat_runner.py` | 18 |
| HTTP adapter | `tests/gateway/test_web_chat_adapter.py` | 25 |
| Sandboxed `web_file_*` tools | `tests/gateway/test_web_sandboxed_file_tools.py` | 21 |
| End-to-end integration | `tests/gateway/test_web_chat_platform.py` | 13 |

Plus a standalone smoke test that boots a real `aiohttp` server on an ephemeral port and walks every endpoint (`/api/healthz` → SPA shell → register → list keys → SSE chat with token / tool_start / tool_end / done frames → quota → workspace verification on disk → cross-user → Bearer auth → 429 over-quota → logout). All 11 checks pass against real TCP sockets with real cookie handling.

The most load-bearing test is **`test_concurrent_requests_dont_swap_user_contexts`** — two simultaneous chat requests from Alice and Bob (each with their own Bearer token) must end up with their own `user_id` reaching the runner. This is the test that proves the multi-user contract: ContextVars are asyncio-task-local, not threadlocal, so one user's request can't leak into another's workspace under concurrent load.

Run with the project test wrapper:

```bash
scripts/run_tests.sh tests/gateway/test_web_*.py tests/hermes_state/test_user_id_filtering.py
```

---

## Repository layout

```
.
├── gateway/
│   ├── platforms/web_chat.py        HTTP adapter — auth + routes + SSE
│   └── web/                         ← all multi-tenant code lives here
│       ├── users.py                 UserStore (Argon2id + quota + keys + sessions)
│       ├── auth.py                  cookie + Bearer middleware
│       ├── sandbox.py               enter_user_context / confine_path
│       ├── quota.py                 HTTP-aware quota gate
│       ├── chat_runner.py           AIAgent factory (mirror of api_server)
│       └── tools/
│           ├── __init__.py          (side-effect register on import)
│           └── sandboxed_file_operations.py     web_file_* tools
│
├── web-chat/                        ← React SPA → builds to gateway/web/_static/
│   ├── src/
│   │   ├── App.tsx                  hash router + auth gate + nav
│   │   ├── api.ts                   typed fetch wrappers + SSE async generator
│   │   ├── main.tsx                 React entrypoint
│   │   ├── styles.css               single global stylesheet (dark + light)
│   │   ├── pages/{Auth,Chat,Settings}Page.tsx
│   │   └── components/{QuotaBadge,ConversationList,ToolEvent}.tsx
│   ├── package.json                 react 19 + vite 7 + ts 5
│   ├── vite.config.ts               proxies /api → :8643 in dev
│   └── README.md                    SPA dev notes
│
├── tests/
│   ├── hermes_state/test_user_id_filtering.py
│   └── gateway/test_web_*.py        9 test files, 162 cases
│
├── docs/user-guide/web-chat.md      operator guide
│
└── (everything else from upstream Hermes Agent, untouched)
```

---

## Roadmap

In rough order of useful next steps:

- [ ] **Admin CLI** — replace direct-SQLite admin tasks with `hermes web-chat user list / disable / quota / grant-terminal`
- [ ] **GET /api/conversations/{id}** to load transcript history (SPA can switch sessions but doesn't fetch history yet)
- [ ] **Password reset flow** — currently admin issues reset tokens via SQL
- [ ] **Plugin-hook proposal to upstream** — `register_gateway_platform()` on `PluginManager` so this whole fork can be re-published as a standalone plugin and the four B-class edits dissolve
- [ ] **Optional Postgres backend** for `web_users.db` when single-box SQLite tops out
- [ ] **OAuth / SSO** at the proxy layer for company deployments
- [ ] **OS-level per-user sandbox** wired through upstream's existing Docker terminal backend

The user-id propagation fixes from stage 1 (commit `2ce65f980`) are intended to be offered back to upstream as a PR — they're real bugs in the shared `user_id`-column infrastructure, with no behavioral change for existing single-user callers.

---

## Acknowledgements & license

- **Upstream**: [Nous Research / hermes-agent](https://github.com/NousResearch/hermes-agent) — the entire agent loop, skill system, memory stack, tool registry, 25+ gateway platforms, model-provider plugins, and CLI come from there. The fork is a thin operational layer on top of that work.
- **License**: MIT, matching upstream — see [`LICENSE`](LICENSE).

Further reading:

- [`docs/user-guide/web-chat.md`](docs/user-guide/web-chat.md) — operator-focused guide (setup, HTTP surface, capacity, production checklist, admin tasks via SQL).
- [`web-chat/README.md`](web-chat/README.md) — SPA development notes.
- For upstream agent behavior (skills, memory, tools, model routing), see [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) — everything there applies here too, unmodified.
- [`AGENTS.md`](AGENTS.md) (~1100 lines) is the upstream engineering guide — canonical for anything below the multi-user layer.
- [`CLAUDE.md`](CLAUDE.md) is the orientation file for working in this repo with [Claude Code](https://claude.com/claude-code).
