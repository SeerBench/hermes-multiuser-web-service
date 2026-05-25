# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AGENTS.md is the canonical engineering guide

**Read `AGENTS.md` before any non-trivial change.** It is ~1100 lines, deeply
maintained, and covers project structure, the AIAgent loop, slash-command
registry, TUI architecture, plugin system, skills authoring standards,
profiles, dependency pinning policy, testing, and known pitfalls. This file
(`CLAUDE.md`) is a thin orientation layer — `AGENTS.md` is the source of
truth and supersedes it where the two ever disagree.

`CONTRIBUTING.md` (~1300 lines) is the contributor-onboarding companion —
useful for the "should this be a skill or a tool" decision tree, skill PR
salvage checklist, cross-platform rules, and the security-considerations
section.

## What this repo is

Hermes Agent — a self-improving AI agent CLI + messaging gateway by Nous
Research. Single repo, multiple sub-projects:

| Sub-project        | Language   | Entry point                                  |
|--------------------|------------|----------------------------------------------|
| Python core        | Python 3.11| `cli.py`, `run_agent.py`, `hermes_cli/main.py` |
| Messaging gateway  | Python     | `gateway/run.py` (Telegram, Discord, Slack, …) |
| TUI (`hermes --tui`) | TypeScript (Ink) + Python | `ui-tui/` + `tui_gateway/` |
| Web dashboard      | React + Vite | `web/` → built into `hermes_cli/web_dist/`  |
| Docs site          | Docusaurus | `website/`                                   |

The Python core is enormous (`cli.py` is ~11k LOC, `run_agent.py` ~12k LOC,
`hermes_state.py` ~3k LOC). Use targeted reads / grep; don't slurp whole
files. `AGENTS.md` explains where each load-bearing piece lives.

## Setup

```bash
./setup-hermes.sh        # creates .venv, installs .[all,dev], symlinks ~/.local/bin/hermes
./hermes                 # auto-activates .venv, no `source` needed
```

Manual equivalent: `uv venv .venv --python 3.11 && source .venv/bin/activate
&& uv pip install -e ".[all,dev]"`.

Other sub-projects:
- `cd ui-tui && npm install && npm run build`  (TUI client)
- `cd web && npm install && npm run build`     (dashboard SPA — output goes to `hermes_cli/web_dist/`)
- `cd website && npm install && npm run build` (Docusaurus)

## Test command — use the wrapper, not raw pytest

```bash
scripts/run_tests.sh                                   # full suite
scripts/run_tests.sh tests/agent/                      # one directory
scripts/run_tests.sh tests/agent/test_foo.py::test_x   # one test
scripts/run_tests.sh -- -v --tb=long                   # pass-through pytest flags
```

The wrapper enforces CI-parity: hermetic env (`env -i`), `TZ=UTC`,
`LANG=C.UTF-8`, blanked credential vars, and per-file subprocess isolation
via `scripts/run_tests_parallel.py` (each test file gets its own fresh
Python interpreter — module-level state cannot leak between files). Calling
`pytest` directly on a developer machine with API keys and a non-UTC TZ
diverges from CI in ways that have caused multiple "works locally, fails in
CI" incidents. If you absolutely must, `pytest` from inside the activated
venv at least picks up the isolation plugin via `addopts` in `pyproject.toml`.

Integration tests (`-m integration`) require external services and are
excluded by default.

## Lint

```bash
ruff check .                          # blocking — enforces PLW1514 (unspecified-encoding)
python scripts/check-windows-footguns.py --all   # blocks Windows-unsafe primitives
ty check                              # type check (advisory)
```

CI also runs an advisory ruff+ty diff against the base branch and posts it
as a PR comment.

## Non-obvious rules that bite

These are the ones that aren't visible from reading the filesystem:

1. **Tools must be wired into a toolset to be exposed.** `tools/registry.py`
   auto-discovers any `tools/*.py` with a `registry.register()` call at the
   top level, but the tool name must also appear in a toolset in
   `toolsets.py` (typically `_HERMES_CORE_TOOLS`) or no agent will see it.
   This is deliberate, not an oversight.

2. **For custom tools, prefer the plugin route over editing core.** Drop
   `~/.hermes/plugins/<name>/plugin.yaml` + `__init__.py`; register tools
   via `ctx.register_tool(...)`. Only edit `tools/` + `toolsets.py` when
   contributing a tool that should ship in core.

