# 容器部署（Docker / Docker Compose）

本镜像只跑 headless 模式（`node src/server.js`），**不包含 Electron 桌面壳**。
桌面端的托盘、开机自启、内置 SnowLuma 进程管理、便携 QQ 在容器里全部不可用 ——
这部分能力由独立的协议端容器（NapCat）替代。

## 架构

```
┌──────────────── 宿主机（host 网络）────────────────┐
│                                                   │
│  浏览器 ──► 127.0.0.1:3210 ──► [qq-agent 容器]     │
│                                     │             │
│                                     │ ws://127.0.0.1:3001
│                                     ▼             │
│                            [napcat 容器]           │
│                              3000 / 3001 / 6099    │
└───────────────────────────────────────────────────┘
                                      │
                                      ▼
                              OpenAI 兼容 API
```

## 为什么必须是 host 网络

`src/app.js` 里有两道锁：

1. `server.listen(port, '127.0.0.1')` —— 默认只监听回环
2. `originAllowed()` —— 所有 `/api/*` 要求 `Host` 头是回环地址（`127.0.0.1` / `localhost` / `[::1]`），带 `Origin` 时还要求与 `Host` 同源

第 2 道是防 DNS rebinding / CSRF 的，不是疏漏。后果是：**用 `-p 3210:3210` 映射出去，
页面能加载，但所有接口 403，控制台看起来"打开了却一片空白"**。

host 网络下容器内的 `127.0.0.1` 就是宿主机回环，从宿主机浏览器访问天然满足校验。

远程访问有两种方式，默认是第一种。

**A. SSH 隧道（默认配置，最安全）**

```bash
ssh -L 3210:127.0.0.1:3210 user@192.168.1.10
# 然后在本机浏览器打开 http://127.0.0.1:3210
```

**B. 局域网直连**（手机、其他电脑直接开 `http://<服务器IP>:3210`）

```bash
cp .env.example .env
```

`.env` 里改这两行，**必须成对出现，缺一个就全部 403**：

```ini
QQ_AGENT_HOST=0.0.0.0
QQ_AGENT_ALLOWED_HOSTS=192.168.1.10:3210
```

```bash
docker compose up -d
```

`QQ_AGENT_ALLOWED_HOSTS` 是精确匹配（含端口、不支持通配）。这不是端口映射的问题——
即使监听 `0.0.0.0`，Host 头不在名单里照样 403，那是防 DNS rebinding 的，
换域名指向这台机器也绕不过去。

> 只有纯内网才建议开 B。宿主机一旦有公网 IP，先看文末「安全边界」。

## 部署

```bash
# 1. 目录与权限（容器内以 uid 1000 运行，bind mount 必须先对齐属主）
mkdir -p qq-agent && cd qq-agent
mkdir -p data skills plugins data-napcat/config data-napcat/qq
sudo chown -R 1000:1000 data skills plugins data-napcat

# 2. 拉编排文件
curl -fsSLO https://raw.githubusercontent.com/DC1024/QQ-agent/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/DC1024/QQ-agent/main/.env.example
cp .env.example .env      # 只在本机访问就不改；要局域网直连见上一节

# 3. 起服务
docker compose up -d
docker compose logs -f qq-agent
```

私有镜像需要先登录（公开镜像可跳过）：

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u DC1024 --password-stdin
```

## 首次配置

### 1. 登录 QQ（NapCat）

浏览器打开 `http://<服务器IP>:6099/webui`，用手机 QQ 扫码。
登录态写在 `data-napcat/qq`。注意：**光挂载登录态不够**，还必须配自动登录账号，
否则每次重启都会退回二维码流程，见下一节。

### 2. 打开 OneBot v11 服务

NapCat 首次登录后生成的 `data-napcat/config/onebot11_<QQ号>.json` 里
**所有网络服务都是空的**（默认不开任何端口），必须手动启用。

推荐直接把 `doc/examples/onebot11.example.json` 复制过去改名：

```bash
cp doc/examples/onebot11.example.json /opt/qq-agent/data-napcat/config/onebot11_<QQ号>.json
docker restart napcat
```

| 项 | 值 | 说明 |
|---|---|---|
| 正向 WebSocket | `127.0.0.1:3001` | qq-agent 作为客户端连它 |
| HTTP 服务端 | `127.0.0.1:13000` | **不要用默认 3000**，见下 |
| 消息格式 | `array` | 必须 |

**为什么 HTTP 用 13000 而不是 3000**：NapCat 默认 HTTP 端口是 3000，
而 3000 在宿主上常被别的容器占着（本次部署就被 `bilirec-web` 占了）。
host 网络下没有端口隔离，绑定会直接失败。换个不冲突的端口即可，
记得同步改 qq-agent 的 `snowluma.httpUrl`。

