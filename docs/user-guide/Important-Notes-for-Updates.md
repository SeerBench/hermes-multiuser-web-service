# Hermes 升级重要注意事项（Important Notes for Updates）

本文面向本仓库（`hermes-multiuser-web-service`）运维与开发人员，说明在同步 **上游 Hermes Agent** 或发布本 fork 新版本时，必须保留的边界、推荐操作步骤与验收清单。

相关文档：

- [DEPLOY.md](DEPLOY.md) — PostgreSQL + Docker 生产部署
- [DEPLOY-no-docker.md](DEPLOY-no-docker.md) — SQLite、无 Docker 轻量部署（若本地存在）
- [web-chat.md](web-chat.md) — Web Chat 运维与日常更新
- 仓库根目录 `CLAUDE.md` — Strategy 2 与 fork 路由

---

## 1. 先理解：本仓库是什么

本仓库是上游 `NousResearch/hermes-agent` 的 **fork**，在不动 Hermes Agent 主循环的前提下，叠加多用户 Web SaaS：

| 层级 | 路径 | 与上游关系 |
|------|------|------------|
| Platform API | `platform-api/` | **仅本 fork**，上游无此目录 |
| Web 控制面 / 沙箱工具 | `gateway/web/` | **仅本 fork** |
| Web Chat 平台 | `gateway/platforms/web_chat.py` | **仅本 fork** |
| React SPA | `web-chat/` | **仅本 fork** |
| Hermes Agent / 网关核心 | `run_agent.py`、`gateway/run.py`、`tools/` 等 | **上游核心**，极少改动 |

**结论：**

- `gateway/` **整体属于 Hermes 网关体系**，但其中的 `gateway/web/**` 与 `web_chat.py` 是 fork 扩展层。
- 升级上游时，冲突主要出现在「少量共享补丁文件」，而不是整个 `gateway/web/`。

---

## 2. Strategy 2：保持可 rebase 的铁律

> **宁可重复代码，也不要为了省事去改上游核心文件。**

### 2.1 禁止修改（零业务耦合）

以下文件应保持与上游一致或仅含已登记的极小 additive 补丁；**不要**在此写 SaaS 业务逻辑：

```
run_agent.py                 # 除已登记的 user_id 传播外勿扩业务
cli.py
hermes_cli/main.py
agent/memory_manager.py      # 隔离靠 HERMES_HOME ContextVar，不改 MemoryManager
tools/file_operations.py     # wrap，不 fork
tools/file_tools.py          # wrap，不 fork
tools/terminal_tool.py
gateway/platforms/api_server.py   # 禁止重构；web_chat 可复制逻辑
```

沙箱文件工具必须继续调用上游公开 API（如 `read_file_tool`），在 `gateway/web/tools/` 外包一层 `confine_path`，**不要复制**上游实现。

### 2.2 允许的小补丁（rebase 时必须手解）

这些改动是有意保留的，每次上游同步都要确认还在：

| 文件 | 用途 |
|------|------|
| `run_agent.py` / `agent/conversation_compression.py` | 会话写入时传播 `user_id` |
| `gateway/run.py` | 注册 `Platform.WEB_CHAT`、少量会话修复 |
| `gateway/config.py` | `WEB_CHAT` 枚举与校验 |
| `hermes_cli/platforms.py` | `web_chat` 平台信息 |
| `toolsets.py` | `hermes-web-chat` 工具集 |
| `hermes_state.py` | `list_sessions_rich` / `search_messages` 的 `user_id` 过滤 |
| `pyproject.toml` | `[web-chat]`、`[platform]` extras |
| `tools/web_tools.py` | fork 的 `http-fetch` / 搜索可用性门控（若仍存在） |

冲突原则：**保留 fork 的 additive 行**，再合入上游其余变更。

### 2.3 几乎不会与上游冲突的路径

```
gateway/web/**
gateway/platforms/web_chat.py
platform-api/
web-chat/
deploy/
docs/user-guide/
tests/gateway/test_web_*.py
tests/platform/
```

上游没有这些路径时，`rebase` 通常干净通过。

---

## 3. 两类「更新」不要混用

| 类型 | 目的 | 典型命令 |
|------|------|----------|
| **A. 发布本 fork** | 服务器拉本仓库新提交并重启 | `./deploy/update-platform.sh` 或 `git pull --ff-only` |
| **B. 同步上游 Hermes** | 把 `upstream/main` 合进本 fork | `git fetch upstream && git rebase upstream/main` |

- 生产 VPS 日常升级多半是 **A**。
- 开发者吸收上游新功能、修漏洞时才做 **B**，做完再发布为 **A**。

