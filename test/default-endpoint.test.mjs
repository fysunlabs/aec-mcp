// 默认端点解析的单元测试（全部依赖注入，确定性，无网络）：
//   run profile 免配置回落官方云端；显式 env 永远优先；
//   author profile 强制显式提供（公网 author 端点 403，不静默回落）。
// 密钥解析（resolveApiKey）的测试在 security-and-db.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEndpoint, DEFAULT_KERNEL_URL } from '../src/transport.mjs';

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
