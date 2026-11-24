# 单容器镜像：后端（Express + WebSocket）+ 前端静态产物，一个端口跑完整套。
#
# RDP 走浏览器内的 IronRDP(WASM) + 后端的 RDCleanPath 代理，
# VNC 走浏览器内的 noVNC + 后端的 WebSocket→TCP 桥，
# 所以不再需要 guacd / remote-gateway / nginx 这些额外容器。
#
#   docker build -t nexus-terminal .
#   docker run -d -p 18111:3001 -v $(pwd)/data:/app/data --env-file .env nexus-terminal

# ---------- 构建阶段 ----------
# 固定到「已修复 2026-10 安全公告」的补丁版本：v22.23.4（2026-10-20）
# 涉及 CVE-2026-111497（Brotli 越界写可 RCE）/ CVE-2026-106069 / CVE-2026-105482 等
FROM --platform=$BUILDPLATFORM node:22.23.4 AS builder

WORKDIR /app

# 先只拷 lock 与各 workspace 的 package.json，让 npm install 能被缓存
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
RUN npm install

# 后端
COPY packages/backend/src ./packages/backend/src
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/backend/html-presets ./packages/backend/html-presets
RUN npm run build --workspace=@nexus-terminal/backend

# 前端（Vite 构建时需要根 .env 里的 VITE_* 变量）
COPY packages/frontend/src ./packages/frontend/src
COPY packages/frontend/index.html ./packages/frontend/
COPY packages/frontend/tsconfig.json ./packages/frontend/
COPY packages/frontend/vite.config.ts ./packages/frontend/
COPY packages/frontend/public ./packages/frontend/public
COPY .env ./.env
RUN npm run build --workspace=@nexus-terminal/frontend

# ---------- 运行阶段 ----------
FROM node:22.23.4-alpine

# node-gyp / sqlite3 需要编译工具，装完即删
RUN apk add --no-cache --virtual .build-deps python3 py3-setuptools make g++

WORKDIR /app

COPY packages/backend/package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm install --omit=dev --prefer-offline

COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/backend/src/locales ./dist/locales
COPY --from=builder /app/packages/backend/html-presets ./html-presets
# 内置多平台目标机托管代理（nexus-mux 静态压缩二进制与 manifest.json）
COPY packages/remote-agent/dist ./agent-binaries
# 后端会自动检测 /app/public 下的 index.html 并托管前端 + SPA 回退
COPY --from=builder /app/packages/frontend/dist ./public

RUN apk del .build-deps

ENV NODE_ENV=production
ENV PORT=3001
ENV NEXUS_DATA_DIR=/app/data
ENV NEXUS_AGENT_BINARIES_DIR=/app/agent-binaries

EXPOSE 3001

CMD ["node", "dist/index.js"]
