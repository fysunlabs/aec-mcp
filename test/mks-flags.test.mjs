// P0-03（AEC 5.0.0 开发实施计划 §7.1）：aec-mcp 侧 Host MKS flags 空实现测试。
//
// 验收锚点：R-096/R-098/R-099、HLM-01（flags off 时 2.0.0 边端行为逐字节不变）、
// ADR-AEC-5.0-host-local-memory §3.3（lite/node/sovereign）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { localMemoryMode, federationMode, flagsSnapshot, mcpContinuityEnabled } from '../src/mks/flags.mjs';

test('clean env → lite + none (Host MKS off, node-independent)', () => {
  assert.equal(localMemoryMode({}), 'lite');
  assert.equal(federationMode({}), 'none');
  assert.deepEqual(flagsSnapshot({}), {
    schema: 'aec.mks.flags/v1',
    local_memory_mode: 'lite',
    federation_mode: 'none',
    mcp_continuity: false,
    mcp_guidance: false,
    mcp_knowledge: false,
    mks_search_v2: false,
    mks_rerank: false,
    mks_rerank_topn: 10,
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

test('5.1 O0-06: AEC_MCP_CONTINUITY default off, only "1" enables (5.1-R-005)', () => {
  assert.equal(mcpContinuityEnabled({}), false);
  assert.equal(mcpContinuityEnabled({ AEC_MCP_CONTINUITY: 'node' }), false);
  assert.equal(mcpContinuityEnabled({ AEC_MCP_CONTINUITY: '1' }), true);
  // sidecar 需 node + continuity 同时为真；continuity=1 但 lite 形态下快照仍如实上报两者
  const snap = flagsSnapshot({ AEC_MCP_CONTINUITY: '1', AEC_MCP_LOCAL_MEMORY: 'node' });
  assert.equal(snap.mcp_continuity, true);
  assert.equal(snap.local_memory_mode, 'node');
});
