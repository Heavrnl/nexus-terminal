// packages/desktop/scripts/build-sidecar.js
/**
 * Tauri v2 自包含桌面环境与 Node.js Sidecar 准备脚本
 * 功能：
 * 1. 同步后端编译产物 (backend/dist) 到 resources/server/dist
 * 2. 同步前端编译页面 (frontend/dist) 到 resources/server/public (由后端 Express 托管)
 * 3. 准备纯净的后端生产依赖 (resources/server/node_modules)
 * 4. 拷贝官方 Node.js 运行时作为 Tauri Sidecar 二进制 (nexus-server-<triple>.exe)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 桌面端会把 **构建机的 node.exe 原样打进安装包**（见文件末尾拷贝 process.execPath 的逻辑），
 * 用户装完就再也换不掉它。所以这里必须拦住版本过旧的 Node —— 2026-10 的安全公告里
 * Brotli 解码器越界写（CVE-2026-111497，可 RCE）、TLS 主机名校验绕过等，只要 Node
 * 低于 22.23.4 就会被打进发布包。
 */
const MIN_NODE = [22, 23, 4];
function assertNodeVersion() {
  const cur = process.versions.node.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i += 1) {
    if ((cur[i] || 0) > MIN_NODE[i]) return;
    if ((cur[i] || 0) < MIN_NODE[i]) {
      const msg =
        `当前 Node ${process.versions.node} 低于桌面端要求的最低版本 ${MIN_NODE.join('.')}。\n` +
        `桌面端会把构建机的 Node 运行时打进安装包（用户装完换不掉），\n` +
        `低于该版本缺少 2026-10 安全公告的修复（Brotli 解码器越界写可 RCE 等）。\n` +
        `请先升级 Node：nvm install ${MIN_NODE.join('.')} && nvm use ${MIN_NODE.join('.')}`;
      if (process.env.ALLOW_OLD_NODE === '1') {
        console.warn(`\n⚠️  ${msg}\n   已通过 ALLOW_OLD_NODE=1 跳过检查，产物不可用于发布。\n`);
        return;
      }
      console.error(`\n❌ ${msg}\n   （仅本地调试且不发版时，可临时设 ALLOW_OLD_NODE=1）\n`);
      process.exit(1);
    }
  }
}
assertNodeVersion();

function getHostTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    if (arch === 'ia32') return 'i686-pc-windows-msvc';
  } else if (platform === 'darwin') {
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    if (arch === 'x64') return 'x86_64-apple-darwin';
  } else if (platform === 'linux') {
    if (arch === 'x64') return 'x86_64-unknown-linux-gnu';
    if (arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  }

  throw new Error(`暂不支持的宿主系统架构: ${platform}-${arch}`);
}

