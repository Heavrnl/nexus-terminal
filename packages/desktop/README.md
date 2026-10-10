# Nexus Terminal - Tauri v2 桌面客户端架构

本文档说明 Nexus Terminal 基于 **Tauri v2 + Node.js Sidecar** 的桌面化架构设计与构建流程。

---

## 🏗️ 架构全景

```
┌────────────────────────────────────────────────────────┐
│            Nexus Terminal 桌面端 (Tauri v2)            │
├───────────────────────────┬────────────────────────────┤
│   Rust 主进程 (Main)      │   前端渲染层 (Webview2)    │
│   - 窗口管理与系统托盘    │   - Vue 3 + Tailwind CSS   │
│   - 空闲端口自动侦测分配  │   - Xterm.js / Monaco      │
│   - Sidecar 进程生命周期  │   - 纯前端相对路径通信     │
└─────────────┬─────────────┴────────────────────────────┘
              │ 启动并守护 (PID Tracking)
              ▼
┌────────────────────────────────────────────────────────┐
│          Node.js Sidecar 服务 (nexus-server)           │
│   - Express 5 REST API (/api/v1)                       │
│   - WebSocket 实时流 (SSH / SFTP / 桌面终端流)         │
│   - SQLite3 本地数据库 (%APPDATA%/nexus-terminal)      │
└────────────────────────────────────────────────────────┘
```

---

## 📁 目录规范

```
packages/desktop/
├── package.json                   # 桌面端 npm 命令入口
├── scripts/
│   └── build-sidecar.js           # 自动化目标平台 Target-Triple Sidecar 构建脚本
└── src-tauri/
    ├── Cargo.toml                 # Rust 依赖 (tauri v2, tauri-plugin-shell 等)
    ├── tauri.conf.json            # Tauri v2 窗口、权限与 externalBin 配置
    ├── build.rs                   # 构建辅助脚本
    ├── capabilities/
    │   └── default.json           # 权限配置文件
    ├── icons/                     # 应用图标资源
    ├── binaries/                  # 产物目录 (nexus-server-<triple>.exe)
    └── src/
        └── main.rs                # Rust 主进程入口 (动态端口绑定、生命周期优雅清理)
```

---

## 🛠️ 构建与开发指南

### 1. 前置依赖 (编译环境)
- **Node.js**: >= 20.x (当前已通过 Node v22.13 验证)
- **Rust**: >= 1.77.x (`rustup-init.exe`)
- **Windows**: Microsoft C++ 生成工具 (MSVC) 与 WebView2 Runtime (Win10/Win11 默认已内置)

### 2. 常用命令
在项目根目录或 `packages/desktop` 目录下运行：

```bash
# 1. 准备后端 Sidecar 二进制
npm --prefix packages/desktop run build:sidecar

# 2. 启动开发模式 (桌面窗口调试)
npm --prefix packages/desktop run desktop:dev

# 3. 构建发布安装包 (.msi / .exe 安装程序)
npm --prefix packages/desktop run desktop:build
```

---

## 🚀 CI/CD 自动化构建示例 (GitHub Actions)

由于 Tauri 编译需要 Rust 环境，推荐直接通过 GitHub Actions 的标准 `windows-latest` 机器构建，无需在个人电脑额外占用数 GB 的 C++ 开发环境：

```yaml
name: Release Desktop App
on:
  push:
    tags:
      - 'v*'

jobs:
  build-tauri:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: dtolnay/rust-toolchain@stable
      - run: npm install
      - run: npm run build --prefix packages/frontend
      - run: npm run build --prefix packages/backend
      - run: npm run desktop:build --prefix packages/desktop
      - uses: actions/upload-artifact@v4
        with:
          name: nexus-terminal-setup
          path: packages/desktop/src-tauri/target/release/bundle/msi/*.msi
```
