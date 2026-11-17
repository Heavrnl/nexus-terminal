![banner.png](https://lsky.tuyu.me/i/2025/04/30/681209e053db7.png)
---

<div align="center">

[![Docker](https://img.shields.io/badge/-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)][docker-url] [![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-4CAF50?style=flat-square)](https://github.com/Heavrnl/nexus-terminal/blob/main/LICENSE)
<br>
[中文](./README.md) | [English](./doc/README_EN.md)

[docker-url]: https://hub.docker.com/r/heavrnl/nexus-terminal

</div>


## 📖 概述

**星枢终端（Nexus Terminal）** 是一款现代化、功能丰富的 Web SSH / RDP / VNC 客户端，致力于提供高度可定制的远程连接体验。提供独立的本地桌面端。

## ✨ 功能特性

*   多标签页管理 SSH 与 SFTP 连接  
*   支持 RDP/VNC 协议（和 SSH 一样开在会话标签里，画面占满工作区，支持双向剪贴板同步）
*   支持 PWA
*   采用 Monaco Editor，支持在线编辑文件  
*   集成多重登录安全机制，包括人机验证（hCaptcha、Google reCAPTCHA）与双因素认证（2FA）  
*   支持 OIDC 单点登录（可配置多个身份提供商，如 Keycloak、Authentik、Google 等），已有账号可随时绑定/解绑
*   高度可定制的界面主题与布局风格
*   内置简易 Docker 容器管理面板，便于容器运维  
*   支持 IP 白名单与黑名单，异常访问自动封禁  
*   通知系统（如登录提醒、异常告警）  
*   审计日志，全面记录用户行为与系统变更
*   基于 Node.js 的轻量级后端，资源占用低
*   内置心跳保活机制，确保连接稳定

## 📸 截图





|                            终端界面（Light）                            |
|:-------------------------------------------------------------:|
| ![workspace_light.png](https://lsky.tuyu.me/i/2025/04/30/68120a8dd0489.png) |

---

|                            终端界面（Dark）                            |
|:-------------------------------------------------------------:|
| ![workspace_darker.png](https://lsky.tuyu.me/i/2025/04/30/68120aa275a76.png) |

---

|                            移动端界面1                            |                            移动端界面2                            |
|:-------------------------------------------------------------:|:-------------------------------------------------------------:|
| ![1746339196937.png](https://lsky.tuyu.me/i/2025/05/04/6817056948ac2.png) |![1746339222136.png](https://lsky.tuyu.me/i/2025/05/04/681705820fe01.png) |

---


## 🖥️ 桌面端


https://github.com/Heavrnl/nexus-terminal/releases/latest

## 🚀 快速开始

### 1️⃣ 配置环境


新建文件夹
```bash
mkdir ./nexus-terminal && cd ./nexus-terminal
```


下载仓库中的 [**docker-compose.yml**](https://raw.githubusercontent.com/Heavrnl/nexus-terminal/refs/heads/main/docker-compose.yml) 和 [**.env**](https://raw.githubusercontent.com/Heavrnl/nexus-terminal/refs/heads/main/.env) 文件到当前目录。
```bash
wget https://raw.githubusercontent.com/Heavrnl/nexus-terminal/refs/heads/main/docker-compose.yml -O docker-compose.yml && wget https://raw.githubusercontent.com/Heavrnl/nexus-terminal/refs/heads/main/.env -O .env
```



配置 nginx
```conf
location / {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_redirect off;
    proxy_pass http://127.0.0.1:18111;
}
```



为 docker 配置IPv6（可选，如果你不使用ipv6连接服务器可以不配置）

在`/etc/docker/daemon.json`加入以下内容
```json
{
  "ipv6": true,
  "fixed-cidr-v6": "fd00::/80",
  "ip6tables": true,
  "experimental": true
}
```
重启docker服务
```
sudo systemctl restart docker
```

### 2️⃣ 启动服务

```bash
docker compose up -d
```

### 3️⃣ 更新
注意：docker-compose 运行不需要拉取仓库源码，除非你打算自己build，否则只需要在项目目录执行以下命令即可更新。
```bash
docker compose down
```
```bash
docker compose pull
```
```bash
docker compose up -d
```

## 📚 使用指南

### 挂起会话组件
你可以在 SSH 标签页中右键选择“挂起会话”（移动界面长按即可）。一旦挂起，即使网页断开连接，后端也会自动接管并保持 SSH 连接不中断。你可以随时通过面板组件重新恢复会话，整个过程确保编译、长任务等操作不会因网络波动等原因中断。

### 命令输入框组件

1.  **标签页切换**：当命令输入框获得焦点时，使用 `Alt + ↑/↓` 切换 SSH 会话标签页，使用 `Alt + ←/→` 切换文本编辑器标签页。
2.  **命令同步**（需在设置中开启）：开启后，在命令输入框中输入的文字将实时同步到选定的目标输入源。使用 `↑/↓` 键选择菜单命令项，然后按下 `Enter` 发送选中的指令。


### 文件管理器组件

1.  **文件快速选择**：在文件搜索框获得焦点时，可以使用 `↑/↓` 键快速选择文件。
2.  **拖拽上传**：支持从浏览器外部拖拽文件或文件夹进行上传。**注意：** 上传大量文件或深层文件夹时，建议先进行打包压缩，以避免浏览器卡死。
3.  **内部拖拽**：可以直接在文件管理器内部拖动文件或文件夹以进行移动。
4.  **多选操作**：按住 `Ctrl` 或 `Shift` 键可以选择多个文件或文件夹。
5.  **右键菜单**：提供复制、粘贴、剪切、删除、重命名、修改权限等常用文件操作。

### 终端组件
1.  Ctrl + Shift + C 复制，Ctrl + Shift + V 粘贴


### 历史命令组件

1.  **查看完整命令**：当历史命令过长被截断时，将鼠标悬停在命令上即可查看完整的指令内容。

### 通用操作

1.  **缩放**：在终端、文件管理器和文本编辑器组件和快捷指令视图中，可以使用 `Ctrl + 鼠标滚轮` 进行缩放。
2.  **侧栏**：展开的侧栏可以通过拖拽调节宽度。
3.  **标签栏**：对于ssh标签栏和文件管理器标签栏可以右键弹出菜单，内容项有：关闭，关闭左侧标签页，关闭其他标签页，关闭右侧标签页。
4.  **标签分组折叠栏** 可以直接点击视图里的标签名字修改标签名称
5.  **自动重连**：在连接断开状态下，可在命令输入框或终端中按回车，或点击连接列表中的同一 SSH 连接以触发自动重连。

### 其他
1. **移动端可以通过双指手势放大缩小终端字体**
2. 如需启用 Passkey 登录，请在 `.env` 文件中设置 `RP_ID` 和 `RP_ORIGIN` 环境变量。

### OIDC 单点登录

OIDC 提供商在 **设置 → 安全 → OIDC 登录** 中配置，无需改 `.env`，可同时配置多个提供商。每个提供商需要填写：

| 字段 | 说明 |
| --- | --- |
| 名称 | 登录页按钮上显示的名字 |
| Issuer URL | 提供商的 issuer，例如 `https://keycloak.example.com/realms/myrealm`（自动读取其 `/.well-known/openid-configuration`） |
| Client ID / Client Secret | 在提供商侧创建的 confidential client 凭据 |
| Scopes | 默认 `openid profile email`，一般无需修改 |
| 自动创建用户 | 开启后，未绑定过的 OIDC 用户首次登录会自动建号（无本地密码） |
| 允许的邮箱域名 | 可选，逗号分隔；填了之后只有这些域名的邮箱才能自动建号 |

**在提供商侧需要登记的回调地址（Redirect URI）**：

```
https://<你的域名>/api/v1/auth/oidc/providers/<providerId>/callback
```

> `<providerId>` 是保存提供商后由系统生成的 UUID，可在 OIDC 设置页看到。由于每个提供商 ID 不同，
> 建议按提供商分别精确登记回调地址。Keycloak 26 只支持**结尾**通配，可填
> `https://<你的域名>/api/v1/auth/oidc/providers/*` 一次覆盖全部提供商；中段通配（如
> `.../providers/*/callback`）会被拒绝。

**绑定与解绑**：已登录用户可在 **设置 → 安全 → OIDC 登录 → 已绑定账号** 中绑定新提供商或解绑已有绑定。
绑定成功后即可用该提供商登录；解绑后该提供商不再能登录此账号（本地密码不受影响）。

> 提示：配置明文 HTTP 的 issuer（如本地调试用的 `http://127.0.0.1:8080`）时，后端会放行非 HTTPS 的
> 发现请求，仅建议在受信任的内网环境中这样做。

## ⚠️ 注意事项

1. 关于数据备份，请自行备份目录下的 data 文件夹，本项目不提供相关备份功能。
2. 由于浏览器限制，非https或者localhost无法复制终端内容，请使用https访问


## 💐 致谢

*   预设主题方案来源于优秀的 [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) 项目。

## ☕ 捐赠

如果你觉得这个项目对你有帮助，欢迎通过以下方式请我喝杯咖啡：

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/0heavrnl)


## 📄 开源协议

本项目采用 [GPL-3.0](LICENSE) 开源协议，详细信息请参阅 [LICENSE](LICENSE) 文件。

