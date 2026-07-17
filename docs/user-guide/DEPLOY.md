# Hermes Multi-User Web Service VPS 部署手册

本文面向 Ubuntu 22.04/24.04 LTS VPS，给出一套适合约 50 名用户的生产部署流程。目标架构为：

```text
Internet
  │ HTTPS :443
  ▼
nginx（TLS、静态 SPA、反向代理）
  ├─ /api/v1/* ──→ platform-api 127.0.0.1:8700
  ├─ /api/*    ──→ web_chat gateway 127.0.0.1:8643
  └─ /*        ──→ gateway/web/_static/

platform-api + web_chat
  ├─ PostgreSQL + pgvector（Docker，仅监听 127.0.0.1:5432）
  ├─ $HERMES_HOME/web_workspaces/<user_id>/
  └─ new-api（外部或独立部署的 LLM 网关）
```

推荐在一台 VPS 上运行一个 `platform-api` 进程和一个 `web_chat` gateway
进程，由 systemd 管理。PostgreSQL 使用 Docker 持久卷；nginx 安装在主机上。
Redis 和 MinIO 在当前 MVP 中仍属预留组件，不是启动平台的必需项。

> `startplatform.sh` 适合本地开发和私有测试。生产环境建议使用本文的
> systemd 双服务方案，因为脚本会以前台方式管理 gateway，并会写入
> `allow_insecure_bind: true`，不适合作为公网 TLS 部署的长期进程管理方式。

## 1. 部署前准备

### 1.1 VPS 建议规格

- 最低：2 vCPU、4 GB RAM、40 GB SSD。
- 推荐：4 vCPU、8 GB RAM、80 GB SSD。
- 系统：Ubuntu 22.04 或 24.04 LTS，x86_64/arm64 均可。
- 域名：例如 `hermes.example.com`，A/AAAA 记录已指向 VPS。
- 上游：可访问的 new-api 地址；`manual` 模式需用户自行绑定 key，
  `auto` 模式还需 new-api Admin Token。

Agent 并发时内存会明显增加。小型 VPS 可先将
`max_concurrent_agents` 设置为 4–8，观察峰值 RSS 后再调整。

### 1.2 网络与防火墙

公网只开放：

- `22/tcp`：SSH（最好限制来源 IP）；
- `80/tcp`：HTTP，用于跳转 HTTPS 和 ACME；
- `443/tcp`：HTTPS。

不要向公网开放 `5432`、`6379`、`9000`、`8643`、`8700`。

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

如果云厂商还有 Security Group / 防火墙，也只放行 22、80、443。

## 2. 安装系统依赖

以下命令以具有 sudo 权限的运维账号执行：

```bash
sudo apt update
sudo apt install -y \
  ca-certificates curl git nginx certbot python3-certbot-nginx \
  build-essential pkg-config
```

安装 Docker Engine 和 Compose plugin。生产环境建议按 Docker 官方仓库安装；
如果 VPS 已安装，可跳过：

```bash
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo systemctl enable --now docker
docker --version
docker compose version
```

安装 Node.js 20 LTS 或更高版本，用于构建 SPA：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

创建专用的非登录服务用户：

```bash
sudo useradd --system --create-home --home-dir /home/hermes \
  --shell /bin/bash hermes
sudo usermod -aG docker hermes
sudo mkdir -p /opt/hermes
sudo chown hermes:hermes /opt/hermes
```

重新登录一次，或重启 Docker 后再切换用户，使 `docker` 组生效。

## 3. 获取代码并安装运行环境

将仓库地址替换为实际 fork 地址：

```bash
sudo -u hermes -H bash
cd /opt/hermes
git clone <YOUR_REPOSITORY_URL> app
cd app
git checkout main
```

安装 `uv`，创建 Python 3.11 虚拟环境并安装平台依赖：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

cd /opt/hermes/app
uv python install 3.11
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -e ".[web-chat,platform]"
```

### 3.1 PostgreSQL 驱动（psycopg）

当 `PLATFORM_DATABASE_URL` 使用 `postgresql+psycopg://...`（仓库示例的默认写法）
时，需要安装 `psycopg` 驱动（SQLAlchemy 不会自动带上数据库驱动）。

生产环境请在部署机上显式安装一次：

```bash
uv pip install "psycopg[binary]"
```

构建 React SPA。构建产物位于 `gateway/web/_static/`，该目录被 Git 忽略，
所以每次发布前都必须重新构建：

```bash
cd /opt/hermes/app/web-chat
npm ci
npm run build
test -f ../gateway/web/_static/index.html
cd ..
```

## 4. 部署 PostgreSQL + pgvector