---

## 4. 同步上游 Hermes（类型 B）操作步骤

### 4.1 前置检查

```bash
# 工作区干净
git status

# 确认 remotes（名称以实际为准）
git remote -v
# 应有类似：
# origin    <your-fork>
# upstream  https://github.com/NousResearch/hermes-agent.git
```

若没有 `upstream`：

```bash
git remote add upstream https://github.com/NousResearch/hermes-agent.git
```

**备份**（尤其生产数据）：

- `$HERMES_HOME/platform.db`（或 PostgreSQL dump）
- `$HERMES_HOME/web_users.db`、`state.db`
- `$HERMES_HOME/web_users_master.key`
- `$HERMES_HOME/web_workspaces/`
- `$HERMES_HOME/.env`、`config.yaml`

建议在独立分支操作：

```bash
git checkout -b sync/upstream-$(date +%Y%m%d)
git fetch upstream
git rebase upstream/main
```

### 4.2 冲突时优先检查的文件

```bash
# rebase 中途或结束后，核对 fork 补丁是否还在
git diff upstream/main -- \
  gateway/run.py \
  gateway/config.py \
  run_agent.py \
  hermes_state.py \
  toolsets.py \
  hermes_cli/platforms.py \
  pyproject.toml
```

重点确认：

1. `Platform.WEB_CHAT` / `hermes-web-chat` 仍存在。
2. `sessions.user_id` 传播逻辑未丢。
3. `toolsets.py` 中 `hermes-web-chat` 仍包含 `web_file_*`、`web_skill_*`、`web_knowledge_search` 等，且**没有**把 `terminal` / upstream `read_file` / `delegate_task` 暴露给 Web。
4. `api_server.py` **无**业务耦合改动。

### 4.3 同步后必须跑的测试

```bash
source .venv/bin/activate   # 或项目约定的 venv
uv pip install -e ".[web-chat,platform]"

scripts/run_tests.sh \
  tests/gateway/test_web_*.py \
  tests/hermes_state/test_user_id_filtering.py \
  tests/platform/
```

有依赖变更时再执行 `uv lock`（若本仓库使用 lockfile）并提交。

### 4.4 同步后本地冒烟

```bash
./startplatform.sh --host 127.0.0.1
# 另开终端：
curl -fsS http://127.0.0.1:8700/api/v1/healthz
curl -fsS http://127.0.0.1:8643/api/healthz
```

浏览器：注册/登录 → 绑定或 API key → 聊天 → 附件/`web_file_read` → 文件页。

---

## 5. 生产环境发布本 fork（类型 A）

**不要只执行 `git pull`。** SPA 在 `gateway/web/_static/`（gitignore），依赖也可能变化。

推荐（systemd）：

```bash
sudo -u hermes -H bash -lc '
  set -e
  export PATH="$HOME/.local/bin:$PATH"
  cd /opt/hermes/hermes-multiuser-web-service
  ./deploy/update-platform.sh --systemd hermes-platform-api,hermes-gateway
'
```

手工等价要点：

1. `git pull --ff-only`
2. `uv pip install -e ".[web-chat,platform]"`（若还需 gateway HTTP：确认 `aiohttp`，必要时加 `messaging`）
3. `cd web-chat && npm ci && npm run build`
4. `systemctl restart hermes-platform-api hermes-gateway`
5. 健康检查 + 浏览器硬刷新

详见 [DEPLOY.md](DEPLOY.md) §日常更新。

### 5.1 `.env` / 配置变更何时生效

`$HERMES_HOME/.env` 由 systemd `EnvironmentFile=` 在**进程启动时**加载。修改后必须：

```bash
sudo systemctl restart hermes-platform-api hermes-gateway
```

`daemon-reload` / `reload` **不会**重新读 `.env`。

---

## 6. 升级时必须核对的运行时不变量

这些是历史踩坑点，代码回退后症状会「看起来像上游问题」，实为 fork 约束丢失：

| 不变量 | 说明 |
|--------|------|
| `enter_user_context(user_id)` | 每个 chat / 沙箱操作必须在用户上下文中 |
| `contextvars.copy_context().run` | `run_in_executor` **不会**自动传播 ContextVar；缺了会导致上游 key 变成占位符 → 401 |
| SSE `done` | 终端 `done` 在主事件循环直接 `put_nowait`，不要用 `call_soon_threadsafe` 推 `done` |
| Quota `finally` | 即使客户端断开也要记账 |
| `web_file_*` 暴露 | `WebChatAgentRunner` 必须合并动态 toolset（`web_file` 等）；仅靠 `_get_platform_tools` 会丢工具 |
| 禁止暴露 | `terminal`、`execute_code`、`browser_*`、`delegate_task`、upstream `read_file`/`write_file` |
| Memory 隔离 | 靠 `HERMES_HOME` override，不要改 `MemoryManager` |
| Cookie | platform-api 与 gateway 共用同一 `PLATFORM_DATABASE_URL` / session 存储 |

