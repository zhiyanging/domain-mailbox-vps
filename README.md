# 多域名仅收件邮箱（单 VPS）

一个可独立部署的收件专用服务：单台 VPS 承载多个邮件域，所有域共享一个
SMTP MX 主机名；Node.js 负责 SMTP、管理台、专属收件页和稳定 API，Caddy
负责 HTTPS 与证书续期。元数据存入 SQLite，原始 MIME 以明文 `.eml` 永久保存。

## 固定边界

- 仅接收已创建、已启用且所属域已启用的地址；未知地址在 `RCPT TO` 阶段返回 `550`。
- 无外发、转发、SMTP AUTH、公开注册、Catch-all、IMAP 或 POP3。
- 唯一管理员；管理员密码使用 scrypt，管理 Token 和邮箱访问码仅保存哈希。
- 不含邮件删除或清空接口；停用邮箱和轮换访问码都保留历史邮件。
- 默认单封 25 MiB、最多 50 个 SMTP 连接；磁盘 80% 告警，90% 或剩余不足 1 GiB 时以临时错误暂停新收件。
- Docker Compose 仅运行应用与 Caddy，面向 1 核、约 1 GB 内存环境。

## 主机隔离

| Host | 开放路径 |
| --- | --- |
| `manage.PRIMARY_DOMAIN` | `/admin`、`/docs`、`/openapi.json`、`/v1/*`、`/api/admin/*`、`/health` |
| `inbox.MAIL_DOMAIN` | `/cf-inbox/{token}/{address}`、`/inbox/{address}`、`/api/inbox/*` |
| `MAIL_DOMAIN`、`www.MAIL_DOMAIN` | `/`、静态首页资源 |
| `mx.PRIMARY_DOMAIN` | 仅用于共享 MX、SMTP TLS 证书和简单 Web 探针 |

所有登记过的 Web Host 访问 `/` 都显示同一个本地静态“数字基础设施”首页；根路径返回 `200`，不跳转 `/admin`。首页不加载远程资源，也不出现邮箱、API 或管理员入口。未登记 Host 返回 `421`，登记 Host 上不属于其角色的路径返回普通 `404`。

管理员 Cookie 是 control host 的 Host-only Cookie；收件 Cookie 是相应 inbox host 的 Host-only Cookie。访问码必须在邮箱所属域的 inbox host 上兑换。

## 多域配置

复制示例并编辑：

```bash
cp config/domains.example.json config/domains.json
cp config/cloudflare-ips.example.json config/cloudflare-ips.json
chown root:1000 config/domains.json config/cloudflare-ips.json
chmod 640 config/domains.json config/cloudflare-ips.json
```

`config/domains.json` 使用 schema v1：

```json
{
  "schema_version": 1,
  "default_domain": "alpha.example.com",
  "shared_mx_host": "mx.example.com",
  "control_host": "manage.example.com",
  "landing": {
    "title": "Digital Infrastructure",
    "headline": "Reliable digital infrastructure for modern teams.",
    "description": "Secure, resilient services designed for dependable digital operations."
  },
  "domains": [
    {
      "domain": "alpha.example.com",
      "inbox_host": "inbox.alpha.example.com",
      "public_hosts": ["alpha.example.com", "www.alpha.example.com"],
      "enabled": true
    },
    {
      "domain": "beta.example.net",
      "inbox_host": "inbox.beta.example.net",
      "public_hosts": ["beta.example.net", "www.beta.example.net"],
      "enabled": true
    }
  ]
}
```

启动前会校验默认域、DNS 名称、重复域、Host 冲突、MX/Web 冲突和默认域启用状态。域级 `enabled:false` 会在服务重载后停止该域的新 SMTP 投递；数据库和 `.eml` 保留。

数据库 schema v2 为邮箱增加 `domain` 字段及域名索引。打开旧 schema v1 数据库时，服务按邮箱地址后缀自动回填并升级，原邮箱、Token 哈希、投递关系和邮件文件保持原样。

## DNS：MX → 主机名 → IPv4

MX 的目标必须是主机名，且该主机名再由 A 记录解析到 VPS IPv4：

```text
alpha.example.com  MX 10 mx.example.com
beta.example.net   MX 10 mx.example.com
mx.example.com     A     NEW_VPS_IP
```

每个邮件域的完整记录：

```text
A      @       NEW_VPS_IP                          Proxied
CNAME  www     MAIL_DOMAIN                         Proxied
A      inbox   NEW_VPS_IP                          Proxied
MX     @       mx.PRIMARY_DOMAIN  priority 10      DNS only
TXT    @       v=spf1 -all
TXT    _dmarc  v=DMARC1; p=reject; adkim=s; aspf=s
```

主域额外记录：

```text
A  manage.PRIMARY_DOMAIN  NEW_VPS_IP   Proxied
A  mx.PRIMARY_DOMAIN      NEW_VPS_IP   DNS only
```

关键规则：

- MX 内容只写 `mx.PRIMARY_DOMAIN`，不写 IP，也不让 MX 主机使用 CNAME。
- `mx.PRIMARY_DOMAIN` 始终为 **DNS only**。标准 Cloudflare Web 代理不承载公网 SMTP TCP/25；发件服务器必须直接解析该 A 记录并连接 VPS。
- `inbox`、`manage`、根域和 `www` 是 HTTPS Web Host。它们先以 DNS only 让 Caddy 取得源站证书，验证成功后切换为 **Proxied**；它们不是 MX 目标。
- 只发布 A，不创建 AAAA，直到新 VPS 具备稳定 IPv6。
- Cloudflare Email Routing 保持关闭。
- `/admin*`、`/api*`、`/v1*`、`/docs*`、`/openapi.json`、`/cf-inbox*`、`/inbox*` 和 `/health` 应配置绕过缓存。

