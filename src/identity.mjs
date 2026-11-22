// Client-side identity primitives.
//
// 2026-11-19 密钥模式：机器码绑定（machineCode / machineProof / 机器激活）整体
// 移除——机器码依赖 reg query / ioreg 等平台命令，在安全软件黑名单（reg.exe 被
// 禁）的 Windows 主机上读不到，安装链路直接断在这一步。身份从"机器自证"换成
// "用户持票"：用户从 AEC 服务器获取 api_key（aec_key_ 前缀），客户端首次经
// POST /aec/v2/keys/verify 云端校验，成功后把密钥存进本机凭证文件；之后每次
// 业务调用 Bearer <api_key>，由云端逐请求快速校验（查表 + 状态/过期）。
//
// 凭证文件（credentials.json，0600）按 profile 分段：
//   { schema: 'aec.credentials/v1', endpoint, run: {api_key, key_id, ...}, author: {...} }
// 目录解析沿用 defaultIdentityDir —— 这就是 win/mac/linux 的差异处理：
//   AEC_IDENTITY_DIR > XDG_CONFIG_HOME > win32 %APPDATA%\aec > ~/.config/aec
// （macOS 无 APPDATA 环境变量，自然落 ~/.config/aec；Linux 同）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { warn } from './edge/util.mjs';

// 统一默认基础目录（credentials.json / author.key / sessions-index.json / roles.sqlite 共用）。
export function defaultIdentityDir({ env = process.env } = {}) {
  if (env.AEC_IDENTITY_DIR) return env.AEC_IDENTITY_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'aec');
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'aec');
  // 无 HOME/USERPROFILE 的精简 env（测试/守护进程）也不抛错：回落 os.homedir()
  return join(env.HOME || process.env.USERPROFILE || homedir(), '.config', 'aec');
}

export function resolveIdentityPath({ env = process.env, explicit = null, workspaceAecDir = null } = {}) {
  const candidates = [];
  if (explicit) candidates.push({ path: resolve(explicit), level: 'explicit' });
  else if (env.AEC_IDENTITY) candidates.push({ path: resolve(env.AEC_IDENTITY), level: 'explicit' });
  if (env.XDG_CONFIG_HOME) candidates.push({ path: join(env.XDG_CONFIG_HOME, 'aec', 'identity.json'), level: 'xdg' });
  else if (process.platform === 'win32' && env.APPDATA) candidates.push({ path: join(env.APPDATA, 'aec', 'identity.json'), level: 'appdata' });
  else if (env.HOME) candidates.push({ path: join(env.HOME, '.config', 'aec', 'identity.json'), level: 'home' });
  if (workspaceAecDir) candidates.push({ path: join(workspaceAecDir, 'identity.json'), level: 'workspace' });
  for (const candidate of candidates) {
    try { mkdirSync(join(candidate.path, '..'), { recursive: true, mode: 0o700 }); return candidate; }
    catch (e) { warn(`身份目录不可用（${candidate.path}）：${e.message} —— 尝试下一个候选目录。`); }
  }
  return candidates[candidates.length - 1] || null;
}

// --- api-key credentials file ------------------------------------------------
export const credentialsPath = ({ env = process.env } = {}) => join(defaultIdentityDir({ env }), 'credentials.json');

export function loadCredentials(path = credentialsPath()) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc?.schema === 'aec.credentials/v1' ? doc : null;
  } catch { return null; }
}

export function saveCredentials(path, segment, { replace = false } = {}) {
  const doc = replace ? {} : (loadCredentials(path) || { schema: 'aec.credentials/v1', endpoint: null, run: null, author: null });
  const merged = { ...doc, ...segment, schema: 'aec.credentials/v1' };
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

// 兼容读取旧版 identity.json（aec.identity/v2，机器绑定形态）：v2.0 客户端不再
// 使用机器绑定令牌；探测到旧文件时给出一次性迁移提示，不读取其内容。
export function detectLegacyIdentity(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc?.schema === 'aec.identity/v2' ? path : null;
  } catch { return null; }
}

// 兼容别名：旧调用点（loadIdentity/saveIdentity）等价于 credentials 版本。
export const loadIdentity = loadCredentials;
export const saveIdentity = saveCredentials;
