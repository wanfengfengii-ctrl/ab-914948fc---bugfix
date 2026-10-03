// 藻类细胞分裂谱系复原核心（纯函数，零依赖，浏览器 / Node 共用）
//
// 模型：
//  - 帧按时刻排列；每帧若干斑点（唯一 id、整数坐标、整数亮度）。
//  - 连接只允许相邻帧（gap=1）或跨越恰好一帧漏检（gap=2）。
//  - 一个细胞要么保持为一个后代，要么分裂为恰两个后代；不允许消亡。
//  - 每个非起始斑点恰有一个祖先（入边），同一斑点不得被两支共用。
//  - 所有存活支必须从起始斑点出发到达末帧，且末帧存活数恰为目标数。
//  - 裁决顺序：总亮度最高 → 漏检段最少 → 输入顺序（逐帧采用斑点局部序号，
//    再逐斑点母本全局序号）字典序稳定裁决。
//
// 位掩码动态规划：帧内斑点以位掩码表示；边界转移在「已占用女儿掩码 +
// 新开漏检母本掩码」上做内层 DP，同一 (女儿集合, 漏检集合) 只保留字典序最小
// 的母本配对，不展开母亲排列；状态 (帧, 存活掩码, 漏检掩码, 剩余额度) 备忘。

'use strict';

/**
 * 校验并规范化输入。
 * @returns {{errors:Array<{field:string,message:string}>, spec:object|null}}
 */
export function normalizeSpec(raw) {
  const errors = [];
  const field = (name, message) => errors.push({ field: name, message });

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    return { errors: [{ field: 'frames', message: '缺少帧数据' }], spec: null };
  }
  const F = raw.frames.length;
  if (F < 4 || F > 7) {
    field('frames', `帧数必须在 4 至 7 之间（当前 ${F}）`);
  }

  const frames = [];
  raw.frames.forEach((fr, t) => {
    const out = [];
    if (!Array.isArray(fr) || fr.length < 2 || fr.length > 8) {
      field(`frame${t}`, `第 ${t + 1} 帧斑点数必须在 2 至 8 之间（当前 ${Array.isArray(fr) ? fr.length : 0}）`);
      return;
    }
    const seen = new Set();
    fr.forEach((s, j) => {
      const label = `第 ${t + 1} 帧斑点 ${j + 1}`;
      if (!s || typeof s.id !== 'string' || s.id.trim() === '') {
        field(`frame${t}`, `${label} 缺少唯一编号`);
        return;
      }
      const id = s.id.trim();
      if (seen.has(id)) {
        field(`frame${t}`, `第 ${t + 1} 帧内斑点编号重复：${id}`);
        return;
      }
      seen.add(id);
      const x = Number(s.x);
      const y = Number(s.y);
      const b = Number(s.b);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        field(`frame${t}`, `${label}（${id}）坐标必须为整数`);
        return;
      }
      if (!Number.isInteger(b) || b < 0) {
        field(`frame${t}`, `${label}（${id}）亮度必须为非负整数`);
        return;
      }
      out.push({ id, x, y, b });
    });
    frames.push(out);
  });

  if (errors.length) return { errors, spec: null };

  const startId = typeof raw.startId === 'string' ? raw.startId.trim() : '';
  const startIndex = frames[0] ? frames[0].findIndex((s) => s.id === startId) : -1;
  if (startIndex < 0) {
    field('startId', `起始斑点必须是第 1 帧中存在的编号（当前“${raw.startId}”）`);
  }

  const maxDist = Number(raw.maxDist);
  if (!Number.isFinite(maxDist) || maxDist < 0) {
    field('maxDist', '相邻帧最大位移必须为非负数');
  }

  const maxSkip = Number(raw.maxSkip);
  if (!Number.isInteger(maxSkip) || maxSkip < 0 || maxSkip > F - 2) {
    field('maxSkip', `允许漏检帧数必须为 0 至 ${Math.max(0, F - 2)} 的整数`);
  }

  const lastSize = frames[F - 1] ? frames[F - 1].length : 0;
  const target = Number(raw.target);
  if (!Number.isInteger(target) || target < 1 || target > lastSize) {
    field('target', `终帧存活细胞数必须为 1 至末帧斑点数（${lastSize}）的整数`);
  }

  // 分裂不应期：女儿再次分裂前至少经历的帧间数（普通连接计 1，跨漏检计 2）。
  const refractoryEnabled = raw.refractoryEnabled === true;
  let refractory = 0;
  if (refractoryEnabled) {
    refractory = Number(raw.refractory);
    if (!Number.isInteger(refractory) || refractory < 2 || refractory > 4) {
      field('refractory', '分裂不应期门槛必须为 2 至 4 的整数（帧间）');
    }
  }

  if (errors.length) return { errors, spec: null };
  return {
    errors: [],
    spec: { frames, startIndex, maxDist, maxSkip, target, refractoryEnabled, refractory },
  };
}

function compareTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// 比较两个裁决签名：逐帧比较（采用斑点局部序号元组，再母本全局序号元组）。
function betterSignature(a, b) {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const c = compareTuple(a[k].used, b[k].used);
    if (c !== 0) return c < 0;
    const cm = compareTuple(a[k].mothers, b[k].mothers);
    if (cm !== 0) return cm < 0;
  }
  return false;
}

/**
 * 求解谱系。
 * @returns {object} 可行时 {feasible:true, ...}；不可行时
 *   {feasible:false, earliestBreak:{from:number,to:number}}
 */
export function solveLineage(spec) {
  const { frames, startIndex, maxDist, maxSkip, target } = spec;
  const refractoryEnabled = spec.refractoryEnabled === true;
  const refractory = refractoryEnabled ? spec.refractory : 0;
  const F = frames.length;
  const sizes = frames.map((fr) => fr.length);

  // 分裂年龄按「帧间」累计：普通连接 +1，跨一帧漏检 +2，分裂产生的女儿从 0
  // 重新计龄。起始细胞本体（含其漏检延续）享有「首次分裂不受限」，以高龄
  // 哨兵 ROOT_AGE 表示：恒满足任何门槛，且沿保持/漏检不被普通计龄覆盖。
  const ROOT_AGE = 100;
  const ageAfter = (age, delta) => (age >= ROOT_AGE ? ROOT_AGE : age + delta);
  const canSplit = (age) => !refractoryEnabled || age >= refractory;

  const offset = [0];
  for (let t = 1; t <= F; t++) offset[t] = offset[t - 1] + sizes[t - 1];
  const gi = (t, i) => offset[t] + i;
  const decode = (g) => {
    let t = 0;
    while (t + 1 < F && g >= offset[t + 1]) t++;
    return { t, i: g - offset[t] };
  };

  const d2 = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const popcnt = (m) => {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  };
  const bits = (m) => {
    const out = [];
    for (let i = 0; m; i++, m >>>= 1) if (m & 1) out.push(i);
    return out;
  };

  // 邻接位掩码：near1[t][i] 为帧 t 斑点 i 在帧 t+1 内可达的女儿掩码；
  // near2[t][i] 为跨一帧漏检后在帧 t+2 内可达的女儿掩码。
  const D2 = maxDist * maxDist;
  const G2 = 4 * D2;
  const near1 = [];
  const near2 = [];
  for (let t = 0; t < F - 1; t++) {
    near1[t] = frames[t].map((s) => {
      let mask = 0;
      frames[t + 1].forEach((q, j) => { if (d2(s, q) <= D2) mask |= 1 << j; });
      return mask;
    });
    if (t < F - 2) {
      near2[t] = frames[t].map((s) => {
        let mask = 0;
        frames[t + 2].forEach((q, j) => { if (d2(s, q) <= G2) mask |= 1 << j; });
        return mask;
      });
    }
  }

  // 各帧「掩码 → 亮度和」预计算
  const maskBright = frames.map((fr) => {
    const arr = new Array(1 << fr.length).fill(0);
    for (let m = 1; m < arr.length; m++) {
      const lsb = m & -m;
      arr[m] = arr[m ^ lsb] + fr[Math.log2(lsb)].b;
    }
    return arr;
  });

  // 每对 (t, 母本) 的保持单女儿掩码列表与分裂双女儿掩码列表
  const keepOpts = [];
  const splitOpts = [];
  for (let t = 0; t < F - 1; t++) {
    keepOpts[t] = near1[t].map((mask) => bits(mask).map((j) => 1 << j));
    splitOpts[t] = near1[t].map((mask) => {
      const js = bits(mask);
      const out = [];
      for (let a = 0; a < js.length; a++) {
        for (let b = a + 1; b < js.length; b++) out.push((1 << js[a]) | (1 << js[b]));
      }
      return out;
    });
  }

  // 将按斑点序号排列的年龄向量打包进 BigInt（每槽 4 bit，ROOT 记为 15）。
  function packAges(arr, n) {
    let k = 0n;
    for (let i = 0; i < n; i++) {
      const v = !arr || arr[i] >= ROOT_AGE ? 15 : arr[i];
      k |= BigInt(v & 15) << BigInt(4 * i);
    }
    return k;
  }

  /**
   * 边界 t 的联合转移：存活母本（帧 t）与待补获漏检母本（帧 t-1）
   * 共同在帧 t+1 上安排女儿。年龄随支联合传递：
   *  - 漏检补获：女儿年龄 = 母年龄 + 2（真实跨度两个帧间）；
   *  - 保持：女儿年龄 = 母年龄 + 1（起始支保持起始身份）；
   *  - 分裂：仅当母年龄达门槛（ignoreAge=true 时仅用于不应期阻断诊断），
   *    两个女儿年龄一律归零；
   *  - 本帧漏检：母年龄原样携带，补获时再 +2。
   * @returns {Map<number, {mom:Int8Array,age:Int8Array,openedAge:Int8Array}>}
   *   key = 女儿掩码*512 + 新开漏检母本掩码；同一 key 只保留字典序最小母本向量。
   */
  const expandMemo = new Map();
  function expand(t, live, gaps, liveAge, gapAge, ignoreAge = false) {
    const key =
      BigInt(t) | (BigInt(live) << 3n) | (BigInt(gaps) << 11n) |
      (BigInt(ignoreAge ? 1 : 0) << 19n) |
      (packAges(liveAge, sizes[t]) << 20n) |
      (packAges(gapAge, t >= 1 ? sizes[t - 1] : 0) << BigInt(20 + 4 * sizes[t]));
    const cached = expandMemo.get(key);
    if (cached) return cached;

    const nChild = sizes[t + 1];
    const nLive = sizes[t];
    const liveMoms = bits(live);
    const gapMoms = bits(gaps);
    // dp：转移中间状态键 -> {母本向量, 女儿年龄向量, 新开漏检母本年龄向量}
    let dp = new Map([[0, {
      mom: new Int8Array(nChild).fill(-1),
      age: new Int8Array(nChild).fill(-1),
      openedAge: new Int8Array(nLive),
    }]]);

    // 同一 (女儿集合, 漏检集合) 只保留字典序最小的母本向量；年龄与开漏年龄
    // 均由母本向量与输入年龄唯一确定，无需另行比较。
    const put = (map, k, tr) => {
      const old = map.get(k);
      if (old === undefined) { map.set(k, tr); return; }
      for (let j = 0; j < nChild; j++) {
        if (tr.mom[j] !== old.mom[j]) {
          if (tr.mom[j] < old.mom[j]) map.set(k, tr);
          return;
        }
      }
    };

    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿，年龄 +2
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const cap = near2[t - 1][mi];
      const capturedAge = ageAfter(gapAge[mi], 2);
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const ndp = new Map();
      for (const [state, tr] of dp) {
        const used = Math.floor(state / 512);
        for (const b of bits(cap & ~used)) {
          const bit = 1 << b;
          if (popcnt(used | bit) + rest > target) continue;
          const mom2 = tr.mom.slice();
          const age2 = tr.age.slice();
          mom2[b] = gm;
          age2[b] = capturedAge;
          put(ndp, (used | bit) * 512, { mom: mom2, age: age2, openedAge: tr.openedAge });
        }
      }
      dp = ndp;
      processed++;
    }

    // 2) 存活母本（帧 t）：保持一女 / 分裂两女（须达不应期门槛）/ 本帧漏检
    const canOpen = t + 2 <= F - 1;
    // 未启用不应期时年龄不参与任何裁决，令分裂女儿也保持统一高龄，
    // 使备忘状态与旧版完全合并（避免无意义的状态空间膨胀）。
    const resetAge = refractoryEnabled ? 0 : ROOT_AGE;
    for (const mi of liveMoms) {
      const gm = gi(t, mi);
      const miBit = 1 << mi;
      const motherAge = liveAge[mi];
      const keptAge = ageAfter(motherAge, 1);
      const allowSplit = ignoreAge || canSplit(motherAge);
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, tr] of dp) {
        const used = Math.floor(state / 512);
        const opened = state % 512;

        // 2a) 保持
        for (const bit of keepOpts[t][mi]) {
          if (used & bit) continue;
          const used2 = used | bit;
          if (popcnt(used2) + popcnt(opened) + rest > target) continue;
          const b = Math.log2(bit);
          const mom2 = tr.mom.slice();
          const age2 = tr.age.slice();
          mom2[b] = gm;
          age2[b] = keptAge;
          put(ndp, used2 * 512 + opened, { mom: mom2, age: age2, openedAge: tr.openedAge });
        }
        // 2b) 分裂（启用时女儿从零计龄；年龄不足则该母本此边界无分裂候选）
        if (allowSplit) {
          for (const pair of splitOpts[t][mi]) {
            if (used & pair) continue;
            const used2 = used | pair;
            if (popcnt(used2) + popcnt(opened) + rest > target) continue;
            const mom2 = tr.mom.slice();
            const age2 = tr.age.slice();
            for (const b of bits(pair)) {
              mom2[b] = gm;
              age2[b] = resetAge;
            }
            put(ndp, used2 * 512 + opened, { mom: mom2, age: age2, openedAge: tr.openedAge });
          }
        }
        // 2c) 本帧漏检（下一帧必须补获）；年龄原样携带
        if (canOpen) {
          const opened2 = opened | miBit;
          if (popcnt(used) + popcnt(opened2) + rest <= target) {
            const oa = tr.openedAge.slice();
            oa[mi] = motherAge;
            put(ndp, used * 512 + opened2, { mom: tr.mom, age: tr.age, openedAge: oa });
          }
        }
      }
      dp = ndp;
      processed++;
    }

    expandMemo.set(key, dp);
    return dp;
  }

  const memo = new Map();
  // 备忘键含各支年龄：同一边界掩码但年龄分布不同时，可行后缀与最优值均可能不同。
  const stateKey = (t, live, gaps, left, liveAge, gapAge) =>
    (packAges(liveAge, sizes[t]) << 22n) |
    (packAges(gapAge, t >= 1 ? sizes[t - 1] : 0) << 54n) |
    BigInt((((t * 256 + live) * 256 + gaps) * 8) + (left + 1));

  // 计数增长走廊：从 (live, gaps) 起，每步至多翻倍，漏检补获只能单传，
  // 判断末帧存活数能否达到目标。
  function canReachTarget(t, live, gaps) {
    let co = popcnt(live);
    let cg = popcnt(gaps);
    for (let s = 1; s <= F - 1 - t; s++) {
      co = Math.min(sizes[t + s], 2 * co + cg);
      cg = 0;
    }
    return co >= target;
  }

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null
  function solve(t, live, gaps, left, liveAge, gapAge) {
    const key = stateKey(t, live, gaps, left, liveAge, gapAge);
    if (memo.has(key)) return memo.get(key);

    const count = popcnt(live) + popcnt(gaps);
    if (count > target || left < 0) {
      memo.set(key, null);
      return null;
    }
    if (t === F - 1) {
      const leaf = gaps === 0 && popcnt(live) === target
        ? { bright: 0, skips: 0, frames: [], pick: null, sub: null }
        : null;
      memo.set(key, leaf);
      return leaf;
    }
    if (!canReachTarget(t, live, gaps)) {
      memo.set(key, null);
      return null;
    }

    let best = null;
    for (const [state, tr] of expand(t, live, gaps, liveAge, gapAge)) {
      const used = Math.floor(state / 512);
      const opened = state % 512;
      const openCount = popcnt(opened);
      if (openCount > left) continue;

      const sub = solve(t + 1, used, opened, left - openCount, tr.age, tr.openedAge);
      if (!sub) continue;

      const usedBits = bits(used);
      const sigFrame = {
        used: usedBits,
        mothers: usedBits.map((j) => tr.mom[j]),
      };
      const cand = {
        bright: maskBright[t + 1][used] + sub.bright,
        skips: openCount + sub.skips,
        frames: [sigFrame, ...sub.frames],
        pick: { t, used, mom: tr.mom, age: tr.age, openedAge: tr.openedAge },
        sub,
      };
      if (
        !best ||
        cand.bright > best.bright ||
        (cand.bright === best.bright &&
          (cand.skips < best.skips ||
            (cand.skips === best.skips && betterSignature(cand.frames, best.frames))))
      ) {
        best = cand;
      }
    }
    memo.set(key, best);
    return best;
  }

  const rootMask = 1 << startIndex;
  const rootAge = new Int8Array(sizes[0]);
  rootAge[startIndex] = ROOT_AGE; // 起始细胞首次分裂不受不应期限制
  const rootGapAge = new Int8Array(0);
  const root = solve(0, rootMask, 0, maxSkip, rootAge, rootGapAge);

  if (!root) {
    // 最早断开帧间：逐步前向展开可达状态（含各支分裂年龄），以局部必要存活
    // 条件（计数走廊、漏检必须在补获帧有可达斑点、末帧计数恰为目标）筛选，
    // 找出首个所有后继都无法存活的帧间。
    const viable = (t, live, gaps, left) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (t === F - 1) return gaps === 0 && popcnt(live) === target;
      if (!canReachTarget(t, live, gaps)) return false;
      if (t >= 1) {
        for (const mi of bits(gaps)) {
          if (near2[t - 1][mi] === 0) return false;
        }
      }
      return true;
    };

    const fkey = (t, live, gaps, left, la, ga) =>
      (packAges(la, sizes[t]) << 40n) |
      (packAges(ga, t >= 1 ? sizes[t - 1] : 0) << 72n) |
      BigInt((((t * 256 + live) * 256 + gaps) * 8) + (left + 1));

    // 逐边界记录可达状态集合：不应期归因需要回溯到普通断链之前的帧间。
    const reachByFrame = [];
    let reach = new Map();
    if (viable(0, rootMask, 0, maxSkip)) {
      reach.set(fkey(0, rootMask, 0, maxSkip, rootAge, rootGapAge),
        { live: rootMask, gaps: 0, left: maxSkip, liveAge: rootAge, gapAge: rootGapAge });
    }
    reachByFrame.push([...reach.values()]);
    let earliest = 0;
    for (let t = 0; t < F - 1; t++) {
      const next = new Map();
      for (const st of reach.values()) {
        for (const [state, tr] of expand(t, st.live, st.gaps, st.liveAge, st.gapAge)) {
          const used = Math.floor(state / 512);
          const opened = state % 512;
          const nleft = st.left - popcnt(opened);
          if (!viable(t + 1, used, opened, nleft)) continue;
          const k = fkey(t + 1, used, opened, nleft, tr.age, tr.openedAge);
          if (!next.has(k)) {
            next.set(k, { live: used, gaps: opened, left: nleft, liveAge: tr.age, gapAge: tr.openedAge });
          }
        }
      }
      if (next.size === 0) {
        earliest = t;
        break;
      }
      earliest = t + 1;
      reach = next;
      reachByFrame.push([...reach.values()]);
    }
    earliest = Math.min(earliest, F - 2);

    // 不应期归因：普通断链（最早无局部可行状态穿过的帧间）可能晚于真正的
    // 病因——某些保持路径虽能局部延续到更晚的帧间，但所有完整谱系在更早的
    // 帧间就被迫过早分裂。自前向后找首个「遵守年龄的转移无一能进入（放宽
    // 年龄的）可行后缀」的边界：该边界上放宽年龄后出现的可行转移，其被迫
    // 过早分裂的母本即病因；后续帧间的普通断链不得掩盖这一诊断。
    let refractoryBlock = null;
    if (refractoryEnabled) {
      const relMemo = new Map();
      function canFinishRelaxed(t, live, gaps, left, la, ga) {
        if (left < 0 || popcnt(live) + popcnt(gaps) > target) return false;
        if (t === F - 1) return gaps === 0 && popcnt(live) === target;
        if (!canReachTarget(t, live, gaps)) return false;
        const k = fkey(t, live, gaps, left, la, ga);
        if (relMemo.has(k)) return relMemo.get(k);
        let ok = false;
        for (const [state, tr] of expand(t, live, gaps, la, ga, true)) {
          const used = Math.floor(state / 512);
          const opened = state % 512;
          const oc = popcnt(opened);
          if (oc > left) continue;
          if (canFinishRelaxed(t + 1, used, opened, left - oc, tr.age, tr.openedAge)) {
            ok = true;
            break;
          }
        }
        relMemo.set(k, ok);
        return ok;
      }

      // 首个「遵守年龄则无可行后缀」的边界。该边界必然存在且不晚于普通断链
      // 帧间：那里没有任何可存活的后继，条件自然成立。
      let blockFrame = -1;
      for (let t = 0; t <= earliest; t++) {
        let passable = false;
        for (const st of reachByFrame[t]) {
          for (const [state, tr] of expand(t, st.live, st.gaps, st.liveAge, st.gapAge)) {
            const used = Math.floor(state / 512);
            const opened = state % 512;
            const oc = popcnt(opened);
            if (oc > st.left) continue;
            if (canFinishRelaxed(t + 1, used, opened, st.left - oc, tr.age, tr.openedAge)) {
              passable = true;
              break;
            }
          }
          if (passable) break;
        }
        if (!passable) {
          blockFrame = t;
          break;
        }
      }

      // 在阻断边界上放宽年龄的可行转移中统计同一母本出现次数（2 次即分裂），
      // 选出受阻最严重的过早分裂母本。
      if (blockFrame >= 0) {
        let bestBlock = null;
        const betterBlock = (cand, best) =>
          !best ||
          cand.need > best.need ||        // 尚缺等待帧间最多（受阻最严重）
          (cand.need === best.need &&
            (cand.age < best.age ||       // 分裂年龄最小
              (cand.age === best.age && cand.mother < best.mother))); // 输入顺序裁决
        for (const st of reachByFrame[blockFrame]) {
          for (const [state, tr] of expand(blockFrame, st.live, st.gaps, st.liveAge, st.gapAge, true)) {
            const used = Math.floor(state / 512);
            const opened = state % 512;
            const oc = popcnt(opened);
            if (oc > st.left) continue;
            if (!canFinishRelaxed(blockFrame + 1, used, opened, st.left - oc, tr.age, tr.openedAge)) continue;

            const splits = new Map();
            for (const j of bits(used)) splits.set(tr.mom[j], (splits.get(tr.mom[j]) || 0) + 1);
            for (const [gm, n] of splits) {
              if (n !== 2) continue;
              const { t: mf, i: mi } = decode(gm);
              if (mf !== blockFrame) continue; // 只有帧 t 存活母本可能在此边界分裂
              const age = st.liveAge[mi];
              if (canSplit(age)) continue;  // 达门槛者不受阻断
              const block = { frame: blockFrame, mother: gm, age, need: refractory - age };
              if (betterBlock(block, bestBlock)) bestBlock = block;
            }
          }
        }
        refractoryBlock = bestBlock;
      }
    }

    return {
      feasible: false,
      earliestBreak: { from: earliest, to: earliest + 1 },
      refractoryEnabled,
      refractory,
      refractoryBlock,
      _decode: decode,
      _gi: gi,
    };
  }

  // 沿最优链重建母女边
  const edges = [];
  // 每个采用斑点在其所在帧的分裂年龄：起始细胞本体为 null（首次分裂不受限），
  // 分裂女儿从 0 起算。代际：起始为 0，每分裂一次 +1。
  const spotAge = new Map([[gi(0, startIndex), null]]);
  const generation = new Map([[gi(0, startIndex), 0]]);
  let node = root;
  while (node && node.pick) {
    const { t, used, mom, age: childAge } = node.pick;
    for (const j of bits(used)) {
      const g = mom[j];
      const { t: mf, i: mi } = decode(g);
      const gap = mf === t - 1 ? 2 : 1;
      const child = gi(t + 1, j);
      const a = childAge[j];
      spotAge.set(child, a >= ROOT_AGE ? null : a);
      edges.push({
        from: g,
        to: child,
        gap,
        motherAge: spotAge.get(g),
        childAge: a >= ROOT_AGE ? null : a,
        dist: Math.sqrt(d2(frames[mf][mi], frames[t + 1][j])),
      });
    }
    node = node.sub;
  }
  // 代际由边数确定：同一母本两条相邻帧边即分裂，女儿代际 = 母代际 + 1
  const childCount = new Map();
  for (const e of edges) childCount.set(e.from, (childCount.get(e.from) || 0) + 1);
  for (let t = 0; t < F; t++) {
    for (const e of edges) {
      if (decode(e.to).t !== t) continue;
      const motherDivides = childCount.get(e.from) === 2 && e.gap === 1;
      generation.set(e.to, (generation.get(e.from) ?? 0) + (motherDivides ? 1 : 0));
    }
  }

  const usedPerFrame = Array.from({ length: F }, () => new Set());
  usedPerFrame[0].add(startIndex);
  for (const e of edges) {
    const { t, i } = decode(e.to);
    usedPerFrame[t].add(i);
  }

  return {
    feasible: true,
    root: gi(0, startIndex),
    totalBrightness: frames[0][startIndex].b + root.bright,
    skips: root.skips,
    survivors: target,
    edges,
    usedPerFrame: usedPerFrame.map((s) => [...s].sort((a, b) => a - b)),
    spotAge,
    generation,
    refractoryEnabled,
    refractory,
    _decode: decode,
    _gi: gi,
  };
}

