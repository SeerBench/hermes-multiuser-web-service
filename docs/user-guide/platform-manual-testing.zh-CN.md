# Platform / Web Chat 人工测试指南

> **Fork 专属文档** — 路径 `docs/user-guide/` 在上游 Hermes 不存在，  
> `git rebase upstream/main` 时不会产生合并冲突。  
> 自动化测试命令见 [`platform-saas.md`](platform-saas.md#测试)。

面向 **Platform SaaS MVP** 与 **Legacy web_chat** 的本地/预发人工验收。  
架构与配置背景见 [`platform-saas.md`](platform-saas.md)、[`web-chat.md`](web-chat.md)、[`deploy/README.md`](../../deploy/README.md)。

---

## 先决条件（一次性）

```bash
cd /path/to/hermes-multiuser-web-service
source .venv/bin/activate   # 或 venv/
uv pip install -e ".[web-chat,platform]"

# 上游 LLM 网关（gateway 启动必填）
# 编辑 ~/.hermes/.env：
#   NEW_API_BASE_URL=https://你的-new-api-地址

# 推理 key（二选一）
# A) 全局 fallback，方便先跑通 chat：
#   OPENROUTER_API_KEY=sk-or-...
# B) 每用户在设置页 bind 自己的 sk- key（更接近生产）
```

### Platform 控制面数据库

```bash
# 本地最快：SQLite（无需 Docker）
export PLATFORM_DATABASE_URL=sqlite:///$HOME/.hermes/platform.db

# 或 PostgreSQL（更接近生产）
docker compose -f deploy/docker-compose.yml up -d postgres
export PLATFORM_DATABASE_URL=postgresql+psycopg://hermes:hermes@127.0.0.1:5432/hermes_platform
```

### 创建管理员（测 Admin 页）

```bash
python scripts/create_admin.py --email admin@example.com --password 'changeme123'
```

---

## 模式 A：Platform 全链路（推荐）

**一键启动**（platform-api + gateway，SQLite 控制面）：

```bash
./startplatform.sh --host 127.0.0.1
# 使用 PostgreSQL：./startplatform.sh --postgres --host 127.0.0.1
```

或手动分终端启动（等价于脚本内部流程）：

### 终端 1 — platform-api（:8700）

```bash
source .venv/bin/activate
export PLATFORM_DATABASE_URL=sqlite:///$HOME/.hermes/platform.db
export UPSTREAM_PROVISIONER=manual
hermes-platform-api
```

### 终端 2 — gateway / web_chat（:8643）

```bash
source .venv/bin/activate
export PLATFORM_DATABASE_URL=sqlite:///$HOME/.hermes/platform.db   # 必须与终端 1 相同
./startweb.sh --host 127.0.0.1
# 或：hermes gateway run
```

### 终端 3 — 前端

| 方式 | 命令 | 访问地址 | 适用 |
|------|------|----------|------|
| **Vite 热更新**（调试 UI） | `cd web-chat && npm run dev` | http://127.0.0.1:5173 | `/api/v1`→8700，`/api`→8643 |
| **生产构建** | `cd web-chat && npm run build` | http://127.0.0.1:8643 | 与部署一致 |

### 启动自检

```bash
curl -s http://127.0.0.1:8700/api/v1/healthz   # platform-api
curl -s http://127.0.0.1:8643/api/healthz        # gateway
```

两者均 200 后再开浏览器。

---

## 模式 B：仅 Legacy Chat

不测 Platform 时，只验证多用户 key 登录 + 对话：

```bash
# 不设置 PLATFORM_DATABASE_URL，或停掉 platform-api
./startweb.sh --host 127.0.0.1
# 打开 http://127.0.0.1:8643 → 发消息 → 弹 Key 模态框 → 粘贴 sk-
```

SPA 检测到 platform-api 不可达时自动退回 Legacy 路径。

---

## 人工测试清单

### 1. 认证（Platform 主路径）

1. 打开 http://127.0.0.1:5173（或 :8643）
2. 应出现 **注册/登录**（`AuthPage`），而非 Legacy Key 弹窗
3. 注册新用户 → 登录 → 进入 Chat
4. **设置** → **绑定 upstream key**（须在 `NEW_API_BASE_URL` 上有效）
5. 绑定前发消息应 **403**；绑定后应能流式回复

### 2. Chat 核心

- 空状态、发送、SSE 流式 token、多轮对话
- 「+ New chat」、会话列表、切换会话
- 斜杠命令（如 `/help`）
- 附件上传（若启用）

### 3. Platform 各页

| 路由 | 验证点 |
|------|--------|
| `#/files` | 上传 PDF/TXT → ingestion 状态 |
| `#/memory` | 读写 MEMORY.md |
| `#/skills` | 技能列表 / 开关 |
| `#/settings` | 用户信息、bind-key、登出 |
| `#/admin` | 仅 admin 可见；用户列表 / 禁用 |

### 4. Legacy 备路径

1. 在 `AuthPage` 使用「API Key 登录」入口，或停掉 platform-api 后刷新
2. 粘贴 `sk-...` → Cookie 会话 → Chat

### 5. 多租户隔离（建议两个浏览器 / 无痕窗口）

- 用户 A 的会话，用户 B 无法读 / 改 / 删
- 用户 A 搜不到用户 B 的知识库
- Admin 禁用用户 B 后，B 无法登录 / chat

### 6. 双用户并发（可选）

两账号同时发消息，确认回复与工作区不串。

---

## 建议首次验收顺序（约 15 分钟）

```
健康检查 → 注册/登录 → bind-key → 发一条 chat
  → 上传文件 → 知识库问答
  → 第二账号验证看不到对方数据
  → Admin 禁用第二账号
```

---

## 自动化测试（提交前建议先跑）

```bash
scripts/run_tests.sh tests/platform/          # Platform E2E + 隔离（20 cases）
scripts/run_tests.sh tests/gateway/test_web_*.py
scripts/verify-web-chat.sh                    # typecheck + vitest + build
```

---

## 常见问题

| 现象 | 排查 |
|------|------|
| gateway 起不来 | `NEW_API_BASE_URL` 是否在 `~/.hermes/.env` |
| 不出现注册页 | platform-api 是否在跑；`/api/v1/healthz` 是否 200 |
| Chat 403 `upstream_key_required` | 设置页 bind-key 未完成 |
| Chat 401 Invalid token | bind 的 key 与 `NEW_API_BASE_URL` 不匹配 |
| UI 是占位页 | `cd web-chat && npm run build` |
| Cookie 不生效 | 使用 `127.0.0.1` 而非 `localhost`（与 E2E 测试同一注意点） |

---

## 文档维护说明

| 放这里 ✅ | 不要放这里 ❌ |
|-----------|----------------|
| `docs/user-guide/*.md`（本目录，fork 专属） | `AGENTS.md`、`CONTRIBUTING.md`（上游工程指南） |
| `docs/plans/*.md`（设计计划，非操作手册） | `website/docs/`（上游 Docusaurus 站点） |
| `deploy/README.md` 仅加一行链接 | 在 `README.md` 写大段 fork 专属内容 |

本文件与 [`platform-saas.md`](platform-saas.md) 分工：**saas** = 架构与配置；**本文件** = 人工验收步骤与清单。
