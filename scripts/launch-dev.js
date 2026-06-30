#!/usr/bin/env node
/**
 * 通用项目启动器（Launch Adapter）
 *
 * 第一性原理：项目启动不是“执行一个固定命令”，而是一个需要根据当前环境
 * 进行探测、适配、验证、诊断的多阶段工作流。
 *
 * 本脚本抽象了启动前必须处理的共性问题：
 *   1. Bun 可用性检查
 *   2. 依赖完整性检查与自动修复
 *   3. 无 TTY / CI 环境适配
 *   4. Electron 桌面环境检查
 *   5. 启动失败时的诊断信息收集
 *
 * 迁移到其他项目时，只需修改下方的 PROJECT 配置对象。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import process from 'node:process';
import { resolve } from 'node:path';

/** 项目启动契约 —— 修改此处即可复用到其他项目 */
const PROJECT = {
  name: 'SunCode',
  type: 'electron', // 'electron' | 'web' | 'node'
  packageManager: 'bun',
  /** 实际要执行的开发命令（相对于项目根目录） */
  devCommand: {
    bin: 'node_modules/vite/bin/vite.js',
    args: [],
    fallbackScript: 'dev:internal',
  },
  /** 关键依赖路径，用于判断 node_modules 是否完整 */
  requiredDeps: ['node_modules/vite/package.json', 'node_modules/electron/package.json'],
};

const IS_WIN = platform() === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

function log(...args) {
  console.log(`[${PROJECT.name} launcher]`, ...args);
}

function error(...args) {
  console.error(`[${PROJECT.name} launcher]`, ...args);
}

function hasTTY() {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function hasExplorerProcess() {
  try {
    const result = spawnSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq explorer.exe', '/NH'],
      { encoding: 'utf8', shell: false },
    );
    return result.status === 0 && /explorer\.exe/i.test(result.stdout ?? '');
  } catch {
    return false;
  }
}

function hasDesktopSession() {
  const p = platform();
  if (p === 'darwin') return true;
  if (p === 'win32') {
    // Windows 桌面会话：优先检查 SESSIONNAME，再回退到 explorer.exe 进程
    return !!process.env.SESSIONNAME || hasExplorerProcess();
  }
  if (p === 'linux') {
    return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  }
  return false;
}

function findBinary(name) {
  const paths = (process.env.PATH ?? '').split(PATH_SEP);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const full = resolve(dir.trim(), name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function detectPackageManager() {
  const bin = findBinary(PROJECT.packageManager);
  return bin ? { name: PROJECT.packageManager, bin } : null;
}

function isDependencyInstalled(depPath) {
  try {
    const full = resolve(process.cwd(), depPath);
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

function areDepsComplete() {
  return PROJECT.requiredDeps.every(isDependencyInstalled);
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      shell: IS_WIN,
      env: process.env,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function installDependencies(pm) {
  log('检测到依赖不完整，尝试自动安装...');

  const env = { ...process.env };
  if (!hasTTY()) {
    log('当前无 TTY，以 CI 模式运行安装');
    env.CI = 'true';
  }

  const start = Date.now();
  const code = await runCommand(pm.bin, ['install'], { env });

  if (code !== 0 && !areDepsComplete()) {
    throw new Error(
      `依赖安装失败（exit ${code}，耗时 ${Date.now() - start}ms）。` +
      `常见原因：lockfile 策略冲突、网络问题、或需要手动运行 bun install。`,
    );
  }

  if (code !== 0) {
    log(`安装命令返回非零退出码 ${code}，但关键依赖已存在，继续启动`);
  } else {
    log('依赖安装完成');
  }
}

function resolveDevBinary(pm) {
  // 优先直接调用本地 dev 工具，避免包管理器再次做状态检查
  const direct = resolve(process.cwd(), PROJECT.devCommand.bin);
  if (existsSync(direct)) {
    return { bin: 'node', args: [direct, ...PROJECT.devCommand.args] };
  }

  // fallback：通过 Bun 执行项目内的 dev:internal 脚本
  return { bin: pm.bin, args: ['run', PROJECT.devCommand.fallbackScript, ...PROJECT.devCommand.args] };
}

async function main() {
  log('启动环境探测...');

  // 1. 桌面环境检查（Electron 项目必须）
  if (PROJECT.type === 'electron' && !hasDesktopSession()) {
    error('未检测到可用的桌面会话，无法启动 Electron 应用。');
    error('请在带有图形界面的环境中运行，或配置远程桌面/X11 转发。');
    process.exit(1);
  }

  // 2. Bun 探测
  const pm = detectPackageManager();
  if (!pm) {
    error('未找到 Bun。请先安装 Bun。');
    process.exit(1);
  }
  log(`使用 Bun: ${pm.bin}`);

  // 3. 依赖完整性检查与修复
  if (!areDepsComplete()) {
    await installDependencies(pm);
    if (!areDepsComplete()) {
      error('自动安装后关键依赖仍缺失，请检查 lockfile 与网络环境。');
      process.exit(1);
    }
  }

  // 4. 构造并执行开发命令
  const { bin, args } = resolveDevBinary(pm);
  log(`执行: ${bin} ${args.join(' ')}`);

  const env = { ...process.env };
  if (!hasTTY()) {
    env.CI = env.CI ?? 'true';
  }

  const code = await runCommand(bin, args, { env });
  process.exit(code);
}

main().catch((err) => {
  error('启动失败:', err.message);
  if (err.stack) error(err.stack);
  process.exit(1);
});
