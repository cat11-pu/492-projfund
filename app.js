'use strict';
/* 界面层：状态、历史（撤销）、渲染。引擎逻辑全部在 engine.js。 */
(function () {
  const E = window.Engine;
  const clone = o => JSON.parse(JSON.stringify(o));

  let state = E.sampleState();
  let conclusions = E.analyzeAll(state).map;
  let history = [];            // { label, state, conclusions }
  let lastAffected = new Set(Object.keys(conclusions));
  let lastActionLabel = '初始载入（全量推演）';
  let consistencyOk = true;

  const STATUS_ORDER = { cycle: 0, prereq: 1, nopool: 2, mutex: 3, partial: 4, ok: 5 };
  const $ = sel => document.querySelector(sel);

  /* ---------- 变更入口：快照 -> 变更 -> 增量重判 -> 全量校验 ---------- */
  function applyChange(label, mutate) {
    const oldState = clone(state);
    const oldConclusions = conclusions;
    const changedIds = mutate() || [];
    history.push({ label, state: oldState, conclusions: oldConclusions });

    const scope = E.affectedClosure(changedIds, oldState, state);
    const inc = E.runAnalysis(state, scope, oldConclusions);
    const full = E.analyzeAll(state);
    consistencyOk = E.stableStringify(inc.map) === E.stableStringify(full.map);
    conclusions = consistencyOk ? inc.map : full.map; // 校验失败时回退全量，保证展示正确
    if (!consistencyOk) console.warn('增量结果与全量重推不一致，已回退为全量结果');

    lastAffected = inc.touched;
    lastActionLabel = label;
    render();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    state = prev.state;
    conclusions = prev.conclusions; // 结论与依据整体还原，无中间残留
    lastAffected = new Set(Object.keys(conclusions));
    lastActionLabel = '撤销：' + prev.label;
    consistencyOk = true;
    render();
  }

  /* ---------- 编辑操作 ---------- */
  function editProject(id, field, value) {
    applyChange('修改 ' + id + ' 的' + field, () => {
      const p = state.projects.find(x => x.id === id);
      if (!p) return [];
      if (field === '需求') p.need = value;
      else if (field === '优先级') p.priority = value;
      else if (field === '名称') p.name = value;
      else if (field === '资金池') p.pool = value;
      else if (field === '前置') p.prereqs = value;
      else if (field === '互斥') p.mutex = value;
      return [id];
    });
  }

  function addProject() {
    let n = state.projects.length + 1;
    while (state.projects.some(p => p.id === 'P' + n)) n++;
    const id = 'P' + n;
    applyChange('新增项目 ' + id, () => {
      state.projects.push({ id, name: '新项目' + id, need: 50,
        pool: state.pools[0] ? state.pools[0].id : '', priority: 1, prereqs: [], mutex: [] });
      return [id];
    });
  }

  function deleteProject(id) {
    applyChange('删除项目 ' + id, () => {
      state.projects = state.projects.filter(p => p.id !== id);
      return [id];
    });
  }

  function editPool(id, field, value) {
    applyChange('修改资金池 ' + id + ' 的' + field, () => {
      const pool = state.pools.find(x => x.id === id);
      if (!pool) return [];
      if (field === '名称') pool.name = value;
      else if (field === '额度') pool.budget = value;
      return state.projects.filter(p => p.pool === id).map(p => p.id);
    });
  }

  function addPool() {
    let n = state.pools.length + 1;
    const ids = state.pools.map(p => p.id);
    let code = 'A';
    while (ids.indexOf(code) !== -1) code = String.fromCharCode(code.charCodeAt(0) + 1);
    applyChange('新增资金池 ' + code, () => {
      state.pools.push({ id: code, name: '资金池' + code, budget: 100 });
      return [];
    });
  }

  function deletePool(id) {
    applyChange('删除资金池 ' + id, () => {
      state.pools = state.pools.filter(p => p.id !== id);
      return state.projects.filter(p => p.pool === id).map(p => p.id);
    });
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fund-allocation.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.pools) || !Array.isArray(data.projects)) throw new Error('bad shape');
        applyChange('导入 JSON（' + file.name + '）', () => {
          const oldIds = state.projects.map(p => p.id);
          state = data;
          return oldIds.concat(data.projects.map(p => p.id));
        });
      } catch (e) {
        alert('导入失败：文件不是有效的推演数据 JSON');
      }
    };
    reader.readAsText(file);
  }

  function resetSample() {
    applyChange('恢复示例数据', () => {
      const oldIds = state.projects.map(p => p.id);
      state = E.sampleState();
      return oldIds.concat(state.projects.map(p => p.id));
    });
  }

  /* ---------- 渲染 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderPools() {
    const used = {}, remaining = {};
    state.pools.forEach(p => { used[p.id] = 0; });
    state.projects.forEach(p => {
      const c = conclusions[p.id];
      if (c && c.fund && used[p.pool] !== undefined) used[p.pool] += c.fund.allocated;
    });
    $('#pools').innerHTML = state.pools.map(pool => {
      const rem = pool.budget - (used[pool.id] || 0);
      const pct = pool.budget > 0 ? Math.min(100, (used[pool.id] || 0) / pool.budget * 100) : 0;
      return '<div class="pool-card">' +
        '<div class="pool-head">' +
          '<span class="pool-id">' + esc(pool.id) + '</span>' +
          '<input class="pool-name" data-pool="' + esc(pool.id) + '" value="' + esc(pool.name) + '">' +
          '<button class="btn danger small" data-delpool="' + esc(pool.id) + '">删除</button>' +
        '</div>' +
        '<div class="pool-body">额度 <input type="number" class="pool-budget" data-pool="' + esc(pool.id) + '" value="' + pool.budget + '">' +
        ' 已占 ' + (used[pool.id] || 0) + ' 剩余 <b>' + rem + '</b></div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  function renderProjects() {
    const poolOpts = sel => state.pools.map(p =>
      '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name) + '(' + esc(p.id) + ')</option>').join('');
    $('#projectRows').innerHTML = state.projects.map(p =>
      '<tr>' +
        '<td class="pid">' + esc(p.id) + '</td>' +
        '<td><input data-id="' + esc(p.id) + '" data-field="名称" value="' + esc(p.name) + '"></td>' +
        '<td><input type="number" data-id="' + esc(p.id) + '" data-field="需求" value="' + p.need + '"></td>' +
        '<td><select data-id="' + esc(p.id) + '" data-field="资金池">' + poolOpts(p.pool) + '</select></td>' +
        '<td><input type="number" data-id="' + esc(p.id) + '" data-field="优先级" value="' + p.priority + '"></td>' +
        '<td><input data-id="' + esc(p.id) + '" data-field="前置" placeholder="如 P1,P2" value="' + esc(p.prereqs.join(',')) + '"></td>' +
        '<td><input data-id="' + esc(p.id) + '" data-field="互斥" placeholder="如 P4" value="' + esc(p.mutex.join(',')) + '"></td>' +
        '<td><button class="btn danger small" data-del="' + esc(p.id) + '">删除</button></td>' +
      '</tr>').join('');
  }

  function renderConclusions() {
    const items = Object.keys(conclusions).map(id => ({ c: conclusions[id], p: state.projects.find(x => x.id === id) }))
      .filter(x => x.p);
    items.sort((a, b) => (STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status]) || (a.c.id < b.c.id ? -1 : 1));
    $('#conclusions').innerHTML = items.map(x => {
      const c = x.c, p = x.p;
      const flash = lastAffected.has(c.id) ? ' flash' : '';
      return '<div class="card ' + c.status + flash + '">' +
        '<div class="card-head"><span class="pid">' + esc(c.id) + '</span> ' + esc(p.name) +
        '<span class="badge ' + c.status + '">' + esc(c.statusText) + '</span></div>' +
        '<div class="card-meta">需求 ' + p.need + ' · 优先级 ' + p.priority + ' · 可用资金上限 <b>' + c.cap + '</b></div>' +
        '<ul class="reasons">' + c.reasons.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
      '</div>';
    }).join('');
  }

  function renderCycles() {
    const seen = {}, cycles = [];
    Object.keys(conclusions).forEach(id => {
      const cyc = conclusions[id].cycle;
      if (cyc) { const k = cyc.join('|'); if (!seen[k]) { seen[k] = 1; cycles.push(cyc); } }
    });
    const banner = $('#cycleBanner');
    if (!cycles.length) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.innerHTML = cycles.map(c =>
      '⚠ 检测到前置环：<b>' + esc(c.join(' → ')) + ' → ' + esc(c[0]) + '</b>，环上项目均不可纳入分配').join('<br>');
  }

  function renderConflicts() {
    const byId = {};
    state.projects.forEach(p => { byId[p.id] = p; });
    const pairs = {};
    state.projects.forEach(p => (p.mutex || []).forEach(m => {
      if (byId[m] && m !== p.id) pairs[[p.id, m].sort().join('|')] = [p.id, m].sort();
    }));
    let html = '';
    Object.keys(pairs).forEach(k => {
      const a = pairs[k][0], b = pairs[k][1];
      const ca = conclusions[a], cb = conclusions[b];
      if (!ca || !cb) return;
      const inConflict = (ca.mutex && !ca.mutex.won) || (cb.mutex && !cb.mutex.won);
      if (!inConflict) return;
      html += '<div class="conflict"><div class="conflict-title">互斥冲突：' + esc(a) + ' ⚡ ' + esc(b) + '</div>' +
        [a, b].map(id => {
          const c = conclusions[id], p = byId[id];
          return '<div class="conflict-side"><span class="badge ' + c.status + '">' + esc(c.statusText) + '</span> ' +
            '<b>' + esc(id) + '</b> ' + esc(p.name) + '（优先级 ' + p.priority + '）—— ' +
            esc(c.mutex ? c.mutex.detail : '') + '</div>';
        }).join('') + '</div>';
    });
    Object.keys(conclusions).forEach(id => {
      const c = conclusions[id];
      if (c.status !== 'partial') return;
      const p = byId[id];
      html += '<div class="conflict"><div class="conflict-title">资金冲突：' + esc(id) + '</div>' +
        '<div class="conflict-side"><span class="badge partial">资金不足</span> <b>' + esc(id) + '</b> ' +
        esc(p.name) + '（需求 ' + p.need + '，可用上限 ' + c.cap + '）—— ' + esc(c.fund.note) + '</div></div>';
    });
    $('#conflicts').innerHTML = html || '<div class="muted">当前没有互斥或资金冲突。</div>';
  }

  function renderHeader() {
    const undoBtn = $('#undoBtn');
    undoBtn.disabled = history.length === 0;
    undoBtn.textContent = history.length ? '撤销（' + history[history.length - 1].label + '）' : '撤销';
    const badge = $('#consistencyBadge');
    badge.textContent = consistencyOk ? '增量重判 = 全量重推 ✓' : '增量校验失败，已回退全量 ✗';
    badge.className = 'consistency ' + (consistencyOk ? 'ok' : 'bad');
    const affected = Array.from(lastAffected).sort();
    $('#lastAction').textContent = '最近操作：' + lastActionLabel +
      '；本次重判 ' + affected.length + ' 个项目' +
      (affected.length ? '（' + affected.join('、') + '），其余结论沿用上轮缓存' : '');
  }

  function render() {
    renderHeader();
    renderCycles();
    renderPools();
    renderProjects();
    renderConclusions();
    renderConflicts();
  }

  /* ---------- 事件 ---------- */
  function parseIdList(v) {
    return v.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#projectRows').addEventListener('change', ev => {
      const t = ev.target;
      const id = t.getAttribute('data-id'), field = t.getAttribute('data-field');
      if (!id || !field) return;
      let value = t.value.trim();
      if (field === '需求' || field === '优先级') value = Math.max(0, Number(value) || 0);
      if (field === '前置' || field === '互斥') value = parseIdList(value);
      editProject(id, field, value);
    });
    $('#pools').addEventListener('change', ev => {
      const t = ev.target, id = t.getAttribute('data-pool');
      if (!id) return;
      if (t.classList.contains('pool-budget')) editPool(id, '额度', Math.max(0, Number(t.value) || 0));
      else if (t.classList.contains('pool-name')) editPool(id, '名称', t.value.trim());
    });
    document.body.addEventListener('click', ev => {
      const t = ev.target;
      if (t.getAttribute && t.getAttribute('data-del')) deleteProject(t.getAttribute('data-del'));
      else if (t.getAttribute && t.getAttribute('data-delpool')) deletePool(t.getAttribute('data-delpool'));
    });
    $('#undoBtn').addEventListener('click', undo);
    $('#addProjectBtn').addEventListener('click', addProject);
    $('#addPoolBtn').addEventListener('click', addPool);
    $('#exportBtn').addEventListener('click', exportJSON);
    $('#resetBtn').addEventListener('click', resetSample);
    $('#importFile').addEventListener('change', ev => {
      if (ev.target.files[0]) importJSON(ev.target.files[0]);
      ev.target.value = '';
    });
    render();
  });
})();
