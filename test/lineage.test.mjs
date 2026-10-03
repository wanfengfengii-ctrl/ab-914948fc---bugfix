// 谱系求解器测试：约束结构、裁决顺序、漏检、不可行报告 + 独立暴力枚举对拍。
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, solveLineage, presentSolution } from '../public/js/lineage.js';

function run(input) {
  const { errors, spec } = normalizeSpec(input);
  assert.deepEqual(errors, [], `输入校验应通过: ${JSON.stringify(errors)}`);
  const raw = solveLineage(spec);
  return { spec, raw, sol: presentSolution(spec, raw) };
}

// 对任意可行解做通用结构约束校验
function assertValidLineage(spec, sol, input) {
  const F = spec.frames.length;
  assert.equal(sol.feasible, true);
  assert.equal(sol.survivors, input.target);
  assert.equal(sol.used[F - 1].length, input.target);
  assert.deepEqual(sol.used[0], [spec.frames[0][spec.startIndex].id]);

  const indeg = new Map(); // 'frame:id' -> 入边数
  const outEdges = new Map();
  for (const e of sol.edges) {
    indeg.set(`${e.toFrame}:${e.toId}`, (indeg.get(`${e.toFrame}:${e.toId}`) || 0) + 1);
    const k = `${e.fromFrame}:${e.fromId}`;
    if (!outEdges.has(k)) outEdges.set(k, []);
    outEdges.get(k).push(e);
    assert.ok([1, 2].includes(e.gap), '连接只能相邻或跨一帧');
    assert.equal(e.toFrame - e.fromFrame, e.gap);
    const m = spec.frames[e.fromFrame].find((s) => s.id === e.fromId);
    const c = spec.frames[e.toFrame].find((s) => s.id === e.toId);
    const d = Math.hypot(m.x - c.x, m.y - c.y);
    assert.ok(d <= input.maxDist * e.gap + 1e-9, '位移超限');
    assert.ok(Math.abs(d - e.dist) < 0.011);
  }

  // 每个采用的非起始斑点恰有一个祖先；同一斑点不入两支
  for (let t = 0; t < F; t++) {
    for (const id of sol.used[t]) {
      const deg = indeg.get(`${t}:${id}`) || 0;
      if (t === 0 && id === input.startId) {
        assert.equal(deg, 0, '起始斑点不应有祖先');
      } else {
        assert.equal(deg, 1, `斑点 F${t + 1}·${id} 应有恰一个祖先，实际 ${deg}`);
      }
    }
  }

  // 每支 1 或 2 个后代；漏检补获只能单传；全部到达末帧
  for (let t = 0; t < F; t++) {
    for (const id of sol.used[t]) {
      const es = outEdges.get(`${t}:${id}`) || [];
      if (t === F - 1) {
        assert.equal(es.length, 0, '末帧斑点不应再有后代');
      } else {
        const gaps = es.filter((e) => e.gap === 2);
        const direct = es.filter((e) => e.gap === 1);
        if (gaps.length) {
          assert.equal(gaps.length, 1);
          assert.equal(direct.length, 0, '漏检中细胞不能同时分裂到下一帧');
        } else {
          assert.ok([1, 2].includes(direct.length), '必须保持一个或分裂为恰两个后代');
        }
        assert.ok(es.every((e) => reachesLast(e, F)), '所有存活支必须到达末帧');
      }
    }
  }

  function reachesLast(e, F) {
    if (e.toFrame === F - 1) return true;
    return (outEdges.get(`${e.toFrame}:${e.toId}`) || []).some((nx) => reachesLast(nx, F));
  }

  // 分裂次数与漏检数
  assert.equal(sol.skips, sol.edges.filter((e) => e.gap === 2).length);
  let div = 0;
  for (const list of outEdges.values()) if (list.filter((e) => e.gap === 1).length === 2) div++;
  assert.equal(sol.divisions, div);

  // 总亮度
  let bright = 0;
  sol.used.forEach((ids, t) => ids.forEach((id) => {
    bright += spec.frames[t].find((s) => s.id === id).b;
  }));
  assert.equal(sol.totalBrightness, bright);

  // 分裂不应期：分裂时年龄、计龄规则、代际、尚余等待帧间
  if (input.refractoryEnabled) {
    const R = input.refractory;
    assert.ok(sol.spots, '启用不应期时结果应携带逐斑点年龄信息');
    const spotRec = new Map();
    sol.spots.forEach((list, t) => list.forEach((r) => spotRec.set(`${t}:${r.id}`, r)));

    for (const [key, list] of outEdges) {
      if (list.filter((e) => e.gap === 1).length !== 2) continue;
      const e0 = list[0];
      const rec = spotRec.get(`${e0.fromFrame}:${e0.fromId}`);
      assert.ok(rec, `分裂母本 ${key} 应有年龄记录`);
      if (rec.age === null) {
        // 年龄为 null 必为「从未分裂的起始细胞本体」：沿唯一母边单传回溯到起始
        let cur = e0;
        while (cur.fromFrame > 0) {
          const mIn = (indeg.get(`${cur.fromFrame}:${cur.fromId}`) || 0);
          assert.equal(mIn, 1, `${key} 年龄为 null 却不是单传起始本体`);
          const up = sol.edges.find((x) =>
            x.toFrame === cur.fromFrame && x.toId === cur.fromId);
          assert.ok(up, `${key} 起始本体回溯断链`);
          assert.equal((outEdges.get(`${up.fromFrame}:${up.fromId}`) || []).length, 1,
            `${key} 的祖先曾分裂，不应保留 null 年龄`);
          cur = up;
        }
        assert.equal(cur.fromId, input.startId, 'null 年龄母本必须追溯到起始斑点');
      } else {
        assert.ok(rec.age >= R, `母本 ${key} 分裂时年龄 ${rec.age} 不足门槛 ${R}`);
      }
      assert.equal(rec.divides, true);
      assert.equal(rec.divisionAge, rec.age);
    }

    for (const e of sol.edges) {
      if (e.gap === 2) {
        // 跨漏检计 2 个帧间；起始支保持 null
        if (e.motherAge === null) assert.equal(e.childAge, null);
        else assert.equal(e.childAge, e.motherAge + 2, '跨漏检女儿年龄应 +2');
      } else {
        const siblings = (outEdges.get(`${e.fromFrame}:${e.fromId}`) || [])
          .filter((x) => x.gap === 1);
        if (siblings.length === 2) {
          assert.equal(e.childAge, 0, '分裂女儿年龄应从零累计');
        } else if (e.motherAge === null) {
          assert.equal(e.childAge, null, '起始支保持后仍享首次分裂不受限');
        } else {
          assert.equal(e.childAge, e.motherAge + 1, '普通连接女儿年龄应 +1');
        }
      }
      const mother = spotRec.get(`${e.fromFrame}:${e.fromId}`);
      const child = spotRec.get(`${e.toFrame}:${e.toId}`);
      const motherDivides = (outEdges.get(`${e.fromFrame}:${e.fromId}`) || [])
        .filter((x) => x.gap === 1).length === 2;
      assert.equal(child.generation,
        mother.generation + (motherDivides ? 1 : 0), '代际应随分裂递增');
      assert.equal(child.wait, child.age === null ? 0 : Math.max(0, R - child.age),
        '尚余等待帧间计算错误');
    }
  } else {
    assert.equal(sol.spots, undefined, '未启用不应期时不应输出逐斑点年龄');
    assert.ok(sol.edges.every((e) => e.motherAge === undefined && e.childAge === undefined),
      '未启用不应期时边不应携带年龄字段');
  }
}

