/**
 * 文件管理器图标映射工具库
 * 提供单例静态映射表，杜绝在列表渲染时高频重复创建大对象造成的 GC 压力
 */

// 特殊全文件名匹配表
const SPECIAL_FILENAME_MAP: Record<string, string> = {
  'makefile': 'fas fa-cogs',
  'dockerfile': 'fab fa-docker',
  'package.json': 'fab fa-npm',
  'package-lock.json': 'fab fa-npm',
  'yarn.lock': 'fab fa-yarn',
  'pnpmfile.js': 'fas fa-cogs',
  'composer.json': 'fab fa-php',
  'composer.lock': 'fab fa-php',
  'gemfile': 'fas fa-gem',
  'gemfile.lock': 'fas fa-gem',
  '.git': 'fab fa-git-alt',
  '.gitignore': 'fab fa-git-alt',
  '.gitattributes': 'fab fa-git-alt',
  '.gitmodules': 'fab fa-git-alt',
  '.gitkeep': 'fab fa-git-alt',
  'gitconfig': 'fab fa-git-alt',
  'dockerignore': 'fab fa-docker',
  'npmignore': 'fab fa-npm',
  'npmrc': 'fab fa-npm',
  'yarnrc': 'fab fa-yarn',
  'babelrc': 'fas fa-cogs',
  'eslintrc': 'fas fa-cogs',
  'prettierrc': 'fas fa-cogs',
  'stylelintrc': 'fas fa-cogs',
  'browserslistrc': 'fas fa-cogs',
  'editorconfig': 'fas fa-cog',
  'tsconfig.json': 'fas fa-cogs',
  'jsconfig.json': 'fas fa-cogs',
  'webpack.config.js': 'fas fa-cogs',
  'vite.config.js': 'fas fa-cogs',
  'vite.config.ts': 'fas fa-cogs',
  'rollup.config.js': 'fas fa-cogs',
  'postcss.config.js': 'fas fa-cogs',
  'jest.config.js': 'fas fa-cogs',
  'cypress.json': 'fas fa-cogs',
  'playwright.config.ts': 'fas fa-cogs',
  'readme': 'fas fa-book-reader',
  'license': 'fas fa-balance-scale',
  'contributing': 'fas fa-users-cog',
  'code_of_conduct': 'fas fa-gavel',
  'changelog': 'fas fa-list-alt',
  'favicon.ico': 'fas fa-icons',
  'htaccess': 'fas fa-cog',
  'htpasswd': 'fas fa-lock',
  'bashrc': 'fas fa-cog',
  'zshrc': 'fas fa-cog',
  'profile': 'fas fa-cog',
  'bash_profile': 'fas fa-cog',
  'vimrc': 'fas fa-cog',
  'screenrc': 'fas fa-cog',
  'tmux.conf': 'fas fa-cog',
};

