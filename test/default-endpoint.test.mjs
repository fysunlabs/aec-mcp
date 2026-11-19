// 默认端点与机器码读取的单元测试（全部依赖注入，确定性，无网络）：
//   1) resolveEndpoint：run profile 免配置回落官方云端；显式 env 永远优先；
//      author profile 强制显式提供（公网 author 端点 403，不静默回落）。
//   2) machineCode：win32 reg query 失败（安全软件黑名单 reg.exe）时回退
//      PowerShell 读同一注册表值——机器码不漂移；两条路都断才拒绝。
//   3) 真机 smoke：无注入 machineCode() 必须产出稳定标识（win32=GUID 形状，
//      darwin/linux 非空），保证"安装即用"链路在真实主机上成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint, DEFAULT_KERNEL_URL } from '../src/transport.mjs';
import { machineCode } from '../src/identity.mjs';

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('resolveEndpoint: run profile without AEC_KERNEL_URL falls back to the official cloud endpoint', () => {
  assert.equal(resolveEndpoint({ profile: 'run', env: {} }), DEFAULT_KERNEL_URL);
  assert.equal(DEFAULT_KERNEL_URL, 'https://aec-api.cursor-free.site');
});

test('resolveEndpoint: explicit AEC_KERNEL_URL always wins (self-hosted override)', () => {
  assert.equal(resolveEndpoint({ profile: 'run', env: { AEC_KERNEL_URL: 'https://kernel.internal.example' } }), 'https://kernel.internal.example');
  assert.equal(resolveEndpoint({ profile: 'author', env: { AEC_KERNEL_URL: 'http://100.64.0.1:18041' } }), 'http://100.64.0.1:18041');
});

test('resolveEndpoint: blank AEC_KERNEL_URL counts as unset (trimmed)', () => {
  assert.equal(resolveEndpoint({ profile: 'run', env: { AEC_KERNEL_URL: '   ' } }), DEFAULT_KERNEL_URL);
});

test('resolveEndpoint: author profile without AEC_KERNEL_URL refuses with endpoint_missing', () => {
  assert.throws(() => resolveEndpoint({ profile: 'author', env: {} }), e => {
    assert.equal(e.code, 'endpoint_missing');
    assert.match(e.message, /author/);
    return true;
  });
});

test('machineCode: win32 reg query succeeds -> MachineGuid, no powershell fallback', () => {
  const calls = [];
  const execFile = (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'reg') return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${GUID}\r\n`;
    throw new Error('powershell must not be called when reg works');
  };
  const r = machineCode({ platform: 'win32', execFile });
  assert.equal(r.code, GUID);
  assert.equal(r.source, 'MachineGuid');
  assert.deepEqual(calls, ['reg']);
});

test('machineCode: win32 reg blocked -> powershell fallback reads the SAME MachineGuid value', () => {
  const execFile = (cmd, args) => {
    if (cmd === 'reg') throw new Error('Access is denied.'); // 安全软件黑名单 reg.exe
    if (cmd === 'powershell.exe') {
      assert.match(args.at(-1), /Cryptography/);
      return `\r\n${GUID}\r\n`; // PowerShell 输出带 CRLF
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  const r = machineCode({ platform: 'win32', execFile });
  assert.equal(r.code, GUID);
  assert.equal(r.source, 'MachineGuid (powershell)');
});

test('machineCode: powershell fallback ignores malformed output and keeps refusing honestly', () => {
  const execFile = (cmd) => {
    if (cmd === 'reg') throw new Error('blocked');
    return '  <CloudGuidMissing>  '; // 垃圾输出不进机器码
  };
  assert.throws(() => machineCode({ platform: 'win32', execFile }), e => {
    assert.equal(e.code, 'machine_code_required');
    return true;
  });
});

test('machineCode: both reg and powershell failing refuses to enrol (no unbound token)', () => {
  const execFile = () => { throw new Error('blocked'); };
  assert.throws(() => machineCode({ platform: 'win32', execFile }), e => e.code === 'machine_code_required');
});

test('machineCode: real-machine smoke — every supported host yields a stable identifier', () => {
  const r = machineCode();
  assert.ok(r && r.code, `no machine code on ${process.platform}`);
  if (process.platform === 'win32') assert.match(r.code, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
  else assert.ok(r.code.trim().length >= 8, `identifier too short: ${r.source}`);
});
