# Per-User Skill Isolation for `web_chat`

> **Status:** Design — awaiting review. No code written yet.
> **For Hermes:** Use the subagent-driven-development skill to implement this plan task-by-task **only after the design has been approved**.

**Goal:** Let each authenticated web user install, view, and delete skills inside their per-user workspace, without (a) cross-tenant bleed, (b) touching upstream files, or (c) regressing the global operator-curated skill library.

**Architecture:** Add a fork-internal sandboxed skill toolset (`web_skill_*`) that operates on `<workspace>/skills/`, reuses `confine_path` + `enter_user_context`, and exposes a **merged read view** (per-user overlay over global). Replace `skills_list`/`skill_view` in the `hermes-web-chat` toolset with the fork-native variants so the agent sees a single unified surface.

**Tech Stack:** Python, `aiohttp` (already in `web_chat`), `argon2-cffi` (already pinned), YAML frontmatter parsing (PyYAML — already in deps for skill loading), pytest with temp workspaces and the existing `tests/gateway/test_web_*.py` harness.

---

## 1. Problem statement

The `hermes-web-chat` toolset (in `toolsets.py`) intentionally exposes only **read-only** skill operations (`skills_list`, `skill_view`). The exclusion of `skill_manage` is not policy — it's a forced workaround for an upstream caching bug:

```python
# tools/skills_tool.py:91
SKILLS_DIR = HERMES_HOME / "skills"   # ← evaluated at import time
```

`SKILLS_DIR` is a module-level constant resolved **once**, when `tools/skills_tool.py` is first imported (process startup). `enter_user_context` overrides `HERMES_HOME` via `set_hermes_home_override(...)`, but `SKILLS_DIR` does not re-read it — the binding is frozen. Any write through upstream `skill_manage` therefore lands in the **process-global** `~/.hermes/skills/`, which would let user A install a malicious skill that user B's agent then auto-loads on the next session.

This forces a UX gap: users see "install brave-search skill" suggestions in chat, but the agent has no tool to do it. Their reasonable expectation is that "install" should land inside *their* isolated environment.

## 2. Goals and non-goals

### Goals

1. A user-issued instruction like *"install a skill named X"* leads to a write under `<workspace>/skills/X/`, visible to that user's future sessions and **invisible** to every other user.
2. The user's agent sees both the operator-curated global skills (`~/.hermes/skills/`) and the user's private skills (`<workspace>/skills/`) in a single merged listing, with a clear `source` field.
3. Zero modifications to upstream files. The fork's Strategy 2 ("pay code duplication if it means upstream files don't get touched") is preserved.
4. Per-user skill writes count against the existing per-user storage quota.
5. SKILL.md frontmatter is validated before write (name length, description length, no path traversal in `name`, allowed `platforms` values).

### Non-goals

1. **Auto-loading user skills into the system prompt.** Upstream's `agent/prompt_builder.py` calls `get_external_skills_dirs()` directly at prompt construction time, which (a) reads `config.yaml`, not ContextVars, and (b) caches by mtime. Plumbing per-user dirs through it would touch upstream and break the cache invariant. Instead, user-installed skills are discovered by the agent at runtime via `web_skills_list` (progressive disclosure — the Anthropic-recommended pattern).
2. **Cross-user skill sharing.** A user cannot "publish" a skill to another user. That's a future feature (operator promotion endpoint).
3. **Skill execution sandbox.** Skills can ship `scripts/`, but `hermes-web-chat` toolset deliberately excludes `terminal_tool`/`code_execution`, so user scripts are reference-only — the agent reads them, no execution path exists. This stays unchanged.
4. **Modifying upstream `skills_list`/`skill_view`.** We replace them with `web_skills_list`/`web_skill_view` in the `hermes-web-chat` toolset only. Other platforms see the upstream tools untouched.

## 3. Proposed solution

### 3.1 New module: `gateway/web/tools/sandboxed_skill_manage.py`