const base4 = () => ({
  frames: [
    [{ id: 'a', x: 0, y: 0, b: 10 }, { id: 'z0', x: 9, y: 9, b: 99 }],
    [{ id: 'b', x: 1, y: 0, b: 11 }, { id: 'z1', x: 9, y: 9, b: 99 }],
    [{ id: 'c', x: 2, y: 0, b: 12 }, { id: 'z2', x: 9, y: 9, b: 99 }],
    [{ id: 'd', x: 3, y: 0, b: 13 }, { id: 'z3', x: 9, y: 9, b: 99 }],
  ],
  startId: 'a', maxDist: 2, maxSkip: 0, target: 1,
});

test('基础保持谱系：最亮杂质因位移/祖先约束被排除', () => {
  const input = base4();
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used, [['a'], ['b'], ['c'], ['d']]);
  assert.equal(sol.divisions, 0);
  assert.equal(sol.totalBrightness, 46);
  // 逐帧贪心选最亮点会错误串起 z0→z1→z2→z3；本解绝不能采用它们
  assert.ok(sol.used.every((ids) => !ids.some((id) => id.startsWith('z'))));
});

test('分裂谱系：一支在末段分裂为恰两个后代', () => {
  const input = {
    frames: [
      [{ id: 'a', x: 0, y: 0, b: 10 }, { id: 'q0', x: 8, y: 8, b: 50 }],
      [{ id: 'b', x: 1, y: 0, b: 10 }, { id: 'q1', x: 8, y: 8, b: 50 }],
      [{ id: 'c', x: 2, y: 0, b: 10 }, { id: 'q2', x: 8, y: 8, b: 50 }],
      [
        { id: 'd1', x: 3, y: -1, b: 10 },
        { id: 'd2', x: 3, y: 1, b: 10 },
        { id: 'q3', x: 8, y: 8, b: 50 },
      ],
    ],
    startId: 'a', maxDist: 2, maxSkip: 0, target: 2,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used[3].sort(), ['d1', 'd2']);
  assert.equal(sol.divisions, 1);
  const last = sol.edges.filter((e) => e.toFrame === 3);
  assert.equal(last.length, 2);
  assert.deepEqual(last.map((e) => e.fromId), ['c', 'c']);
});

test('漏检：中间帧无近邻斑点时跨一帧连接', () => {
  const input = {
    frames: [
      [{ id: 'a', x: 0, y: 0, b: 10 }, { id: 'g0', x: 9, y: 0, b: 10 }],
      [{ id: 'j1', x: 9, y: 0, b: 99 }, { id: 'j2', x: 9, y: 9, b: 99 }],
      [{ id: 'c', x: 2, y: 0, b: 10 }, { id: 'g2', x: 9, y: 0, b: 10 }],
      [{ id: 'd', x: 3, y: 0, b: 10 }, { id: 'g3', x: 9, y: 0, b: 10 }],
    ],
    startId: 'a', maxDist: 2, maxSkip: 1, target: 1,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used, [['a'], [], ['c'], ['d']]);
  assert.equal(sol.skips, 1);
  const gap = sol.edges.find((e) => e.gap === 2);
  assert.deepEqual({ f: gap.fromFrame, t: gap.toFrame, from: gap.fromId, to: gap.toId },
    { f: 0, t: 2, from: 'a', to: 'c' });
  assert.equal(gap.dist, 2);
});