// 后缀名映射表（静态常量）
const EXTENSION_ICON_MAP: Record<string, string> = {
  // 图像
  'jpg': 'fas fa-file-image',
  'jpeg': 'fas fa-file-image',
  'png': 'fas fa-file-image',
  'gif': 'fas fa-file-image',
  'bmp': 'fas fa-file-image',
  'svg': 'fas fa-file-image',
  'webp': 'fas fa-file-image',
  'ico': 'fas fa-file-image',
  'tiff': 'fas fa-file-image',

  // 视频
  'mp4': 'fas fa-file-video',
  'mkv': 'fas fa-file-video',
  'avi': 'fas fa-file-video',
  'mov': 'fas fa-file-video',
  'wmv': 'fas fa-file-video',
  'flv': 'fas fa-file-video',
  'webm': 'fas fa-file-video',

  // 音频
  'mp3': 'fas fa-file-audio',
  'wav': 'fas fa-file-audio',
  'ogg': 'fas fa-file-audio',
  'flac': 'fas fa-file-audio',
  'aac': 'fas fa-file-audio',
  'm4a': 'fas fa-file-audio',

  // 文档
  'doc': 'fas fa-file-word',
  'docx': 'fas fa-file-word',
  'xls': 'fas fa-file-excel',
  'xlsx': 'fas fa-file-excel',
  'ppt': 'fas fa-file-powerpoint',
  'pptx': 'fas fa-file-powerpoint',
  'pdf': 'fas fa-file-pdf',
  'odt': 'fas fa-file-alt',
  'ods': 'fas fa-file-alt',
  'odp': 'fas fa-file-alt',
  'rtf': 'fas fa-file-alt',
  'csv': 'fas fa-file-csv',
  'tsv': 'fas fa-file-csv',

  // 压缩归档
  'zip': 'fas fa-file-archive',
  'rar': 'fas fa-file-archive',
  'tar': 'fas fa-file-archive',
  'gz': 'fas fa-file-archive',
  '7z': 'fas fa-file-archive',
  'bz2': 'fas fa-file-archive',
  'xz': 'fas fa-file-archive',
  'iso': 'fas fa-compact-disc',

  // 代码与脚本
  'js': 'fab fa-js-square',
  'mjs': 'fab fa-js-square',
  'cjs': 'fab fa-js-square',
  'jsx': 'fab fa-react',
  'ts': 'fas fa-file-code',
  'tsx': 'fab fa-react',
  'vue': 'fab fa-vuejs',
  'svelte': 'fas fa-file-code',
  'py': 'fab fa-python',
  'pyc': 'fab fa-python',
  'pyd': 'fab fa-python',
  'pyw': 'fab fa-python',
  'ipynb': 'fab fa-python',
  'java': 'fab fa-java',
  'jar': 'fab fa-java',
  'class': 'fab fa-java',
  'kt': 'fas fa-file-code',
  'kts': 'fas fa-file-code',
  'cs': 'fas fa-file-code',
  'fs': 'fas fa-file-code',
  'go': 'fas fa-file-code',
  'rs': 'fas fa-file-code',
  'c': 'fas fa-file-code',
  'h': 'fas fa-file-code',
  'cpp': 'fas fa-file-code',
  'hpp': 'fas fa-file-code',
  'cxx': 'fas fa-file-code',
  'hxx': 'fas fa-file-code',
  'rb': 'fas fa-gem',
  'erb': 'fas fa-gem',
  'php': 'fab fa-php',
  'swift': 'fab fa-swift',
  'scala': 'fas fa-file-code',
  'perl': 'fas fa-file-code',
  'pl': 'fas fa-file-code',
  'lua': 'fas fa-file-code',
  'dart': 'fas fa-file-code',
  'r': 'fas fa-file-code',
  'html': 'fab fa-html5',
  'htm': 'fab fa-html5',
  'xhtml': 'fab fa-html5',
  'css': 'fab fa-css3-alt',
  'scss': 'fab fa-sass',
  'sass': 'fab fa-sass',
  'less': 'fab fa-less',
  'styl': 'fas fa-file-code',
  'json': 'fas fa-file-code',
  'webmanifest': 'fas fa-file-code',
  'jsonc': 'fas fa-file-code',
  'xml': 'fas fa-file-code',
  'xsl': 'fas fa-file-code',
  'xsd': 'fas fa-file-code',
  'yml': 'fas fa-cog',
  'yaml': 'fas fa-cog',
  'ini': 'fas fa-cog',
  'conf': 'fas fa-cog',
  'cfg': 'fas fa-cog',
  'config': 'fas fa-cog',
  'toml': 'fas fa-cog',
  'md': 'fab fa-markdown',
  'markdown': 'fab fa-markdown',
  'sql': 'fas fa-database',
  'ddl': 'fas fa-database',
  'db': 'fas fa-database',
  'sqlite': 'fas fa-database',
  'mdb': 'fas fa-database',
  'lock': 'fas fa-lock',

  // 纯文本与其他
  'txt': 'fas fa-file-alt',
  'text': 'fas fa-file-alt',
  'log': 'fas fa-file-alt',
  'out': 'fas fa-file-alt',
  'err': 'fas fa-file-alt',
  'key': 'fas fa-key',
  'pem': 'fas fa-key',
  'pub': 'fas fa-key',
  'asc': 'fas fa-key',
  'crt': 'fas fa-certificate',
  'cer': 'fas fa-certificate',
  'csr': 'fas fa-certificate',
  'pfx': 'fas fa-certificate',
  'p12': 'fas fa-certificate',

  // 可执行文件与安装包
  'exe': 'fas fa-cogs',
  'msi': 'fas fa-cogs',
  'app': 'fas fa-cogs',
  'com': 'fas fa-cogs',
  'sh': 'fas fa-terminal',
  'bash': 'fas fa-terminal',
  'zsh': 'fas fa-terminal',
  'fish': 'fas fa-terminal',
  'csh': 'fas fa-terminal',
  'ksh': 'fas fa-terminal',
  'bat': 'fas fa-terminal',
  'cmd': 'fas fa-terminal',
  'ps1': 'fas fa-terminal',
  'psm1': 'fas fa-terminal',
  'vb': 'fas fa-file-code',
  'vbs': 'fas fa-file-code',
  'deb': 'fas fa-archive',
  'rpm': 'fas fa-archive',
  'pkg': 'fas fa-archive',
  'dmg': 'fas fa-compact-disc',
  'img': 'fas fa-compact-disc',

  // 字体
  'ttf': 'fas fa-font',
  'otf': 'fas fa-font',
  'woff': 'fas fa-font',
  'woff2': 'fas fa-font',
  'eot': 'fas fa-font',
};

const DEFAULT_FILE_ICON = 'far fa-file';

/**
 * 根据文件名返回 FontAwesome 图标 Class
 */
export function getFileIconClass(filename: string): string {
  const lowerFilename = filename.toLowerCase();

  // 1. 特殊全名优先匹配
  const specialMatch = SPECIAL_FILENAME_MAP[lowerFilename];
  if (specialMatch) {
    return specialMatch;
  }

  // 2. 特殊前缀与后缀匹配
  if (lowerFilename.endsWith('docker-compose.yml') || lowerFilename.endsWith('docker-compose.yaml')) {
    return 'fab fa-docker';
  }
  if (lowerFilename.startsWith('.env')) {
    return 'fas fa-shield-alt';
  }
  if (lowerFilename === 'readme' || lowerFilename.startsWith('readme.')) {
    return 'fas fa-book-reader';
  }
  if (lowerFilename === 'license' || lowerFilename.startsWith('license.')) {
    return 'fas fa-balance-scale';
  }
  if (lowerFilename === 'contributing' || lowerFilename.startsWith('contributing.')) {
    return 'fas fa-users-cog';
  }
  if (lowerFilename === 'code_of_conduct' || lowerFilename.startsWith('code_of_conduct.')) {
    return 'fas fa-gavel';
  }
  if (lowerFilename === 'changelog' || lowerFilename.startsWith('changelog.')) {
    return 'fas fa-list-alt';
  }

  // 3. 提取扩展名
  let extension = '';
  const lastDotIndex = lowerFilename.lastIndexOf('.');

  if (lastDotIndex > 0 && lastDotIndex < lowerFilename.length - 1) {
    extension = lowerFilename.substring(lastDotIndex + 1);
  } else if (lastDotIndex === 0 && lowerFilename.length > 1) {
    extension = lowerFilename.substring(1);
  }

  return EXTENSION_ICON_MAP[extension] || DEFAULT_FILE_ICON;
}