/**
 * 将基于序号的解翻译成带 id 的 JSON 友好结构（页面与测试共用）。
 * 未启用分裂不应期时输出与旧版完全一致；启用后额外给出每个采用斑点的
 * 代际、分裂年龄、尚余等待帧间，以及每条分裂边的分裂时年龄。
 */
export function presentSolution(spec, result) {
  if (!result.feasible) {
    const out = {
      feasible: false,
      earliestBreak: result.earliestBreak,
      earliestBreakLabel:
        `第 ${result.earliestBreak.from + 1} 帧 → 第 ${result.earliestBreak.to + 1} 帧`,
    };
    if (result.refractoryEnabled && result.refractoryBlock) {
      const b = result.refractoryBlock;
      const dec = result._decode ?? null;
      let motherLabel = '';
      if (dec) {
        const { t, i } = dec(b.mother);
        motherLabel = `第 ${t + 1} 帧·${spec.frames[t][i].id}`;
      }
      out.refractory = result.refractory;
      out.refractoryBlock = {
        frame: b.frame,
        motherFrame: b.frame,
        motherId: dec ? spec.frames[b.frame][dec(b.mother).i].id : null,
        age: b.age,
        need: b.need,
        label:
          `第 ${b.frame + 1} 帧 → 第 ${b.frame + 2} 帧间，母细胞 ${motherLabel} ` +
          `分裂年龄仅 ${b.age}，尚缺 ${b.need} 个等待帧间（门槛 ${result.refractory}）`,
      };
    }
    return out;
  }
  const { frames } = spec;
  const dec = result._decode;
  const childrenOf = new Map();
  const enabled = result.refractoryEnabled === true;
  const refractory = result.refractory || 0;
  const edges = result.edges.map((e) => {
    const mf = dec(e.from);
    const cf = dec(e.to);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
    const out = {
      fromFrame: mf.t,
      fromId: frames[mf.t][mf.i].id,
      toFrame: cf.t,
      toId: frames[cf.t][cf.i].id,
      gap: e.gap,
      dist: Math.round(e.dist * 100) / 100,
    };
    if (enabled) {
      out.motherAge = e.motherAge;
      out.childAge = e.childAge;
    }
    return out;
  });
  edges.sort((a, b) =>
    a.fromFrame - b.fromFrame ||
    a.toFrame - b.toFrame ||
    String(a.fromId).localeCompare(String(b.fromId)) ||
    String(a.toId).localeCompare(String(b.toId)));

  let divisions = 0;
  for (const list of childrenOf.values()) if (list.length === 2) divisions++;

  const sol = {
    feasible: true,
    totalBrightness: result.totalBrightness,
    skips: result.skips,
    survivors: result.survivors,
    divisions,
    counts: result.usedPerFrame.map((s) => s.length),
    used: result.usedPerFrame.map((list, t) => list.map((i) => frames[t][i].id)),
    edges,
  };

  if (enabled) {
    // 分裂时年龄记在母本斑点上；尚余等待帧间 = 门槛 − 当前分裂年龄（起始为 0）。
    const dividesAt = new Map();
    for (const e of result.edges) {
      if (childrenOf.get(e.from)?.length === 2 && e.gap === 1) {
        dividesAt.set(e.from, e.motherAge);
      }
    }
    sol.refractory = refractory;
    sol.spots = result.usedPerFrame.map((list, t) => list.map((i) => {
      const g = result._gi(t, i);
      const age = result.spotAge.get(g);
      return {
        id: frames[t][i].id,
        generation: result.generation.get(g) ?? 0,
        age,
        wait: age === null ? 0 : Math.max(0, refractory - age),
        divides: dividesAt.has(g),
        divisionAge: dividesAt.has(g) ? dividesAt.get(g) : null,
      };
    }));
    for (const e of edges) {
      const idxInFrame = frames[e.fromFrame].findIndex((s) => s.id === e.fromId);
      const gFrom = result._gi(e.fromFrame, idxInFrame);
      if (childrenOf.get(gFrom)?.length === 2 && e.gap === 1) {
        e.divisionAge = result.spotAge.get(gFrom); // null 表示起始首裂
      } else {
        e.divisionAge = false; // 非分裂行占位
      }
    }
  }

  return sol;
}
