# Hermes SaaS 部署（MVP）

## 组件

| 服务 | 端口 | 说明 |
|------|------|------|
| `web_chat` gateway | 8643 | Agent SSE、会话、legacy key 登录 |
| `platform-api` | 8700 | 注册登录、工作区、RAG、Admin |
| PostgreSQL + pgvector | 5432 | 控制面数据库 |
| Redis | 6379 | 预留异步 ingestion worker |
| MinIO | 9000 | 预留对象存储 |
| nginx | 8080 | 统一入口 |

## 快速开始（开发机）

```bash
# 1. 基础设施
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d postgres redis minio

# 2. Python 依赖
source .venv/bin/activate
uv pip install -e ".[web-chat,platform]"

# 3. 环境变量（示例使用 SQLite 本地测试可跳过 PG）
export PLATFORM_DATABASE_URL=postgresql+psycopg://hermes:hermes@127.0.0.1:5432/hermes_platform
export UPSTREAM_PROVISIONER=manual
export NEW_API_BASE_URL=https://your-new-api.example.com

# 4. 创建管理员
python scripts/create_admin.py --email admin@example.com --password 'changeme123'

# 5. 启动服务（两个终端）
hermes-platform-api
hermes gateway   # 确保 config.yaml 启用 platforms.web_chat

# 6. 构建 SPA
cd web-chat && npm ci && npm run build
```

## nginx 生产入口

`deploy/nginx.conf` 将 `/api/v1/*` 转发到 platform-api，`/api/chat` 等转发到 web_chat。

## 备份

- **PostgreSQL**: `pg_dump hermes_platform > backup.sql`
- **用户工作区**: 归档 `$HERMES_HOME/web_workspaces/`
- **Hermes 会话**: `$HERMES_HOME/state.db`（按 user_id 列隔离）

## 监控建议

- `/api/healthz`（gateway）与 `/api/v1/healthz`（platform）做存活探测
- 关注 gateway 日志 `hermes.gateway.web_chat` 与 `hermes.web.platform.store`
- 50 用户规模：单进程 gateway + 单 platform-api 足够；压测后再水平扩展
