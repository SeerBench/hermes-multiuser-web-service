# `web_chat` 多用户 Skill 隔离设计

> **状态：** 设计 — 等待评审。尚未写代码。
> **致 Hermes：** **设计通过后**再用 subagent-driven-development skill 按任务逐步实现本计划。

**目标：** 让每个已认证 web 用户在自己的 per-user workspace 内安装、查看、删除 skill，并满足：(a) 不发生跨租户泄漏；(b) 不动 upstream 文件；(c) 不破坏全局 operator-curated 的 skill 库。

**架构：** 在 fork 内部新增一组 sandboxed skill 工具集（`web_skill_*`），作用于 `<workspace>/skills/`，复用 `confine_path` + `enter_user_context`，并向 agent 暴露**合并后的只读视图**（用户层覆盖全局层）。把 `hermes-web-chat` 工具集里的 `skills_list` / `skill_view` 替换成 fork 原生版本，让 agent 看到一个统一的接口。

**技术栈：** Python、`aiohttp`（`web_chat` 已用）、`argon2-cffi`（已 pin）、YAML frontmatter 解析（PyYAML — skill 加载链路已经依赖）、pytest，搭配现有 `tests/gateway/test_web_*.py` 测试夹具与临时 workspace。

---

## 1. 问题陈述

`toolsets.py` 中的 `hermes-web-chat` 工具集**故意**只暴露**只读**的 skill 操作（`skills_list`、`skill_view`），不暴露 `skill_manage`。这并不是策略偏好 —— 这是被 upstream 的一个缓存缺陷逼出来的妥协：

```python
# tools/skills_tool.py:91
SKILLS_DIR = HERMES_HOME / "skills"   # ← 在 import 时求值
```

`SKILLS_DIR` 是 module-level 常量，在 `tools/skills_tool.py` 第一次被 import 时（进程启动时）**只求值一次**。`enter_user_context` 通过 `set_hermes_home_override(...)` 覆盖 `HERMES_HOME`，但 `SKILLS_DIR` 不会重新读取 —— 这个绑定已经被冻结。所以 upstream `skill_manage` 的所有写入都会落到**进程全局** `~/.hermes/skills/`，这意味着用户 A 能装一个恶意 skill，然后用户 B 的 agent 在下一个 session 里就会自动加载它。

由此带来一个 UX 缺口：用户在聊天里看到"安装 brave-search skill"的建议，但 agent 根本没有相应的工具能做这件事。用户合理的预期是："安装"应该落到**他自己**的隔离环境里。

## 2. 目标与非目标

### 目标

1. 用户在聊天里说"装一个叫 X 的 skill"，应该让 agent 在 `<workspace>/skills/X/` 下完成写入；该 skill 对该用户后续 session 可见，对其他用户**不可见**。
2. 用户的 agent 看到**一个合并的列表**：operator-curated 的全局 skill（`~/.hermes/skills/`）+ 用户自己的私有 skill（`<workspace>/skills/`），每条都有清晰的 `source` 字段。
3. **不修改任何 upstream 文件**。fork 的 Strategy 2（"为了不动 upstream 文件可以付出代码重复的代价"）得以保留。
4. 用户对 skill 的写入计入既有的 per-user 存储配额。
5. 写盘前校验 SKILL.md 的 frontmatter（`name` 长度、`description` 长度、`name` 不含路径穿越、`platforms` 取值在白名单内）。

### 非目标

1. **把用户私有 skill 自动注入 system prompt。** upstream 的 `agent/prompt_builder.py` 在构建 system prompt 时直接调 `get_external_skills_dirs()`，它 (a) 读 `config.yaml`，不读 ContextVar；(b) 按 mtime 缓存。如果要把 per-user 目录塞进去，必然触碰 upstream，且会破坏缓存语义。改用 **运行时通过 `web_skills_list` 主动发现**（progressive disclosure —— Anthropic 推荐的模式）。
2. **跨用户共享 skill。** 用户不能"发布" skill 给其他用户。这是未来功能（operator 提权端点）。
3. **Skill 执行沙箱。** Skill 可以带 `scripts/`，但 `hermes-web-chat` 工具集本来就不暴露 `terminal_tool` / `code_execution`，所以用户脚本是**纯参考性的** —— agent 能读但执行不了。本设计不改变这点。
4. **修改 upstream `skills_list` / `skill_view`。** 仅在 `hermes-web-chat` 工具集中把它们替换为 `web_skills_list` / `web_skill_view`。其他平台看到的 upstream 工具不动。

## 3. 提议方案

### 3.1 新模块：`gateway/web/tools/sandboxed_skill_manage.py`

fork 原生、自给自足的 skill 工具集。**不** import `tools.skills_tool` —— 自己实现一份最小的扫描 / 读取逻辑（约 200 LOC），避免和 upstream 进度披露机制耦合（upstream 那套虽然丰富，但绑死在 `SKILLS_DIR` 上）。

