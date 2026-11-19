#!/usr/bin/env node
// aec-mcp CLI: stdio MCP server (default) + local role/device management.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const cmd = process.argv[2];

if (cmd === 'roles') {
  const { RolesDB, resolveRolesDbPath } = await import('./db/roles.mjs');
  const db = new RolesDB(resolveRolesDbPath());
  const sub = process.argv[3] || 'list';
  if (sub === 'list' || !sub) {
    console.log(JSON.stringify({ schema_version: db.schemaVersion, devices: db.listDevices(), profiles: db.listProfiles(), tokens: db.listTokens().length }, null, 2));
  } else if (sub === 'profile' && process.argv[4]) {
    console.log(JSON.stringify(db.getProfile(process.argv[4]), null, 2));
  } else {
    process.stderr.write('用法：aec-mcp roles [list|profile <subject>]\n');
    process.exitCode = 2;
  }
  db.close();
} else {
  // Default: launch the MCP server (pass through --profile etc.).
  // 与 mcp.mjs 直跑入口一致：启动期失败（占位 URL / 端点不可达 / 缺密钥等）只给
  // 一行可读错误 + code，不向宿主日志倾倒堆栈。
  const { main } = await import('./mcp.mjs');
  try { await main(); }
  catch (e) {
    process.stderr.write(`[aec-mcp] 启动失败：${e.message}（code=${e.code || 'unknown'}）\n`);
    process.exit(1);
  }
}