test('不允许漏检时同一用例不可行，并报告最早断开帧间', () => {
  const input = { ...base4(), frames: structuredClone(base4().frames), maxSkip: 0, target: 1 };
  // 重放漏检场景但关闭漏检
  input.frames = [
    [{ id: 'a', x: 0, y: 0, b: 10 }, { id: 'g0', x: 9, y: 0, b: 10 }],
    [{ id: 'j1', x: 9, y: 0, b: 99 }, { id: 'j2', x: 9, y: 9, b: 99 }],
    [{ id: 'c', x: 2, y: 0, b: 10 }, { id: 'g2', x: 9, y: 0, b: 10 }],
    [{ id: 'd', x: 3, y: 0, b: 10 }, { id: 'g3', x: 9, y: 0, b: 10 }],
  ];
  const { raw, sol } = run(input);
  assert.equal(raw.feasible, false);
  assert.equal(sol.feasible, false);
  assert.equal(sol.earliestBreak.from, 0);
  assert.equal(sol.earliestBreak.to, 1);
});

test('终帧目标数超出增长能力时不可行', () => {
  const input = base4();
  input.target = 2; // 全程只有 1 个可达斑点，无法在末帧前分裂
  const { raw } = run(input);
  assert.equal(raw.feasible, false);
  assert.ok(raw.earliestBreak.from >= 0 && raw.earliestBreak.to < 4);
});

test('最早断开帧间定位到真正无解的中段边界', () => {
  // 前三个帧间单传均可走；唯独末帧前需要分裂为 2，但末帧轨迹旁只有 1 个近邻斑点
  const input = {
    frames: [
      [{ id: 'a', x: 0, y: 0, b: 5 }, { id: 'q0', x: 9, y: 9, b: 9 }],
      [{ id: 'b', x: 1, y: 0, b: 5 }, { id: 'q1', x: 9, y: 9, b: 9 }],
      [{ id: 'c', x: 2, y: 0, b: 5 }, { id: 'q2', x: 9, y: 9, b: 9 }],
      [{ id: 'd', x: 3, y: 0, b: 5 }, { id: 'far', x: 30, y: 30, b: 9 }],
    ],
    startId: 'a', maxDist: 2, maxSkip: 0, target: 2,
  };
  const { raw, sol } = run(input);
  assert.equal(raw.feasible, false);
  assert.equal(raw.earliestBreak.from, 2);
  assert.equal(raw.earliestBreak.to, 3);
  assert.match(sol.earliestBreakLabel, /第 3 帧 → 第 4 帧/);
});

test('亮度优先：宁选稍暗但能连成高总和的一支（联合最优而非逐帧贪心）', () => {
  // 近邻有两条互斥路径；亮路径中途会撞上同一斑点（违反唯一祖先）→ 只能走低亮路径
  const input = {
    frames: [
      [{ id: 'a', x: 0, y: 0, b: 1 }, { id: 'x', x: 0, y: 5, b: 1 }],
      [{ id: 'b', x: 1, y: 0, b: 1 }, { id: 'B', x: 1, y: 5, b: 100 }],
      [{ id: 'c', x: 2, y: 0, b: 1 }, { id: 'C', x: 2, y: 5, b: 100 }],
      [{ id: 'd', x: 3, y: 0, b: 1 }, { id: 'D', x: 3, y: 3, b: 100 }],
    ],
    startId: 'x', maxDist: 3, maxSkip: 0, target: 1,
  };
  // 从 x(0,5) 出发：B(1,5) 很亮，但 B 能到 c(2,0) 吗？距离 5.1 >3；只能到 C。
  // C(2,5) 到 D(3,3) 距离 √5<3 可取，路径 x-B-C-D 全亮。
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used, [['x'], ['B'], ['C'], ['D']]);
  assert.equal(sol.totalBrightness, 301);
});

test('亮度相同、漏检数相同：按输入顺序稳定裁决（采用更早的斑点）', () => {
  const mk = (startId) => ({
    frames: [
      [{ id: 'p', x: 0, y: 0, b: 5 }, { id: 'q', x: 0, y: 3, b: 5 }],
      [{ id: 'r', x: 1, y: 0, b: 5 }, { id: 's', x: 1, y: 3, b: 5 }],
      [{ id: 't', x: 2, y: 0, b: 5 }, { id: 'u', x: 2, y: 3, b: 5 }],
      [{ id: 'v', x: 3, y: 0, b: 5 }, { id: 'w', x: 3, y: 3, b: 5 }],
    ],
    startId, maxDist: 3, maxSkip: 0, target: 1,
  });
  const r1 = run(mk('p'));
  assertValidLineage(r1.spec, r1.sol, mk('p'));
  assert.deepEqual(r1.sol.used, [['p'], ['r'], ['t'], ['v']]);
  const r2 = run(mk('q'));
  assert.deepEqual(r2.sol.used, [['q'], ['s'], ['u'], ['w']]);
});

