# Multi-User Web Chat Platform (`web_chat`)

The `web_chat` gateway adapter turns a single Hermes Agent process into
a self-hostable, multi-user chat service.  Each user has their own
account (email + password), their own API keys, their own conversations
and memory, and a 30-day token quota.  All on top of a shared
process — sized for 2c/4G VPSes and up.

This is **distinct from**:

- `hermes dashboard` (port 9119) — single-user local admin UI; not
  multi-tenant.
- `api_server` platform (port 8642) — OpenAI-compatible HTTP surface
  for external clients (Open WebUI, LibreChat, OpenAI SDKs).  Single
  shared `API_SERVER_KEY` across consumers.

`web_chat` (port 8643) is the **public-facing multi-tenant** surface:
browser SPA, per-user cookie sessions, per-user Bearer API keys,
per-user filesystem sandbox.

---

## Quick start

1. **Install the extra**:

   ```bash
   uv pip install -e ".[web-chat]"   # adds argon2-cffi
   ```

2. **Enable the platform** in `~/.hermes/config.yaml`:

   ```yaml
   platforms:
     web_chat:
       enabled: true
       extra:
         host: 127.0.0.1            # bind address
         port: 8643
         max_concurrent_agents: 12  # asyncio.Semaphore size
         cookie_secure: false       # set true in production (HTTPS)
         cookie_ttl_seconds: 604800 # 7 days
   ```

3. **Start the gateway**:

   ```bash
   hermes gateway run
   ```

4. **Build the SPA** (one-time, on first run / after pulling updates):

   ```bash
   cd web-chat
   npm install
   npm run build       # outputs to ../gateway/web/_static/
   ```

5. Open `http://127.0.0.1:8643/` in a browser, register an account,
   and start chatting.

---

## HTTP surface

All endpoints return JSON unless noted.  Auth modes:

- **Cookie** — `hermes_session` cookie, set by `/api/auth/login` or
  `/api/auth/register`.  Used by the SPA.
- **Bearer** — `Authorization: Bearer hermes_sk_…`.  For non-browser
  clients (curl, scripts, OpenAI-compat libraries).  Sign keys at
  `/api/keys`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | none | create account + initial API key + cookie |
| `POST` | `/api/auth/login` | none | verify password, set cookie |
| `POST` | `/api/auth/logout` | cookie | expire cookie + delete server-side row |
| `GET`  | `/api/keys` | yes | list user's keys (prefix only, no plaintext) |
| `POST` | `/api/keys` | yes | sign a new key (plaintext returned **once**) |
| `DELETE` | `/api/keys/{key_id}` | yes | revoke a key |
| `GET`  | `/api/conversations` | yes | list user's session IDs, titled / preview |
| `GET`  | `/api/usage` | yes | current quota state |
| `POST` | `/api/chat` | yes | SSE stream of agent response |
| `GET`  | `/api/healthz` | none | liveness probe |
| `GET`  | `/` | none | SPA shell |
| `GET`  | `/static/*` | none | SPA assets |

### `POST /api/chat` event stream

The response is `text/event-stream`.  Each SSE frame carries an
`event:` name and a JSON `data:` body:

| event | data | when |
|---|---|---|
| `token` | `{"text": "..."}` | streaming assistant tokens |
| `tool_start` | `{"tool": "...", "preview": "..."}` | tool call begins |
| `tool_end` | `{"tool": "...", "duration": 1.2, "error": false}` | tool call returns |
| `reasoning` | `{"text": "..."}` | model reasoning (provider-dependent) |
| `done` | `{"session_id": "...", "usage": {...}, "quota": {...}}` | terminal frame |
| `error` | `{"message": "...", "code": "..."}` | fatal mid-stream error |

Quota headers (`X-Quota-Used` / `X-Quota-Limit` / `X-Quota-Remaining`)
are set on every chat response so the SPA can render the meter
without a separate `/api/usage` poll.

### Request body

```json
{
  "message": "What's the weather in Tokyo?",
  "session_id": "optional — resume an existing conversation",
  "session_key": "optional — long-term memory scope (Honcho etc.)",
  "system_prompt": "optional — ephemeral, not persisted",
  "conversation_history": [{"role": "user", "content": "..."}]
}
```

### Cancellation

Aborting the SSE connection (browser closes tab, `AbortController.abort()`,
client disconnect) causes the server to call `agent.interrupt()` on the
running AIAgent so the executor thread doesn't keep consuming tokens.
Partial usage **is** still recorded against the user's quota — the
server pulls `agent.session_total_tokens` in a `finally` block.

---

## Per-user isolation

