---
name: Phase6 health load security
overview: 落地 Phase 6 三项硬化：Platform API 深度 healthz（DB/Redis/MinIO）、k6 10 用户压测脚本与文档、正式安全 review checklist，并同步更新 TODOLIST / DEPLOY。
todos:
  - id: healthz-tests
    content: 写 test_healthz.py（happy / redis fail / minio fail / db fail）
    status: completed
  - id: healthz-impl
    content: 实现 health_checks + store.ping + 改写 /healthz
    status: completed
  - id: k6-loadtest
    content: deploy/loadtest k6 脚本 + README；DEPLOY 链入
    status: completed
  - id: security-doc
    content: SECURITY_REVIEW.md + 文档交叉链接
    status: completed
  - id: todolist-sync
    content: 更新 TODOLIST Phase 6 / 下一步优先
    status: completed
isProject: false
---

# Phase 6：深度 healthz · 10 用户压测 · 安全 checklist

## 现状

- [`platform_api/routers/health.py`](platform_api/routers/health.py) 仅返回 `{"status":"ok"}`，触碰 store 初始化但无真实探测。
- Redis / MinIO 已有配置探测入口：[`queue.redis_configured`](platform_api/services/queue.py)、[`object_store.minio_configured`](platform_api/services/object_store.py)。
- Gateway [`/api/healthz`](gateway/platforms/web_chat.py) 保持轻量存活（不改 Hermes 面过大）；深度探测集中在 Platform API。
- Phase 6 清单见 [`TODOLIST.md`](TODOLIST.md) §6.1–6.3：安全 checklist、深度 health、压测仍开着。

## 1. 深度 healthz（测试先行）

**契约**（扩展现有 `GET /api/v1/healthz`，不另开路径，避免改 nginx/start 脚本）：

```json
{
  "status": "ok" | "degraded",
  "service": "platform-api",
  "checks": {
    "database": { "status": "ok" | "error", "latency_ms": 1.2 },
    "redis": { "status": "ok" | "skipped" | "error", "detail": "..." },
    "object_store": { "status": "ok" | "local" | "error", "detail": "..." }
  }
}
```

| Check | 行为 |
|-------|------|
| `database` | 必选：对 `PlatformStore` engine 执行 `SELECT 1` |
| `redis` | 未设 `REDIS_URL` → `skipped`；已设 → `PING` |
| `object_store` | 未设 `MINIO_ENDPOINT` → `local`（本地 uploads，视为健康）；已设 → `head_bucket` |

**HTTP 状态**：

- `database` 失败，或已配置的 redis/minio 探测失败 → **503**，`status: "degraded"`
- 全部通过（含 skipped/local）→ **200**，`status: "ok"`

**实现落点**：

- 新建 [`platform_api/services/health_checks.py`](platform_api/services/health_checks.py)：`check_database(store)` / `check_redis()` / `check_object_store()` / `run_health_checks(store) -> (http_status, body)`
- 改写 [`platform_api/routers/health.py`](platform_api/routers/health.py) 调用上述函数；用 `JSONResponse`
- `PlatformStore` 增加轻量 `ping()`（`session.execute(text("SELECT 1"))`），避免 health 层直接摸 engine 私有字段过多

**测试** [`tests/platform/test_healthz.py`](tests/platform/test_healthz.py)：

1. Happy path（默认 SQLite、无 Redis/MinIO）→ 200，`database=ok`，`redis=skipped`，`object_store=local`
2. Redis 已配置但 PING 失败（mock `_redis`）→ 503，`redis=error`
3. MinIO 已配置但 head_bucket 失败（mock）→ 503，`object_store=error`
4. DB ping 失败（mock）→ 503，`database=error`

跑：`scripts/run_tests.sh tests/platform/test_healthz.py`

更新 [`startplatform.sh`](startplatform.sh) 的 health 等待逻辑：仍接受 200；文档注明生产可用 `jq` 看 `checks`。

