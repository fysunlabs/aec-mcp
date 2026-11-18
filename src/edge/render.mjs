// Dual-output renderer (design §4, plan P0-4).
//
// One intermediate representation per op, two exits: content[0].text for the
// model (Markdown it can follow without parsing) and structuredContent for
// hosts that consume JSON. Both come from the same call with the same data, so
// they cannot drift — that is the whole point of B9/§4.1.
//
// Pure module: no filesystem, no clock. The caller precomputes everything.
import { signatureLine } from './signature.mjs';

export function renderOpen({ session, sessionDir, workspace, match, loop, env, actions, orphan, next, goalFrame = null, plan = null, trust = null }) {
  const aecOut = actions.aecOut || null;
  // 渲染器必须是"全函数"：任何契约合法的 loop 都能渲染出文本，缺字段就标未声明。
  // B-17：草稿允许不写 when.not_for（zod 的 default 只填 parsed 副本），旧版这里
  // 直接 .join() → 试用 open 500。展示层的健壮性不能依赖作者写全可选数组。
  const when = loop.when || {};
  const notFor = Array.isArray(when.not_for) ? when.not_for.filter(x => String(x ?? '').trim()) : [];
  const outFiles = (loop.steps || []).flatMap(s => s.produces || []);
  const md = [];
  if (orphan) {
    md.push(`[AEC] 上次有个未完成的会话（${orphan.age}，第 ${orphan.step}/${orphan.steps} 步 ${orphan.stepId}）——`,
      '      如果用户这次讲的是同一件事，先说一句"上次没跑完，要不要接着做"；否则忽略这句。', '');
  }
  md.push(
    `[AEC] 匹配 ${match.chosen || `${match.package_id}@${match.version}`}（置信度 ${match.confidence ?? '—'}${match.source ? `，来源 ${match.source}` : ''}）`,
    match.why ? `      理由：${match.why}` : null,
    // L0：把"为什么是这个包"落到可比骨架，而不是只有一句关键词理由。
    match.signature ? `      槽位：${signatureLine(match.signature)}` : null,
    ...(match.rejected || []).filter(r => r?.diff?.length)
      .map(r => `      与 ${r.ref} 的差别：${r.diff.map(d => d.note).join('；')}`),
    `[AEC] 会话 ${session} 材料已落地到 ${sessionDir}`, '',
  // W13（a175/a126，GoalFrame 呈现）：首屏同时渲染原话 / 当前理解 / outcomes 三要素，
  // 缺一判回执不合格。理解与用户要办的事有出入时用 turn(goal_op) 修正，不猜。
  ...(goalFrame ? [
    '## 目标（GoalFrame）',
    `- 你的原话：${goalFrame.intent_raw}`,
    `- 当前理解：${goalFrame.intent_interpreted}${goalFrame.intent_status ? `（${goalFrame.intent_status}）` : ''}`,
    '- 交付判据（outcomes）：',
    ...((goalFrame.outcomes || []).map(o => `    · [${o.outcome_id}] ${o.statement}（判定方式 ${o.evidence_kind}${o.commitment === 'required' ? '，必须达成' : '，建议'}）`)),
    '若"当前理解"与用户要办的事有出入：不要猜，用 turn(goal_op="restate_intent") 修正后继续。',
    // G0 护栏：包内 outcome 默认 optional（C2），close 要求 ≥1 required 否则 no_committed_outcome。
    // 以往只在 close 才报错、Agent 措手不及；这里在开场就告知提交义务与确切调用。
    ...((goalFrame.outcomes || []).some(o => o.commitment === 'required')
      ? []
      : [
          '',
          '⚠ 收尾前置条件：当前没有任何「必须达成」的判据（包内判据默认只是建议）。',
          '在向用户确认交付判据后、close 之前，必须至少把一条提升为 required，否则 close 会以 no_committed_outcome 拒绝、不产生 grade。',
          '做法：`aec(op="turn", session="<本会话>", goal_op="revise_outcome", target="<上面的 outcome_id>", payload={commitment:"required"})`（goal_frame 由边端从会话目录 goal.json 自动读入，不要手传）。',
          '若本次确实是纯探索、没有可承诺的交付结果，则在 open 时声明 exploratory=true（仅探索场景可用，不给正常交付兜底）。',
        ]),
    '',
  ] : ['## 这件事是什么', String(when.description || '（未声明：when.description）'), '']),
  // R3-5（a105）：包级信任显式带出；self_attested_only 必须出现 self-attested。
  ...(trust ? [
    `这条经验的信任等级：${trust.scope}${String(trust.delivery || '').includes('self-attested') ? '（self-attested：无人独立复核，交付时如实转告用户）' : ''}`, '',
  ] : []),
  '## 这个包不负责',
    ...(notFor.length ? [notFor.join(' / '), '命中其中任一条，直接把上面这句话告诉用户，不要尝试绕。'] : ['（未声明：when.not_for——这个包没说清什么时候不该用，误配风险高）']), '',
    '## 产出',
    ...(outFiles.length ? outFiles.map(f => `- ${f}`) : ['- 按各步完成标志确认']), '',
    '## 环境检查',
    ...(env && env.length ? env.map(e => `- ${e.name} ${e.status === 'ok' ? `${e.found} ✅` : e.status === 'missing' ? '❌ 未安装' : '未能探测（宿主沙箱限制）'}${e.required ? '' : '（本包只在部分分支用到）'}`) : ['- （本包未声明依赖）']),
    env && env.length ? '（探测由 aec-mcp 在本机完成，没有安装任何东西）' : '', '',
  );
  for (const [index, step] of (loop.steps || []).entries()) {
    const action = (actions.list || []).find(a => a.step === step.id);
    const isRun = !!action;
    md.push(
      `## 第 ${index + 1} 步 / 共 ${loop.steps.length} 步：${step.id}`,
      ...(isRun ? [
        '跑下面这一条命令就行。它已经处理好参数、工作目录、票据与重试——',
        '**不要自己拼参数、不要改这条命令、不要 cd 到别处**。', '',
        `    ${action.argv.join(' ')}`, '',
        '注意：',
        ...(step.watch_out || []).map(w => `- ${w}`),
        ...(step.watch_out?.length ? [] : ['- （作者没有写注意事项）']), '',
      ] : [
        '这一步由你完成（不是跑命令）：',
        ...(step.instruction || '').split('\n'),
        ...(step.watch_out || []).length ? ['', '注意：', ...(step.watch_out || []).map(w => `- ${w}`)] : [], '',
      ]),
      `完成标志：${step.done_when}`, '',
    );
  }
  md.push('## 规则', ...BASELINE_RULES, '');
  if ((loop.ask_user || []).length) {
    md.push('## 要问用户的条件',
      ...(loop.ask_user || []).map(a => `- ${a.when === 'always' ? '开工前' : a.when} → ${a.question}`), '');
  } else {
    md.push('## 要问用户的条件', '- （没有。不要主动向用户提问）', '');
  }
  const hasRequired = (goalFrame?.outcomes || []).some(o => o.commitment === 'required');
  md.push('## 什么时候回来',
    `- 全部完成 → aec(op="close", session="${session}")`,
    ...(!hasRequired && goalFrame
      ? ['  ⚠ 但 close 前须先提交一个 required outcome：`aec(op="turn", target="<outcome_id>", goal_op="revise_outcome", payload={commitment:"required"})`（goal_frame 边端自动读）；否则 close 以 no_committed_outcome 拒绝（G0）。']
      : []),
    '- 某步失败或结果不对 → aec(op="turn", session="' + session + '")        ← 不用告诉我退出码，我读得到',
    '  （只有当我解释不了你看到的现象时，才加一句 note:"…"）',
    `- 命中要问用户的条件 → aec(op="turn", session="${session}", ask="<问题>")`,
    `- 中途要某份长文档 → aec(op="resource", session="${session}", want="<ref>")`);
  const markdown = md.filter(l => l !== null).join('\n');
  const structuredContent = {
    v: 'aec/v2', session, home: sessionDir, workspace,
    match, package: { id: loop.id, version: loop.version, digest: match.digest ?? null },
    plan: loop, env: env || [], prompt: promptOf(loop),
    // W13/W14（a126/a175）：GoalFrame 与 Plan 摘要进结构化回执（同源双出口）。
    ...(goalFrame ? { goal_frame: goalFrame } : {}),
    ...(plan ? {
      plan_summary: {
        plan_id: plan.plan_id, revision: plan.revision, steps: (plan.steps || []).length,
        subgoals: (plan.subgoals || []).length,
        strategy: plan.strategy?.rationale ?? null,
        serves_unmapped: (plan.steps || []).filter(s => !(s.serves || []).length).map(s => s.id),
      },
    } : {}),
    resources: { stage: actions.stage || null, cwd: actions.cwd || null, files: actions.files || [], api: actions.api || [] },
    actions: actions.list || [], ...(aecOut ? { aec_out: aecOut } : {}), next: next || '按第 1 步执行',
  };
  return { markdown, structuredContent };
}