| What | How |
|---|---|
| Conversations / sessions | `sessions.user_id` column filtered on every `list_sessions_rich` / `search_messages` query |
| Memory (`MEMORY.md`, `USER.md`, provider caches) | `enter_user_context` overrides `HERMES_HOME` via ContextVar — `MemoryManager` and every memory provider read `get_hermes_home()` and land under `~/.hermes/web_workspaces/<user_id>/` |
| Filesystem (tools) | `web_file_read` / `web_file_write` / `web_file_patch` / `web_file_search` are sandboxed mirrors of upstream tools; every path goes through `confine_path` which rejects anything outside the user's workspace |
| Quota | Rolling 30-day window per user, stored in `web_users.db`; preflight returns `429` when exceeded |
| Authentication | argon2id password hashes; SHA-256 of key plaintext stored, never the plaintext |

⚠️ **Not** isolated by default:

- **`terminal`, `process`, `code_execution`, `browser_*`** tools are
  **not** in the `hermes-web-chat` toolset.  Don't add them back
  without an OS-level sandbox (Docker / firejail / chroot).  The
  Python-layer `confine_path` defends against accidental path
  traversal, **not** kernel exploits.
- The gateway process itself runs as the host user.  If someone gets
  shell via a future bug, they get the host user.  Run the gateway in
  a container or under a dedicated UID for any deployment that takes
  internet traffic.

---

## Sizing

Numbers from the plan's capacity table.  All assume a cloud LLM
upstream — no local model.

| Tier | RAM | CPU | Active agents | SPA users online | Notes |
|---|---|---|---|---|---|
| 2c/4G | 4 GB | 2 vCPU | 10–15 | 80–150 | hobby / private / `< 10` real users |
| 4c/8G | 8 GB | 4 vCPU | 25–40 | 200–300 | recommended starting point |
| 8c/16G | 16 GB | 8 vCPU | 60–100 | 500–1000 | needs monitoring / alerting |
| larger | — | — | — | — | switch to Postgres + Redis + multi-worker |

Real bottlenecks (in order of arrival):

1. **Upstream LLM rate limit** — every user shares one upstream key
   in this design.  OpenRouter / OpenAI typically allow 60–500 RPM
   per key; that's the ceiling on concurrent active agents, not
   your VPS.
2. **Context-compression CPU spikes** — when several users hit
   compression at once, RAM doubles temporarily.  Keep
   `WEB_CHAT_MAX_CONCURRENT_AGENTS` conservative on small boxes.
3. **SQLite write lock** — fine under ~5 RPS; switch to Postgres
   above that.

---

## Production checklist

- [ ] TLS in front (Caddy / nginx reverse proxy on 443)
- [ ] `cookie_secure: true` in `config.yaml`
- [ ] `WEB_CHAT_HOST=0.0.0.0` only after the above are set;
      otherwise the gateway refuses to start
- [ ] Real upstream LLM key in `~/.hermes/.env`, key has a usage cap
- [ ] Per-user `quota_tokens` set via admin CLI (default 1M / month)
- [ ] Backup of `~/.hermes/state.db` + `~/.hermes/web_users.db` +
      `~/.hermes/web_workspaces/`
- [ ] Monitoring: `/api/healthz` probe, process RSS, SQLite size,
      upstream LLM 429 rate

---

## Admin tasks

There is no dedicated admin CLI yet — for the first version, manage
users via direct SQLite access on `~/.hermes/web_users.db`.

```bash
sqlite3 ~/.hermes/web_users.db

# Disable a user
UPDATE users SET disabled = 1 WHERE email = 'someone@example.com';

# Raise quota
UPDATE users SET quota_tokens = 10000000 WHERE email = '...';

# Grant terminal tool (after reading the security caveat above!)
UPDATE users SET terminal_enabled = 1 WHERE email = '...';

# Reset quota window now
UPDATE users SET quota_used = 0, quota_period_start = strftime('%s', 'now')
  WHERE email = '...';
```

A real admin CLI (`hermes web-chat user list` etc.) is on the
roadmap but not in this release.

---

## Differences from upstream Hermes

`web_chat` is a fork-only platform.  It adds:

- `gateway/platforms/web_chat.py` — HTTP adapter (mirror of
  `api_server.py` but independent — no shared module to avoid
  perpetual upstream merge conflicts)
- `gateway/web/` — `users.py`, `auth.py`, `sandbox.py`, `quota.py`,
  `chat_runner.py`, and `tools/sandboxed_file_operations.py`
- `web-chat/` — React SPA
- `[web-chat]` pyproject extra (argon2-cffi)
- One new toolset (`hermes-web-chat`) + one new Platform enum value
  (`Platform.WEB_CHAT`)
- **Four** small B-class edits to upstream files: the `user_id`
  propagation fix (`run_agent.py`, `agent/conversation_compression.py`,
  `gateway/run.py`) and `hermes_state.py` query-filter parameters.
  These are real bug fixes upstream is welcome to take.

Everything else — `tools/file_operations.py`, `tools/file_tools.py`,
`gateway/platforms/api_server.py`, every other upstream file —
remains untouched.  See the project's plan file for the upstream-sync
strategy.