A fork-native, self-contained skill toolset. Does **not** import `tools.skills_tool` — re-implements the minimal scan/read logic needed, ~200 LOC, to avoid coupling to upstream's progressive-disclosure machinery (which is rich but tied to `SKILLS_DIR`).

Four tools, registered into the `web_skill` toolset:

| Tool | Purpose | Reads | Writes |
|---|---|---|---|
| `web_skills_list` | Merged listing of global + user skills | `~/.hermes/skills/`, `<ws>/skills/` | — |
| `web_skill_view` | Read a SKILL.md or linked file (user overrides global by name) | both layers | — |
| `web_skill_install` | Write a new skill under `<ws>/skills/<category>/<name>/` | — | `<ws>/skills/...` only |
| `web_skill_delete` | Remove a user-owned skill (refuses global names) | — | `<ws>/skills/...` only |

Every tool calls `get_user_workspace()` (from `gateway/web/sandbox.py`) and refuses to run if no user context is active. Every path is funnelled through `confine_path(...)` before any I/O.

### 3.2 Layout inside a user workspace

```
$HERMES_HOME/web_workspaces/<user_id>/
├── memories/        # existing
├── files/           # existing  (web_file_* sandbox lives here by convention)
├── cache/           # existing
└── skills/          # NEW — created on first install
    └── <category>/
        └── <name>/
            ├── SKILL.md          # required, frontmatter validated
            ├── scripts/          # optional, reference-only
            └── references/       # optional
```

`skills/` is added to the `_USER_SUBDIRS` tuple in `gateway/web/sandbox.py` so `ensure_workspace` creates it pre-emptively (zero-cost mkdir).

### 3.3 Merged view semantics

`web_skills_list` returns:

```json
{
  "success": true,
  "skills": [
    {"name": "arxiv", "description": "...", "category": "research", "source": "global"},
    {"name": "my-domain-glossary", "description": "...", "category": "domain", "source": "user"},
    {"name": "brave-search", "description": "...", "category": "research", "source": "global"}
  ],
  "categories": ["research", "domain", ...]
}
```

`source` is one of `"global"` or `"user"`. On **name collision**, user wins (overlay semantics) and the global entry is suppressed from the list — same as how `/etc/skel` overlays work.

### 3.4 SKILL.md validation on install

Before any disk write, `web_skill_install` parses the supplied SKILL.md and rejects if:

- Frontmatter `name` differs from the supplied skill name (catch copy-paste errors).
- `name` contains `/`, `..`, `\0`, or any non-`[A-Za-z0-9_-]` char (path-traversal guard, length ≤64 chars matching upstream).
- `description` is missing or >1024 chars (upstream limit).
- `category` (from URL path) is not in `_USER_SUBDIRS`-style allowlist (we'll match upstream's well-known categories: `apple, autonomous-ai-agents, creative, data-science, devops, diagramming, dogfood, domain, email, gaming, gifs, github, mcp, media, mlops, note-taking, productivity, red-teaming, research, smart-home, social-media, software-development, yuanbao`).
- The category dir path under `<ws>/skills/` would resolve outside the workspace (defense in depth — `confine_path` catches this too, but we want a friendlier error).
- Total skill size (SKILL.md + scripts + references) >256 KB or any single file >64 KB (quota-aware, configurable).

### 3.5 Quota integration

`web_skill_install` adds to the user's existing quota counter (the byte counter in `gateway/web/quota.py`, currently tracks file writes). Skill size counts the same as `files/` writes. Existing `_handle_chat`'s `finally`-block quota recording stays unchanged.

## 4. API design — tool schemas (exact)

