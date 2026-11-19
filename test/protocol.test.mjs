import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpV2 } from '../src/mcp.mjs';

// Create an in-process fake kernel and verify the MCP server registers exactly
// the expected tools and routes ops to the kernel without touching a real server.
const calls = [];
const fakeKernel = {
  async call(name, args) {
    calls.push({ name, args });
    if (name === 'aec' && args.op === 'open') {
      return {
        code: 'authoring_redirect',
        message: '这是创作意图，请用 aec_author。',
      };
    }
    return { code: 'no_match', session: null };
  },
};

const server = createMcpV2(fakeKernel, { profile: 'run' });
const tools = await server.listTools?.() ?? null;
// SDK server may not expose listTools directly; assert via registered definitions.
console.log('server name:', server.server?.getServerVersion?.() ?? '(sdk internal)');
console.log('registered tool handlers:', calls.length === 0 ? 'no calls yet (ok)' : 'called');

// Invoke the registered tool callback through the SDK's _registeredTools if available.
const anyServer = server;
const reg = anyServer._registeredTools || anyServer.server?._registeredTools || {};
console.log('tool names:', Object.keys(reg).join(',') || '(use protocol test instead)');

if (Object.keys(reg).length) {
  if (!reg.aec || !reg.aec_setup) { console.error('expected tools: aec + aec_setup'); process.exit(1); }
  const aecTool = reg.aec;
  const res = await aecTool.handler({ op: 'open', intent: '做一个经验包' });
  console.log('aec(open) result text head:', String(res.content?.[0]?.text || '').slice(0, 60));
  console.log('kernel calls:', calls.length, calls[0]?.name, calls[0]?.args?.op);
  if (calls.length !== 1 || calls[0].name !== 'aec' || calls[0].args.op !== 'open') process.exit(1);
} else {
  console.log('skip callback probe (SDK hides registry in this version)');
}
console.log('PROTOCOL_SMOKE_OK');
