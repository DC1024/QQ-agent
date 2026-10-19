# syntax=docker/dockerfile:1
#
# QQ Agent —— 容器镜像（headless 模式，无 Electron 桌面壳）
#
# 只跑 `node src/server.js`，控制台通过 HTTP 访问。
# 桌面端专属能力（托盘、自启、内置 SnowLuma 进程管理、便携 QQ）
# 在容器里不可用，这是设计边界，不是缺陷：
# QQ 协议端请用 mlikiowa/napcat-docker 单独承载（见 docker-compose.yml）。

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production

# 只装生产依赖：electron / electron-builder / jsdom 全在 devDependencies，
# 用 --omit=dev 跳过（否则会触发 electron 的二进制下载，白白多几百 MB）。
# 生产依赖只有 js-yaml / undici / ws，全部纯 JS，无需编译工具链。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force


FROM node:22-bookworm-slim

# ffmpeg/ffprobe：视频理解可选功能。缺失时 video-reader 会自动降级为
# "只读元信息"，不报错。装上才能抽帧/转码。
# tini：作为 PID 1 转发信号，保证 docker stop 时能走完 app.stop() 优雅退出。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    QQ_AGENT_DATA_DIR=/app/data \
    QQ_AGENT_PORT=3210

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY ui ./ui
COPY assets ./assets

# skills/ 与 plugins/ 出厂为空（git 不追踪空目录），但热重载要求目录存在。
# /app/data 同时被声明为 VOLUME：用命名卷挂载时会继承这里的属主，
# 用 bind mount 时需要在宿主机先 chown 1000:1000（见 doc/DOCKER.md）。
RUN mkdir -p /app/data /app/skills /app/plugins \
 && chown -R node:node /app

USER node

EXPOSE 3210
VOLUME ["/app/data"]

# 注意：/api/status 也要过 originAllowed，所以这里必须用回环 Host 访问。
# 即使容器内监听 0.0.0.0，从 127.0.0.1 发起依然算回环，不受 ALLOWED_HOSTS 影响。
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.QQ_AGENT_PORT||3210)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