在 `web_skill` 工具集下注册四个工具：

| 工具 | 用途 | 读 | 写 |
|---|---|---|---|
| `web_skills_list` | 全局 + 用户私有 skill 的合并列表 | `~/.hermes/skills/`、`<ws>/skills/` | — |
| `web_skill_view` | 读取一份 SKILL.md 或其下的关联文件（同名时用户层覆盖全局层） | 两层 | — |
| `web_skill_install` | 写入一个新 skill 到 `<ws>/skills/<category>/<name>/` | — | 仅 `<ws>/skills/...` |
| `web_skill_delete` | 删除用户私有 skill（全局 skill 拒绝删除） | — | 仅 `<ws>/skills/...` |

每个工具都调用 `get_user_workspace()`（来自 `gateway/web/sandbox.py`），如果没有激活的用户上下文就拒绝运行。每个路径在落盘前都过一遍 `confine_path(...)`。

### 3.2 用户 workspace 内的目录布局

```
$HERMES_HOME/web_workspaces/<user_id>/
├── memories/        # 已有
├── files/           # 已有  （按约定 web_file_* sandbox 在这里）
├── cache/           # 已有
└── skills/          # 新增 — 首次 install 时创建
    └── <category>/
        └── <name>/
            ├── SKILL.md          # 必填，frontmatter 经过校验
            ├── scripts/          # 可选，仅供参考
            └── references/       # 可选
```

`skills/` 加入 `gateway/web/sandbox.py` 的 `_USER_SUBDIRS` 元组，让 `ensure_workspace` 在创建时预先 mkdir（零成本）。

### 3.3 合并视图语义

`web_skills_list` 返回：

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

`source` 取值为 `"global"` 或 `"user"`。**遇到 name 冲突时用户层胜出**（overlay 语义），全局层的对应条目在列表中被隐藏 —— 类似 `/etc/skel` 的覆盖逻辑。

### 3.4 install 时的 SKILL.md 校验

`web_skill_install` 在任何写盘动作之前，先解析传入的 SKILL.md，遇到以下情况直接拒绝：

- frontmatter 里的 `name` 和入参 `name` 不一致（防止复制粘贴错误）。
- `name` 中含 `/`、`..`、`\0`，或包含 `[A-Za-z0-9_-]` 以外的字符（防路径穿越，长度 ≤64，对齐 upstream）。
- `description` 缺失或长度 >1024（upstream 上限）。
- `category`（来自 URL 路径）不在白名单内（与 upstream 的常用分类对齐：`apple, autonomous-ai-agents, creative, data-science, devops, diagramming, dogfood, domain, email, gaming, gifs, github, mcp, media, mlops, note-taking, productivity, red-teaming, research, smart-home, social-media, software-development, yuanbao`）。
- 解析后的 category 目录路径若会跳出 `<ws>/skills/`（纵深防御 —— 即使 `confine_path` 已经能拦住，这里返回更友好的错误信息）。
- skill 总大小（SKILL.md + scripts + references）>256 KB 或任意单文件 >64 KB（quota-aware，可配置）。

### 3.5 配额集成

`web_skill_install` 累加用户既有的配额计数器（`gateway/web/quota.py` 中的字节计数器，当前用于跟踪文件写入）。skill 大小与 `files/` 写入同等计费。`_handle_chat` `finally` 块中的配额上报逻辑保持不变。

## 4. API 设计 —— 工具 schema（最终版）

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

## 5. 安全模型

| 威胁 | 缓解措施 |
|---|---|
| 用户 A 写入用户 B 的 workspace | 所有路径强制走 `confine_path`；ContextVar `_USER_WORKSPACE` 是 asyncio task-local 的，上下文退出时重置 |
| 用户 A 覆盖全局 skill | install/delete 只能动 `<ws>/skills/`；合并视图的覆盖是只读的 |
| 通过 `name="../etc/passwd"` 做路径穿越 | 正则 `^[A-Za-z0-9_-]{1,64}$` + `confine_path` 双重保险 |
| YAML 反序列化攻击 | 使用 `yaml.safe_load`（项目现有惯例）；非 dict frontmatter 拒绝 |
| 磁盘填满 | 单 skill 256KB、单文件 64KB 上限 + 现有 quota |
| `name` 与实际目录身份不一致 | frontmatter 的 `name` 必须与 install 入参 `name` 相等（否则 400） |
| 在用户上下文之外调用 `confine_path` | 现行实现已抛 `RuntimeError` —— 保留这个安全属性 |
| 工具在非 web 平台被误用 | `web_skill_*` 工具位于 `gateway/web/tools/`，仅在 `hermes-web-chat` 工具集中注册；其他平台看不到 |

