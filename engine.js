'use strict';
/*
 * 资金分配推演引擎（纯逻辑，无 DOM 依赖，可在 Node 中自测）
 *
 * 数据模型：
 *   state = {
 *     pools:    [{ id, name, budget }],
 *     projects: [{ id, name, need, pool, priority, prereqs:[id], mutex:[id] }]
 *   }
 *
 * 每个项目的结论分三层推导，便于增量重判：
 *   1. 资格层 elig     —— 前置关系是否满足（含环检测）
 *   2. 互斥层 mutex    —— 互斥对之间按优先级裁决，双方结论都保留
 *   3. 资金层 fund     —— 同一资金池内按优先级从高到低占用额度
 * 最终 status / reasons 由三层组装而成。
 */

/* ---------- 图算法 ---------- */

// Tarjan 强连通分量，adj: id -> [id]
function tarjanSCC(ids, adj) {
  let counter = 0;
  const index = {}, low = {}, onStack = {}, stack = [], sccs = [];
  function strongconnect(v) {
    index[v] = low[v] = counter++;
    stack.push(v); onStack[v] = true;
    (adj[v] || []).forEach(w => {
      if (index[w] === undefined) { strongconnect(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
    });
    if (low[v] === index[v]) {
      const scc = []; let w;
      do { w = stack.pop(); onStack[w] = false; scc.push(w); } while (w !== v);
      sccs.push(scc);
    }
  }
  ids.forEach(v => { if (index[v] === undefined) strongconnect(v); });
  return sccs;
}

function buildGraph(st) {
  const byId = {};
  st.projects.forEach(p => { byId[p.id] = p; });
  const ids = st.projects.map(p => p.id);
  // 前置边只保留指向存在项目的部分；缺失引用在资格层单独报告
  const prereqs = {};
  ids.forEach(id => { prereqs[id] = (byId[id].prereqs || []).filter(x => byId[x]); });
  const sccs = tarjanSCC(ids, prereqs);
  const cycleOf = {}; // id -> 环成员数组（仅成环节点）
  sccs.forEach(s => {
    const isCycle = s.length > 1 || (s.length === 1 && prereqs[s[0]].indexOf(s[0]) !== -1);
    if (isCycle) s.forEach(id => { cycleOf[id] = s.slice().sort(); });
  });
  // Kahn 拓扑序（排除环节点；依赖环节点的节点仍在序中，资格层会判其不可纳入）
  const dependents = {}, indeg = {};
  ids.forEach(id => { dependents[id] = []; if (!cycleOf[id]) indeg[id] = 0; });
  ids.forEach(id => prereqs[id].forEach(pre => {
    if (cycleOf[id] || cycleOf[pre]) return;
    dependents[pre].push(id); indeg[id]++;
  }));
  const queue = ids.filter(id => !cycleOf[id] && indeg[id] === 0);
  const topo = [];
  while (queue.length) {
    const v = queue.shift(); topo.push(v);
    dependents[v].forEach(w => { if (--indeg[w] === 0) queue.push(w); });
  }
  return { byId, ids, prereqs, cycleOf, topo };
}

function emptyConclusion(id) {
  return { id, cycle: null, elig: false, eligReasons: [], mutex: null,
           fund: null, status: '', statusText: '', cap: 0, reasons: [] };
}

function assemble(c) {
  c.reasons = [];
  if (c.cycle) {
    c.status = 'cycle'; c.statusText = '不可纳入 · 前置成环'; c.cap = 0;
    c.reasons = c.eligReasons.slice();
    return;
  }
  if (!c.elig) {
    c.status = 'prereq'; c.statusText = '不可纳入 · 前置未满足'; c.cap = 0;
    c.reasons = c.eligReasons.slice();
    return;
  }
  c.reasons = c.eligReasons.slice();
  if (c.mutex) c.reasons.push(c.mutex.detail);
  if (c.mutex && !c.mutex.won) {
    c.status = 'mutex'; c.statusText = '冲突 · 互斥让位'; c.cap = 0;
    return;
  }
  if (!c.fund || c.fund.status === 'na') {
    c.status = 'nopool'; c.statusText = '不可纳入 · 资金池缺失'; c.cap = 0;
    c.reasons.push('所属资金池不存在，无法参与分配');
    return;
  }
  c.reasons.push(c.fund.note);
  if (c.fund.status === 'ok') {
    c.status = 'ok'; c.statusText = '可纳入'; c.cap = c.fund.cap;
  } else {
    c.status = 'partial'; c.statusText = '资金不足'; c.cap = c.fund.cap;
  }
}

/*
 * 核心推演：对 scope 内的项目重推三层结论，scope 外项目沿用 base 中的缓存。
 * scope 为 null 表示全量重推。返回 { map, touched, cycleOf }。
 */
function runAnalysis(st, scope, base) {
  const g = buildGraph(st);
  const all = scope === null;
  const sc = all ? new Set(g.ids) : scope;
  const out = {}, touched = new Set();
  g.ids.forEach(id => {
    if (!sc.has(id) && base && base[id]) out[id] = JSON.parse(JSON.stringify(base[id]));
  });
  const ensure = id => { if (!out[id]) out[id] = emptyConclusion(id); return out[id]; };

  // 层 1a：环节点直接判不可纳入
  Object.keys(g.cycleOf).forEach(id => {
    if (!sc.has(id)) return;
    const c = ensure(id); touched.add(id);
    c.cycle = g.cycleOf[id]; c.elig = false;
    c.eligReasons = ['处于前置环，环上项目均不可纳入：' + g.cycleOf[id].join('、')];
  });
  // 层 1b：按拓扑序传播资格结论
  g.topo.forEach(id => {
    if (!sc.has(id)) return;
    const p = g.byId[id], c = ensure(id); touched.add(id);
    c.cycle = null; c.elig = true; c.eligReasons = [];
    (p.prereqs || []).forEach(pre => {
      if (!g.byId[pre]) { c.elig = false; c.eligReasons.push('前置项目 ' + pre + ' 不存在'); }
    });
    g.prereqs[id].forEach(pre => {
      const pc = out[pre];
      if (pc && pc.cycle) { c.elig = false; c.eligReasons.push('前置项目 ' + pre + ' 处于前置环，不可纳入'); }
      else if (pc && !pc.elig) { c.elig = false; c.eligReasons.push('前置项目 ' + pre + ' 不可纳入'); }
    });
    if (c.elig) c.eligReasons.push(g.prereqs[id].length ? '全部前置项目均可纳入' : '无前置约束');
  });

  // 层 2：互斥裁决（声明对称化，双方结论都保留）
  sc.forEach(id => { if (out[id]) { out[id].mutex = null; touched.add(id); } });
  const pairs = {};
  g.ids.forEach(id => (g.byId[id].mutex || []).forEach(m => {
    if (g.byId[m] && m !== id) pairs[[id, m].sort().join('|')] = [id, m].sort();
  }));
  Object.keys(pairs).forEach(k => {
    const a = pairs[k][0], b = pairs[k][1];
    if (!sc.has(a) && !sc.has(b)) return;
    const ca = ensure(a), cb = ensure(b);
    touched.add(a); touched.add(b);
    const aok = ca.elig && !ca.cycle, bok = cb.elig && !cb.cycle;
    if (aok && bok) {
      const pa = g.byId[a].priority, pb = g.byId[b].priority;
      if (pa === pb) {
        ca.mutex = { won: false, peer: b, detail: '与 ' + b + ' 互斥且优先级相同（' + pa + '），系统不自动裁决，双方均暂缓' };
        cb.mutex = { won: false, peer: a, detail: '与 ' + a + ' 互斥且优先级相同（' + pb + '），系统不自动裁决，双方均暂缓' };
      } else {
        const win = pa > pb ? a : b, lose = pa > pb ? b : a;
        ensure(win).mutex = { won: true, peer: lose, detail: '与 ' + lose + ' 互斥，优先级更高（' + Math.max(pa, pb) + ' > ' + Math.min(pa, pb) + '），保留' };
        ensure(lose).mutex = { won: false, peer: win, detail: '与 ' + win + ' 互斥，优先级 ' + Math.min(pa, pb) + ' < ' + Math.max(pa, pb) + '，让位' };
      }
    } else {
      if (aok) ca.mutex = { won: true, peer: b, detail: '互斥方 ' + b + ' 当前不可纳入，不构成本轮冲突' };
      if (bok) cb.mutex = { won: true, peer: a, detail: '互斥方 ' + a + ' 当前不可纳入，不构成本轮冲突' };
    }
  });

  // 层 3：资金池分配（只重算 scope 触及的资金池，整池按优先级重排）
  const poolsById = {};
  st.pools.forEach(p => { poolsById[p.id] = p; });
  const poolsTouched = new Set();
  sc.forEach(id => { if (g.byId[id]) poolsTouched.add(g.byId[id].pool); });
  poolsTouched.forEach(poolId => {
    const members = g.ids.filter(id => g.byId[id].pool === poolId);
    members.forEach(id => { ensure(id).fund = null; touched.add(id); });
    const pool = poolsById[poolId];
    if (!pool) return; // 资金池缺失，assemble 阶段报 nopool
    const cand = members.filter(id => {
      const c = out[id];
      return c.elig && !c.cycle && (!c.mutex || c.mutex.won);
    });
    cand.sort((x, y) => (g.byId[y].priority - g.byId[x].priority) || (x < y ? -1 : 1));
    let remaining = pool.budget;
    const consumers = [];
    cand.forEach(id => {
      const c = out[id], need = g.byId[id].need;
      if (need <= remaining) {
        c.fund = { status: 'ok', cap: need, allocated: need,
                   note: '资金池「' + pool.name + '」剩余充足，按优先级全额保障 ' + need };
        remaining -= need;
        consumers.push(id + '（' + need + '）');
      } else {
        c.fund = { status: 'insufficient', cap: Math.max(0, remaining), allocated: 0,
                   note: '资金池「' + pool.name + '」剩余 ' + Math.max(0, remaining) + ' < 需求 ' + need +
                         (consumers.length ? '；更高优先级已占用：' + consumers.join('、') : '；池内无更高优先级占用') };
      }
    });
    members.forEach(id => { if (!out[id].fund) out[id].fund = { status: 'na', cap: 0, allocated: 0, note: '未进入资金分配' }; });
  });

  touched.forEach(id => { if (out[id]) assemble(out[id]); });
  return { map: out, touched, cycleOf: g.cycleOf };
}

function analyzeAll(st) { return runAnalysis(st, null, null); }

/*
 * 受影响闭包：从变更项目出发，沿约束传播路径扩张——
 * 前置下游、同环成员、互斥伙伴、同资金池成员（含变更前归属），迭代到不动点。
 */
function affectedClosure(changedIds, oldSt, newSt) {
  const affected = new Set(changedIds);
  const g = buildGraph(newSt);
  // 反向前置邻接（允许指向已删除/不存在的 id）
  const dependents = {};
  newSt.projects.forEach(p => (p.prereqs || []).forEach(q => {
    (dependents[q] = dependents[q] || []).push(p.id);
  }));
  const cycles = [];
  Object.keys(g.cycleOf).forEach(id => cycles.push(g.cycleOf[id]));
  let grew = true;
  while (grew) {
    grew = false;
    cycles.forEach(cyc => {
      if (cyc.some(id => affected.has(id)))
        cyc.forEach(id => { if (!affected.has(id)) { affected.add(id); grew = true; } });
    });
    Array.from(affected).forEach(id => (dependents[id] || []).forEach(d => {
      if (!affected.has(d)) { affected.add(d); grew = true; }
    }));
  }
  // 互斥伙伴 + 同池成员（新旧两个状态都考虑），迭代到不动点
  const inEither = id =>
    newSt.projects.some(p => p.id === id) || oldSt.projects.some(p => p.id === id);
  grew = true;
  while (grew) {
    grew = false;
    const add = id => { if (inEither(id) && !affected.has(id)) { affected.add(id); grew = true; } };
    [newSt, oldSt].forEach(st => st.projects.forEach(p => {
      if (affected.has(p.id)) (p.mutex || []).forEach(add);
      else if ((p.mutex || []).some(m => affected.has(m))) add(p.id);
    }));
    const pools = new Set();
    [newSt, oldSt].forEach(st => st.projects.forEach(p => {
      if (affected.has(p.id)) pools.add(p.pool);
    }));
    newSt.projects.forEach(p => { if (pools.has(p.pool)) add(p.id); });
  }
  // 只保留新状态中仍存在的项目
  const alive = new Set(newSt.projects.map(p => p.id));
  return new Set(Array.from(affected).filter(id => alive.has(id)));
}

/* ---------- 示例数据 ---------- */
function sampleState() {
  return {
    pools: [
      { id: 'A', name: '战略池', budget: 500 },
      { id: 'B', name: '运营池', budget: 300 },
      { id: 'C', name: '创新池', budget: 200 }
    ],
    projects: [
      { id: 'P1', name: '核心平台升级', need: 200, pool: 'A', priority: 9, prereqs: [],       mutex: [] },
      { id: 'P2', name: '数据迁移',      need: 120, pool: 'A', priority: 8, prereqs: ['P1'],   mutex: [] },
      { id: 'P3', name: '安全加固',      need: 150, pool: 'A', priority: 7, prereqs: ['P1'],   mutex: [] },
      { id: 'P9', name: '市场推广',      need: 250, pool: 'A', priority: 6, prereqs: [],       mutex: [] },
      { id: 'P4', name: '自建客服系统',  need: 100, pool: 'B', priority: 5, prereqs: [],       mutex: ['P6'] },
      { id: 'P6', name: '外包客服',      need: 90,  pool: 'B', priority: 5, prereqs: [],       mutex: ['P4'] },
      { id: 'P5', name: '现场支持',      need: 80,  pool: 'B', priority: 4, prereqs: [],       mutex: [] },
      { id: 'P7', name: '试验舱甲',      need: 60,  pool: 'C', priority: 4, prereqs: ['P8'],   mutex: [] },
      { id: 'P8', name: '试验舱乙',      need: 60,  pool: 'C', priority: 4, prereqs: ['P7'],   mutex: [] }
    ]
  };
}

/* ---------- 结果一致性比较 ---------- */
function stableStringify(map) {
  return JSON.stringify(Object.keys(map).sort().map(k => [k, map[k]]));
}

const Engine = { tarjanSCC, buildGraph, runAnalysis, analyzeAll, affectedClosure,
                 sampleState, stableStringify, emptyConclusion };
if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
if (typeof window !== 'undefined') window.Engine = Engine;
