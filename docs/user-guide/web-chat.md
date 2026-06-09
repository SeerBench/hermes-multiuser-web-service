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

   For subsequent updates on a deployed box, `./update-web.sh` automates
   pull → rebuild → restart — see [Updating a deployment](#updating-a-deployment).

6. **Issue users keys from new-api**: in the new-api admin panel,
   create user accounts and API keys, then share each key with the
   end-user out-of-band.

7. **End user flow**: open `http://127.0.0.1:8643/`, type a message,
   paste the key when prompted, send.  Subsequent visits reuse the
   cookie until it expires (7 days by default).

---

## Web research out of the box (no API keys)

Every web user shares one tool surface, and the two web-research tools in
the `hermes-web-chat` toolset work with **zero extra configuration** —
no Firecrawl / Tavily / Exa / Parallel account required:

| Tool | Default backend | Notes |
|---|---|---|
| `web_search` | `ddgs` (DuckDuckGo) | Shipped in the `[web-chat]` extra so search works on a fresh install. |
| `web_extract` | `http-fetch` (fork-bundled) | Plain `httpx` GET + stdlib HTML→text. Auto-selected when no paid extract backend is configured — see `plugins/web/http_fetch/`. |

`http-fetch` is **extract-only** and deliberately lightweight: no
JavaScript rendering, no readability heuristics. It's the "fetch this
article / docs page / RSS item" fallback, not a scraper. The downstream
LLM summarizer compresses whatever it returns. Server-Side Request
Forgery is blocked by `web_extract_tool`'s `is_safe_url` gate *before*
the provider sees a URL — private / link-local / metadata-endpoint
targets never get fetched.

**To upgrade quality**, point `web.extract_backend` at a paid provider in
`~/.hermes/config.yaml` and set its key in `~/.hermes/.env`:

```yaml
web:
  extract_backend: firecrawl   # or tavily / exa / parallel
```

Any explicitly-configured extract backend, and any paid backend whose key
is present, takes precedence — the `http-fetch` auto-route only fires as
the last resort when extract would otherwise fail with a "search-only
backend" error.

---

## HTTP surface

All endpoints return JSON unless noted.  The single auth mode is the
`hermes_session` cookie, issued by `/api/auth/login`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | validate new-api key + set cookie |
| `POST` | `/api/auth/logout` | cookie | expire cookie + delete server-side row |
| `GET`  | `/api/me` | yes | return current `user_id` + timestamps |
| `GET`  | `/api/conversations` | yes | list user's sessions (`?archived=1` for the archived bucket) |
| `GET`  | `/api/conversations/{id}` | yes | full transcript for one session |
| `PATCH`  | `/api/conversations/{id}` | yes | rename (`{"title": "..."}`) |
| `DELETE` | `/api/conversations/{id}` | yes | delete the session + its flags |
| `POST` | `/api/conversations/{id}/flags` | yes | pin / archive (`{"pinned": bool, "archived": bool}`) |
| `POST` | `/api/uploads` | yes | multipart file upload into the user's sandbox `uploads/` |
| `POST` | `/api/chat` | yes | SSE stream of agent response |
| `GET`  | `/api/healthz` | none | liveness probe |
| `GET`  | `/` | none | SPA shell |
| `GET`  | `/static/*`, `/assets/*` | none | SPA assets |

The four `/api/conversations/{id}` mutations enforce ownership: a session
owned by another user is reported as `404` so the surface never leaks the
existence of someone else's session id.  Pin / archive state lives in a
fork-owned `conversation_flags` table in `web_users.db` — the shared
`sessions` table is never modified.

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
| `status` | `{"kind": "lifecycle"\|"warn", "message": "..."}` | agent lifecycle/warning (compression, rate-limit retries, fallback switches) |
| `step` | `{"step": 3, "tools": ["web_search"]}` | a new agent loop iteration began |
| `activity` | `{"kind": "thinking", "text": "..."}` | pre-tool "what it's about to do" hint |
| `done` | `{"session_id": "...", "usage": {...}}` | terminal frame |
| `error` | `{"message": "...", "code": "..."}` | fatal mid-stream error |

The `status` / `step` / `activity` frames are what the SPA renders as the
collapsible **execution timeline** under each assistant turn — they expose
what the agent is doing between tokens (compressing context, switching
providers, looping through tool calls) instead of leaving the user staring
at a spinner.

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

### Attachments

The composer's 📎 button uploads files via `POST /api/uploads`. Each file
is streamed into the user's sandbox at `<workspace>/uploads/<name>`
(filename sanitized, de-duped, size-capped) — `confine_path` guarantees it
can't escape the per-user workspace. The endpoint returns workspace-relative
paths (`uploads/<name>`); the SPA appends a reference block to the chat
message so the agent reads them on demand with `web_file_read` /
`web_file_search`. Nothing is sent inline to the model up front, and the
absolute host path is never exposed. Uploads are plain files in the
workspace — no separate retention or cleanup beyond `web_workspaces/`.

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

## Per-user skill management

Web users get a sandboxed skill toolset that mirrors upstream's skill
surface but with per-tenant isolation.  Four tools, all confined to the
user's workspace by `confine_path`:

| Tool | Purpose |
|---|---|
| `web_skills_list` | Merged listing of global (operator-curated) + per-user skills.  On name collision the user version overlays the global one.  Filterable by `category` and `source` (`"all"` / `"global"` / `"user"`). |
| `web_skill_view` | Read a skill's `SKILL.md`, or a relative file under it (`file_path="references/api.md"`).  User layer wins over global on name collision. |
| `web_skill_install` | Write a new skill into `<workspace>/skills/<category>/<name>/`.  Validates SKILL.md frontmatter (`name` matches install arg, `description` ≤1024 chars, `version` present), enforces a per-file 64 KB and per-skill 256 KB cap, and accepts optional `files={...}` for `references/` and `scripts/`. |
| `web_skill_delete` | Remove a personal skill.  Global operator-curated skills cannot be deleted by users — the call returns an error. |

Upstream's `skill_manage` is **not** exposed on the web platform because
`tools/skills_tool.py` caches `SKILLS_DIR` at module-import time and would
bleed writes across tenants.  See
`docs/plans/2026-05-26-per-user-skill-isolation.md` for the full design
rationale.

### What user-installed skills are (and aren't)

- **Discoverable on demand** — the agent calls `web_skills_list` to see
  what's available and `web_skill_view` to load full content.
- **NOT auto-injected into the system prompt.**  Upstream's prompt
  banner is rendered once per session by code (`agent/prompt_builder.py`)
  that doesn't observe per-request ContextVars, so per-user skills
  cannot be added to it without breaking the fork's zero-upstream-touch
  rule.  Treat user skills as Anthropic-style progressive disclosure:
  the agent pulls them when relevant.
- **Scripts are reference-only.**  The `hermes-web-chat` toolset
  excludes `terminal`, `process`, `code_execution`, and `browser_*`,
  so any `scripts/*.py` in a user skill is read for guidance, never
  executed by the agent.

### Operator-curated global library

Anything you (the operator) place under `$HERMES_HOME/skills/<category>/<name>/`
is read-only-visible to every web user.  Useful for shipping shared
references (e.g. the bundled `brave-search` skill).  Categories are
restricted to a fixed allowlist matching upstream's de-facto top-level
directories — adding a new category requires editing
`_ALLOWED_CATEGORIES` in `gateway/web/tools/sandboxed_skill_manage.py`.

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

## Updating a deployment

Shipping new code to a running box is **not** just `git pull` + restart.
Two things bite every time:

1. **The SPA bundle is `.gitignore`'d.** `gateway/web/_static/` is built,
   never committed, so a plain `git pull` leaves the browser serving the
   *old* UI even though the backend updated — the classic "I pulled but
   nothing changed" trap. You must rebuild it (`cd web-chat && npm run
   build`). Note `startweb.sh` only auto-builds when the bundle is
   **missing**; it will not rebuild a stale one.
2. **Schema changes are automatic, but deps are not.** New tables
   (e.g. `conversation_flags`) are created on startup via
   `CREATE TABLE IF NOT EXISTS` — no migration step. But if
   `pyproject.toml` / `uv.lock` changed you must reinstall Python deps,
   and if `web-chat/package*.json` changed you must reinstall npm deps
   before building.

### One command: `update-web.sh`

`update-web.sh` (repo root) automates the whole flow on a native (venv)
box: activate venv → `git pull --ff-only` from the fork remote → rebuild
the SPA → restart the gateway → health-check `/api/healthz`. It is
idempotent and handles the traps above (always rebuilds the bundle; only
runs `npm ci` when the SPA manifests changed; restores the repo-root
`package.json` if npm's postinstall dirties it; stops the port's old
process before relaunch and skips a duplicate launch if a supervisor
already respawned it).

```bash
# On the server, in the repo checkout, after pushing to the fork:
./update-web.sh                      # pull → rebuild → relaunch → verify
```

Restart strategy (pick the one matching how the box runs the gateway):

| You run the gateway via… | Use |
|---|---|
| foreground / tmux / `nohup` (default) | `./update-web.sh` (stops the old process, relaunches `hermes gateway run` in the background, logs to `~/.hermes/web-gateway.log`) |
| **systemd** | `./update-web.sh --systemd <unit-name>` (restarts via `systemctl`, no second process) |
| a custom supervisor | `./update-web.sh --restart-cmd '<your restart command>'` |
| you'll restart it yourself | `./update-web.sh --no-restart` (pull + build only) |

Other useful flags: `--test` (run the fork web test suite and abort on
failure before restarting), `--stash` (auto-stash a dirty tree for the
pull), `--no-pull` (rebuild + restart the current checkout),
`--remote` / `--branch`, `--host` / `--port` (override the health-check
target). `./update-web.sh --help` lists them all.

> The default background relaunch suits foreground/tmux/nohup setups. If
> the box is **systemd**-managed, always pass `--systemd <unit>` — the
> script has respawn detection as a safety net, but the explicit path is
> cleanest and avoids a kill-then-double-launch race.

### Manual equivalent

If you'd rather not use the script:

```bash
git pull --ff-only                       # pull the new code
cd web-chat && npm run build && cd ..    # REQUIRED: rebuild the SPA bundle
#   (run `npm ci` first only if web-chat/package*.json changed)
#   (if `pyproject.toml`/`uv.lock` changed: uv pip install -e ".[web-chat]")
# then restart the gateway however you run it (systemctl restart … / re-run startweb.sh)
```

### After updating

- Verify: `git log --oneline -1`, a fresh `gateway/web/_static/index.html`
  mtime, and `curl -s http://<host>:<port>/api/healthz`.
- Tell testers to **hard-refresh** (Ctrl-Shift-R) — vite emits
  hash-named assets and `index.html` is served `no-cache`, so a normal
  reload picks up the new bundle, but a hard refresh avoids any
  cached-JS confusion.
- Rollback: `git reset --hard <previous-commit>` then rebuild the SPA and
  restart. `web_users.db` / `state.db` are forward-compatible — the new
  `conversation_flags` table is simply ignored by older code.

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
- `plugins/web/http_fetch/` — bundled zero-key `web_extract` provider
  (auto-loaded as a `kind: backend` plugin) so web research works on a
  fresh install; opt up to a paid backend via `web.extract_backend`
- `[web-chat]` pyproject extra (`cryptography==46.0.7`, `ddgs==9.14.4`)
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