export function renderTurn({ session, step, report, judgement, hint, command, ask, pending }) {
  const md = [`[AEC] 会话 ${session} · 第 ${step.step_no}/${step.step_total} 步 ${step.id}${report.exit !== undefined && report.exit !== null ? `：exit=${report.exit}（从 report.json 读到，用时 ${Math.round((report.ms || 0) / 1000)} s）` : ''}。`];
  // B-13：失败步骤的真实证据必须进回执——此前只给 exit/ms，模型的"无报错输出、
  // 无错误码可据"正是从这里来的（runner 明明记录了 stderr_tail）。
  for (const [label, lines] of [['stderr', report.stderr_tail], ['stdout', report.stdout_tail]]) {
    if (!lines) continue;
    const tail = String(lines).trim().split('\n').slice(-6).join('\n');
    if (tail) md.push(`      ${label} 尾部：`, ...tail.split('\n').map(l => `        ${l.slice(0, 200)}`));
  }
  if (judgement) md.push(`      判断：${judgement}`);
  if (hint) md.push(...hint.split('\n').map(l => `      ${l}`));
  if (command) md.push('', '重跑同一条命令（不用改）：', `    ${command.argv.join(' ')}`);
  if (pending) md.push('', `未完成。继续等（可重复跑）：`, `    ${pending.argv.join(' ')}`);
  if (ask) md.push('', '## 要问用户', ask);
  const markdown = md.join('\n');
  return { markdown, structuredContent: { v: 'aec/v2', session, op: 'turn', step, judgement: judgement || null, hint: hint || null, ...(command ? { command } : {}), ...(pending ? { pending } : {}), ...(ask ? { ask } : {}) } };
}

