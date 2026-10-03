// 烟测：
//  1) 等待 /healthz 通过（服务由外部提供 BASE_URL，或本脚本临时拉起一个）；
//  2) 抓取页面与脚本资源，确认站点可服务；
//  3) 在同一求解器内核上跑「含一次分裂 + 一次漏检」的谱系场景并校验结果；
// 以退出码报告：0 通过，非 0 失败。
'use strict';

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeSpec, solveLineage, presentSolution } from '../public/js/lineage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.WEB_HOST || 'web';
const PORT = process.env.WEB_PORT || '8080';
const BASE_URL = process.env.BASE_URL ||
  ((HOST === 'web' || HOST === '0.0.0.0') ? `http://web:${PORT}` : `http://127.0.0.1:${PORT}`);

let ownServer = null;
let portFile = null;

function log(msg) { console.log(`[smoke] ${msg}`); }
function fail(msg) { console.error(`[smoke] 失败: ${msg}`); process.exitCode = 1; throw new Error(msg); }

async function waitHealthy(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) {
        const j = await jsonOrText(r);
        log(`健康检查通过 ${base}/healthz -> ${JSON.stringify(j)}`);
        return;
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`健康检查超时: ${lastErr?.message || 'no response'}`);
}

async function jsonOrText(r) {
  try { return await r.json(); } catch { return await r.text(); }
}

async function startOwnServer() {
  portFile = join(tmpdir(), `algal-port-${process.pid}.txt`);
  if (existsSync(portFile)) rmSync(portFile);
  const child = spawn(process.execPath, [join(ROOT, 'server.cjs')], {
    env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: '0', PORT_FILE: portFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  ownServer = child;
  return await new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').trim());
        if (Number.isInteger(port) && port > 0) {
          res(`http://127.0.0.1:${port}`);
          return;
        }
      }
      if (Date.now() - t0 > 10000) return rej(new Error('服务器未在 10s 内监听'));
      setTimeout(tick, 100);
    };
    tick();
  });
}
async function checkStatic(base) {
  const pages = ['/', '/index.html', '/js/lineage.js', '/js/app.js', '/css/style.css'];
  for (const p of pages) {
    const r = await fetch(`${base}${p}`);
    if (r.status !== 200) fail(`GET ${p} 状态码 ${r.status}`);
    const body = await r.text();
    if (!body.length) fail(`GET ${p} 返回空内容`);
  }
  log('静态资源全部可访问');
  const r404 = await fetch(`${base}/no-such-file`);
  if (r404.status !== 404) fail(`缺失资源应返回 404，实际 ${r404.status}`);
  log('404 行为正常');
}

// 同时含分裂与漏检的场景：
// 帧0 a → 帧1 b →（帧2 漏检）→ 帧3 c → 帧4 分裂为 e1/e2；
// 各帧还放置更亮的杂质 z*，验证不会被逐帧贪心串入。
function scenario() {
  return {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b', x: 15, y: 50, b: 42 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        { id: 'z2a', x: 86, y: 90, b: 200 },
        { id: 'z2b', x: 86, y: 80, b: 190 },
      ],
      [
        { id: 'c', x: 35, y: 50, b: 44 },
        { id: 'z3', x: 84, y: 85, b: 200 },
      ],
      [
        { id: 'e1', x: 45, y: 42, b: 46 },
        { id: 'e2', x: 45, y: 58, b: 48 },
        { id: 'z4', x: 82, y: 82, b: 200 },
      ],
    ],
    startId: 'a',
    maxDist: 14,
    maxSkip: 1,
    target: 2,
  };
}

