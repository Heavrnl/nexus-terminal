/**
 * 目标服务器环境探测、OS/架构归一化与自动加固命令构造（纯函数，不含 SSH IO，便于单测全覆盖）。
 */

import crypto from 'crypto';
import type { AgentArch, AgentOs } from './agent-binary.registry';

/**
 * 根据持久化的全局 workspaceOwnerId 派生不可逆的 32 字符十六进制 ownerNamespace。
 */
export function deriveOwnerNamespace(workspaceOwnerId: string): string {
  return crypto
    .createHash('sha256')
    .update(`nexus-mux-ns:${workspaceOwnerId.trim()}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export interface TargetProbeResult {
  platformFamily: 'unix' | 'windows' | 'unknown';
  os: AgentOs | null;
  arch: AgentArch | null;
  /** 可写且可执行的代理安装目录 */
  installDir: string | null;
  /** 最终二进制完整路径 */
  binaryPath: string | null;
  /** 已安装的 nexus-mux 版本（空字符串表示未安装或损坏不可执行） */
  installedVersion: string | null;
  /** 已安装二进制的 SHA256（可选） */
  installedSha256: string | null;
  /** Unix 下是否存在 systemd KillUserProcesses=yes 且未开启 linger */
  needsLingerFix: boolean;
  /** Unix 下当前用户名（用于 loginctl enable-linger） */
  username: string;
  isRoot: boolean;
  hasPasswordlessSudo: boolean;
  /** 仅 Unix：系统是否有 sha256sum / shasum 用于上传后校验 */
  hashTool: 'sha256sum' | 'shasum' | 'openssl' | null;
}

/** 根据 SFTP realpath('.') 判断大类平台（Unix 以 / 开头且非 /C:/ 形式；Windows 为 C:\ 或 /C:/） */
export function inferPlatformFamilyFromSftpHome(homePath: string | null | undefined): 'unix' | 'windows' | 'unknown' {
  if (!homePath || typeof homePath !== 'string') return 'unknown';
  const trimmed = homePath.trim();
  if (!trimmed) return 'unknown';
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\/[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.includes('\\')) {
    return 'windows';
  }
  if (trimmed.startsWith('/')) {
    return 'unix';
  }
  return 'unknown';
}

/** 归一化 uname -s / Windows OS 输出为标准 AgentOs */
export function normalizeOs(raw: string | null | undefined): AgentOs | null {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'linux' || s.startsWith('linux')) return 'linux';
  if (s === 'darwin' || s === 'macos' || s.startsWith('darwin')) return 'darwin';
  if (s === 'freebsd' || s.startsWith('freebsd')) return 'freebsd';
  if (s === 'windows' || s.startsWith('windows') || s.startsWith('mingw') || s.startsWith('msys') || s.startsWith('cygwin')) {
    return 'windows';
  }
  return null;
}

/** 归一化 uname -m / PROCESSOR_ARCHITECTURE 输出为标准 AgentArch */
export function normalizeArch(raw: string | null | undefined): AgentArch | null {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'x86_64' || s === 'amd64' || s === 'x64') return 'x86_64';
  if (s === 'aarch64' || s === 'arm64') return 'aarch64';
  if (s === 'armv7l' || s === 'armv7' || s === 'armhf') return 'armv7';
  return null;
}

/** 解析 `nexus-mux version` 输出中的版本号（形如 `nexus-mux 0.1.0 (protocol=1 ...)`） */
export function parseAgentVersionOutput(stdout: string | null | undefined): string | null {
  if (!stdout) return null;
  const m = /nexus-mux\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return m ? m[1] : null;
}

/**
 * Unix（Linux / macOS / BSD）单次 SSH exec 探测脚本：
 * 一次往返获取 OS、Arch、可写目录、已装版本、哈希工具、KillUserProcesses/linger 状态与提权能力。
 * 严格兼容 POSIX sh / dash / ash（Alpine BusyBox 无 bash 也能稳定运行）。
 */
export const UNIX_PROBE_SCRIPT = [
  'OS=$(uname -s 2>/dev/null || echo "")',
  'ARCH=$(uname -m 2>/dev/null || echo "")',
  'USER_NAME=$(id -un 2>/dev/null || echo "${USER:-}")',
  'IS_ROOT=0; [ "$(id -u 2>/dev/null)" = "0" ] && IS_ROOT=1',
  'SUDO=0; if command -v sudo >/dev/null 2>&1; then sudo -n true >/dev/null 2>&1 && SUDO=1; fi',
  'HASH_TOOL=""',
  'for ht in sha256sum shasum openssl; do if command -v "$ht" >/dev/null 2>&1; then HASH_TOOL="$ht"; break; fi; done',
  'INSTALL_DIR=""',
  'for cand in "$HOME/.nexus-terminal/bin" "${XDG_DATA_HOME:-$HOME/.local/share}/nexus-terminal/bin" "/tmp/.nexus-terminal-${USER_NAME:-$(id -u 2>/dev/null)}/bin"; do',
  '  [ -z "$cand" ] && continue',
  '  if mkdir -p "$cand" 2>/dev/null && [ -w "$cand" ]; then',
  '    TESTF="$cand/.nx_probe_$$"',
  '    if (printf "#!/bin/sh\\nexit 0\\n" > "$TESTF" && chmod 700 "$TESTF" && "$TESTF") >/dev/null 2>&1; then',
  '      rm -f "$TESTF" 2>/dev/null',
  '      INSTALL_DIR="$cand"',
  '      break',
  '    fi',
  '    rm -f "$TESTF" 2>/dev/null',
  '  fi',
  'done',
  'VER=""; BIN_PATH=""',
  'if [ -n "$INSTALL_DIR" ]; then',
  '  BIN_PATH="$INSTALL_DIR/nexus-mux"',
  '  if [ -x "$BIN_PATH" ]; then VER=$("$BIN_PATH" version 2>/dev/null | head -n 1 || true); fi',
  'fi',
  'NEEDS_LINGER=0',
  'if [ "$OS" = "Linux" ]; then',
  '  KUP=$(grep -h "^[[:space:]]*KillUserProcesses=" /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null | tail -n 1 | cut -d= -f2 | tr "[:upper:]" "[:lower:]" | tr -d "[:space:]")',
  '  if [ "$KUP" = "yes" ] || [ "$KUP" = "true" ] || [ "$KUP" = "1" ]; then',
  '    if [ -n "$USER_NAME" ] && [ ! -f "/var/lib/systemd/linger/$USER_NAME" ]; then NEEDS_LINGER=1; fi',
  '  fi',
  'fi',
  'printf "NX_OS=%s\\nNX_ARCH=%s\\nNX_USER=%s\\nNX_ROOT=%s\\nNX_SUDO=%s\\nNX_HASH=%s\\nNX_DIR=%s\\nNX_BIN=%s\\nNX_VER=%s\\nNX_LINGER=%s\\n" "$OS" "$ARCH" "$USER_NAME" "$IS_ROOT" "$SUDO" "$HASH_TOOL" "$INSTALL_DIR" "$BIN_PATH" "$VER" "$NEEDS_LINGER"',
].join('\n');

/**
 * Windows OpenSSH 探测命令（使用 powershell -NoProfile -NonInteractive 兼容 cmd.exe 或 powershell.exe 默认 shell）。
 */
export const WINDOWS_PROBE_COMMAND =
  'powershell -NoProfile -NonInteractive -Command "' +
  "$arch = $env:PROCESSOR_ARCHITECTURE; " +
  "if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }; " +
  "$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $env:TEMP }; " +
  "$dir = Join-Path $base 'nexus-terminal\\bin'; " +
  "New-Item -ItemType Directory -Path $dir -Force | Out-Null; " +
  "$bin = Join-Path $dir 'nexus-mux.exe'; " +
  "$ver = ''; if (Test-Path $bin) { try { $ver = (& $bin version 2>$null | Select-Object -First 1) } catch { $ver = '' } }; " +
  "Write-Output ('NX_OS=Windows'); " +
  "Write-Output ('NX_ARCH=' + $arch); " +
  "Write-Output ('NX_USER=' + $env:USERNAME); " +
  "Write-Output ('NX_DIR=' + $dir); " +
  "Write-Output ('NX_BIN=' + $bin); " +
  "Write-Output ('NX_VER=' + $ver)" +
  '"';

function extractField(stdout: string, key: string): string {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = re.exec(stdout || '');
  return m ? m[1].replace(/\r$/, '').trim() : '';
}

export function parseUnixProbeOutput(stdout: string): TargetProbeResult {
  const os = normalizeOs(extractField(stdout, 'NX_OS'));
  const arch = normalizeArch(extractField(stdout, 'NX_ARCH'));
  const installDir = extractField(stdout, 'NX_DIR') || null;
  const binaryPath = extractField(stdout, 'NX_BIN') || null;
  const rawVer = extractField(stdout, 'NX_VER');
  const hashRaw = extractField(stdout, 'NX_HASH');
  const hashTool =
    hashRaw === 'sha256sum' || hashRaw === 'shasum' || hashRaw === 'openssl' ? hashRaw : null;

  return {
    platformFamily: os === 'windows' ? 'windows' : os ? 'unix' : 'unknown',
    os,
    arch,
    installDir,
    binaryPath,
    installedVersion: parseAgentVersionOutput(rawVer),
    installedSha256: null,
    needsLingerFix: extractField(stdout, 'NX_LINGER') === '1',
    username: extractField(stdout, 'NX_USER'),
    isRoot: extractField(stdout, 'NX_ROOT') === '1',
    hasPasswordlessSudo: extractField(stdout, 'NX_SUDO') === '1',
    hashTool,
  };
}

export function parseWindowsProbeOutput(stdout: string): TargetProbeResult {
  const os = normalizeOs(extractField(stdout, 'NX_OS') || 'windows');
  const arch = normalizeArch(extractField(stdout, 'NX_ARCH'));
  const installDir = extractField(stdout, 'NX_DIR') || null;
  const binaryPath = extractField(stdout, 'NX_BIN') || null;
  const rawVer = extractField(stdout, 'NX_VER');

  return {
    platformFamily: 'windows',
    os,
    arch,
    installDir,
    binaryPath,
    installedVersion: parseAgentVersionOutput(rawVer),
    installedSha256: null,
    needsLingerFix: false,
    username: extractField(stdout, 'NX_USER'),
    isRoot: false,
    hasPasswordlessSudo: false,
    hashTool: null,
  };
}

/** 判断目标机是否需要上传/覆盖二进制（未安装或版本与内置版本不一致） */
export function needsAgentDeploy(installedVersion: string | null, desiredVersion: string): boolean {
  if (!installedVersion) return true;
  return installedVersion.trim() !== desiredVersion.trim();
}

/** 构造 Unix 下免交互启用 systemd linger 的自动加固命令；无权限时返回 null */
export function buildEnableLingerCommand(probe: TargetProbeResult): string | null {
  if (probe.platformFamily !== 'unix' || !probe.needsLingerFix) return null;
  if (!probe.username || !/^[a-zA-Z0-9._-]+$/.test(probe.username)) return null;
  if (!probe.isRoot && !probe.hasPasswordlessSudo) return null;
  const prefix = probe.isRoot ? '' : 'sudo -n ';
  return `${prefix}loginctl enable-linger ${probe.username}`;
}

/** 构造用于校验远端文件 SHA256 的跨平台命令 */
export function buildRemoteSha256Command(probe: TargetProbeResult, filePath: string): string | null {
  if (probe.platformFamily === 'windows') {
    const escaped = filePath.replace(/'/g, "''");
    return `powershell -NoProfile -NonInteractive -Command "(Get-FileHash -LiteralPath '${escaped}' -Algorithm SHA256).Hash.ToLower()"`;
  }
  const quoted = shellQuoteUnix(filePath);
  if (probe.hashTool === 'sha256sum') {
    return `sha256sum ${quoted} | awk '{print $1}'`;
  }
  if (probe.hashTool === 'shasum') {
    return `shasum -a 256 ${quoted} | awk '{print $1}'`;
  }
  if (probe.hashTool === 'openssl') {
    return `openssl dgst -sha256 ${quoted} | awk '{print $NF}'`;
  }
  return null;
}

/** 构造启动 `nexus-mux stdio` 的安全命令行 */
export function buildMuxStdioCommand(platformFamily: 'unix' | 'windows', binaryPath: string): string {
  if (platformFamily === 'windows') {
    // 兼容 Windows OpenSSH 的 cmd.exe 与 powershell.exe 两种默认 shell
    const escaped = binaryPath.replace(/"/g, '\\"');
    return `"${escaped}" stdio`;
  }
  return `exec ${shellQuoteUnix(binaryPath)} stdio`;
}

/** Unix POSIX 单引号安全转义 */
export function shellQuoteUnix(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** 将 Windows 路径转换为 OpenSSH SFTP 路径格式（如 C:\Users\a -> /C:/Users/a） */
export function toSftpPath(platformFamily: 'unix' | 'windows', fsPath: string): string {
  if (platformFamily !== 'windows') return fsPath;
  const forward = fsPath.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(forward) ? `/${forward}` : forward;
}
