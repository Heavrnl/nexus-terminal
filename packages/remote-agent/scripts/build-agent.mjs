#!/usr/bin/env node
/**
 * nexus-mux 跨平台二进制打包与 manifest.json 生成脚本
 *
 * 用法：
 *   1. 本地构建当前宿主机目标：
 *      node packages/remote-agent/scripts/build-agent.mjs --host-only
 *   2. CI 汇总各平台矩阵编译产物目录（文件名形如 nexus-mux-<os>-<arch>[.exe]）：
 *      node packages/remote-agent/scripts/build-agent.mjs --collect-from <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(AGENT_DIR, 'dist');
const CARGO_TOML = path.join(AGENT_DIR, 'Cargo.toml');

const PROTOCOL_VERSION = 1;

function readAgentVersion() {
  const raw = fs.readFileSync(CARGO_TOML, 'utf8');
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('无法从 Cargo.toml 解析 nexus-mux 版本号');
  return match[1];
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function detectHostPlatform() {
  const os = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return { os, arch };
}

function packageBinary(rawPath, os, arch) {
  const rawBuf = fs.readFileSync(rawPath);
  const gzBuf = zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_COMPRESSION });
  const ext = os === 'windows' ? '.exe' : '';
  const gzName = `nexus-mux-${os}-${arch}${ext}.gz`;
  const targetGzPath = path.join(DIST_DIR, gzName);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(targetGzPath, gzBuf);

  const entry = {
    os,
    arch,
    filename: gzName,
    binaryName: `nexus-mux${ext}`,
    rawSha256: sha256Hex(rawBuf),
    gzipSha256: sha256Hex(gzBuf),
    rawSize: rawBuf.length,
    gzipSize: gzBuf.length,
  };
  console.log(
    `📦 [nexus-mux] 已打包 ${os}-${arch}: ${(rawBuf.length / 1024).toFixed(1)}KB -> ${(gzBuf.length / 1024).toFixed(1)}KB (${gzName})`
  );
  return entry;
}

function writeManifest(version, targets) {
  const manifest = {
    version,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    targets,
  };
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✅ [nexus-mux] manifest.json 已生成 (${Object.keys(targets).length} 个平台): ${manifestPath}`);
}

function parseArgs(argv) {
  const out = { hostOnly: false, collectFrom: null, skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host-only') out.hostOnly = true;
    else if (arg === '--skip-build') out.skipBuild = true;
    else if (arg === '--collect-from' && argv[i + 1]) {
      out.collectFrom = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = readAgentVersion();
  const targets = {};

  // 先加载已有 manifest（便于增量补充宿主机平台）
  const existingManifestPath = path.join(DIST_DIR, 'manifest.json');
  if (!opts.collectFrom && fs.existsSync(existingManifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'));
      if (existing && existing.version === version && existing.targets) {
        Object.assign(targets, existing.targets);
      }
    } catch {}
  }

  if (opts.collectFrom) {
    if (!fs.existsSync(opts.collectFrom)) {
      throw new Error(`产物汇总目录不存在: ${opts.collectFrom}`);
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const m = entry.name.match(/^nexus-mux-(linux|darwin|windows|freebsd)-(x86_64|aarch64|armv7)(\.exe)?$/);
        if (!m) continue;
        const [, os, arch] = m;
        targets[`${os}-${arch}`] = packageBinary(full, os, arch);
      }
    };
    walk(opts.collectFrom);
    if (Object.keys(targets).length === 0) {
      throw new Error(`在 ${opts.collectFrom} 下未找到任何 nexus-mux-<os>-<arch> 二进制文件`);
    }
    writeManifest(version, targets);
    return;
  }

  // 默认或 --host-only：构建并打包当前宿主机平台
  const { os, arch } = detectHostPlatform();
  if (!opts.skipBuild) {
    console.log(`🔨 [nexus-mux] 正在构建当前宿主机 Release (${os}-${arch})...`);
    execSync('cargo build --release', { cwd: AGENT_DIR, stdio: 'inherit' });
  }
  const ext = os === 'windows' ? '.exe' : '';
  const builtPath = path.join(AGENT_DIR, 'target', 'release', `nexus-mux${ext}`);
  if (!fs.existsSync(builtPath)) {
    throw new Error(`未找到编译产物: ${builtPath}`);
  }
  targets[`${os}-${arch}`] = packageBinary(builtPath, os, arch);
  writeManifest(version, targets);
}

main();