只监听 `127.0.0.1` 是刻意的：host 网络下容器与宿主共享回环，
qq-agent 连得上，外部机器连不上，不需要额外防火墙。

若设置了 token，把它填进 qq-agent 的 `snowluma.accessToken` / `snowluma.httpAccessToken`。

> 配置项名字仍叫 `snowluma.*`（历史遗留），实际可以指向任何 OneBot v11 实现。

### 3. 让 NapCat 重启后自动登录

```bash
python3 - <<'PY'
import json
p = '/opt/qq-agent/data-napcat/config/webui.json'
d = json.load(open(p))
d['autoLoginAccount'] = '你的QQ号'
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=4)
PY
docker restart napcat
```

验证成功的标志（`docker logs napcat`）：

```
[NapCat] [WebUi] 自动快速登录成功: <QQ号>
[OneBot] [HTTP Server Adapter] Start On 127.0.0.1:13000
```

### 4. 配置 qq-agent

浏览器打开 `http://127.0.0.1:3210`（或走 SSH 隧道），设置页顶部有体检卡：

1. 填模型 Base URL + Key，点「获取列表」选模型
2. 白名单从 QQ 群列表里勾选
3. 响应档位从 1 档（仅 @）开始试

## 数据与备份

| 宿主机路径 | 内容 | 是否敏感 |
|---|---|---|
| `data/config.json` | 全部配置，**含 API Key** | 是 |
| `data/` 其余 | 会话存档、群友记忆、表情库、用量统计 | 是（聊天记录） |
| `data-napcat/qq` | QQ 登录态 | 是 |
| `data-napcat/config` | NapCat 网络配置 | 否 |

备份直接打包 `data/` 与 `data-napcat/` 即可。**不要把它们提交到任何仓库**（`.gitignore` 已覆盖）。

## 升级

```bash
docker compose pull
docker compose up -d
```

镜像标签：`latest`（main 分支）、`main`、`sha-xxxxxxx`、`v1.2.3`（打 tag 时）。
生产环境建议钉 `sha-` 或版本号，别跟 `latest`。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面打开一片空白，接口 403 | `Host` 不是回环且不在白名单 | 用 `127.0.0.1` 访问，或配 `QQ_AGENT_ALLOWED_HOSTS` |
| 局域网能 ping 通但打不开页面 | `.env` 里 `QQ_AGENT_HOST` 还是 `127.0.0.1` | 改成 `0.0.0.0` 并配 `QQ_AGENT_ALLOWED_HOSTS` |
| 局域网页面能开、接口全 403 | 只改了 `QQ_AGENT_HOST`，忘了 `ALLOWED_HOSTS` | 两个必须成对，Host 要带端口 |
| 容器起不来，日志 permission denied | bind mount 属主不是 1000 | `sudo chown -R 1000:1000 data data-napcat` |
| `[单实例] 已有实例在运行` | `data/qq-agent.lock` 残留 | 确认无进程后删掉该文件 |
| 日志刷 OneBot 重连 | NapCat 未登录或 3001 未开 | 先扫码，再查网络配置 |
| `docker restart` 后又要扫码 | `webui.json` 没配 `autoLoginAccount` | 见「让 NapCat 重启后自动登录」 |
| 能收消息、发不出消息 | `snowluma.httpUrl` 还指着 3000（被别的容器占用） | 改成 NapCat 实际 HTTP 端口（本例 13000） |
| NapCat 启动后 3001/13000 都没监听 | `onebot11_<QQ号>.json` 里 `network` 全空 | 用 `doc/examples/onebot11.example.json` 覆盖后重启 |
| 端口 3210 被占用 | 宿主已有服务 | 改 `QQ_AGENT_PORT`，或让程序自动 +1 探测 |
| 机器人不回话 | 白名单未勾选 / 档位太低 | 设置页检查白名单与响应档位 |

## 安全边界

- **不要把 3210 直接暴露到公网。** 前端把控制台标识头硬编码为 `qq-agent-console`，
  `server.token` 实际只有一个有效取值，等于没有鉴权。要出公网，前面必须套带 Basic Auth 的反代。
- NapCat 的 6099 是**扫码登录页**，host 网络下监听 `0.0.0.0`。宿主机有公网 IP 时用防火墙限制：
  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 6099 proto tcp
  ```
- 本项目通过非官方方式接入 QQ 协议，**账号有被风控/封禁的风险，建议用小号**。