function checkScenario() {
  const input = scenario();
  const { errors, spec } = normalizeSpec(input);
  if (errors.length) fail(`场景输入校验失败: ${JSON.stringify(errors)}`);
  const raw = solveLineage(spec);
  if (!raw.feasible) fail(`含分裂与漏检的场景被误判不可行: ${JSON.stringify(raw.earliestBreak)}`);
  const sol = presentSolution(spec, raw);

  const assert = (cond, msg) => { if (!cond) fail(msg); };
  assert(sol.skips === 1, `漏检段应为 1，实际 ${sol.skips}`);
  assert(sol.divisions === 1, `分裂次数应为 1，实际 ${sol.divisions}`);
  assert(sol.survivors === 2, `终帧存活应为 2，实际 ${sol.survivors}`);
  assert(JSON.stringify(sol.used[2]) === '[]', `第 3 帧应整帧漏检，实际 ${JSON.stringify(sol.used[2])}`);
  assert(sol.used[3][0] === 'c', `第 4 帧应补获 c，实际 ${JSON.stringify(sol.used[3])}`);
  assert(JSON.stringify(sol.used[4].sort()) === JSON.stringify(['e1', 'e2']),
    `末帧应为 e1/e2，实际 ${JSON.stringify(sol.used[4])}`);
  const gap = sol.edges.find((e) => e.gap === 2);
  assert(gap && gap.fromId === 'b' && gap.toId === 'c', '漏检段应为 b→c');
  const div = sol.edges.filter((e) => e.fromFrame === 3 && e.fromId === 'c');
  assert(div.length === 2 && div.every((e) => ['e1', 'e2'].includes(e.toId)), 'c 应分裂为 e1、e2');
  assert(sol.edges.every((e) => !e.toId.startsWith('z') && !e.fromId.startsWith('z')),
    '亮杂质 z* 不得进入谱系');
  const expectedBright = 40 + 42 + 44 + 46 + 48;
  assert(sol.totalBrightness === expectedBright,
    `总亮度应为 ${expectedBright}，实际 ${sol.totalBrightness}`);
  log(`谱系烟测通过：a→b →漏检→ c →(e1,e2)，总亮度 ${sol.totalBrightness}，位移表 ${sol.edges.length} 行`);

  // 不可行场景：收紧位移使首帧间彻底断开，应报告最早断开为 帧1→帧2
  const tight = structuredClone(input);
  tight.maxDist = 2;
  const spec2 = normalizeSpec(tight).spec;
  const raw2 = solveLineage(spec2);
  assert(raw2.feasible === false, '位移收紧后应不可行');
  assert(raw2.earliestBreak.from === 0 && raw2.earliestBreak.to === 1,
    `最早断开帧间应为 1→2，实际 ${raw2.earliestBreak.from + 1}→${raw2.earliestBreak.to + 1}`);
  log('不可行报告正确：最早断开 第 1 帧 → 第 2 帧');
}