仓库内的 `deploy/docker-compose.yml` 是开发模板，包含示例密码，并公开映射
基础设施端口。不要原样用于公网 VPS。

退出 `hermes` shell，使用 sudo 创建独立生产配置：

```bash
exit
sudo mkdir -p /opt/hermes/infra
sudo chown hermes:hermes /opt/hermes/infra

DB_PASSWORD="$(openssl rand -hex 32)"
sudo tee /opt/hermes/infra/.env >/dev/null <<EOF
POSTGRES_USER=hermes
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=hermes_platform
EOF
sudo chmod 600 /opt/hermes/infra/.env
sudo chown hermes:hermes /opt/hermes/infra/.env
```

创建 `/opt/hermes/infra/compose.yml`：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  pgdata:
```

启动并检查：

```bash
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose up -d'
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose ps'
```

确认 PostgreSQL 只监听本机：

```bash
sudo ss -ltnp | grep ':5432'
# 预期为 127.0.0.1:5432，而不是 0.0.0.0:5432
```

## 5. 配置 Hermes

### 5.1 创建环境文件

`platform-api` 和 gateway 必须使用同一份 `PLATFORM_DATABASE_URL` 和
`HERMES_HOME`。用户绑定的上游 key 由
`$HERMES_HOME/web_users_master.key` 加密；该文件会在首次启动时原子生成，
丢失后将无法解密已有密钥，因此必须纳入备份。

```bash
sudo -u hermes -H mkdir -p /home/hermes/.hermes/logs

DB_PASSWORD="$(sudo awk -F= '/^POSTGRES_PASSWORD=/{print $2}' \
  /opt/hermes/infra/.env)"
```

创建 `/home/hermes/.hermes/.env`。以下示例中的域名和 new-api 地址必须替换：

```bash
sudo -u hermes -H tee /home/hermes/.hermes/.env >/dev/null <<EOF
PLATFORM_DATABASE_URL=postgresql+psycopg://hermes:${DB_PASSWORD}@127.0.0.1:5432/hermes_platform
PLATFORM_API_URL=http://127.0.0.1:8700
PLATFORM_API_PORT=8700

NEW_API_BASE_URL=https://new-api.example.com
UPSTREAM_PROVISIONER=manual
# UPSTREAM_PROVISIONER=auto 时取消下一行注释：
# NEW_API_ADMIN_TOKEN=replace-with-new-api-admin-token

PLATFORM_COOKIE_TTL_SECONDS=604800
PLATFORM_COOKIE_SECURE=true

# 可选：RAG embedding；留空时退化为离线关键词检索
# EMBEDDING_API_BASE_URL=https://api.openai.com/v1
# EMBEDDING_API_KEY=replace-me
# EMBEDDING_MODEL=text-embedding-3-small
EOF

sudo chmod 600 /home/hermes/.hermes/.env
sudo chown hermes:hermes /home/hermes/.hermes/.env
```

注意：

- 如果数据库密码含有 `@`、`:`、`/` 等字符，必须先做 URL 编码。上述流程使用
  hex 密码，不会遇到该问题。
- `NEW_API_BASE_URL` 可带或不带末尾 `/v1`，代码会规范化；推荐填写根地址。
- `manual`：注册后用户在设置页绑定自己的 key。
- `auto`：平台通过 `NEW_API_ADMIN_TOKEN` 为新用户自动创建 new-api key。
- 不要把 `.env`、Admin Token 或 `web_users_master.key` 提交到 Git 或发到日志。

### 5.2 配置 web_chat gateway

创建 `/home/hermes/.hermes/config.yaml`：

```yaml
platforms:
  web_chat:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8643
      max_concurrent_agents: 6
      cookie_secure: true
      cookie_ttl_seconds: 604800
      allow_insecure_bind: false
```

这里故意只监听 `127.0.0.1`，公网流量必须经过 nginx HTTPS。不要为了让外网
访问而改为 `0.0.0.0`；nginx 与应用在同一台 VPS 时不需要这样做。

```bash
sudo chown hermes:hermes /home/hermes/.hermes/config.yaml
sudo chmod 600 /home/hermes/.hermes/config.yaml
```

## 6. 配置 systemd

### 6.1 platform-api 服务

创建 `/etc/systemd/system/hermes-platform-api.service`：

```ini
[Unit]
Description=Hermes Platform API
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=hermes
Group=hermes
WorkingDirectory=/opt/hermes/app
Environment=HERMES_HOME=/home/hermes/.hermes
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=/home/hermes/.hermes/.env
ExecStart=/opt/hermes/app/.venv/bin/uvicorn platform_api.main:app --host 127.0.0.1 --port 8700
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