export function renderClose({ session, grade, checks, artifacts, cleanup, reason, delivery = null }) {
  const passed = checks.filter(c => c.passed === true).length;
  const kernelCount = checks.filter(c => c.where === 'kernel').length;
  const md = [];
  if (grade === 'abandoned') {
    md.push(`[AEC] 任务已放弃${reason ? `：${reason}` : ''}。已记账，未通过任何判据验收。`);
  } else {
    md.push('[AEC] 任务完成。',
      `      质量等级：${grade}（${passed}/${checks.length} 判据通过${kernelCount ? `，其中 ${kernelCount} 条由 AEC 复算` : ''}）`);
  }
  // a007：无论如何正文都要逐条列出判据——结构化出口有 checks[]，文本出口就不得省。
  // abandoned 分支早期只给一句结论，模型看到的文本与 structuredContent 不同源，
  // 用户无法核对"到底哪条判据没过"。
  md.push(...checks.map(c => `      判据：${c.id} ${c.passed ? '✅' : c.passed === null ? '➖' : '❌'} ${c.detail}${c.where === 'kernel' ? '（AEC 复算）' : ''}`));
  if (artifacts.length) {
    md.push('      产物：', ...artifacts.map(a => `            ${a.path}${a.size !== undefined ? ` (${a.size.toLocaleString()} bytes)` : ''}`));
  }
  // W16/W30（§18.5/§16.6）：交付三字段与上限只记录、不合成绿勾；对外文案经词表，
  // 不出现裸 grade 枚举之外的解释性混写。
  if (delivery) {
    if (delivery.session_conclusion) md.push(`      会话结论：${delivery.session_conclusion}`);
    if (delivery.delivery_status?.length)
      md.push('      交付状态：', ...delivery.delivery_status.map(d => `            ${d.id}: ${d.status}`));
    if (delivery.plan_coverage?.length)
      md.push('      计划覆盖：', ...delivery.plan_coverage.map(d => `            ${d.outcome_id}: ${d.coverage}`));
    if (delivery.grade_reasons?.length) md.push(`      原因：${delivery.grade_reasons.join('、')}`);
    if (delivery.grade_caps?.length) md.push(`      等级上限：${delivery.grade_caps.join('、')}`);
    if (delivery.acceptance_summary?.total)
      md.push(`      验收：${delivery.acceptance_summary.accepted}/${delivery.acceptance_summary.total} 已接受（独立通过 ${delivery.acceptance_summary.independently_passed}）`);
    // W30（§16.6）：对外三问（封闭词表；self-attested 必带；不出现裸 grade 枚举）。
    if (delivery.trust) {
      const t = delivery.trust;
      md.push(`      对外三问——能用在哪：${t.scope}｜这次交付靠不靠谱：${t.delivery}｜过程可信度：${t.process}`);
    }
  }
  if (cleanup?.archived) md.push(`      现场已归档：${cleanup.archived.replace(/archive.*$/, 'archive/…')}（close 后保留，不静默删除）`);
  else if (cleanup?.removed) md.push(`      现场已清理：${cleanup.removed.replace(/sessions.*$/, 'sessions/…')} 已删除`);
  const markdown = md.join('\n');
  return {
    markdown,
    structuredContent: {
      v: 'aec/v2', session, op: 'close', grade, checks, artifacts, ledger: { written: true }, cleanup: cleanup || null,
      ...(delivery ? {
        session_conclusion: delivery.session_conclusion ?? null,
        delivery_status: delivery.delivery_status ?? null,
        plan_coverage: delivery.plan_coverage ?? null,
        grade_reasons: delivery.grade_reasons ?? null,
        grade_caps: delivery.grade_caps ?? null,
        grade_revision: delivery.grade_revision ?? null,
        acceptance_summary: delivery.acceptance_summary ?? null,
        trust: delivery.trust ?? null,
      } : {}),
    },
  };
}