3. **New memory providers must ship as standalone repos, not in this tree.**
   The set under `plugins/memory/` is closed (May 2026 policy). PRs adding
   a new directory there will be rejected.

4. **Plugins MUST NOT modify core files** (`run_agent.py`, `cli.py`,
   `gateway/run.py`, `hermes_cli/main.py`). If a plugin needs a capability
   core doesn't expose, expand the plugin surface (new hook, new ctx
   method) — never hardcode plugin-specific logic in core.

5. **Always use `get_hermes_home()` from `hermes_constants`, never
   hardcode `~/.hermes`.** Hardcoding breaks the profiles feature (each
   profile has its own `HERMES_HOME`). Use `display_hermes_home()` for
   user-facing messages.

6. **Prompt caching must not break mid-conversation.** Don't alter past
   context, change toolsets, or rebuild system prompts mid-session. Slash
   commands that mutate system-prompt state default to deferred
   invalidation; `--now` is opt-in. See `/skills install --now`.

7. **Dashboard chat is the embedded `hermes --tui`, not a React rewrite.**
   Don't re-implement the transcript / composer / terminal in React.
   Sidebar widgets and inspectors around the TUI are fine.

8. **Cross-platform — Windows is supported.** Critical: `os.kill(pid, 0)`
   on Windows is NOT a liveness probe — it broadcasts Ctrl+C to the
   target's console group and silently kills processes. Use
   `psutil.pid_exists(pid)`. `wmic` is gone in modern Windows; use
   `Get-CimInstance` via PowerShell. `termios`/`fcntl`/`SIGKILL`/`SIGHUP`
   don't exist. See `CONTRIBUTING.md` § Cross-Platform Compatibility and
   `scripts/check-windows-footguns.py`.

9. **Slash commands have one source of truth.** Add a `CommandDef` to
   `COMMAND_REGISTRY` in `hermes_cli/commands.py`, then a dispatch branch
   in `cli.py::process_command()` and `gateway/run.py` if applicable.
   Adding an alias requires only updating the `aliases` tuple — autocomplete,
   help, Telegram menu, Slack mapping all derive automatically.

10. **Don't write change-detector tests.** Tests asserting specific model
    names, hardcoded provider lists, or `_config_version == 21` get
    rejected. Test invariants (relationships between data) instead. Full
    rationale + examples in `AGENTS.md` § Testing.

11. **Dependency pins are exact (`==X.Y.Z`), not ranges.** Established after
    the litellm compromise and reinforced after the Mini Shai-Hulud worm
    (May 2026). Provider-specific deps belong in extras + `tools/lazy_deps.py`
    (lazy install at first use), not `dependencies =`. See the long comment
    at the top of `pyproject.toml`.

## Where to look first

| Need to…                       | Start at                                      |
|--------------------------------|-----------------------------------------------|
| Understand the agent loop      | `run_agent.py` (`AIAgent.run_conversation`)   |
| Add/modify a tool              | `tools/`, then `toolsets.py`                  |
| Add a slash command            | `hermes_cli/commands.py` → `cli.py` → `gateway/run.py` |
| Add a config key               | `hermes_cli/config.py` (`DEFAULT_CONFIG`)     |
| Add an `.env` (secret) var     | `hermes_cli/config.py` (`OPTIONAL_ENV_VARS`)  |
| Add a messaging platform       | `gateway/platforms/` + `gateway/ADDING_A_PLATFORM.md` |
| Add a skill                    | `skills/<category>/<name>/` (heavy: `optional-skills/`) |
| Add a model provider           | `plugins/model-providers/<name>/`             |
| Add a skin / theme             | `~/.hermes/skins/<name>.yaml` or `hermes_cli/skin_engine.py` `_BUILTIN_SKINS` |
| Touch the TUI                  | `ui-tui/src/app.tsx` + `tui_gateway/server.py` |
| Touch the web dashboard        | `web/src/` (rebuild → `hermes_cli/web_dist/`) |

## Profiles

`hermes -p <name>` runs an isolated instance with its own `HERMES_HOME`
(config, sessions, skills, gateway). `_apply_profile_override()` in
`hermes_cli/main.py` sets `HERMES_HOME` before any imports, so module-level
constants that call `get_hermes_home()` resolve correctly. Tests that mock
`Path.home()` must also `monkeypatch.setenv("HERMES_HOME", ...)` — see
`tests/hermes_cli/test_profiles.py`.
