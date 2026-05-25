<p align="center">
  <img src="assets/banner.png" alt="Hermes Multi-User Web Service" width="100%">
</p>

# Hermes Multi-User Web Service

<p align="center">
  <a href="https://github.com/SeerBench/hermes-multiuser-web-service/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/Upstream-Hermes%20Agent-blueviolet?style=for-the-badge" alt="Upstream: Hermes Agent"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/Lang-中文-red?style=for-the-badge" alt="中文"></a>
</p>

A fork of [Nous Research's Hermes Agent](https://github.com/NousResearch/hermes-agent) that adds a **multi-user, self-hostable web chat service** on top of the agent core. Single backend process, per-user accounts, per-user filesystem sandbox, per-user 30-day token quota, browser SPA over SSE. Everything else — the agent loop, skills, memory, tools, model providers, gateway adapters — comes straight from upstream.

> Upstream Hermes is a single-user CLI/messaging agent. This fork keeps that intact and adds a parallel `web_chat` gateway platform alongside the existing Telegram / Discord / Slack / api_server adapters.

---

## What this fork adds

All new code lives under `gateway/web/` and `gateway/platforms/web_chat.py`. Nothing outside that surface is modified.

| Component | File | Purpose |
|---|---|---|
| User accounts | `gateway/web/users.py` | SQLite `web_users.db` — Argon2id passwords, API keys (`hermes_sk_…`), browser sessions (`hermes_ws_…`), rolling token quota |
| Auth middleware | `gateway/web/auth.py` | Cookie + Bearer; binds `user_id` to the request |
| Per-user sandbox | `gateway/web/sandbox.py` | ContextVar-scoped workspace + `HERMES_HOME` override per request |
| Quota gate | `gateway/web/quota.py` | Preflight 429, post-flight token recording, `X-Quota-*` headers |
| Agent runner | `gateway/web/chat_runner.py` | Spawns `AIAgent` inside an executor; mirrors `api_server.py` without touching it |
| Sandboxed file tools | `gateway/web/tools/sandboxed_file_operations.py` | `web_file_read/write/patch/search` — wrap upstream file tools with `confine_path()` |
| HTTP/SSE adapter | `gateway/platforms/web_chat.py` | `/api/auth/*`, `/api/keys`, `/api/conversations`, `/api/usage`, `/api/chat` (SSE) |

`state.db` is shared across users but isolated by a `user_id` column added at the session-write layer. Memory (`MEMORY.md`, `USER.md`, Honcho cache) is fully isolated because every memory provider reads `get_hermes_home()`, and the sandbox rebinds `HERMES_HOME` per request.

---

## Compatibility with upstream Hermes

Hermes Agent is a fast-moving project. This fork is designed to **rebase cleanly on every upstream release**, indefinitely. The strategy:

- **Sub-package isolation.** All multi-user code lives under `gateway/web/`. Importing the package does not touch the rest of Hermes; nothing outside is rewired.
- **Mirror, don't modify.** `chat_runner.py` is a parallel implementation of `api_server.py`'s agent factory, not a refactor of it. ~150 LOC of duplication in exchange for zero merge conflicts against the most-edited file in upstream.
- **Wrap, don't fork.** Sandboxed file tools import and call `tools/file_tools.py` functions as-is and only add a `confine_path()` guard. Upstream changes to file tools land for free.
- **Toolset, not core, registration.** New tools (`web_file_*`) are added to a dedicated `hermes-web-chat` toolset in `toolsets.py` — the only edit outside the sub-package.
- **Optional dependency, opt-in extra.** `argon2-cffi` is behind the `[web-chat]` extra; nothing forces this dep on users who never run the web service.
- **No edits to load-bearing files.** `run_agent.py`, `cli.py`, `gateway/run.py`, `hermes_cli/main.py` are untouched. The `CLAUDE.md` ground rule that plugins must not modify core is honored here even though this is a fork, not a plugin.

The only changes outside `gateway/web/` are: (1) one toolset entry in `toolsets.py`, (2) a `user_id` column threaded through `SessionDB` writes (commit `2ce65f980`), (3) `web_chat` registered in the gateway platform enum. Each is a small, well-contained patch designed to be re-applied by hand or via `git rerere` if upstream rewrites the file.

In practice, `git fetch upstream && git rebase upstream/main` is the maintenance loop.

---

## When to use this fork

| Scenario | Fit |
|---|---|
| Self-host Hermes for your family / a small team and want a browser UI with login | Yes — primary use case |
| Run a private agent service for a class, lab, or study group with usage caps | Yes — per-user quota + sandbox |
| Build a SaaS-shaped demo on top of Hermes | Yes — multi-user surface is there |
| Single-user personal CLI / Telegram bot | No — upstream Hermes is better; this fork adds operational weight you don't need |
| OpenAI-compatible API for external clients | No — keep using upstream's `api_server` adapter; this fork's `/api/chat` is SSE-only and tuned for the SPA |
| Production multi-tenant SaaS with billing, SSO, RBAC | Not yet — quota is rolling-30d tokens only, no billing, no team/org model |

---

## Hardware requirements (single-machine self-deploy, cloud LLM)

These figures assume LLM inference runs on a cloud provider (Nous Portal, OpenRouter, OpenAI, Anthropic, etc.) — the box hosts only the gateway process and per-user workspaces.

|  | CPU | RAM | Disk |
|---|---|---|---|
| **Minimum** | 2 vCPU | 4 GB | 10 GB |
| **Recommended** | 4 vCPU | 8 GB | 50 GB |

Notes:

- **CPU.** The gateway is I/O-bound for chat (the LLM does the work). CPU is spent on SSE streaming, Argon2id password verification (~50 ms each), and any locally-executed tools the user invokes (search, file ops, code execution).
- **RAM.** ~300–500 MB resident for the Python process at idle; each concurrent agent run adds ~50–150 MB depending on context size and model. 8 GB comfortably handles 10–20 concurrent sessions.
- **Disk.** Code + venv ≈ 2 GB. Per-user data — `web_workspaces/<user_id>/`, session DB rows, memory files — grows with use. 50 GB sustains dozens of active users for a year of real use.
- **Network.** Bandwidth is dominated by streamed tokens (typically 50–200 KB per turn). 100 Mbit/s is enough for 50+ concurrent streams.
- **Local LLMs.** Out of scope for this README. If you self-host the model, GPU sizing follows the model card — the gateway box itself can stay on the figures above as long as it talks to the inference server over the network.

---

## Quickstart

```bash
git clone https://github.com/SeerBench/hermes-multiuser-web-service.git
cd hermes-multiuser-web-service
./setup-hermes.sh                              # uv venv, installs .[all,dev]
source .venv/bin/activate
uv pip install -e ".[web-chat]"                # adds argon2-cffi
```

Configure the gateway to enable the `web_chat` platform (see `gateway/config.py`), put your LLM credentials in `~/.hermes/.env`, then:

```bash
hermes gateway start
```

The web service listens on the port configured in the platform block. Point a browser at it, register the first account, copy the API key shown once at creation. Subsequent users register through the same endpoint or are provisioned out-of-band via `UserStore`.

---

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create user + initial API key + session cookie |
| `POST` | `/api/auth/login` | Verify password, set cookie |
| `POST` | `/api/auth/logout` | Expire cookie |
| `GET`  | `/api/keys` | List user's API keys (no plaintext) |
| `POST` | `/api/keys` | Sign new key — plaintext returned **once** |
| `DELETE` | `/api/keys/{key_id}` | Revoke key |
| `GET`  | `/api/conversations` | List user's sessions |
| `GET`  | `/api/usage` | Current quota state |
| `POST` | `/api/chat` | SSE stream of agent response |
| `GET`  | `/api/healthz` | Public health probe |

SSE events: `token`, `tool_start`, `tool_end`, `reasoning`, `done`, `error`. Each `done` frame carries `session_id`, `usage`, and rolled-up `quota` state — no separate poll required.

---

## Security model

- **Passwords.** Argon2id via `argon2-cffi`. No plaintext stored, no recoverable hash.
- **API keys / web sessions.** Returned once at creation; stored as `sha256(plaintext)`. Compromised keys cannot be reconstructed from the DB.
- **Filesystem sandbox.** Every path argument to `web_file_*` tools is resolved and rejected if it escapes `$HERMES_HOME/web_workspaces/<user_id>/`. The sandbox raises if invoked outside a user context — there is no "no sandbox" fallback.
- **Toolset whitelist.** The `hermes-web-chat` toolset deliberately excludes `terminal`, `code_execution`, and `browser` by default. Re-enable per-deployment only with a clear threat model.
- **LLM credentials.** Read once from `config.yaml` / `~/.hermes/.env` and shared across users. Per-user cost attribution is via the quota counter, not separate provider keys.

The gateway is intended to sit behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik). It speaks plain HTTP on the listener port.

---

## Project status

Early. The control plane (accounts, keys, quota, sandbox) is in place and covered by tests under `tests/gateway/`. The React SPA shell is a placeholder — the SSE protocol is stable but the frontend is minimal. Backup and admin tooling are scripts-and-SQL today; a proper admin CLI is not in scope yet.

Track upstream changes via `git log upstream/main` against the paths this fork touches — `gateway/run.py`, `gateway/platforms/api_server.py`, `tools/file_tools.py`, `toolsets.py`. If any of those see a significant rewrite, the mirror files here may need an equivalent edit.

---

## Credits

Upstream agent and the vast majority of code: [Nous Research / Hermes Agent](https://github.com/NousResearch/hermes-agent), MIT-licensed. This fork adds the multi-user web service layer and inherits the same MIT license.

See `AGENTS.md` (~1100 lines) for the upstream engineering guide, `CONTRIBUTING.md` (~1300 lines) for upstream contribution rules, and `CLAUDE.md` for orientation when working in this repo with Claude Code.

---

## License

MIT — see [LICENSE](LICENSE).