## 2. 10 用户压测（选定 k6）

不引入 Locust 进 `pyproject.toml`（避免污染主依赖）。交付：

```
deploy/loadtest/
  README.md          # 安装 k6、环境变量、解读阈值
  k6-platform.js     # 10 VU 场景
```

**场景**（不打真实 LLM，避免费用与不确定性）：

1. Setup：注册或登录拿 `hermes_session` Cookie（脚本用 `SETUP_EMAIL` / `SETUP_PASSWORD`；或 `PRESEED=1` 跳过注册）
2. 每 VU 循环：`GET /api/v1/healthz` → `GET /api/v1/auth/me` → `GET /api/v1/workspaces` →（若有 workspace）`GET .../files`
3. 并行轻探 Gateway：`GET /api/healthz`、`GET /api/me`（带同一 Cookie）
4. 默认：`vus=10`，`duration=2m`；阈值建议文档写清（p95 healthz &lt; 200ms、error rate &lt; 1%）

运行示例：

```bash
k6 run -e BASE_URL=https://hermes.example.com \
  -e EMAIL=load@example.com -e PASSWORD='...' \
  deploy/loadtest/k6-platform.js
```

在 [`docs/user-guide/DEPLOY.md`](docs/user-guide/DEPLOY.md) 增加一小节「压测（10 VU）」链到 `deploy/loadtest/README.md`。
TODOLIST §6.3：将「50 并发」拆为 `[x] 10 VU k6 基线脚本` + `[ ] 50 并发正式压测`。

## 3. 正式安全 review checklist

新建 [`docs/user-guide/SECURITY_REVIEW.md`](docs/user-guide/SECURITY_REVIEW.md)，可勾选、可签署（日期/审查人）。章节：

1. **Cookie / Session** — HttpOnly、`SameSite`、生产 `PLATFORM_COOKIE_SECURE`、HTTPS；对照 `test_cookie_secure.py`、`scripts/verify-https-cookies.sh`
2. **越权 / 多租户** — `enter_user_context`、workspace 归属、文件 `storage_key` 沙箱、Admin 403；对照 `test_isolation*.py`、`test_storage_key_sandbox.py`
3. **密钥** — `HERMES_WEB_KEY_VAULT_SECRET`、upstream key 加密、日志不落明文、`.env` 权限；轮换步骤摘要
4. **依赖审计** — `uv lock` 完整、定期 `uv pip audit` / `npm audit`（web-chat）、无未 pin 上界依赖
5. **网络面** — 仅 443 公网；8700/8643/Redis/MinIO/SQLite 不暴露
6. **签署栏** — Reviewer / Date / Result (Pass|Fail|Waived)

[`docs/user-guide/platform-saas.md`](docs/user-guide/platform-saas.md) 与 DEPLOY 生产 checklist 各加一行链接到该文档。

## 4. 文档与 TODOLIST 同步

更新 [`TODOLIST.md`](TODOLIST.md)：

- §0.4 / §6.2 healthz → 深度探测已做
- §6.1 安全 review → checklist 文档已做（签署仍靠人工）
- §6.3 → 10 VU 脚本已交付
- 「下一步优先」条目相应勾掉/改写
- 变更日志加 2026-07-19 一行

## 范围外（明确不做）

- 改 Gateway `/api/healthz` 做 DB 探测（Gateway 无 Platform DB 职责）
- Locust / 真实 `/api/chat` LLM 压测
- 50 VU 正式报告、Compose CI job、优雅停机

```mermaid
flowchart LR
  probe[GET /api/v1/healthz]
  db[(SQLite_or_PG)]
  redis[(Redis_optional)]
  minio[(MinIO_optional)]
  probe --> db
  probe --> redis
  probe --> minio
  k6[k6_10VU] --> probe
  k6 --> me[auth_me_workspaces_files]
  k6 --> gw[/api/healthz_/api/me]
```