test('漏检数为第二裁决键：同亮度时优先无漏检方案', () => {
  // 帧1 同时存在直接女儿和跨帧机会，二者后续亮度相同 → 应选直接连接
  const input = {
    frames: [
      [{ id: 'a', x: 0, y: 0, b: 5 }, { id: '_0', x: 0, y: 6, b: 5 }],
      [{ id: 'b', x: 1, y: 0, b: 5 }, { id: '_1', x: 0, y: 6, b: 5 }],
      [{ id: 'c', x: 2, y: 0, b: 5 }, { id: '_2', x: 0, y: 6, b: 5 }],
      [{ id: 'd', x: 3, y: 0, b: 5 }, { id: '_3', x: 0, y: 6, b: 5 }],
    ],
    startId: 'a', maxDist: 5, maxSkip: 1, target: 1,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.equal(sol.skips, 0);
});

test('修改帧内容后重新求解得到不同谱系（不保留旧结果由调用方保证，解本身随输入变化）', () => {
  const input = base4();
  const s1 = run(input).sol;
  input.frames[1][1] = { id: 'b2', x: 1, y: 0, b: 80 }; // 杂质移动到轨迹上
  const s2 = run(input).sol;
  assert.notDeepEqual(s1.used, s2.used);
  assert.ok(s2.used[1].includes('b2'));
});

// ---------- 分裂不应期 ----------
// 每帧 2 个近邻斑点沿竖线排布（y 偏移 ±1..±4），另加两个远处亮杂质。
function denseFrames() {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const junk = (t) => [s(`J${t}a`, 95, 95, 100), s(`J${t}b`, 97, 97, 100)];
  return [
    [s('a', 0, 0), ...junk(0)],
    [s('b1', 10, -1), s('b2', 10, 1), ...junk(1)],
    [s('c1', 20, -2), s('c2', 20, 0), s('c3', 20, 2), s('c4', 20, 4), ...junk(2)],
    [s('d1', 30, -3), s('d2', 30, -1), s('d3', 30, 1), s('d4', 30, 3), ...junk(3)],
  ];
}

test('不应期门槛校验：仅 2 至 4 的整数有效', () => {
  for (const r of [1, 5, 0, 2.5, null]) {
    const r1 = normalizeSpec({ ...base4(), refractoryEnabled: true, refractory: r });
    assert.ok(r1.errors.some((e) => e.field === 'refractory'), `门槛 ${r} 应被拒`);
  }
  const ok = normalizeSpec({ ...base4(), refractoryEnabled: true, refractory: 3 });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.spec.refractoryEnabled, true);
  assert.equal(ok.spec.refractory, 3);
  // 关闭时门槛字段不影响校验
  const off = normalizeSpec({ ...base4(), refractoryEnabled: false, refractory: 99 });
  assert.deepEqual(off.errors, []);
  assert.equal(off.spec.refractory, 0);
});

test('连续分裂被不应期阻断：4 帧内两次分裂在门槛 2 下不可行', () => {
  const input = {
    frames: denseFrames(),
    startId: 'a', maxDist: 20, maxSkip: 0, target: 4,
    refractoryEnabled: true, refractory: 2,
  };
  const { raw, sol } = run(input);
  assert.equal(raw.feasible, false);
  // 放宽（关闭不应期）裁决链在第 1→2 帧间即由 b1/b2（龄 0）再次分裂；
  // 「根保持到第 2 帧再首裂」是只能局部延续、最终必在末帧间失败的路径，
  // 不得掩盖更早的阻断。
  assert.equal(raw.earliestBreak.from, 1);
  assert.ok(raw.refractoryBlock, '应给出不应期阻断归因');
  assert.equal(raw.refractoryBlock.age, 0);
  assert.equal(raw.refractoryBlock.need, 2);
  assert.equal(sol.refractoryBlock.motherId, 'b1');
  assert.match(sol.refractoryBlock.label, /第 2 帧 → 第 3 帧/);
  assert.match(sol.refractoryBlock.label, /母细胞 第 2 帧·b1/);
  assert.match(sol.refractoryBlock.label, /尚缺 2 个等待帧间/);
});