## 6. 文件变更布局

```
gateway/web/tools/sandboxed_skill_manage.py    新增   ~250 LOC
gateway/web/sandbox.py                          修改   在 _USER_SUBDIRS 加 "skills"（1 行）
toolsets.py                                     修改   替换 skills_list/skill_view → web_*；新增 install/delete（约 6 行）
tests/gateway/test_web_sandboxed_skills.py      新增   ~250 LOC（12-15 用例）
docs/user-guide/web-chat.md                     修改   记录新工具（约 30 行）
```

合计：2 个修改文件（都在 fork 的 B-class 补丁允许清单里），2 个新文件。**零 upstream 文件改动**。

## 7. 测试计划

`tests/gateway/test_web_sandboxed_skills.py` —— 通过 `scripts/run_tests.sh` 跑，保持 CI 一致。

必需用例：

1. **list — 合并视图**：用户 workspace 空时 → 只返回全局 skill，且 `source=global`。
2. **list — 覆盖语义**：用户安装与全局同名的 skill → 用户版以 `source=user` 出现，全局版被隐藏。
3. **list — 分类过滤**：按 `category` 过滤时，跨两层都正确生效。
4. **list — source 过滤**：`source="user"` 排除全局；`source="global"` 排除用户私有。
5. **view — 私有**：用户安装后，`view` 返回用户版本内容。
6. **view — 回落到全局**：name 在用户层不存在 → 返回全局内容，`source=global`。
7. **view — 找不到**：返回 `{"success": false, "error": "..."}`，不泄露 traceback。
8. **view — file_path**：能正确读 `references/foo.md`；拒绝 `../../escape`。
9. **install — happy path**：SKILL.md + files 都写入；配额更新。
10. **install — name 不合法**：拒绝 `../escape`、含空格、长度 >64 等。
11. **install — frontmatter 不合法**：缺 `name`、缺 `description`、name 不一致。
12. **install — 大小上限**：单文件 >64KB 拒绝；总和 >256KB 拒绝。
13. **install — overwrite=false**：拒绝覆盖已存在的同名用户私有 skill。
14. **install — 跨租户隔离**：用户 A 装 `foo`；用户 B 的 `list` 看不到。
15. **delete — happy path**：用户 skill 从磁盘和列表中消失。
16. **delete — 拒绝删全局**：全局 skill 无法删除；错误信息友好，磁盘不变。
17. **delete — 不存在**：返回 `{"success": false, ...}`，无 traceback。
18. **上下文外安全性**：在 `enter_user_context` 之外直接调用工具函数会抛错（与 `confine_path` 语义一致）。

E2E：既有 `tests/gateway/test_web_chat_platform.py` 不应受影响 —— 增加一个 round-trip 用例：一次 chat turn 内先 `web_skill_install` 再 `web_skill_view`。

## 8. 实施步骤（通过评审后的任务清单）

1. 在 `gateway/web/sandbox.py` 的 `_USER_SUBDIRS` 中加 `"skills"`；更新一个测试夹具。
2. 搭建 `gateway/web/tools/sandboxed_skill_manage.py` 骨架：import、`_TOOLSET` 常量、与 `sandboxed_file_operations.py` 对齐的注册脚手架。
3. 实现 `_scan_skills_dir(root)` —— 从一个目录里产出 `(name, category, description)` 三元组。纯函数，不依赖 ContextVar。
4. 基于 `_scan_skills_dir` 实现 `web_skills_list`，对两层做合并。
5. 实现 `web_skill_view`，按"私有优先"查找。
6. 实现 SKILL.md frontmatter 校验器（独立函数，单独写单测）。
7. 实现 `web_skill_install`：调用校验器 + `confine_path` + 大小检查 + 配额上报。
8. 实现 `web_skill_delete`，带全局保护守卫。
9. 编写 schema 并注册到 `_REGISTRATIONS` 元组。
10. 改 `toolsets.py` 的 `hermes-web-chat` 条目：把 `skills_list` / `skill_view` 替换为 `web_skills_list` / `web_skill_view`；加上 `web_skill_install` / `web_skill_delete`。
11. 写 `tests/gateway/test_web_sandboxed_skills.py`，覆盖第 7 节所有用例。通过 `scripts/run_tests.sh` 运行。
12. 更新 `docs/user-guide/web-chat.md` —— 在"Per-user skill management"小节记录这四个工具。
13. 用 `/tmp/run_web_chat_server.py` + `browse` skill 做冒烟：注册 → 在聊天里 install 一个 skill → list → view → delete。

## 9. 风险与已考虑的替代方案

### 替代方案 A：直接给 upstream 的 `SKILLS_DIR` 打补丁，让它动态求值

