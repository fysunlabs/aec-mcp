#!/usr/bin/env node
// aec-mcp CLI: stdio MCP server (default) + local role/device management
// + Host MKS administration (AEC 5.0.0 P1-07).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

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
} else if (cmd === 'mks') {
  // Host MKS 管理命令（P1-07）。status 永远只读（lite/无库不建库）；其余子命令
  // 需要 node/sovereign 形态。purge 是唯一破坏性命令，必须 --yes（ADR §3.6 卸载）。
  const { HostMksStore, resolveHostMksPath } = await import('./mks/store.mjs');
  const { flagsSnapshot } = await import('./mks/flags.mjs');
  const sub = process.argv[3] || 'status';
  const args = process.argv.slice(4);
  const dbPath = resolveHostMksPath();
  const die = (msg, code = 2) => { process.stderr.write(`[aec-mcp mks] ${msg}\n`); process.exit(code); };

  if (sub === 'status') {
    const snap = flagsSnapshot();
    if (snap.local_memory_mode === 'lite') {
      console.log(JSON.stringify({ ...snap, db_exists: false, db: null, note: 'lite 不建库（ADR §3.3）' }, null, 2));
    } else if (!existsSync(dbPath)) {
      console.log(JSON.stringify({ ...snap, db_exists: false, db: null, path: dbPath }, null, 2));
    } else {
      const mks = new HostMksStore({ path: dbPath, env: process.env });
      console.log(JSON.stringify({ ...snap, db_exists: true, path: dbPath, ...mks.status() }, null, 2));
      mks.close();
    }
  } else if (sub === 'export') {
    const scopes = (args.find(a => a.startsWith('--scopes'))?.split('=')[1] ?? 'memory,knowledge,experience,business').split(',').filter(Boolean);
    const outIdx = args.indexOf('--out');
    const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    const bundle = mks.exportBundle({ scopes });
    if (outPath) { writeFileSync(outPath, JSON.stringify(bundle, null, 2)); console.log(JSON.stringify({ ok: true, out: outPath, items: bundle.items.length, digest: bundle.digest }, null, 2)); }
    else console.log(JSON.stringify(bundle, null, 2));
    mks.close();
  } else if (sub === 'import') {
    const fileIdx = args.indexOf('--file');
    const file = fileIdx >= 0 ? args[fileIdx + 1] : null;
    if (!file || !existsSync(file)) die('import 需要 --file <bundle.json>');
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    console.log(JSON.stringify({ ok: true, result: mks.importBundle(bundle) }, null, 2));
    mks.close();
  } else if (sub === 'purge') {
    if (!args.includes('--yes')) die('purge 是破坏性命令，必须 --yes 确认（ADR-AEC-5.0-host-local-memory §3.6）');
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    console.log(JSON.stringify({ ok: true, purged: mks.purge() }, null, 2));
    mks.close();
  } else if (sub === 'rebuild') {
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    mks.rebuildFts();
    console.log(JSON.stringify({ ok: true, rebuilt: ['host_memory_fts', 'host_chunk_fts'] }, null, 2));
    mks.close();
  } else if (sub === 'memory' && (args[0] === 'list' || !args[0])) {
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    console.log(JSON.stringify({ items: mks.listMemories({ kind: valueOf(args, '--kind'), status: valueOf(args, '--status') }) }, null, 2));
    mks.close();
  } else if (sub === 'memory' && args[0] === 'show' && args[1]) {
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    const item = mks.getMemory({ memory_id: args[1] });
    if (!item) die(`memory 不存在：${args[1]}`, 1);
    console.log(JSON.stringify({ item }, null, 2));
    mks.close();
  } else if (sub === 'memory' && args[0] === 'forget' && args[1]) {
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    console.log(JSON.stringify({ ok: true, forgotten: mks.forgetMemory({ memory_id: args[1] }) }, null, 2));
    mks.close();
  } else if (sub === 'memory' && args[0] === 'export') {
    // P2-4 用户控制：导出全部（含 forgotten）记忆为可读 JSON；--out 落盘。
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    const rows = mks.db.prepare('SELECT * FROM host_memory ORDER BY created_at, rowid').all();
    const doc = { schema: 'aec.memory-export/v1', exported_at: new Date().toISOString(), count: rows.length, items: rows };
    const outIdx = args.indexOf('--out');
    if (outIdx >= 0 && args[outIdx + 1]) { writeFileSync(args[outIdx + 1], JSON.stringify(doc, null, 2)); console.log(JSON.stringify({ ok: true, out: args[outIdx + 1], count: rows.length }, null, 2)); }
    else console.log(JSON.stringify(doc, null, 2));
    mks.close();
  } else if (sub === 'ingest') {
    // P2-3 用户控制：MD/HTML 文件 → Host MKS 文档/切片/claim。
    const file = args[0];
    if (!file || !existsSync(file)) die('ingest 需要 -- <file.md|file.html>');
    const { ingestDocument } = await import('./mks/ingest.mjs');
    const content = readFileSync(file, 'utf8');
    const fmt = /\.(md|markdown|html?|txt)$/i.exec(file)?.[1]?.toLowerCase() || 'md';
    const mks = new HostMksStore({ path: dbPath, env: process.env });
    const res = ingestDocument(mks, {
      title: valueOf(args, '--title') || null, source_uri: pathToFileURL(file).href,
      media_type: fmt, content, format: fmt, extractClaims: args.includes('--claims'),
    });
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    mks.close();
  } else {
    process.stderr.write(`用法：aec-mcp mks [status|export [--scopes=...] [--out f]|import --file f|purge --yes|rebuild|memory list|memory show <id>|memory forget <id>|memory export [--out f]|ingest <file> [--claims] [--title <t>]]\n`);
    process.exitCode = 2;
  }

  function valueOf(arr, flag) {
    const i = arr.indexOf(flag);
    return i >= 0 ? arr[i + 1] : undefined;
  }
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