```python
_WEB_SKILLS_LIST_SCHEMA = {
    "name": "web_skills_list",
    "description": (
        "List all skills available to you: global (operator-curated, read-only) "
        "and personal (installed in your workspace via web_skill_install). "
        "Returns name + description + category + source for each. Use "
        "web_skill_view(name) for full content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "category": {"type": "string", "description": "Optional category filter"},
            "source": {
                "type": "string",
                "enum": ["all", "global", "user"],
                "description": "Restrict to global or personal skills (default: all)",
            },
        },
        "required": [],
    },
}

_WEB_SKILL_VIEW_SCHEMA = {
    "name": "web_skill_view",
    "description": (
        "Read a skill's SKILL.md or a linked file under it. Personal skills "
        "take precedence over global ones on name collision."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Skill name (matches SKILL.md frontmatter name)"},
            "file_path": {
                "type": "string",
                "description": "Optional relative file path under the skill dir (e.g. 'references/api.md'). Omit to read SKILL.md.",
            },
        },
        "required": ["name"],
    },
}

_WEB_SKILL_INSTALL_SCHEMA = {
    "name": "web_skill_install",
    "description": (
        "Install a skill into your personal workspace. Creates "
        "skills/<category>/<name>/SKILL.md. Optional support files via "
        "files={'scripts/foo.py': '...', 'references/api.md': '...'}. "
        "Size limits: 64KB/file, 256KB total per skill. SKILL.md must "
        "include valid frontmatter with name, description, version."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Skill name — [A-Za-z0-9_-]{1,64}"},
            "category": {
                "type": "string",
                "description": "Category dir (research, domain, productivity, etc.)",
            },
            "skill_md": {"type": "string", "description": "Full SKILL.md content with frontmatter"},
            "files": {
                "type": "object",
                "description": "Optional dict of {relative_path: content} for scripts/references/assets",
                "additionalProperties": {"type": "string"},
            },
            "overwrite": {
                "type": "boolean",
                "description": "Replace existing personal skill with same name (default: false)",
            },
        },
        "required": ["name", "category", "skill_md"],
    },
}

_WEB_SKILL_DELETE_SCHEMA = {
    "name": "web_skill_delete",
    "description": (
        "Delete a personal skill from your workspace. Global skills cannot "
        "be deleted (they are operator-curated, shared, and read-only for "
        "all users — the call will return an error if the name resolves "
        "only to a global skill)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
        },
        "required": ["name"],
    },
}
```

## 5. Security model

| Threat | Mitigation |
|---|---|
| User A writes into user B's workspace | `confine_path` enforced on every path; ContextVar `_USER_WORKSPACE` is asyncio-task-local and reset on context exit |
| User A overwrites a global skill | Install/delete only touch `<ws>/skills/`; merged-view overlay is read-only |
| Path-traversal via `name="../etc/passwd"` | Validation regex `^[A-Za-z0-9_-]{1,64}$` + `confine_path` belt-and-braces |
| YAML deserialization attack | Use `yaml.safe_load` (already the project convention); reject non-dict frontmatter |
| Disk fill | Per-skill 256KB, per-file 64KB caps + existing quota |
| `name` claims a different identity than the dir | Frontmatter `name` must equal install param `name` (else 400) |
| `confine_path` called outside a user context | Already raises `RuntimeError` — preserves the existing security property |
| Tool inadvertently usable on non-web platforms | `web_skill_*` tools live under `gateway/web/tools/` and are listed only in the `hermes-web-chat` toolset; other platforms cannot see them |

## 6. File layout (changes)

```
gateway/web/tools/sandboxed_skill_manage.py    NEW   ~250 LOC
gateway/web/sandbox.py                          MOD   add "skills" to _USER_SUBDIRS (1 line)
toolsets.py                                     MOD   swap skills_list/skill_view → web_*; add install/delete (~6 lines)
tests/gateway/test_web_sandboxed_skills.py      NEW   ~250 LOC (12-15 cases)
docs/user-guide/web-chat.md                     MOD   document the new tools (~30 lines)
```