// §4.5: "no match" is a normal result, stated as advice, not an error dump.
export function renderNoMatch({ code, message, closest, candidates, advice }) {
  const md = [`[AEC] ${message}`];
  if (candidates?.length) {
    // B-11：ambiguous_match 的候选此前被边端丢弃，模型"没法把选项念给用户选"。
    // L0：候选附能力签名 + 与第一个候选的差异槽——用户选哪个，看的正是这些差别。
    md.push('      候选包（把编号念给用户选，不要自己挑）：',
      ...candidates.flatMap((c, i) => [
        `        ${i + 1}. ${c.capability_ref || c.asset_id || c.id}@${c.version || c.package_ref?.version || '—'} — ${c.title || ''}${c.score !== undefined ? `（匹配度 ${c.score}）` : ''}`,
        ...(c.signature ? [`           槽位：${signatureLine(c.signature)}`] : []),
        ...(c.diff?.length ? [`           与第 1 个的差别：${c.diff.map(d => d.note).join('；')}`] : []),
      ]));
  }
  if (closest?.length) {
    md.push('      最接近的都不是这件事：',
      ...closest.flatMap(c => [
        `        · ${c.id}@${c.version} — ${c.title}（${c.diff || c.when?.description || ''}）`,
        ...(c.signature ? [`           槽位：${signatureLine(c.signature)}`] : []),
      ]));
  }
  if (advice) md.push(`      建议：${advice}`);
  return { markdown: md.join('\n'), structuredContent: { v: 'aec/v2', code, closest: closest || [], candidates: candidates || [] } };
}

// The three baseline rules (§6.1) are appended by the renderer itself — an
// author cannot remove them, because they answer "when do I stop".
export const BASELINE_RULES = [
  '- 命令照抄，不要改：参数、票据、工作目录都已固定；改了就不可复现',
  '- 同一个异常连续出现 2 次就停下，把看到的现象如实告诉用户，不要第 3 次重试',
  '- 完成后如实报告产物路径；不确定是否成功时调 turn，不要声称成功',
];

function promptOf(loop) {
  const when = loop?.when || {};
  return {
    overview: when.description ?? '',
    not_for: Array.isArray(when.not_for) ? when.not_for : [],
    steps: (loop.steps || []).map(s => ({ id: s.id, instruction: s.instruction, watch_out: s.watch_out, done_when: s.done_when })),
    rules: BASELINE_RULES.map(r => r.replace(/^- /, '')),
    return_when: ['某步失败 → turn', '命中 ask_user → turn 带 ask', '完成 → close'],
  };
}
