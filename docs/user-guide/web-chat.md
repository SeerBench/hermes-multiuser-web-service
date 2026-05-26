# Multi-User Web Chat Platform (`web_chat`)

The `web_chat` gateway adapter turns a single Hermes Agent process into
a self-hostable, multi-user chat service that delegates **authentication
and billing** to an upstream
[new-api](https://github.com/QuantumNous/new-api)-style OpenAI-compatible
gateway.  Administrators issue per-user API keys from the new-api admin
panel and hand them to users over a side channel (email, Slack, etc.);
users paste their key once into the SPA's login modal and get an
encrypted-at-rest cookie session.  Each user has their own
conversations, memory, and per-user filesystem sandbox.

This is **distinct from**:

- `hermes dashboard` (port 9119) — single-user local admin UI; not
  multi-tenant.
- `api_server` platform (port 8642) — OpenAI-compatible HTTP surface
  for external clients (Open WebUI, LibreChat, OpenAI SDKs).  Single
  shared `API_SERVER_KEY` across consumers.

`web_chat` (port 8643) is the **public-facing multi-tenant** browser
surface: per-user cookie sessions on top of per-user new-api keys, with
per-user filesystem sandbox and conversation isolation.  Token
accounting lives entirely upstream — this gateway never tracks usage.

---

## Architecture in one sentence

> Browser → cookie (`hermes_session`) → web_chat → user's new-api key
> (decrypted from the session row) → new-api → real LLM, with new-api
> recording usage against the key owner's account.

The user_id that anchors workspaces and conversation history is
**derived** from `sha256(api_key)` — so the same key in any browser
on any machine lands the user in the same conversation history.

---

## Quick start

1. **Install the extra**:

   ```bash
   uv pip install -e ".[web-chat]"   # adds cryptography (for KeyVault)
   ```

2. **Configure the upstream new-api URL** in `~/.hermes/.env`:

   ```bash
   NEW_API_BASE_URL=https://your-new-api.example.com
   ```

   Without this set, `web_chat` refuses to start — there's nowhere to
   route LLM calls.

3. **Enable the platform** in `~/.hermes/config.yaml`:

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

4. **Start the gateway**:

   ```bash
   hermes gateway run
   ```

5. **Build the SPA** (one-time, on first run / after pulling updates):

   ```bash
   cd web-chat
   npm install
   npm run build       # outputs to ../gateway/web/_static/
   ```

6. **Issue users keys from new-api**: in the new-api admin panel,
   create user accounts and API keys, then share each key with the
   end-user out-of-band.

7. **End user flow**: open `http://127.0.0.1:8643/`, type a message,
   paste the key when prompted, send.  Subsequent visits reuse the
   cookie until it expires (7 days by default).

---

## HTTP surface

All endpoints return JSON unless noted.  The single auth mode is the
`hermes_session` cookie, issued by `/api/auth/login`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | validate new-api key + set cookie |
| `POST` | `/api/auth/logout` | cookie | expire cookie + delete server-side row |
| `GET`  | `/api/me` | yes | return current `user_id` + timestamps |
| `GET`  | `/api/conversations` | yes | list user's session IDs, titled / preview |
| `POST` | `/api/chat` | yes | SSE stream of agent response |
| `GET`  | `/api/healthz` | none | liveness probe |
| `GET`  | `/` | none | SPA shell |
| `GET`  | `/static/*`, `/assets/*` | none | SPA assets |

There is **no** `/api/auth/register` (accounts live in new-api), no
`/api/keys/*` (keys are minted by new-api), and no `/api/usage`
(billing is the upstream's responsibility).

### `POST /api/auth/login`

```json
{ "api_key": "sk-…" }
```

The server probes `{NEW_API_BASE_URL}/v1/models` with this key as a
Bearer token (10-second timeout).  Response classification:

| Outcome | Server response | SPA behavior |
|---|---|---|
| Upstream returns 2xx | 200 + cookie | log in successful |
| Upstream returns 401 / 403 | 401 `code=invalid_key` | "API key was rejected" |
| Upstream returns other 4xx | 502 `code=misconfigured` | "Admin: check NEW_API_BASE_URL" |
| Upstream returns 5xx / 429, network error, timeout | 503 `code=upstream_unreachable` | "Try again in a moment" |

On success the server derives `user_id = "u_" + sha256(api_key)[:12]`,
upserts a row in `web_users.db`, encrypts the key with the gateway's
master key, and signs the cookie.

### `POST /api/chat` event stream

The response is `text/event-stream`.  Each SSE frame carries an
`event:` name and a JSON `data:` body:

| event | data | when |
|---|---|---|
| `token` | `{"text": "..."}` | streaming assistant tokens |
| `tool_start` | `{"tool": "...", "preview": "..."}` | tool call begins |
| `tool_end` | `{"tool": "...", "duration": 1.2, "error": false}` | tool call returns |
| `reasoning` | `{"text": "..."}` | model reasoning (provider-dependent) |
| `done` | `{"session_id": "...", "usage": {...}}` | terminal frame |
| `error` | `{"message": "...", "code": "..."}` | fatal mid-stream error |

On 401 (cookie missing/expired or master key rotated) the SPA opens
the key-prompt modal again; the original message is resent
automatically after the user re-authenticates.

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
Whatever tokens **did** get consumed are still billed by new-api on the
upstream side.

---

## Multi-browser behavior

Because `user_id = sha256(api_key)[:12]` is deterministic, the same key
in any browser maps to the same `user_id` → same workspace → same
conversation history.

| Scenario | Behavior |
|---|---|
| B browser logs in after A has chatted | B's conversation list shows A's sessions |
| B reopens a session A created | Full history visible |
| A creates a new session while B has the list open | B sees it after refresh (no live push) |
| A and B open the same session at the same time and A sends a message | A sees streamed tokens; B sees the new turn after refresh |
| A and B send to the same session concurrently | SQLite write lock serialises; UI does not auto-sync |

Real-time cross-browser push (SSE event-bus) is not implemented.

---

## Per-user isolation

| What | How |
|---|---|
| Conversations / sessions | `sessions.user_id` column filtered on every `list_sessions_rich` / `search_messages` query |
| Memory (`MEMORY.md`, `USER.md`, provider caches) | `enter_user_context` overrides `HERMES_HOME` via ContextVar — `MemoryManager` and every memory provider read `get_hermes_home()` and land under `~/.hermes/web_workspaces/<user_id>/` |
| Filesystem (tools) | `web_file_read` / `web_file_write` / `web_file_patch` / `web_file_search` are sandboxed mirrors of upstream tools; every path goes through `confine_path` which rejects anything outside the user's workspace |
| Upstream key | Encrypted with Fernet under `~/.hermes/web_users_master.key` (chmod 600).  Decrypted in memory per request, never logged.  Bound to the request via the `_UPSTREAM_API_KEY` ContextVar so the AIAgent's worker thread uses the right key when calling the upstream gateway. |
| Billing | Entirely upstream — new-api records per-key usage; this gateway never tracks tokens |

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

Numbers from the plan's capacity table.

| Tier | RAM | CPU | Active agents | SPA users online | Notes |
|---|---|---|---|---|---|
| 2c/4G | 4 GB | 2 vCPU | 10–15 | 80–150 | hobby / private / `< 10` real users |
| 4c/8G | 8 GB | 4 vCPU | 25–40 | 200–300 | recommended starting point |
| 8c/16G | 16 GB | 8 vCPU | 60–100 | 500–1000 | needs monitoring / alerting |
| larger | — | — | — | — | switch to Postgres + Redis + multi-worker |

Real bottlenecks (in order of arrival):

1. **Upstream new-api rate limit** — each user's key has its own
   limit, so concurrent users no longer share one global key.  But
   new-api itself has connection limits; check the upstream's docs.
2. **Context-compression CPU spikes** — when several users hit
   compression at once, RAM doubles temporarily.  Keep
   `WEB_CHAT_MAX_CONCURRENT_AGENTS` conservative on small boxes.
3. **SQLite write lock** — fine under ~5 RPS; switch to Postgres
   above that.

---

## Production checklist

- [ ] `NEW_API_BASE_URL` set in `~/.hermes/.env`, pointing at the
      operator's new-api instance
- [ ] new-api itself is reachable from this host (probe with
      `curl ${NEW_API_BASE_URL}/v1/models` — should return 401 unauthed)
- [ ] TLS in front (Caddy / nginx reverse proxy on 443)
- [ ] `cookie_secure: true` in `config.yaml`
- [ ] `WEB_CHAT_HOST=0.0.0.0` only after the above are set;
      otherwise the gateway refuses to start
- [ ] `~/.hermes/web_users_master.key` permissions verified at 0600
      (auto-generated on first start)
- [ ] Backup of `~/.hermes/state.db`, `~/.hermes/web_users.db`,
      `~/.hermes/web_users_master.key`, and `~/.hermes/web_workspaces/`
      (the master key and DB must be backed up together — neither is
      useful without the other)
- [ ] Monitoring: `/api/healthz` probe, process RSS, SQLite size,
      upstream new-api error rate

---

## Admin tasks

There is no dedicated admin CLI yet — for the first version, manage
users via direct SQLite access on `~/.hermes/web_users.db`.

```bash
sqlite3 ~/.hermes/web_users.db

# List recently active users
SELECT user_id, datetime(last_seen_at, 'unixepoch') FROM users
  ORDER BY last_seen_at DESC LIMIT 20;

# Disable a user (locks them out even if they re-paste a valid key —
# their derived user_id is the disable target)
UPDATE users SET disabled = 1 WHERE user_id = 'u_abc123def456';

# Purge expired session rows
DELETE FROM web_sessions WHERE expires_at < strftime('%s', 'now');
```

To **revoke** a user, do it in **new-api** (the upstream gateway).
Revoking the key there means even cached web_chat cookies become
useless — every subsequent LLM call will be rejected by new-api.

### Rotating the master key

If `~/.hermes/web_users_master.key` is compromised, the operator can
delete it and restart.  A fresh key is generated on next start;
**every existing cookie session is invalidated** (their encrypted
key payloads can no longer be decrypted) and users will be prompted
for their new-api key again on the next chat attempt.  No data loss —
conversation history is keyed by `user_id`, which is still derivable
from the same key.

---

## Differences from upstream Hermes

`web_chat` is a fork-only platform.  It adds:

- `gateway/platforms/web_chat.py` — HTTP adapter (mirror of
  `api_server.py` but independent — no shared module to avoid
  perpetual upstream merge conflicts)
- `gateway/web/` — `users.py`, `auth.py`, `sandbox.py`,
  `chat_runner.py`, `upstream_key.py`, `upstream_validator.py`,
  `key_storage.py`, and `tools/sandboxed_file_operations.py`
- `web-chat/` — React SPA
- `[web-chat]` pyproject extra (`cryptography==46.0.7`)
- `NEW_API_BASE_URL` registered in `hermes_cli/config.py::OPTIONAL_ENV_VARS`
- One new toolset (`hermes-web-chat`) + one new Platform enum value
  (`Platform.WEB_CHAT`)
- A small B-class edit to `gateway/run.py`'s `_resolve_runtime_agent_kwargs`
  to honor `NEW_API_BASE_URL`, plus the existing `user_id` propagation
  fix (`run_agent.py`, `agent/conversation_compression.py`,
  `gateway/run.py`) and `hermes_state.py` query-filter parameters.
  These are real bug fixes upstream is welcome to take.

Everything else — `tools/file_operations.py`, `tools/file_tools.py`,
`gateway/platforms/api_server.py`, every other upstream file —
remains untouched.  See the project's plan file for the upstream-sync
strategy.
