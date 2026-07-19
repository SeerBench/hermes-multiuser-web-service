# Hermes 多用户 SaaS 平台

面向普通用户的多租户 AI Agent 服务，在现有 `web_chat` 网关之上增加 FastAPI 控制面。

## 架构

| 组件 | 端口 | 职责 |
|------|------|------|
| **platform-api** | 8700 | 注册登录、工作区、RAG、Memory/Skill 配置、Admin |
| **web_chat** | 8643 | SSE 对话、会话 CRUD、legacy API key 登录 |
| **PostgreSQL** | 5432 | 控制面（用户、会话 cookie、文件元数据、向量块） |

nginx 将 `/api/v1/*` 转发到 platform-api，`/api/chat` 等转发到 web_chat。详见 [`deploy/README.md`](../../deploy/README.md)。

## 认证

三条路径并存：

1. **主路径** — 邮箱注册：`POST /api/v1/auth/register`
2. **备路径** — Legacy API key：`POST /api/auth/login`（内测/运维）
3. **混合** — 注册后 `upstream_status=pending_bind`，用户在设置页 `bind-key`

`hermes_session` cookie 由 platform-api 签发，web_chat 通过共享 `PlatformStore` 验证。

## 环境变量

```bash
export PLATFORM_DATABASE_URL=postgresql+psycopg://hermes:hermes@127.0.0.1:5432/hermes_platform
export NEW_API_BASE_URL=https://your-new-api.example.com
export NEW_API_ADMIN_TOKEN=...          # AutoProvisioner
export UPSTREAM_PROVISIONER=manual       # 或 auto
export HERMES_WEB_KEY_VAULT_SECRET=...    # Fernet 主密钥
```

本地测试可使用 SQLite：`PLATFORM_DATABASE_URL=sqlite:///./platform.db`

## 安装与启动

```bash
uv pip install -e ".[web-chat,platform]"
python scripts/create_admin.py --email admin@example.com --password 'changeme123'
hermes-platform-api   # :8700
hermes gateway          # 启用 platforms.web_chat
cd web-chat && npm run build
```

## 多租户隔离

- `user_id` = 平台 UUID（注册路径）或 legacy `derive_user_id(api_key)`
- 工作区：`$HERMES_HOME/web_workspaces/<user_id>/`
- 每个 chat 请求在 `enter_user_context(user_id)` 内执行
- 知识库检索按 `workspace_id` / `tenant_id` 过滤

## RAG（MVP）

1. 用户在「文件」页上传 PDF/DOCX/TXT 等
2. 同步 ingestion：解析 → 分块 → 可选 embedding
3. Agent 通过 `web_knowledge_search` 工具检索（需 `PLATFORM_DATABASE_URL`）

## 生产清单

正式签署版见 **[SECURITY_REVIEW.md](SECURITY_REVIEW.md)**（Cookie、越权、密钥、依赖审计）。

- [ ] TLS 终止（nginx）+ `PLATFORM_COOKIE_SECURE=true`
- [ ] PostgreSQL 定期 `pg_dump` 备份（若使用 PG；SQLite 见 `scripts/backup-platform.sh`）
- [ ] 归档 `web_workspaces/` 与 `state.db`
- [ ] 监控 `/api/healthz` 与深度 `/api/v1/healthz`（`checks.database` / redis / object_store）
- [ ] 10 VU k6 基线已跑通（[deploy/loadtest](../../deploy/loadtest/README.md)）；50 用户正式压测按需
- [ ] 已完成或明确 Waived [SECURITY_REVIEW.md](SECURITY_REVIEW.md) 签署

## 测试

自动化：

```bash
scripts/run_tests.sh tests/platform/
scripts/run_tests.sh tests/gateway/test_web_*.py
scripts/verify-web-chat.sh
```

人工验收步骤见 [`platform-manual-testing.zh-CN.md`](platform-manual-testing.zh-CN.md)。
