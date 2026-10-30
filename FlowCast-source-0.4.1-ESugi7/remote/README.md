# 远程连接服务

FlowCast 的局域网模式不需要服务器。电脑和手机处于不同网络时，需要一台公网主机提供 HTTPS 信令，并在无法直连时提供 TURN 中继。本目录只提供部署模板，不包含公共服务或任何真实凭据。

## 组件

- **hub**：短期配对、房间隔离和 WebSocket 信令
- **Caddy**：HTTPS 反向代理和证书
- **coturn**：WebRTC 媒体中继，可选但建议配置

视频、音频和录像不经过 hub 保存。录像仍由电脑端写入本地目录。

## 部署要求

需要 Linux 主机、Docker Engine/Compose、解析到主机的域名、受信任的 HTTPS 证书和公网 IPv4。模板使用 host network 运行 Caddy 与 coturn；主机位于 NAT 后时需要自行配置公网映射和端口转发。

1. 在 Linux 主机进入 `remote/` 目录，复制配置：`cp .env.example .env`
2. 填入域名、HTTPS 地址、公网 IPv4，并生成两个独立的随机密钥。
3. 放行 TCP 80/443/3478、UDP 3478 和 UDP 49160–49200。
4. 检查并启动：

~~~sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build
curl --fail https://your-domain.example/health
~~~

不要把 `.env`、配对二维码、配对文本或令牌提交到公共仓库。

## 连接方式

电脑工作台的“跨网连接”填写远程服务 HTTPS 地址和服务接入密钥，然后生成 v3 配对二维码。手机扫描二维码，或在扫码页粘贴远程配对文本。配对凭据约 10 分钟有效且单次使用；刷新二维码不影响已配对手机，断开手机会撤销访问。电脑服务重启后需要重新启用远程连接。房间仅保存在内存，公网进程重启或电脑离线超过 5 分钟后需要重新配对。

WebRTC 优先尝试直连，失败后使用 TURN。界面显示“已配置中继”不等于当前媒体已经经过中继，应以连接诊断为准。模板默认只开放 UDP/TCP 3478，不包含 TURN TLS/443；需要企业网络兼容时应另行配置。

仅运行 hub 时，可在配置 `.env.example` 所列环境变量后执行 `npm run remote:start`，默认监听 8080；需要自行放在 HTTPS 反向代理之后。工作台的 4310/4311 端口无需开放到公网。

## 限制

该模板面向个人或小规模自托管使用，采用共享服务接入密钥，最多 100 个房间，没有账号系统、多人权限、持久设备管理或区域调度。反向代理后限流按 socket IP 计算并忽略转发 IP；多个客户端可能共享每分钟 20 次配对/连接尝试的额度。公网带宽和 TURN 流量由服务器套餐承担。正式对外服务前，请自行增加访问控制、监控、备份、限流和隐私政策。

## 验证

~~~powershell
npm test
npm run test:remote:browser
~~~

浏览器流程默认使用本机回环服务，不能替代公网 NAT、真实 TURN、移动数据或长时间运行测试。可在隔离测试环境设置 `FLOWCAST_TEST_TURN_URLS`、`FLOWCAST_TEST_TURN_SECRET`、`FLOWCAST_TEST_STUN_URLS` 和 `FLOWCAST_TEST_RELAY_ONLY=1` 后验证实际中继；不要在日志或仓库中公开这些测试凭据。