### 6.1 工作区文件读取（2026-07 起）

- 工具注册：`gateway/web/tools/sandboxed_file_operations.py`
- 暴露修复：`gateway/web/chat_runner.py` 中 `_resolve_web_chat_enabled_toolsets`
- PDF/Office：`web_file_read` 在 confine 后走 `platform_api.services.extract`

升级后确认：

```bash
# 日志或调试中应看到 web_file 在 enabled toolsets 中
# 聊天附加 uploads/xxx.txt 或 .docx 后，模型应能调用 web_file_read
```

**已知未覆盖（勿当回归 bug 误修进上游）：** MinIO `s3://` 直读、Files `DocumentChunk` 与 Knowledge Center 合并、SPA 跨轮附件路径持久化。

---

## 7. 依赖与 extras

| Extra | 作用 |
|-------|------|
| `[web-chat]` | cryptography、ddgs 等；缺了 gateway 可能拒启 web_chat |
| `[platform]` | FastAPI、SQLAlchemy、文档解析（pypdf/docx 等） |
| `aiohttp` | 实际在 `[messaging]` 等路径；生产建议确认 venv 内可 `import aiohttp` |

安装示例：

```bash
uv pip install -e ".[web-chat,platform]"
# 若仍报 aiohttp missing：
uv pip install "aiohttp==3.13.3"
# 或
uv pip install -e ".[web-chat,platform,messaging]"
```

platform-api 与 gateway 共用同一 `.venv` 时，装完后**两个服务都要重启**（`_AIOHTTP_AVAILABLE` 等在 import 时缓存）。

---

## 8. 回滚

```bash
# 代码回滚到已知好提交
git log --oneline -20
git checkout <KNOWN_GOOD_COMMIT>
uv pip install -e ".[web-chat,platform]"
cd web-chat && npm ci && npm run build
sudo systemctl restart hermes-platform-api hermes-gateway
```

注意：

- 若某版本做了**不可逆 DB 迁移**，仅回滚代码不够，需恢复数据库备份。
- `web_users_master.key` 与数据库必须成对恢复，否则无法解密用户上游 key。

---

## 9. 升级验收清单（可打印勾选）

### 同步上游 / 合并 PR 后

- [ ] 禁止改动区无新增业务逻辑（见 §2.1）
- [ ] `toolsets.py` 中 `hermes-web-chat` 完整且安全白名单正确
- [ ] `user_id` / WEB_CHAT 相关补丁仍在
- [ ] `scripts/run_tests.sh` 相关套件绿色
- [ ] 本地 `startplatform.sh` 健康检查通过

### 生产发布后

- [ ] `curl` `/api/healthz` 与 `/api/v1/healthz` 正常
- [ ] 登录 / 注册 / 绑 key 或 API key 登录可用
- [ ] 对话 SSE 正常
- [ ] 模型列表非空（API key 登录路径已同步 `upstream_api_key_enc`）
- [ ] 附件或工作区文件可通过 `web_file_read` 被引用
- [ ] 租户隔离：用户 A 看不到用户 B 文件
- [ ] SPA 已重建；浏览器硬刷新
- [ ] `.env` 中 `NEW_API_BASE_URL` 从本机 `curl` 可达

### 安全

- [ ] 应用只监听 `127.0.0.1`，公网仅 80/443
- [ ] `PLATFORM_COOKIE_SECURE=true`，`allow_insecure_bind: false`
- [ ] 密钥与 master key 未进 Git / 日志

---

## 10. 推荐工作流小结

```text
开发机：fetch upstream → rebase → 解冲突（仅补丁文件）→ 跑 fork 测试 → 推 origin
生产机：backup → update-platform.sh / pull+venv+SPA+restart → healthz → 冒烟
出问题：checkout 旧提交 + 恢复 DB/key 备份 → restart
```

原则再次强调：

1. **SaaS 逻辑放在 `platform-api/`、`gateway/web/`、`web-chat/`。**
2. **上游核心只留登记过的短补丁。**
3. **沙箱工具 wrap upstream，不复制、不放开 shell。**
4. **发布必重建 SPA，改 `.env` 必双服务 restart。**

如有新增「必须碰上游文件」的补丁，请同步更新本文 §2.2 与 `CLAUDE.md`，避免下一次 rebase 漏合。