Total: ~2 modified files (both already on fork's B-class patch allowlist), 2 new files. **Zero upstream-file modifications.**

## 7. Testing plan

`tests/gateway/test_web_sandboxed_skills.py` — driven through `scripts/run_tests.sh` for CI parity.

Required cases:

1. **list — merged view**: empty user workspace → only global skills appear with `source=global`.
2. **list — overlay**: user installs a skill with the same name as a global one → user version appears with `source=user`, global is hidden.
3. **list — category filter**: filter by category honored across both sources.
4. **list — source filter**: `source="user"` excludes global entries; `source="global"` excludes user entries.
5. **view — personal**: user installs, then `view` returns user content.
6. **view — global fallback**: name not in user dir → returns global content with `source=global`.
7. **view — not found**: returns `{"success": false, "error": "..."}` with no traceback leak.
8. **view — file_path**: reads `references/foo.md` correctly; rejects `../../escape`.
9. **install — happy path**: writes SKILL.md + files; quota updated.
10. **install — bad name**: rejects `../escape`, `with space`, `>64 chars`.
11. **install — bad frontmatter**: missing `name`, `description`, name mismatch.
12. **install — size cap**: file >64KB rejected; total >256KB rejected.
13. **install — overwrite=false**: refuses to clobber existing user skill.
14. **install — cross-tenant isolation**: user A installs `foo`; user B's `list` does not show it.
15. **delete — happy path**: user skill gone from disk + list.
16. **delete — global rejected**: cannot delete a global skill; error has friendly message, no disk change.
17. **delete — nonexistent**: returns `{"success": false, ...}`, no traceback.
18. **outside-context safety**: directly invoking a tool function outside `enter_user_context` raises (matches `confine_path` semantics).

E2E: existing `tests/gateway/test_web_chat_platform.py` should not break — add one round-trip case where a chat turn invokes `web_skill_install` then `web_skill_view`.

## 8. Implementation steps (post-approval task list)

1. Add `"skills"` to `_USER_SUBDIRS` in `gateway/web/sandbox.py`; update one test fixture.
2. Skeleton `gateway/web/tools/sandboxed_skill_manage.py`: imports, `_TOOLSET` constant, registration plumbing matching `sandboxed_file_operations.py`.
3. Implement `_scan_skills_dir(root)` — yields `(name, category, description)` tuples from a single dir. Pure function, no ContextVar.
4. Implement `web_skills_list` on top of `_scan_skills_dir` for both layers + merge.
5. Implement `web_skill_view` with personal-first lookup.
6. Implement SKILL.md frontmatter validator (separate function, unit-tested).
7. Implement `web_skill_install` calling validator + `confine_path` + size checks + quota recorder.
8. Implement `web_skill_delete` with the global-protection guard.
9. Write the schemas + register into `_REGISTRATIONS` tuple.
10. Update `toolsets.py` `hermes-web-chat` entry: swap `skills_list`/`skill_view` for `web_skills_list`/`web_skill_view`; add `web_skill_install`/`web_skill_delete`.
11. Write `tests/gateway/test_web_sandboxed_skills.py` covering all cases in §7. Run via `scripts/run_tests.sh`.
12. Update `docs/user-guide/web-chat.md` — document the four tools under "Per-user skill management".
13. Smoke test via `/tmp/run_web_chat_server.py` + the `browse` skill: register → install a skill via chat → list → view → delete.

## 9. Risks and alternatives considered

### Alternative A: Patch upstream `SKILLS_DIR` to be dynamic

Change `tools/skills_tool.py:91` from `SKILLS_DIR = HERMES_HOME / "skills"` to `def get_skills_dir(): return get_hermes_home() / "skills"`, then sweep ~12 references. This is the architecturally cleanest fix and probably belongs upstream, but:

- Violates Strategy 2 ("zero upstream changes" — a 12-site sweep is far past B-class).
- Introduces a per-call cost on every skill scan (negligible, but measurable).
- Doesn't unblock us today — would have to wait for upstream review.

Decision: **rejected for the fork**, propose separately as an upstream PR.

### Alternative B: Hook `get_external_skills_dirs()` via monkeypatch in `enter_user_context`

Add a ContextVar-keyed override list, wrap `get_external_skills_dirs`. Less code than Alternative A but:

- Module monkeypatching is fragile across reloads.
- The mtime-keyed cache in `get_external_skills_dirs` would still return stale data when `external_dirs` changes per-request.

Decision: **rejected** — fragile and crosses module boundaries.

### Alternative C: Pure file-tool-based skill install

Tell users to `web_file_write("skills/research/foo/SKILL.md", ...)` and rely on `confine_path`. No new tools.

- Pro: zero new code.
- Con: user skills don't appear in `skills_list` (it doesn't scan workspaces); agent can't discover them; SKILL.md frontmatter unvalidated; no overlay semantics; no quota.