这里直接运行 uvicorn，是为了让 platform-api 只监听 `127.0.0.1`；
`hermes-platform-api` 命令当前固定监听 `0.0.0.0`，不应直接暴露在公网。

### 6.2 gateway 服务

创建 `/etc/systemd/system/hermes-gateway.service`：

```ini
[Unit]
Description=Hermes Multi-User Web Gateway
After=network-online.target docker.service hermes-platform-api.service
Wants=network-online.target
Requires=docker.service hermes-platform-api.service

[Service]
Type=simple
User=hermes
Group=hermes
WorkingDirectory=/opt/hermes/app
Environment=HOME=/home/hermes
Environment=HERMES_HOME=/home/hermes/.hermes
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=/home/hermes/.hermes/.env
ExecStart=/opt/hermes/app/.venv/bin/hermes gateway run --replace
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

加载、启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-platform-api hermes-gateway

sudo systemctl status hermes-platform-api --no-pager
sudo systemctl status hermes-gateway --no-pager

sudo test -f /home/hermes/.hermes/web_users_master.key
sudo stat -c '%a %U:%G %n' /home/hermes/.hermes/web_users_master.key
# 预期：600 hermes:hermes
```

查看日志：

```bash
sudo journalctl -u hermes-platform-api -f
sudo journalctl -u hermes-gateway -f
```

本机健康检查：

```bash
curl -fsS http://127.0.0.1:8700/api/v1/healthz
curl -fsS http://127.0.0.1:8643/api/healthz
```

如果 gateway 日志反复出现：

```text
Cannot connect to host 127.0.0.1:8700
```

说明 `platform-api` 未运行或启动失败。先检查：

```bash
sudo systemctl status hermes-platform-api
sudo journalctl -u hermes-platform-api -n 100 --no-pager
sudo ss -ltnp | grep ':8700'
```

## 7. 创建首个管理员

确保两个服务已启动，然后以 `hermes` 用户加载同一份环境变量：

```bash
sudo -u hermes -H bash -lc '
  set -a
  source /home/hermes/.hermes/.env
  set +a
  cd /opt/hermes/app
  .venv/bin/python scripts/create_admin.py \
    --email admin@example.com \
    --password "replace-with-a-long-random-password"
'
```

管理员密码建议至少 16 位，并存入密码管理器。创建后立即登录确认，并避免在
shell history 中长期保留真实密码；更严格的环境可先临时关闭 history 或交互输入。

## 8. 配置 nginx

