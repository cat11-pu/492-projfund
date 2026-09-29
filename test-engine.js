'use strict';
const E = require('./engine.js');
const clone = o => JSON.parse(JSON.stringify(o));

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
}

/* 1. 示例数据的基础结论 */
{
  const r = E.analyzeAll(E.sampleState());
  check(r.map.P7.status === 'cycle' && r.map.P8.status === 'cycle', 'P7/P8 应判为环');
  check(r.map.P4.status === 'mutex' && r.map.P6.status === 'mutex', 'P4/P6 同优先级互斥应双方保留');
  check(r.map.P9.status === 'partial' && r.map.P9.cap === 30, 'P9 资金不足上限应为 30');
  check(r.map.P1.status === 'ok' && r.map.P1.cap === 200, 'P1 应全额可纳入');
}

/* 2. 随机变更下 增量 == 全量 */
function randomEdit(st, rng) {
  const ids = st.projects.map(p => p.id);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const kind = Math.floor(rng() * 8);
  const changed = [];
  if (kind === 0 && ids.length) {            // 改需求
    const p = pick(st.projects); p.need = Math.floor(rng() * 300); changed.push(p.id);
  } else if (kind === 1 && ids.length) {     // 改优先级
    const p = pick(st.projects); p.priority = Math.floor(rng() * 10); changed.push(p.id);
  } else if (kind === 2 && ids.length) {     // 改前置
    const p = pick(st.projects);
    p.prereqs = rng() < 0.4 ? [] : [pick(ids), pick(ids)].filter((v, i, a) => a.indexOf(v) === i);
    changed.push(p.id);
  } else if (kind === 3 && ids.length) {     // 改互斥
    const p = pick(st.projects);
    p.mutex = rng() < 0.5 ? [] : [pick(ids)];
    changed.push(p.id);
  } else if (kind === 4 && ids.length) {     // 换资金池
    const p = pick(st.projects); p.pool = pick(st.pools).id; changed.push(p.id);
  } else if (kind === 5) {                   // 改池预算
    const pool = pick(st.pools); pool.budget = Math.floor(rng() * 600);
    changed.push(...st.projects.filter(p => p.pool === pool.id).map(p => p.id));
  } else if (kind === 6 && ids.length > 2) { // 删项目
    const victim = pick(st.projects);
    st.projects = st.projects.filter(p => p.id !== victim.id);
    changed.push(victim.id);
  } else {                                   // 加项目
    const id = 'X' + Math.floor(rng() * 100000);
    st.projects.push({ id, name: id, need: Math.floor(rng() * 200),
      pool: pick(st.pools).id, priority: Math.floor(rng() * 10),
      prereqs: rng() < 0.5 ? [pick(ids)] : [], mutex: rng() < 0.3 ? [pick(ids)] : [] });
    changed.push(id);
  }
  return changed;
}

let seed = 20260930;
const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let state = E.sampleState();
let conclusions = E.analyzeAll(state).map;
for (let step = 0; step < 2000; step++) {
  const oldState = clone(state);
  const changed = randomEdit(state, rng);
  const scope = E.affectedClosure(changed, oldState, state);
  const inc = E.runAnalysis(state, scope, conclusions);
  const full = E.analyzeAll(state);
  check(E.stableStringify(inc.map) === E.stableStringify(full.map),
    '第 ' + step + ' 步增量与全量不一致, changed=' + changed.join(','));
  conclusions = full.map; // 以全量为准继续，等价于界面里的回退策略
  if (failures > 5) break;
}
console.log(failures === 0 ? '全部通过：示例结论正确，2000 步随机变更增量==全量' : ('失败 ' + failures + ' 处'));
process.exit(failures === 0 ? 0 : 1);
