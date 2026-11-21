// P0-03（AEC 5.0.0 开发实施计划 §7.1）：aec-mcp 侧 Host MKS flags 空实现测试。
//
// 验收锚点：R-096/R-098/R-099、HLM-01（flags off 时 2.0.0 边端行为逐字节不变）、
// ADR-AEC-5.0-host-local-memory §3.3（lite/node/sovereign）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { localMemoryMode, federationMode, flagsSnapshot } from '../src/mks/flags.mjs';

test('clean env → lite + none (Host MKS off, node-independent)', () => {
  assert.equal(localMemoryMode({}), 'lite');
  assert.equal(federationMode({}), 'none');
  assert.deepEqual(flagsSnapshot({}), {
    schema: 'aec.mks.flags/v1',
    local_memory_mode: 'lite',
    federation_mode: 'none',
  });
});

test('explicit modes parsed; case-insensitive; invalid → conservative', () => {
  assert.equal(localMemoryMode({ AEC_MCP_LOCAL_MEMORY: 'node' }), 'node');
  assert.equal(localMemoryMode({ AEC_MCP_LOCAL_MEMORY: 'sovereign' }), 'sovereign');
  assert.equal(localMemoryMode({ AEC_MCP_LOCAL_MEMORY: 'NODE' }), 'node');
  assert.equal(localMemoryMode({ AEC_MCP_LOCAL_MEMORY: 'garbage' }), 'lite');
  assert.equal(federationMode({ AEC_FEDERATION: 'export' }), 'export');
  assert.equal(federationMode({ AEC_FEDERATION: 'bidirectional' }), 'bidirectional');
  assert.equal(federationMode({ AEC_FEDERATION: 'sync' }), 'none');
});