async function main() {
  console.log('🚀 [Tauri Packager] 开始准备 Nexus Terminal 自包含桌面环境与 Sidecar...');

  const triple = getHostTargetTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const sidecarBinaryName = `nexus-server-${triple}${ext}`;

  const desktopDir = path.resolve(__dirname, '..');
  const srcTauriDir = path.join(desktopDir, 'src-tauri');
  const binariesDir = path.join(srcTauriDir, 'binaries');
  const resourcesDir = path.join(srcTauriDir, 'resources');
  const serverDir = path.join(resourcesDir, 'server');

  fs.mkdirSync(binariesDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const rootDir = path.resolve(desktopDir, '../..');
  const backendDir = path.join(rootDir, 'packages', 'backend');
  const frontendDir = path.join(rootDir, 'packages', 'frontend');

  // 1. 确保后端已构建并打包为自包含单文件 Bundle (零碎文件架构)
  console.log('⚡ 正在编译并打包后端自包含 Bundle (npm run bundle)...');
  execSync('npm run bundle', { cwd: backendDir, stdio: 'inherit' });

  // 2. 确保前端已构建
  const frontendDist = path.join(frontendDir, 'dist');
  if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
    console.log('⚡ 正在编译前端 Vue 源码...');
    execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
  }

  // 3. 同步 dist-bundle 到 resources/server/dist
  // 注意：这里不做整目录 rmSync —— 某些环境（沙箱 / 安全策略）会拦截批量删除，
  // 导致 beforeBuildCommand 直接失败。改为"改名归档 + 覆盖同步"：
  // 旧目录改名到 .dist-old（只保留一份），cpSync 再完整覆盖。
  const serverDistDir = path.join(serverDir, 'dist');
  const oldServerDistDir = path.join(serverDir, '.dist-old');
  if (fs.existsSync(serverDistDir)) {
    try {
      if (fs.existsSync(oldServerDistDir)) {
        fs.renameSync(oldServerDistDir, path.join(serverDir, '.dist-older'));
      }
      fs.renameSync(serverDistDir, oldServerDistDir);
    } catch (err) {
      console.warn('⚠️ 归档旧 dist 失败（将直接覆盖）:', err.message);
    }
  }
  const backendDistBundle = path.join(backendDir, 'dist-bundle');
  console.log('📦 正在同步后端自包含产物到 resources/server/dist...');
  fs.cpSync(backendDistBundle, serverDistDir, { recursive: true, force: true });

  // 4. 同步 frontend/dist 到 resources/server/public 与 resources/server/dist/public
  console.log('🎨 正在同步前端页面到 resources/server/public 与 resources/server/dist/public...');
  fs.cpSync(frontendDist, path.join(serverDir, 'public'), { recursive: true, force: true });
  fs.cpSync(frontendDist, path.join(serverDir, 'dist', 'public'), { recursive: true, force: true });

  // 4.1 同步多语言包 (locales)
  const localesSrc = path.join(backendDir, 'src', 'locales');
  if (fs.existsSync(localesSrc)) {
    console.log('🌐 正在同步多语言包到 resources/server/locales 与 resources/server/dist/locales...');
    fs.cpSync(localesSrc, path.join(serverDir, 'locales'), { recursive: true, force: true });
    fs.cpSync(localesSrc, path.join(serverDir, 'dist', 'locales'), { recursive: true, force: true });
  }

  // 5. 同步 HTML 预设背景主题 (html-presets)
  const htmlPresetsSrc = path.join(backendDir, 'html-presets');
  if (fs.existsSync(htmlPresetsSrc)) {
    console.log('🖼️ 正在同步 HTML 预设背景主题到 resources/server/html-presets...');
    fs.cpSync(htmlPresetsSrc, path.join(serverDir, 'html-presets'), { recursive: true, force: true });
    fs.cpSync(htmlPresetsSrc, path.join(serverDir, 'dist', 'html-presets'), { recursive: true, force: true });
  } else {
    console.warn('⚠️ 未找到 html-presets 目录: ' + htmlPresetsSrc);
  }

  // 5.1 同步多平台目标机托管代理二进制 (agent-binaries)
  const agentBinariesSrc = path.join(rootDir, 'packages', 'remote-agent', 'dist');
  if (fs.existsSync(path.join(agentBinariesSrc, 'manifest.json'))) {
    console.log('🤖 正在内置多平台 nexus-mux 托管代理到 resources/server/agent-binaries...');
    fs.cpSync(agentBinariesSrc, path.join(serverDir, 'agent-binaries'), { recursive: true, force: true });
    fs.cpSync(agentBinariesSrc, path.join(serverDir, 'dist', 'agent-binaries'), { recursive: true, force: true });
  } else {
    console.warn('⚠️ 未找到预编译的 nexus-mux manifest.json（如需内置目标机托管代理请先运行 npm run agent:build）');
  }

  // 5. 准备极简 package.json (已全量 Bundle，零外部运行时依赖)
  const backendPkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8'));
  const cleanPkg = {
    name: 'nexus-terminal-server',
    version: backendPkg.version,
    private: true,
    main: 'dist/index.js'
  };
  fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify(cleanPkg, null, 2));

  // 6. 清理冗余的 node_modules 碎小文件 (Bundle 模式下已完全自包含，消除 13,000+ 碎片)
  const serverNodeModules = path.join(serverDir, 'node_modules');
  if (fs.existsSync(serverNodeModules)) {
    console.log('🧹 正在清理冗余的 node_modules 碎小文件...');
    fs.rmSync(serverNodeModules, { recursive: true, force: true });
  }
  console.log('✅ 零碎片自包含服务资源已就绪 (无需庞大 node_modules)');

  // 7. 将当前运行的 node.exe 拷贝为 Sidecar 二进制
  const targetBinaryPath = path.join(binariesDir, sidecarBinaryName);
  console.log(`🎯 准备 Node 运行时 Sidecar 二进制: ${sidecarBinaryName}`);
  const nodeExePath = process.execPath;
  console.log(`📌 宿主 Node.js 路径: ${nodeExePath}`);

  fs.copyFileSync(nodeExePath, targetBinaryPath);
  console.log(`✅ Sidecar 二进制部署完毕: ${targetBinaryPath}`);

  console.log('✨ [Tauri Packager] 所有自包含资源与 Sidecar 准备完成！');
}

main().catch(err => {
  console.error('❌ [Tauri Packager] 准备失败:', err);
  process.exit(1);
});