Decision: **rejected** — fails goal 1 and goal 2.

### Risk: User installs a skill that confuses the agent

E.g., a SKILL.md that contradicts the system prompt. **Mitigation:** SKILL.md is only loaded when the agent calls `web_skill_view(name)` — it's pull, not push. The agent can choose to ignore. This matches Anthropic's progressive-disclosure recommendation.

### Risk: Disk leakage on user deletion

A deleted user's workspace currently lingers on disk. **Out of scope** — this is an existing issue with the workspace lifecycle, not introduced by this design.

## 10. Open questions for review

These need an answer before implementation kicks off:

**Q1.** Should `web_skill_install` accept a single `skill_md` string + `files` dict (as designed), or should it accept a single tarball/zip (smaller param surface, harder to validate)? *Recommendation: the dict form — easier to validate field-by-field, easier for the agent to construct.*

**Q2.** Should category names be a hard-coded allowlist (as designed) or freeform with a regex (`^[a-z][a-z0-9-]{0,32}$`)? *Recommendation: allowlist — keeps `web_skills_list` listings clean and matches upstream's de-facto category convention.*

**Q3.** Size caps — 64KB/file, 256KB/skill, configurable via `web_chat.skill_quota.*` keys? *Recommendation: yes, but ship with defaults; revisit if operators ask for tunables.*

**Q4.** Should we surface user skills in the **system prompt's** skill banner (matching how global skills appear)? *Recommendation: **no** — the banner is rendered once per session by upstream `prompt_builder.py`, which we don't touch. Agents discover user skills on demand via `web_skills_list`. We document this clearly so users understand the asymmetry.*

**Q5.** When a user is deleted (operator endpoint), do we delete their workspace + skills, or quarantine? *Recommendation: out of scope — existing workspace lifecycle decision applies equally.*

**Q6.** Logging — every skill install/delete should append to per-user audit log under `<ws>/.audit/skills.log`? *Recommendation: yes, write-only NDJSON. Cheap, helps debugging user reports.*

**Q7.** Should the install schema include an optional `replace_files: {relpath: null}` field for surgical removal of a single file without `overwrite=true` on the whole skill? *Recommendation: defer to v2 — adds API surface for a niche case.*

---

## Appendix A — Relationship to existing patches

This design follows the same patterns as the existing fork-internal modules:

- `gateway/web/tools/sandboxed_file_operations.py` — pattern for sandboxed write-capable tools.
- `gateway/web/sandbox.py::enter_user_context` — the ContextVar enter/exit boundary.
- `gateway/web/quota.py` — the byte-counter we extend (not duplicate).

No fork patches in the CLAUDE.md B-class list (`run_agent.py:517`, `agent/conversation_compression.py:391`, `gateway/run.py`, `gateway/config.py`, `hermes_cli/platforms.py`, `toolsets.py`, `hermes_state.py`, `pyproject.toml`) are extended. Only `toolsets.py` is modified, and that's already on the B-class allowlist.