固定上线顺序：

1. 创建共享 MX 主机的 DNS-only A 记录。
2. 启动 Caddy/SMTP，取得共享 MX 证书。
3. 从外部验收 TCP/25、SMTP banner 与 STARTTLS。
4. 再创建各邮件域的 MX/SPF/DMARC。
5. Web Host 先 DNS only 取证书，再切换 Cloudflare Proxied。
6. 公网 TCP/25 验收通过前不切换正式 MX。

`domainctl` 只输出计划文件，不直接修改 Cloudflare DNS：

```bash
VPS_IP=198.51.100.25 ./scripts/domainctl.sh validate
VPS_IP=198.51.100.25 ./scripts/domainctl.sh render
VPS_IP=198.51.100.25 ./scripts/domainctl.sh dns-plan
./scripts/domainctl.sh backup
VPS_IP=198.51.100.25 ./scripts/domainctl.sh apply
```

输出位于 `generated/Caddyfile` 与 `generated/dns-plan.json`。`apply` 会验证 Caddy 配置、重载服务、执行内部健康检查、保存最后成功配置，并在失败时恢复该配置。`update-cloudflare-ips.sh` 从 Cloudflare 官方地址更新源站入口白名单；Caddy 只把 Cloudflare 官方网段的 Web 请求转给应用，ACME 和共享 MX 证书处理保持独立。

## 首次部署到新 VPS

本项目源码阶段不会连接旧 VPS 或改动现有 DNS。准备好新 VPS 和上述预备 DNS 后：

```bash
cd /opt/domain-mailbox
chmod +x scripts/*.sh
PRIMARY_DOMAIN=example.com \
MAIL_DOMAINS=example.com,example.net \
VPS_IP=198.51.100.25 \
ACME_EMAIL=admin@example.com \
./scripts/install.sh
```

也可以先手工放置 `config/domains.json`，此时安装器直接使用它。安装器会安装 Docker/Compose、生成新会话密钥、更新 Cloudflare IP 网段、生成并验证配置、取得证书、初始化唯一管理员、启动服务并仅开放 SSH、25、80、443。新管理员密码和管理 API Token 只显示一次，不复用 VPS 登录凭据。

## API 与本地文档

公开参考页位于 control host：

- `/docs`：本地 Swagger UI，无远程 CDN。
- `/openapi.json`：OpenAPI 3.1。
- Swagger 的 Try it out 和全部提交方法已关闭。
- 规范只列出 `/health` 与稳定 `/v1/*`，不列内部 `/api/*`。

管理请求使用 `Authorization: Bearer ADMIN_API_TOKEN`：

```http
GET /v1/domains

POST /v1/mailboxes/batch
Content-Type: application/json

{"count":20,"domain":"alpha.example.com"}
```

稳定接口：

- `GET /health`
- `GET /v1/domains`
- `POST /v1/mailboxes/batch`
- `POST /v1/mailboxes`
- `GET /v1/mailboxes?domain=...`
- `PATCH /v1/mailboxes/{address}`
- `POST /v1/mailboxes/{address}/rotate-token`
- `GET /v1/messages?address=...&limit=...&offset=...`
- `GET /v1/messages/{id}/raw`
- `GET /v1/messages/{id}/attachments/{index}`

省略 `domain` 时使用默认域。创建与轮换响应中的 `inbox_url` 自动指向邮箱所属域的 inbox host。`/cf-inbox/{token}/{address}` 继续作为兼容凭据链接；首次浏览器访问后写入 30 天 HttpOnly 会话，并跳转到不含访问码的 URL。

## 主程序 schema v3

桌面主程序的本地 `runtime/state_data/cloudflare-mailbox.json` 可使用：

```json
{
  "schema_version": 3,
  "default_domain": "alpha.example.com",
  "providers": {
    "primary-vps": {
      "provider": "vps",
      "label": "自建域名邮箱",
      "api_origin": "https://manage.example.com",
      "admin_token": "LOCAL_ADMIN_TOKEN",
      "domains": ["alpha.example.com", "beta.example.net"]
    }
  }
}
```

同一 VPS 的域共享 control API Origin 和管理 Token；下拉域名从配置动态生成。专属链接仍在对应 inbox host，主程序从链接提取邮箱 Token 后，按所属域把 `/v1/messages` 请求发送到配置的 control host。旧 Worker provider、schema v2、历史扁平配置和共享 IMAP 标记继续可读。

## 数据、备份与回滚

- SQLite：`data/mailbox.sqlite3`
- 原始邮件：`data/raw/YYYY/MM/*.eml`
- 备份：`./scripts/backup.sh`
- 恢复：`./scripts/restore.sh backups/domain-mailbox-TIMESTAMP.tar.gz`
- 健康检查：`./scripts/healthcheck.sh`
- 停止服务并保留全部数据卷：`./scripts/rollback.sh`

备份包含 `.env`、一致性 SQLite 快照和全部原始邮件，内容是明文，应作为高敏感文件保存。DNS 回滚按部署前快照和记录 ID 单独执行。

## 本地验证

```bash
npm ci
npm test
npm run check
```

测试覆盖域名配置冲突、schema v1→v2 迁移、同本地部分跨域创建、Host 路由隔离、静态根站、OpenAPI、访问码 Host 绑定、Cookie 隔离、轮换失效、多域 SMTP、多收件人、未知地址/域/中继拒绝、原始 MIME、HTML 隔离、附件下载和无删除接口。生产验收脚本：

```bash
ADMIN_API_TOKEN=... ADMIN_PASSWORD=... node scripts/production-verify.mjs
```