把 `tools/skills_tool.py:91` 从 `SKILLS_DIR = HERMES_HOME / "skills"` 改成 `def get_skills_dir(): return get_hermes_home() / "skills"`，再清扫 ~12 处引用。架构上这是最干净的修法，**应该作为一个独立 PR 提给 upstream**。但：

- 违反 Strategy 2（"零 upstream 改动" —— 12 处清扫远超 B-class 补丁的边界）。
- 每次扫描都引入一点点函数调用成本（可忽略，但可测）。
- 今天就解决不了我们的问题 —— 得等 upstream review。

决定：**fork 内拒绝**，作为独立的 upstream PR 另议。

### 替代方案 B：在 `enter_user_context` 里 monkey-patch `get_external_skills_dirs()`

加一个 ContextVar 形式的覆盖列表，包装 `get_external_skills_dirs`。代码量比方案 A 少，但：

- 跨 module reload 时 monkey-patch 很脆。
- `get_external_skills_dirs` 的按 mtime 缓存在 per-request `external_dirs` 切换时会返回过期数据。

决定：**拒绝** —— 脆弱、跨模块边界。

### 替代方案 C：纯文件工具实现 skill install

让用户 / agent 用 `web_file_write("skills/research/foo/SKILL.md", ...)`，靠 `confine_path` 兜底。不加新工具。

- 利：零新增代码。
- 弊：用户 skill 不会出现在 `skills_list`（它不扫 workspace）；agent 发现不了；SKILL.md frontmatter 没校验；没有覆盖语义；没有配额计费。

决定：**拒绝** —— 无法满足目标 1 和目标 2。

### 风险：用户装了一个会干扰 agent 的 skill

例如 SKILL.md 与 system prompt 矛盾。**缓解：** SKILL.md 只有在 agent 主动调 `web_skill_view(name)` 时才会加载 —— 是"拉"不是"推"。agent 可以选择忽略。这与 Anthropic 的 progressive-disclosure 推荐一致。

### 风险：用户删除时的磁盘泄漏

当前的 workspace 在用户被删除时不会立即清理。**超出范围** —— 这是 workspace 生命周期既有的问题，不是本设计引入的。

## 10. 评审时需要回答的开放问题

正式实施前，下面这些需要拍板：

**Q1.** `web_skill_install` 是按目前的设计接收 `skill_md` 字符串 + `files` 字典，还是接收单个 tarball / zip（参数面更小，但校验更难）？*推荐：保留 dict 形式 —— 便于字段级校验，便于 agent 构造。*

**Q2.** `category` 应该是硬编码白名单（当前设计），还是用正则约束的自由格式（`^[a-z][a-z0-9-]{0,32}$`）？*推荐：白名单 —— 让 `web_skills_list` 输出更干净，也对齐 upstream 的事实分类约定。*

**Q3.** 大小上限 —— 64KB / 文件、256KB / skill，是否通过 `web_chat.skill_quota.*` 键支持配置？*推荐：是，但带默认值上线；如果 operator 主动要求再加调参旋钮。*

**Q4.** 用户私有 skill 是否要出现在 system prompt 的 skill banner 中（和全局 skill 一样）？*推荐：**不要** —— banner 由 upstream `prompt_builder.py` 每个 session 渲染一次，那块我们不动。agent 通过 `web_skills_list` 按需发现用户 skill。我们会清楚地说明这个不对称性。*

**Q5.** 当用户被删除（operator 端点触发）时，是删除其 workspace + skill 还是隔离归档？*推荐：超出范围 —— 沿用既有 workspace 生命周期决策。*

**Q6.** 日志 —— 每一次 skill install / delete 都追加到 per-user 审计日志 `<ws>/.audit/skills.log`？*推荐：是，NDJSON 只写不读。便宜，能帮排查用户反馈。*

**Q7.** install schema 是否要加可选字段 `replace_files: {relpath: null}`，用于在不 `overwrite=true` 整个 skill 的前提下精细删除单个文件？*推荐：留到 v2 —— 为一个小众场景增加 API 表面不划算。*

---

## 附录 A —— 与既有补丁的关系

本设计沿用 fork 内既有模块的模式：

- `gateway/web/tools/sandboxed_file_operations.py` —— 可写型 sandboxed tool 的范式。
- `gateway/web/sandbox.py::enter_user_context` —— ContextVar 进入 / 退出边界。
- `gateway/web/quota.py` —— 我们扩展（而非复制）的字节计数器。

CLAUDE.md 的 B-class 补丁清单（`run_agent.py:517`、`agent/conversation_compression.py:391`、`gateway/run.py`、`gateway/config.py`、`hermes_cli/platforms.py`、`toolsets.py`、`hermes_state.py`、`pyproject.toml`）中没有任何一项被扩展。本设计**只动 `toolsets.py`**，而它本身就在 B-class 允许清单里。
