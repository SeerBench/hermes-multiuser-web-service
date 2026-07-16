<p align="center">
  <a href="README.md">English</a> · <b><a href="README.zh-CN.md">中文</a></b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/上游-Hermes%20Agent-blueviolet?style=for-the-badge" alt="Upstream: Hermes Agent"></a>
  <a href="https://github.com/QuantumNous/new-api"><img src="https://img.shields.io/badge/LLM%20网关-new--api-2496ED?style=for-the-badge" alt="LLM Gateway: new-api"></a>
</p>

# Hermes 多用户 Web 服务

基于 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的自托管多用户 AI Agent 平台。项目在上游 Hermes Agent 之外增加了：

- FastAPI Platform API：邮箱注册、登录、工作区、文件/RAG、Memory、Skill、模型偏好、用量和 Admin。
- Agent Gateway：Cookie 鉴权、SSE 流式对话、会话管理、附件上传和每用户 Agent 上下文。
- React Web Chat：面向普通用户的聊天、工作区和账户管理界面。
- 多租户隔离：每用户会话、记忆、Skill、文件和上游 API key 相互隔离。

LLM 路由和计费继续委托给 OpenAI-compatible 网关（推荐
[new-api](https://github.com/QuantumNous/new-api)）。平台注册可自动 provisioning
上游 key，也支持注册后手动绑定；原有 API key 登录保留为兼容入口。

## 当前完成度

截至 2026-07-16，Phase 0–5 的 MVP 主链路已可用，当前重点转向检索基础设施和生产硬化。

| 模块 | 状态 | 已有能力 |
|---|---|---|
| 身份与账户 | 可用 | 注册/登录/登出、自动或手动 bind-key、资料/头像、改密、Legacy key 登录 |
| Chat | 可用 | SSE 流式、推理与工具事件、会话搜索/置顶/归档/重命名/删除、重试/编辑/复制/分享 |
| 附件 | 可用 | 本地上传、文件库引用、图片悬浮预览、Markdown/PDF Drawer 预览 |
| 文件工作区 | 可用 | 上传进度、文件夹、分类、标签、筛选、重命名/移动/删除、内容预览 |
| RAG | MVP 可用 | 文档解析、同步分块、关键词检索、可选 embedding、`web_knowledge_search` |
| Memory / Skill | 可用 | Memory 编辑、Skill catalog/安装/预览/创建/编辑/删除/启停 |
| 模型与用量 | 可用 | 可搜索模型选择、常用模型、workspace 偏好、new-api 用量与日志 |
| Admin | 基础可用 | 用户列表、启用/禁用、用户/文件/chunk 统计、审计日志写库 |
| 响应式体验 | 可用 | 移动端导航/会话抽屉、Onboarding、中英双语、主题和字号切换 |
| 生产硬化 | 进行中 | TLS/备份文档已有；压测、自动备份、异步 Worker、Compose CI 待补 |

完整进度和未完成项见 [`TODOLIST.md`](TODOLIST.md)。

## 架构

```text
Browser SPA
  │
  ├─ /api/v1/* ──────▶ Platform API :8700
  │                     auth / workspace / files / RAG / memory / skills / admin
  │
  └─ /api/chat 等 ───▶ Agent Gateway :8643
                        SSE / conversations / uploads / Hermes runner
                                   │
                                   ▼
                        Hermes Agent（上游运行时）
                                   │
                                   ▼
                        new-api / OpenAI-compatible gateway
```

本地开发时，Agent Gateway 会把 `/api/v1/*` 代理到 Platform API；生产环境可使用
`deploy/nginx.conf` 做相同路由。

数据边界：

- Platform 控制面：SQLite（本地默认）或 PostgreSQL。
- 用户工作区：`$HERMES_HOME/web_workspaces/<user_id>/`。
- Agent 会话：Hermes `state.db`，所有查询按 `user_id` 过滤。
- 上游 key：通过 `KeyVault` 加密存储，请求期间使用 ContextVar 注入。
- 对象存储、Redis Worker 和 pgvector cosine 检索尚未接入业务主路径。

## 快速开始

### 1. 安装

```bash
git clone https://github.com/SeerBench/hermes-multiuser-web-service.git
cd hermes-multiuser-web-service

./setup-hermes.sh
source .venv/bin/activate
uv pip install -e ".[web-chat,platform]"

cd web-chat
npm install
npm run build
cd ..
```

### 2. 配置上游 LLM 网关

在 `$HERMES_HOME/.env`（默认 `~/.hermes/.env`）中配置：

```bash
NEW_API_BASE_URL=https://your-new-api.example.com

# 自动开户时配置；不配置则使用 manual 模式，让用户注册后绑定 key
NEW_API_ADMIN_TOKEN=replace-me
UPSTREAM_PROVISIONER=auto
```

Gateway 首次启动会在 `$HERMES_HOME/web_users_master.key` 自动生成 Fernet 主密钥。
生产环境必须将该 `0600` 文件与数据库一同安全备份。

### 3. 启动 Platform SaaS

```bash
# SQLite 控制面，默认仅监听 localhost
./startplatform.sh --host 127.0.0.1

# 使用 deploy/docker-compose.yml 中的 PostgreSQL
./startplatform.sh --postgres --host 127.0.0.1
```

打开 <http://127.0.0.1:8643/>。Platform API 默认监听 `:8700`，Gateway/SPA
监听 `:8643`。

首次创建管理员：

```bash
source .venv/bin/activate
python scripts/create_admin.py \
  --email admin@example.com \
  --password 'replace-with-a-strong-password'
```

仅需要原有 API key 登录模式时，可运行：

```bash
./startweb.sh --host 127.0.0.1
```

详细部署说明见 [`deploy/README.md`](deploy/README.md) 和
[`docs/user-guide/platform-saas.md`](docs/user-guide/platform-saas.md)。

## 用户能力

### Chat

- SSE token、reasoning、tool start/end、usage 和 error 事件。
- 新建、切换、搜索、置顶、归档、重命名和删除会话。
- 消息复制、编辑、重试，对话 Markdown 导出和系统分享。
- 可搜索模型下拉、常用模型过滤和会话宽度切换。
- Composer 自动高度、附件 chips、图片预览和文件库选择。
- 移动端会话 Drawer、顶部/底部滚动渐隐和响应式布局。

### 工作区

- 文件上传百分比和 ingestion 状态轮询。
- 文件、图片 Tab；文件夹、分类和标签管理。
- 文件重命名、移动、删除、标签筛选和“引用到对话”。
- 图片悬浮预览，Markdown/PDF Drawer 预览。
- `MEMORY.md` / `USER.md` 编辑。
- Skill catalog、workspace Skill CRUD、SKILL.md 预览和启停。

### 账户与运营

- Profile、头像、密码、API key、常用模型和用量日志。
- Account 下拉可直接切换 system/light/dark 主题和字体大小。
- Admin 可查看统计、启用或禁用用户；操作写入 `audit_logs`。

## 认证模式

三条路径并存：

1. **平台注册（主路径）**：邮箱密码注册，Platform UUID 作为稳定 `user_id`。
2. **注册后绑定 key**：自动 provisioning 不可用时进入 `pending_bind`，在
   Onboarding 或 Settings 绑定上游 key。
3. **Legacy key 登录（兼容路径）**：通过 `/api/auth/login` 验证 key，并使用派生
   user id 访问旧工作区。

`hermes_session` Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产环境应启用
`Secure`。更换平台用户绑定的上游 key 不会改变其 UUID，也不会丢失工作区数据。

## API 概览

### Platform API：`/api/v1`

- `/auth/*`：register、login、logout、bind-key、me、change-password。
- `/billing/*`：usage、logs。
- `/workspaces/*`：workspace、models、preferences。
- `/workspaces/{id}/files*`：上传、列表、状态、内容、ingest、重命名/移动/标签、删除。
- `/workspaces/{id}/file-folders*`、`file-categories*`、`file-tags*`。
- `/workspaces/{id}/knowledge/search`。
- `/workspaces/{id}/memory`、`skills*`。
- `/admin/*`：users、stats、skills。

### Agent Gateway：`/api`

- `/chat`：SSE 流式 Agent 响应。
- `/conversations*`：会话读取和管理。
- `/uploads`：聊天快速附件上传。
- `/commands`、`/command`：Slash command。
- `/me`、`/auth/login`、`/auth/logout`：Gateway/Legacy 认证。

完整端点清单见 [`TODOLIST.md`](TODOLIST.md#api-端点总表)。

## 多租户与安全边界

- 每个请求都在 `enter_user_context(user_id)` 内运行。
- `HERMES_HOME`、workspace 和 upstream key 通过 ContextVar 隔离，并显式传播到
  executor thread。
- `web_file_*` 在调用上游文件工具前使用 `confine_path` 阻止路径越界。
- 会话、Workspace、文件、Memory、Skill 和知识库查询均校验 owner/tenant。
- Web toolset 默认排除 `terminal`、`code_execution`、`browser_*` 和
  `delegate_task`；当前不是 OS 级不可信代码沙箱。
- LLM 额度和计费由 new-api 等上游网关执行，本项目不重复实现本地 billing engine。

## 测试与质量

请使用项目测试 wrapper，避免本地凭证、时区和并发环境造成测试漂移：

```bash
# Platform API
scripts/run_tests.sh tests/platform/

# Gateway、沙箱、会话和 ContextVar 隔离
scripts/run_tests.sh tests/gateway/test_web_*.py \
  tests/hermes_state/test_user_id_filtering.py

# Web Chat
cd web-chat
npm run verify
```

最近一次完整相关验证（2026-07-16）：

- Platform：17 个文件，57 项测试通过。
- Gateway + SessionDB：18 个文件，291 项测试通过。
- Web Chat：47 个文件，164 项测试通过。
- TypeScript typecheck 与 Vite production build 通过。

## 上游兼容策略

本项目坚持“业务能力放在 sidecar/fork 路径，上游核心保持可合并”：

- 多用户代码位于 `gateway/web/`、`gateway/platforms/web_chat.py`、
  `platform_api/` 和 `web-chat/`。
- 沙箱工具包装上游公共函数，不复制 `tools/file_operations.py` 等实现。
- `run_agent.py`、`hermes_state.py`、`gateway/run.py` 等仅保留少量具名、向后兼容的
  user_id 传播和平台注册补丁。
- Memory 隔离通过 `HERMES_HOME` ContextVar 完成，不修改
  `agent/memory_manager.py`。

同步上游：

```bash
git fetch upstream
git rebase upstream/main
```

具体边界和 rebase 注意事项见 [`CLAUDE.md`](CLAUDE.md)。

## 尚未完成

- Redis 异步 ingestion Worker、失败重试和死信队列。
- MinIO/S3 业务接入。
- 原生 pgvector 列、索引和 cosine 检索。
- 登录失败速率限制。
- Admin 分页、用户搜索、审计日志 UI 和全局 Skill UI。
- 50 用户压测、自动备份、优雅停机和 Docker Compose CI。
- Markdown 代码块高亮/复制、知识库试搜索、拖拽/粘贴上传。

这些项目的优先级和验收标准记录在 [`TODOLIST.md`](TODOLIST.md)。

## 文档

- [`docs/user-guide/platform-saas.md`](docs/user-guide/platform-saas.md)：Platform SaaS 配置。
- [`docs/user-guide/web-chat.md`](docs/user-guide/web-chat.md)：Gateway 运维和更新。
- [`deploy/README.md`](deploy/README.md)：Compose/nginx 部署。
- [`web-chat/README.md`](web-chat/README.md)：SPA 开发说明。
- [`AGENTS.md`](AGENTS.md)：上游 Hermes 工程指南。

## 致谢与许可

- 上游 Agent：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- 参考 LLM 网关：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)
- License：MIT，见 [`LICENSE`](LICENSE)
