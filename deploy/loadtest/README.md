# Platform SaaS 压测（k6 · 10 VU 基线）

对 **Platform API** 与 **Gateway** 做轻量并发基线，**不调用真实 LLM**（不打 `/api/chat`），避免费用与模型抖动干扰结果。

## 安装 k6

macOS：

```bash
brew install k6
```

Linux（示例）：

```bash
# 见 https://grafana.com/docs/k6/latest/set-up/install-k6/
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6
```

## 场景说明

| 步骤 | 路径 | 说明 |
|------|------|------|
| setup | `POST /api/v1/auth/register`（可跳过）+ `login` | 获取 `hermes_session` |
| 循环 | `GET /api/v1/healthz` | 深度探测（DB / Redis / MinIO） |
| 循环 | `GET /api/v1/auth/me` | 会话 |
| 循环 | `GET /api/v1/workspaces` + `.../files` | 工作区列表 |
| 循环 | `GET /api/healthz`、`GET /api/me` | Gateway 存活 + 会话 |

默认：**10 VU × 2 分钟**，每迭代 `sleep(1)`。

## 运行

本地（`startplatform.sh` 默认端口）：

```bash
# 先启动平台；准备一个测试账号或让脚本自动注册
k6 run \
  -e BASE_URL=http://127.0.0.1:8700 \
  -e GATEWAY_URL=http://127.0.0.1:8643 \
  -e EMAIL=loadtest@example.com \
  -e PASSWORD='loadtest-password-123' \
  deploy/loadtest/k6-platform.js
```

经 nginx 的生产域名（同源代理）：

```bash
k6 run \
  -e BASE_URL=https://hermes.example.com \
  -e GATEWAY_URL=https://hermes.example.com \
  -e EMAIL=load@example.com \
  -e PASSWORD='...' \
  -e SKIP_REGISTER=1 \
  deploy/loadtest/k6-platform.js
```

常用环境变量：

| 变量 | 默认 | 含义 |
|------|------|------|
| `BASE_URL` | `http://127.0.0.1:8700` | Platform API（或 nginx 入口） |
| `GATEWAY_URL` | 若 BASE 端口为 8700 则改为 8643 | Agent Gateway |
| `EMAIL` / `PASSWORD` | 见脚本 | 压测账号 |
| `SKIP_REGISTER` | 空 | `1` = 只登录（账号已存在） |
| `VUS` | `10` | 虚拟用户数 |
| `DURATION` | `2m` | 持续时间 |

## 解读阈值

脚本内置 thresholds（失败则 k6 exit ≠ 0）：

- `http_req_failed` rate **&lt; 1%**
- `platform_healthz_ms` **p95 &lt; 200ms**
- `platform_errors` rate **&lt; 1%**（业务 check 失败）

建议同时人工确认：

1. `GET /api/v1/healthz` 返回 `status: "ok"`，且 `checks.database/redis/object_store` 符合部署形态。
2. 压测期间 SQLite/磁盘无明显尖刺；若 `REDIS_URL` / MinIO 已启用，确认 worker 与对象存储无连接风暴。
3. 本基线 **不能** 代替 50 并发正式压测（含聊天 SSE）；见 `TODOLIST.md` Phase 6.3。

## 健康检查样例

```bash
curl -fsS http://127.0.0.1:8700/api/v1/healthz | jq .
# 生产：
curl -fsS https://hermes.example.com/api/v1/healthz | jq '.status, .checks'
```