// 分裂不应期烟测：
//  A) 跨漏检按真实跨度计 2 个帧间：根首裂 → 两女儿各跨一帧漏检 → 补获时龄 2，
//     门槛 2 下允许再次分裂；门槛收紧到 3 则被阻断（尚缺 1 帧间）。
//  B) 连续分裂：末帧需 4 支而两次分裂间隔不足，门槛 2 下不可行并给出阻断母本；
//     关闭不应期后同一草稿可行。
function checkRefractoryScenarios() {
  const assert = (cond, msg) => { if (!cond) fail(msg); };
  const s = (id, x, y, b = 40) => ({ id, x, y, b });

  // ---- 场景 A：跨漏检计龄 ----
  const gapInput = {
    frames: [
      [s('a', 5, 50), s('z0', 90, 90, 200)],
      [s('b1', 15, 42, 42), s('b2', 15, 58, 42), s('z1', 88, 90, 200)],
      [s('z2a', 86, 90, 200), s('z2b', 86, 80, 190)],
      [s('c1', 35, 42, 44), s('c2', 35, 58, 44), s('z3', 84, 85, 200)],
      [s('d1', 45, 34, 46), s('d2', 45, 46, 46),
       s('d3', 45, 54, 48), s('d4', 45, 66, 48), s('z4', 82, 82, 200)],
    ],
    startId: 'a', maxDist: 14, maxSkip: 2, target: 4,
    refractoryEnabled: true, refractory: 2,
  };
  {
    const { errors, spec } = normalizeSpec(gapInput);
    if (errors.length) fail(`不应期场景 A 输入校验失败: ${JSON.stringify(errors)}`);
    const raw = solveLineage(spec);
    if (!raw.feasible) fail(`跨漏检计龄后满龄应可分裂，却被判不可行: ${JSON.stringify(raw.earliestBreak)}`);
    const sol = presentSolution(spec, raw);
    assert(sol.skips === 2, `两支各跨一帧漏检，漏检段应为 2，实际 ${sol.skips}`);
    assert(sol.divisions === 3, `应为首裂 + 两支各再裂共 3 次，实际 ${sol.divisions}`);
    const gapEdges = sol.edges.filter((e) => e.gap === 2);
    assert(gapEdges.length === 2 && gapEdges.every((e) => e.childAge === 2),
      '跨漏检补获女儿分裂年龄应为 2');
    const cRecs = sol.spots[3];
    assert(cRecs.length === 2 && cRecs.every((r) => r.age === 2 && r.divides && r.divisionAge === 2),
      `c1/c2 应龄 2 并在龄 2 分裂，实际 ${JSON.stringify(cRecs)}`);
    const dRecs = sol.spots[4];
    assert(dRecs.length === 4 && dRecs.every((r) => r.age === 0 && r.generation === 2 && r.wait === 2),
      `末帧女儿应代 2、龄 0、尚余等待 2，实际 ${JSON.stringify(dRecs)}`);
    log('不应期场景 A 通过：跨漏检计 2 帧间，补获满龄即分裂');
  }
  {
    // 同草稿门槛收紧到 3：补获龄 2 仍不足 → 阻断
    const tight = structuredClone(gapInput);
    tight.refractory = 3;
    const spec = normalizeSpec(tight).spec;
    const raw = solveLineage(spec);
    assert(raw.feasible === false, '门槛 3 下补获龄 2 应不可行');
    assert(raw.refractoryBlock, '应给出不应期阻断归因');
    assert(raw.refractoryBlock.age === 2 && raw.refractoryBlock.need === 1,
      `阻断母本应龄 2、尚缺 1，实际 ${JSON.stringify(raw.refractoryBlock)}`);
    assert(raw.earliestBreak.from === 3,
      `最早阻断应在 第 4 帧→第 5 帧，实际 ${raw.earliestBreak.from}`);
    const sol = presentSolution(spec, raw);
    assert(/尚缺 1 个等待帧间/.test(sol.refractoryBlock.label) && /c[12]/.test(sol.refractoryBlock.label),
      `阻断说明应含缺口与母本: ${sol.refractoryBlock.label}`);
    log('不应期场景 A 收紧门槛通过：阻断并指出母本 c1/c2 尚缺 1 帧间');
  }

  // ---- 场景 B：连续分裂被阻断 ----
  const chainInput = {
    frames: [
      [s('a', 5, 50), s('z0', 90, 90, 200)],
      [s('b1', 15, 42, 42), s('b2', 15, 58, 42), s('z1', 88, 90, 200)],
      [s('c1', 25, 34, 44), s('c2', 25, 46, 44),
       s('c3', 25, 54, 44), s('c4', 25, 66, 44), s('z2', 86, 90, 200)],
      [s('d1', 35, 34, 46), s('d2', 35, 46, 46),
       s('d3', 35, 54, 48), s('d4', 35, 66, 48), s('z3', 84, 85, 200)],
    ],
    startId: 'a', maxDist: 20, maxSkip: 0, target: 4,
  };
  {
    const blocked = { ...chainInput, refractoryEnabled: true, refractory: 2 };
    const spec = normalizeSpec(blocked).spec;
    const raw = solveLineage(spec);
    assert(raw.feasible === false, '两次分裂间隔不足 2 帧间时应不可行');
    assert(raw.refractoryBlock && raw.refractoryBlock.need >= 1,
      `连续分裂应被不应期阻断并给出缺口: ${JSON.stringify(raw.refractoryBlock)}`);
    const sol = presentSolution(spec, raw);
    assert(/最早|帧/.test(sol.earliestBreakLabel) && /尚缺/.test(sol.refractoryBlock.label),
      '阻断结果应同时含最早帧间与尚缺等待帧间');
    log(`不应期场景 B 通过：连续分裂被阻断（${sol.refractoryBlock.label}）`);

    // 关闭不应期后同一草稿可行，且不输出年龄字段
    const freed = { ...chainInput };
    const spec2 = normalizeSpec(freed).spec;
    const sol2 = presentSolution(spec2, solveLineage(spec2));
    assert(sol2.feasible === true, '关闭不应期后同草稿应可行');
    assert(sol2.divisions === 3 && sol2.spots === undefined,
      '关闭不应期后应允许连续分裂且不携带年龄结果');
    log('不应期场景 B 关闭开关通过：同草稿恢复可行，结果不含年龄字段');
  }
}

async function main() {
  let base = BASE_URL;
  if (process.env.BASE_URL) {
    log(`使用外部服务 ${base}`);
  } else {
    // Compose 的 verify 服务通过主机名 web 访问；本地直跑时自己拉起服务器
    try {
      await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
    } catch {
      log(`无法连接 ${base}，改为本地临时启动服务器`);
      base = await startOwnServer();
      log(`临时服务器监听于 ${base}`);
    }
  }
  await waitHealthy(base);
  await checkStatic(base);
  checkScenario();
  checkRefractoryScenarios();
  log('全部烟测通过 ✔');
  if (ownServer) ownServer.kill('SIGTERM');
  if (portFile && existsSync(portFile)) rmSync(portFile);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  if (ownServer) ownServer.kill('SIGTERM');
  process.exit(1);
});