test('同一输入关闭不应期后可行，且允许连续分裂', () => {
  const input = {
    frames: denseFrames(),
    startId: 'a', maxDist: 20, maxSkip: 0, target: 4,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.equal(sol.divisions, 3);
  assert.equal(sol.used[3].length, 4);
});

test('后续普通断链不得掩盖更早的不应期阻断：报告第 2→3 帧间母细胞 a（龄 0，尚缺 2）', () => {
  // 四帧：root 首裂 a、b（龄 0）；第 2→3 帧间放宽时 a 立即裂 x、y、b 接 z；
  // 第 3→4 帧间 x、y、z 各只有唯一后代。启用门槛 2 时完整三支谱系最早必须在
  // 第 2→3 帧间违反不应期；a、b 虽可保持到第 3 帧，却凑不出末帧 3 支。
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const input = {
    frames: [
      [s('root', 0, 0), s('j0', 90, 90, 99)],
      [s('a', 8, 0), s('b', 0, 8)],
      [s('x', 16, 0), s('y', 16, 3), s('z', 0, 16)],
      [s('x1', 26, 0), s('y1', 26, 3), s('z1', 0, 24), s('j4', 90, 90, 99)],
    ],
    startId: 'root', maxDist: 10, maxSkip: 0, target: 3,
    refractoryEnabled: true, refractory: 2,
  };
  const { raw, sol } = run(input);
  assert.equal(raw.feasible, false);
  // 阻断位置：第 2 帧 → 第 3 帧（而不是几何上最后才断的第 3 → 4 帧）
  assert.deepEqual(raw.earliestBreak, { from: 1, to: 2 });
  assert.match(sol.earliestBreakLabel, /第 2 帧 → 第 3 帧/);
  assert.ok(raw.refractoryBlock, '必须给出不应期阻断归因，而非普通断链');
  assert.equal(raw.refractoryBlock.frame, 1);
  assert.equal(sol.refractoryBlock.motherId, 'a');
  assert.equal(raw.refractoryBlock.age, 0);
  assert.equal(raw.refractoryBlock.need, 2);
  assert.match(sol.refractoryBlock.label, /第 2 帧 → 第 3 帧/);
  assert.match(sol.refractoryBlock.label, /母细胞 第 2 帧·a/);
  assert.match(sol.refractoryBlock.label, /分裂年龄仅 0/);
  assert.match(sol.refractoryBlock.label, /尚缺 2 个等待帧间/);
});

test('关闭不应期后同一输入完整三支谱系仍可复原', () => {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const input = {
    frames: [
      [s('root', 0, 0), s('j0', 90, 90, 99)],
      [s('a', 8, 0), s('b', 0, 8)],
      [s('x', 16, 0), s('y', 16, 3), s('z', 0, 16)],
      [s('x1', 26, 0), s('y1', 26, 3), s('z1', 0, 24), s('j4', 90, 90, 99)],
    ],
    startId: 'root', maxDist: 10, maxSkip: 0, target: 3,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.equal(sol.divisions, 2);
  assert.deepEqual(sol.used, [['root'], ['a', 'b'], ['x', 'y', 'z'], ['x1', 'y1', 'z1']]);
  assert.equal(sol.spots, undefined, '关闭不应期不输出年龄字段');
});

test('恰好达到门槛时允许分裂：a 保持两个帧间（龄 2）后分裂，谱系可行', () => {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const input = {
    frames: [
      [s('root', 0, 0), s('j0', 90, 90, 99)],
      [s('a', 8, 0), s('b', 0, 8)],
      [s('a1', 16, 0), s('b1', 0, 16)],
      [s('a2', 24, 0), s('b2', 0, 24)],
      [s('p', 32, 0), s('q', 32, 3), s('r', 0, 32), s('j5', 90, 90, 99)],
    ],
    startId: 'root', maxDist: 10, maxSkip: 0, target: 3,
    refractoryEnabled: true, refractory: 2,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used[4].sort(), ['p', 'q', 'r']);
  const a2 = sol.spots[3].find((r0) => r0.id === 'a2');
  assert.equal(a2.age, 2, 'a2 分裂年龄应恰为门槛 2');
  assert.equal(a2.divides, true);
  assert.equal(a2.divisionAge, 2);
  assert.equal(a2.wait, 0);
});

test('等待足够帧间后允许分裂：门槛 2 下女儿保持两次再分裂', () => {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const junk = (t) => [s(`J${t}a`, 95, 95, 100), s(`J${t}b`, 97, 97, 100)];
  const input = {
    frames: [
      [s('a', 0, 0), ...junk(0)],
      [s('b1', 10, -1), s('b2', 10, 1), ...junk(1)],
      [s('c1', 20, -1), s('c2', 20, 1), ...junk(2)],
      [s('e1', 30, -2), s('e2', 30, 0), s('e3', 30, 2), s('e4', 30, 4), ...junk(3)],
      [s('f1', 40, -2), s('f2', 40, 0), s('f3', 40, 2), s('f4', 40, 4), ...junk(4)],
    ],
    startId: 'a', maxDist: 20, maxSkip: 0, target: 4,
    refractoryEnabled: true, refractory: 2,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  // 首次分裂年龄为 null；第二批分裂母本年龄恰为门槛 2；新女儿归零
  const rec = (t, id) => sol.spots[t].find((r) => r.id === id);
  assert.equal(rec(0, 'a').age, null);
  assert.equal(rec(3, 'e1').divisionAge, 2);
  assert.equal(rec(4, 'f1').age, 0);
  assert.equal(rec(4, 'f1').generation, 2);
  assert.equal(rec(2, 'c1').wait, 1);
});

test('跨漏检按真实跨度计 2 个帧间：女儿漏检补获后满龄即可分裂', () => {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const junk = (t) => [s(`J${t}a`, 95, 95, 100), s(`J${t}b`, 97, 97, 100)];
  const input = {
    frames: [
      [s('a', 0, 0), ...junk(0)],
      [s('b1', 10, -1), s('b2', 10, 1), ...junk(1)],
      [s('z1', 90, 90, 100), s('z2', 92, 92, 100)],
      [s('c1', 30, -1), s('c2', 30, 1), ...junk(3)],
      [s('d1', 40, -2), s('d2', 40, 0), s('d3', 40, 2), s('d4', 40, 4), ...junk(4)],
    ],
    startId: 'a', maxDist: 12, maxSkip: 2, target: 4,
    refractoryEnabled: true, refractory: 2,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.equal(sol.skips, 2);
  // b 女儿龄 0；跨漏检补获为 c 时年龄 2；c 在帧4 分裂
  const gap = sol.edges.filter((e) => e.gap === 2);
  assert.equal(gap.length, 2);
  assert.ok(gap.every((e) => e.childAge === 2));
  const cRec = sol.spots[3].find((r) => r.id === 'c1');
  assert.equal(cRec.age, 2);
  assert.equal(cRec.divisionAge, 2);
});

test('跨漏检计龄下门槛 3 时同场景仍被阻断，并报告缺 1 帧间', () => {
  const s = (id, x, y, b = 10) => ({ id, x, y, b });
  const junk = (t) => [s(`J${t}a`, 95, 95, 100), s(`J${t}b`, 97, 97, 100)];
  const input = {
    frames: [
      [s('a', 0, 0), ...junk(0)],
      [s('b1', 10, -1), s('b2', 10, 1), ...junk(1)],
      [s('z1', 90, 90, 100), s('z2', 92, 92, 100)],
      [s('c1', 30, -1), s('c2', 30, 1), ...junk(3)],
      [s('d1', 40, -2), s('d2', 40, 0), s('d3', 40, 2), s('d4', 40, 4), ...junk(4)],
    ],
    startId: 'a', maxDist: 12, maxSkip: 2, target: 4,
    refractoryEnabled: true, refractory: 3,
  };
  const { raw, sol } = run(input);
  assert.equal(raw.feasible, false);
  assert.ok(raw.refractoryBlock, '门槛 3 下补获龄 2 仍不足，应被阻断');
  assert.equal(raw.refractoryBlock.age, 2);
  assert.equal(raw.refractoryBlock.need, 1);
  assert.match(sol.refractoryBlock.label, /尚缺 1 个等待帧间/);
});

test('不应期不改变裁决键：同亮度、同漏检数仍按输入顺序裁决', () => {
  // 两条对称路径，采用更靠输入前面的斑点；门槛放宽到不构成约束。
  const s = (id, x, y, b = 5) => ({ id, x, y, b });
  const input = {
    frames: [
      [s('p', 0, 0), s('q', 0, 3)],
      [s('r', 1, 0), s('t2', 1, 3)],
      [s('u', 2, 0), s('v', 2, 3)],
      [s('w', 3, 0), s('x', 3, 3)],
    ],
    startId: 'p', maxDist: 3, maxSkip: 0, target: 1,
    refractoryEnabled: true, refractory: 4,
  };
  const { spec, sol } = run(input);
  assertValidLineage(spec, sol, input);
  assert.deepEqual(sol.used, [['p'], ['r'], ['u'], ['w']]);
});

test('输入校验：帧数、斑点数、重复编号、参数范围', () => {
  const bad = { frames: base4().frames.slice(0, 3), startId: 'a', maxDist: 1, maxSkip: 0, target: 1 };
  assert.equal(normalizeSpec(bad).errors.length > 0, true);
  const dup = base4();
  dup.frames = structuredClone(dup.frames);
  dup.frames[0][1].id = 'a';
  assert.ok(normalizeSpec(dup).errors.some((e) => e.message.includes('重复')));
  const badCoord = base4();
  badCoord.frames = structuredClone(badCoord.frames);
  badCoord.frames[0][0].x = 1.5;
  assert.ok(normalizeSpec(badCoord).errors.some((e) => e.message.includes('整数')));
  const badTarget = base4();
  badTarget.target = 9;
  assert.ok(normalizeSpec(badTarget).errors.some((e) => e.field === 'target'));
});

// ---------- 独立暴力枚举：逐帧 DFS 穷举全部可行谱系（无备忘、无剪枝界） ----------
// 与求解器完全独立的第二实现；启用不应期时同样为每条支携带分裂年龄。
function bruteForce(spec) {
  const { frames, startIndex, maxDist, maxSkip, target } = spec;
  const refractoryEnabled = spec.refractoryEnabled === true;
  const R = refractoryEnabled ? spec.refractory : 0;
  const F = frames.length;
  const INF = 10 ** 6; // 起始细胞本体：首次分裂不受限
  const near = (m, c, gap) =>
    Math.hypot(m.x - c.x, m.y - c.y) <= maxDist * gap + 1e-9;

  let best = null;

  // t 边界：live/gaps 元素为 {i 局部斑点序号, age 分裂年龄（INF=起始本体）}。
  function dfs(t, live, gaps, usedSkip, bright, usedPerFrame) {
    if (live.length + gaps.length > target) return;
    if (t === F - 1) {
      if (gaps.length > 0 || live.length !== target) return;
      const sig = usedPerFrame.slice(1).map((s) => [...s].sort((a, b) => a - b));
      if (!best ||
        bright > best.bright ||
        (bright === best.bright &&
          (usedSkip < best.skips ||
            (usedSkip === best.skips && tupleLex(sig, best.sig) < 0)))) {
        best = { bright, skips: usedSkip, sig };
      }
      return;
    }

    const tracks = [
      ...live.map((x) => ({ kind: 'o', ...x })),
      ...gaps.map((x) => ({ kind: 'g', ...x })),
    ];
    const claimed = new Set(); // 帧 t+1 已被女儿占用的斑点
    const nextLive = [];       // {i, age}
    const openGaps = [];       // 帧 t 新开漏检的母本 {i, age}

    function rec(k, accBright) {
      if (k === tracks.length) {
        // 仅对传入下层的副本排序，避免改动原数组后 pop 回溯错位
        const liveSorted = nextLive.slice().sort((a, b) => a.i - b.i);
        const gapsSorted = openGaps.slice().sort((a, b) => a.i - b.i);
        dfs(t + 1, liveSorted, gapsSorted,
          usedSkip + openGaps.length, accBright, usedPerFrame);
        return;
      }
      const tr = tracks[k];
      if (tr.kind === 'g') {
        // 漏检母本：恰一个跨帧女儿；真实跨度两个帧间 → 年龄 +2
        const childAge = tr.age >= INF ? INF : tr.age + 2;
        for (let j = 0; j < frames[t + 1].length; j++) {
          if (claimed.has(j)) continue;
          if (!near(frames[t - 1][tr.i], frames[t + 1][j], 2)) continue;
          claimed.add(j); nextLive.push({ i: j, age: childAge });
          usedPerFrame[t + 1].add(j);
          rec(k + 1, accBright + frames[t + 1][j].b);
          usedPerFrame[t + 1].delete(j);
          nextLive.pop(); claimed.delete(j);
        }
        return;
      }
      const m = frames[t][tr.i];
      const keptAge = tr.age >= INF ? INF : tr.age + 1;
      // 保持：一个相邻女儿
      for (let j = 0; j < frames[t + 1].length; j++) {
        if (claimed.has(j) || !near(m, frames[t + 1][j], 1)) continue;
        claimed.add(j); nextLive.push({ i: j, age: keptAge });
        usedPerFrame[t + 1].add(j);
        rec(k + 1, accBright + frames[t + 1][j].b);
        usedPerFrame[t + 1].delete(j);
        nextLive.pop(); claimed.delete(j);
      }
      // 分裂：两个不同的相邻女儿；起始本体不受限，其余须年龄达门槛；女儿归零
      if (!refractoryEnabled || tr.age >= R) {
        for (let a = 0; a < frames[t + 1].length; a++) {
          if (claimed.has(a) || !near(m, frames[t + 1][a], 1)) continue;
          for (let b2 = a + 1; b2 < frames[t + 1].length; b2++) {
            if (claimed.has(b2) || !near(m, frames[t + 1][b2], 1)) continue;
            claimed.add(a); claimed.add(b2);
            nextLive.push({ i: a, age: 0 }, { i: b2, age: 0 });
            usedPerFrame[t + 1].add(a); usedPerFrame[t + 1].add(b2);
            rec(k + 1, accBright + frames[t + 1][a].b + frames[t + 1][b2].b);
            usedPerFrame[t + 1].delete(a); usedPerFrame[t + 1].delete(b2);
            nextLive.pop(); nextLive.pop();
            claimed.delete(a); claimed.delete(b2);
          }
        }
      }
      // 漏检：帧 t+1 不出现（末帧前不开新漏检）；年龄原样携带
      if (usedSkip + openGaps.length < maxSkip && t + 2 <= F - 1) {
        openGaps.push({ i: tr.i, age: tr.age });
        rec(k + 1, accBright);
        openGaps.pop();
      }
    }
    rec(0, bright);
  }

  const used0 = Array.from({ length: F }, () => new Set());
  used0[0].add(startIndex);
  dfs(0, [{ i: startIndex, age: INF }], [], 0, frames[0][startIndex].b, used0);
  return best;
}

function tupleLex(a, b) {
  const flatA = a.flat(), flatB = b.flat();
  for (let i = 0; i < Math.min(flatA.length, flatB.length); i++) {
    if (flatA[i] !== flatB[i]) return flatA[i] - flatB[i];
  }
  return flatA.length - flatB.length;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('随机对拍：小规模输入下与独立暴力枚举裁决一致', () => {
  const rand = rng(20260929);
  let feasibleCases = 0;
  let refractoryCases = 0;
  for (let iter = 0; iter < 3000 && feasibleCases < 300; iter++) {
    const F = rand() < 0.35 ? 5 : 4;
    const frames = [];
    for (let t = 0; t < F; t++) {
      const n = 2 + Math.floor(rand() * 2); // 2~3 个斑点
      const fr = [];
      for (let i = 0; i < n; i++) {
        fr.push({
          id: `f${t}_${i}`,
          x: Math.floor(rand() * 3),
          y: Math.floor(rand() * 3),
          b: Math.floor(rand() * 9) + 1,
        });
      }
      frames.push(fr);
    }
    const useRefractory = rand() < 0.4;
    const lastN = frames[F - 1].length;
    // 启用不应期的用例允许目标数达到 4，以覆盖「女儿再次分裂」受门槛约束的路径
    const maxTarget = useRefractory ? Math.min(4, lastN) : Math.min(2, lastN);
    const input = {
      frames,
      startId: frames[0][Math.floor(rand() * frames[0].length)].id,
      maxDist: 1 + Math.floor(rand() * 3),
      maxSkip: rand() < 0.5 ? 0 : 1,
      target: 1 + Math.floor(rand() * maxTarget),
    };
    // 约四成用例启用分裂不应期（门槛 2~4）
    if (useRefractory) {
      input.refractoryEnabled = true;
      input.refractory = 2 + Math.floor(rand() * 3);
    }
    const { errors, spec } = normalizeSpec(input);
    if (errors.length) continue;
    const raw = solveLineage(spec);
    const bf = bruteForce(spec);
    if (!raw.feasible) {
      assert.equal(bf, null, `迭代 ${iter}：求解器判不可行但暴力枚举存在解`);
      continue;
    }
    assert.ok(bf, `迭代 ${iter}：求解器给出解但暴力枚举无解`);
    feasibleCases++;
    if (input.refractoryEnabled) refractoryCases++;
    const sol = presentSolution(spec, raw);
    assertValidLineage(spec, sol, input);
    assert.equal(sol.totalBrightness, bf.bright, `迭代 ${iter} 总亮度不一致`);
    assert.equal(sol.skips, bf.skips, `迭代 ${iter} 漏检数不一致`);
    const sig = sol.used.slice(1).map((ids, t) =>
      ids.map((id) => frames[t + 1].findIndex((s) => s.id === id)).sort((a, b) => a - b));
    assert.equal(tupleLex(sig, bf.sig), 0, `迭代 ${iter} 输入顺序裁决不一致`);
  }
  assert.ok(feasibleCases >= 30, `可行对拍用例过少: ${feasibleCases}`);
  assert.ok(refractoryCases >= 20, `启用不应期的可行对拍用例过少: ${refractoryCases}`);
});

test('随机对拍：不应期阻断位置/母本/年龄/缺口与关闭不应期后的裁决链一致', () => {
  const rand = rng(20261003);
  // 独立依据「关闭不应期解」的边重建分裂年龄，推出首个被迫过早分裂帧间与母本。
  function expectedBlock(spec, input, offSol) {
    const F = spec.frames.length;
    const R = input.refractory;
    const age = new Map(); // `${frame}:${id}` -> null(起始本体) / number
    age.set(`0:${input.startId}`, null);
    const keyOf = (frame, id) => `${frame}:${id}`;
    let first = null; // {frame, motherId, age, need}
    for (let b = 0; b < F - 1; b++) {
      const candidates = [];
      // 该边界的 gap1 边（保持/分裂）；gap2 捕获不允许分裂
      const edges1 = offSol.edges.filter((e) => e.gap === 1 && e.fromFrame === b);
      const byMother = new Map();
      for (const e of edges1) {
        if (!byMother.has(e.fromId)) byMother.set(e.fromId, []);
        byMother.get(e.fromId).push(e);
      }
      for (const [mid, es] of byMother) {
        const motherAge = age.get(keyOf(b, mid));
        for (const e of es) {
          age.set(keyOf(e.toFrame, e.toId),
            es.length === 2 ? 0 : (motherAge === null ? null : motherAge + 1));
        }
        if (es.length === 2 && motherAge !== null && motherAge < R) {
          candidates.push({ frame: b, motherId: mid, age: motherAge, need: R - motherAge });
        }
      }
      // gap2 补获边（母帧 b-1 → 子帧 b+1），年龄 +2；不产生分裂
      for (const e of offSol.edges.filter((x) => x.gap === 2 && x.fromFrame === b - 1)) {
        const ma = age.get(keyOf(e.fromFrame, e.fromId));
        age.set(keyOf(e.toFrame, e.toId), ma === null ? null : ma + 2);
      }
      if (candidates.length && !first) {
        // 与求解器相同的帧内裁决：need 降序 → age 升序 → 母本局部序号升序
        candidates.sort((p, q) =>
          q.need - p.need ||
          p.age - q.age ||
          spec.frames[b].findIndex((s) => s.id === p.motherId) -
            spec.frames[b].findIndex((s) => s.id === q.motherId));
        first = candidates[0];
      }
    }
    return first;
  }

  let blocked = 0, geometric = 0;
  for (let iter = 0; iter < 2500; iter++) {
    const F = rand() < 0.4 ? 5 : 4;
    const frames = [];
    for (let t = 0; t < F; t++) {
      const n = 2 + Math.floor(rand() * 2);
      const fr = [];
      for (let i = 0; i < n; i++) {
        fr.push({
          id: `g${t}_${i}`,
          x: Math.floor(rand() * 3),
          y: Math.floor(rand() * 3),
          b: Math.floor(rand() * 9) + 1,
        });
      }
      frames.push(fr);
    }
    const lastN = frames[F - 1].length;
    const input = {
      frames,
      startId: frames[0][Math.floor(rand() * frames[0].length)].id,
      maxDist: 1 + Math.floor(rand() * 3),
      maxSkip: rand() < 0.5 ? 0 : 1,
      target: 1 + Math.floor(rand() * Math.min(4, lastN)),
      refractoryEnabled: true,
      refractory: 2 + Math.floor(rand() * 3),
    };
    const { errors, spec } = normalizeSpec(input);
    if (errors.length) continue;
    const enRaw = solveLineage(spec);
    if (enRaw.feasible) continue;
    const offSpec = normalizeSpec({ ...input, refractoryEnabled: false }).spec;
    const offRaw = solveLineage(offSpec);
    if (!offRaw.feasible) {
      // 放宽后仍无解：纯几何不可行，不应给出不应期归因
      assert.equal(enRaw.refractoryBlock, null,
        `迭代 ${iter}：放宽仍无解时不应归因不应期: ${JSON.stringify(enRaw.refractoryBlock)}`);
      geometric++;
      continue;
    }
    const offSol = presentSolution(offSpec, offRaw);
    const exp = expectedBlock(spec, input, offSol);
    assert.ok(exp, `迭代 ${iter}：放宽可行而强制不可行，放宽链必含过早分裂`);
    assert.ok(enRaw.refractoryBlock, `迭代 ${iter}：缺少不应期阻断归因`);
    assert.equal(enRaw.earliestBreak.from, exp.frame,
      `迭代 ${iter}：阻断帧间应为 ${exp.frame}，实际 ${enRaw.earliestBreak.from}`);
    const gotSol = presentSolution(spec, enRaw);
    assert.equal(gotSol.refractoryBlock.motherId, exp.motherId,
      `迭代 ${iter}：阻断母本应为 ${exp.motherId}，实际 ${gotSol.refractoryBlock.motherId}`);
    assert.equal(enRaw.refractoryBlock.age, exp.age, `迭代 ${iter}：分裂年龄不符`);
    assert.equal(enRaw.refractoryBlock.need, exp.need, `迭代 ${iter}：缺口帧间不符`);
    blocked++;
  }
  assert.ok(blocked >= 50, `不应期阻断对拍用例过少: ${blocked}`);
  assert.ok(geometric >= 5, `纯几何不可行对拍用例过少: ${geometric}`);
});