创建 `/etc/nginx/sites-available/hermes`，将域名替换为真实域名：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name hermes.example.com;

    client_max_body_size 25m;

    root /opt/hermes/app/gateway/web/_static;
    index index.html;

    location /api/v1/ {
        proxy_pass http://127.0.0.1:8700;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # SSE 对话与 gateway API：必须关闭代理缓冲
    location /api/ {
        proxy_pass http://127.0.0.1:8643;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        add_header X-Accel-Buffering no;
    }

    # Vite SPA history fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # index.html 不长期缓存；hash 静态资源可长期缓存
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

确保 nginx 可以读取构建产物：

```bash
sudo chmod o+x /opt /opt/hermes /opt/hermes/app
sudo find /opt/hermes/app/gateway/web/_static -type d -exec chmod 755 {} \;
sudo find /opt/hermes/app/gateway/web/_static -type f -exec chmod 644 {} \;

sudo ln -s /etc/nginx/sites-available/hermes /etc/nginx/sites-enabled/hermes
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

先检查 HTTP：

```bash
curl -I http://hermes.example.com/
curl -fsS http://hermes.example.com/api/healthz
curl -fsS http://hermes.example.com/api/v1/healthz
```

## 9. 启用 HTTPS

使用 Certbot 申请证书并让 nginx 自动配置 80 → 443 跳转：

```bash
sudo certbot --nginx -d hermes.example.com
sudo certbot renew --dry-run
```

验证：

```bash
curl -I https://hermes.example.com/
curl -fsS https://hermes.example.com/api/healthz
curl -fsS https://hermes.example.com/api/v1/healthz
```

浏览器登录后，在开发者工具中确认 `hermes_session` Cookie 带有 `Secure` 和
`HttpOnly`。若仍通过纯 HTTP 访问，`PLATFORM_COOKIE_SECURE=true` 的 Cookie
不会发送，这是正确的安全行为。

## 10. 上线验收

建议依次完成：

1. 打开 `https://hermes.example.com`，注册普通账号。
2. `manual` 模式：在设置页绑定有效的 new-api key。
3. 新建对话，确认 SSE 流式回复正常。
4. 上传 TXT/Markdown/PDF，确认文件状态从“索引中”变为“可被检索”。
5. 在文件页使用“试搜”，确认能命中文档片段。
6. 在两个不同账号中上传同名文件，确认彼此不可见。
7. 管理员账号登录，确认管理页面可用。

同时检查：

```bash
sudo ss -ltnp | grep -E ':(80|443|5432|8643|8700)\b'
sudo systemctl --failed
sudo journalctl -u hermes-platform-api -u hermes-gateway \
  --since '10 minutes ago' --no-pager
```

预期 `5432`、`8643`、`8700` 只监听 `127.0.0.1`。

## 11. 日常更新

不要只执行 `git pull`。SPA 构建产物不会提交到 Git，Python/Node 依赖也可能
发生变化。生产更新建议：

```bash
sudo -u hermes -H bash -lc '
  set -e
  export PATH="$HOME/.local/bin:$PATH"
  cd /opt/hermes/app
  git pull --ff-only

  source .venv/bin/activate
  uv pip install -e ".[web-chat,platform]"

  cd web-chat
  npm ci
  npm run build
'

sudo systemctl restart hermes-platform-api
curl -fsS http://127.0.0.1:8700/api/v1/healthz

sudo systemctl restart hermes-gateway
curl -fsS http://127.0.0.1:8643/api/healthz

sudo nginx -t
```

也可用仓库脚本完成拉取和前端构建：

```bash
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/app && ./update-web.sh --no-restart --test'
sudo systemctl restart hermes-platform-api hermes-gateway
```

`update-web.sh --systemd <unit>` 一次只重启指定 unit；平台部署同时有两个服务，
所以推荐使用 `--no-restart` 后显式重启二者。

更新后：

```bash
cd /opt/hermes/app
git log --oneline -1
stat gateway/web/_static/index.html
curl -fsS https://hermes.example.com/api/healthz
curl -fsS https://hermes.example.com/api/v1/healthz
```

若浏览器仍显示旧 UI，先硬刷新（Ctrl/Cmd + Shift + R）。

## 12. 备份与恢复

至少备份：

1. PostgreSQL 数据库；
2. `/home/hermes/.hermes/web_workspaces/`；
3. `/home/hermes/.hermes/state.db`（若存在）；
4. `/home/hermes/.hermes/config.yaml`；
5. `/home/hermes/.hermes/.env`；
6. `/home/hermes/.hermes/web_users_master.key`。

数据库与 `web_users_master.key` 必须一起保留，否则恢复后无法解密用户绑定的
key。

### 12.1 备份示例

```bash
BACKUP_DIR="/var/backups/hermes/$(date -u +%Y%m%dT%H%M%SZ)"
sudo mkdir -p "$BACKUP_DIR"
sudo chmod 700 "$BACKUP_DIR"

sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose exec -T postgres \
   pg_dump -U hermes -d hermes_platform -Fc' \
  | sudo tee "$BACKUP_DIR/platform.dump" >/dev/null

sudo tar -C /home/hermes -czf "$BACKUP_DIR/hermes-home.tar.gz" \
  .hermes/.env \
  .hermes/config.yaml \
  .hermes/web_users_master.key \
  .hermes/web_workspaces \
  .hermes/state.db 2>/dev/null || true

sudo sha256sum "$BACKUP_DIR"/* | sudo tee "$BACKUP_DIR/SHA256SUMS"
```

将备份加密后同步到另一台机器或对象存储，不要只保存在同一块 VPS 磁盘。
定期做恢复演练，而不只是检查备份任务退出码。

### 12.2 恢复概要

1. 停止 `hermes-gateway` 和 `hermes-platform-api`。
2. 恢复 `.env`、`config.yaml`、`web_users_master.key`、
   `web_workspaces/` 和 `state.db`。
3. 确保 PostgreSQL 容器健康，使用 `pg_restore` 恢复数据库。
4. 检查文件属主为 `hermes:hermes`，敏感文件权限为 `600`。
5. 先启动 platform-api 并检查健康，再启动 gateway。

示例：

```bash
sudo systemctl stop hermes-gateway hermes-platform-api

sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose exec -T postgres \
   dropdb -U hermes --if-exists hermes_platform'
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose exec -T postgres \
   createdb -U hermes hermes_platform'
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose exec -T postgres \
   pg_restore -U hermes -d hermes_platform --clean --if-exists' \
  < /path/to/platform.dump

sudo systemctl start hermes-platform-api
curl -fsS http://127.0.0.1:8700/api/v1/healthz
sudo systemctl start hermes-gateway
```

恢复命令会覆盖数据库，务必先在测试机演练并确认备份路径。

## 13. 回滚

回滚前先备份数据库和用户工作区。然后：

```bash
sudo -u hermes -H bash -lc '
  set -e
  cd /opt/hermes/app
  git log --oneline -10
  git checkout <KNOWN_GOOD_COMMIT>
  export PATH="$HOME/.local/bin:$PATH"
  source .venv/bin/activate
  uv pip install -e ".[web-chat,platform]"
  cd web-chat
  npm ci
  npm run build
'
sudo systemctl restart hermes-platform-api hermes-gateway
```

如果版本包含不可逆数据库迁移，代码回滚不能替代数据库恢复；应按该版本发布
说明处理。验证完成后再将工作树切回正式分支。

## 14. 监控与日志

最低限度监控：

- `https://hermes.example.com/api/healthz`；
- `https://hermes.example.com/api/v1/healthz`；
- systemd unit 是否 active；
- PostgreSQL 容器健康状态和磁盘使用量；
- gateway / platform-api RSS、CPU；
- new-api 请求错误率和余额；
- TLS 证书剩余有效期；
- `/home/hermes/.hermes/web_workspaces/` 和数据库备份是否成功。

常用命令：

```bash
sudo systemctl status hermes-platform-api hermes-gateway
sudo journalctl -u hermes-platform-api -n 200 --no-pager
sudo journalctl -u hermes-gateway -n 200 --no-pager
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/infra && docker compose ps'
df -h
du -sh /home/hermes/.hermes/web_workspaces
```

## 15. 常见故障

### `/api/v1/*` 返回 502 或 gateway 报连接 8700 失败

`platform-api` 没有运行、环境变量错误或 PostgreSQL 不可用：

```bash
sudo systemctl status hermes-platform-api
sudo journalctl -u hermes-platform-api -n 100 --no-pager
curl -v http://127.0.0.1:8700/api/v1/healthz
```

### Gateway 拒绝启动

检查：

- `NEW_API_BASE_URL` 是否存在；
- `config.yaml` 是否启用 `platforms.web_chat`；
- `cookie_secure: true`；
- 8643 是否被旧进程占用；
- `[web-chat,platform]` extras 是否已安装。

```bash
sudo ss -ltnp | grep ':8643'
sudo journalctl -u hermes-gateway -n 150 --no-pager
```

### 登录成功后立即掉线

- 域名是否通过 HTTPS 打开；
- platform-api 和 gateway 是否使用同一个 `PLATFORM_DATABASE_URL`；
- `PLATFORM_COOKIE_SECURE=true` 与 gateway `cookie_secure: true` 是否一致；
- 浏览器 Cookie 是否被旧域名或 HTTP 测试污染。

### 更新后 UI 没变化

`gateway/web/_static/` 没有重建。重新执行：

```bash
sudo -u hermes -H bash -lc \
  'cd /opt/hermes/app/web-chat && npm ci && npm run build'
sudo systemctl reload nginx
```

然后浏览器硬刷新。

### 文件上传成功但无法检索

- 确认文件状态为“可被检索”；
- 文件页使用“试搜”验证；
- 检查 embedding 配置，未配置时仅有关键词检索；
- 检查 platform-api ingestion 日志；
- 确认两个应用连接同一个 PostgreSQL。

## 16. 安全检查清单

- [ ] 公网只开放 22、80、443。
- [ ] PostgreSQL 只绑定 `127.0.0.1:5432`。
- [ ] platform-api 和 gateway 只绑定 loopback。
- [ ] nginx 已启用 TLS，Certbot 自动续期正常。
- [ ] `PLATFORM_COOKIE_SECURE=true` 且 gateway `cookie_secure: true`。
- [ ] `allow_insecure_bind: false`。
- [ ] `.env`、`config.yaml`、infra `.env` 权限为 600。
- [ ] new-api Admin Token 和 `web_users_master.key` 未进入 Git/日志。
- [ ] 管理员使用高强度独立密码。
- [ ] SSH 禁止密码登录或至少启用 fail2ban/来源限制。
- [ ] 数据库、工作区、`web_users_master.key` 有异机加密备份。
- [ ] 健康检查、磁盘和进程资源有告警。
- [ ] 定期更新系统、Docker 镜像和应用依赖。

## 17. 相关文档

- [平台架构与认证](platform-saas.md)
- [Web Chat 运维与更新](web-chat.md)
- [平台人工验收](platform-manual-testing.zh-CN.md)
- [部署目录说明](../../deploy/README.md)

