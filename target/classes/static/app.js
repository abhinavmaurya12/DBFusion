const $ = s => document.querySelector(s);
const esc = v => String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const api = async (path, opts = {}) => {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const SAMPLE = { sql: 'SELECT 1 AS example', mongo: '{\n  "collection": "your_collection",\n  "filter": {},\n  "limit": 50\n}' };
const PORTS = { postgresql: 5432, mysql: 3306, oracle: 1521, mongodb: 27017 };
const COLORS = ['#5b5bf0', '#14b8a6', '#f59e0b', '#ef4a6b', '#38bdf8', '#a78bfa', '#84cc16', '#94a3b8'];
let meta = [], shown = [];
let conns = [], active = null, tables = [], editor, res = null, sort = null, chart;
let tabs = [{ id: 1, title: 'Query 1', text: SAMPLE.sql }], cur = 1, nextId = 2;
let theme = store.get('theme', 'light');
const isMongo = () => active?.type === 'mongodb';

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  if (window.monaco) monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
}
applyTheme();
if ($('#theme')) $('#theme').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; store.set('theme', theme); applyTheme(); };

// Monaco editor with table-name autocomplete
if (window.require) {
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  $('#fallback')?.remove();
  editor = monaco.editor.create($('#editor'), {
    value: tabs[0].text, language: 'sql', automaticLayout: true, minimap: { enabled: false },
    fontSize: 14, scrollBeyondLastLine: false, theme: theme === 'dark' ? 'vs-dark' : 'vs'
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems(model, pos) {
      const w = model.getWordUntilPosition(pos);
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      return { suggestions: tables.map(t => ({ label: t, kind: monaco.languages.CompletionItemKind.Struct, insertText: t, range })) };
    }
  });
  renderTabs();
});
}

function setStatus(msg, bad) { const s = $('#status'); s.textContent = msg; s.className = 'grow' + (bad ? ' bad' : ''); }
function setText(t) {
  if (!editor) return;
  if (window.monaco) monaco.editor.setModelLanguage(editor.getModel(), isMongo() ? 'json' : 'sql');
  editor.setValue(t);
}

// Query tabs
function renderTabs() {
  const box = $('#qtabs'); box.innerHTML = '';
  tabs.forEach(t => {
    const b = document.createElement('button');
    b.className = 'qt' + (t.id === cur ? ' on' : '');
    b.innerHTML = `<span>${esc(t.title)}</span>${tabs.length > 1 ? '<i class="x" aria-label="Close tab">×</i>' : ''}`;
    b.onclick = () => switchTab(t.id);
    const x = b.querySelector('.x');
    if (x) x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    box.appendChild(b);
  });
}
function saveTab() { const t = tabs.find(t => t.id === cur); if (t && editor) t.text = editor.getValue(); }
function switchTab(id) { saveTab(); cur = id; setText(tabs.find(t => t.id === id).text); renderTabs(); }
function closeTab(id) {
  tabs = tabs.filter(t => t.id !== id);
  if (cur === id) { cur = tabs[0].id; setText(tabs[0].text); } renderTabs();
}
$('#addTab').onclick = () => {
  saveTab(); tabs.push({ id: nextId, title: 'Query ' + nextId, text: isMongo() ? SAMPLE.mongo : SAMPLE.sql });
  cur = nextId++; setText(tabs.at(-1).text); renderTabs();
};

// Connections
function renderConns() {
  const ul = $('#conns');
  ul.innerHTML = conns.length ? '' : '<li class="empty">None yet. Add one to begin.</li>';
  conns.forEach(c => {
    const li = document.createElement('li');
    li.className = c === active ? 'on' : '';
    li.innerHTML = `<span>${esc(c.type)}: ${esc(c.name)}</span><button class="x" title="Disconnect" aria-label="Disconnect">×</button>`;
    li.onclick = () => select(c);
    li.querySelector('.x').onclick = async e => {
      e.stopPropagation();
      await api('/connections/' + c.id, { method: 'DELETE' }).catch(() => {});
      conns = conns.filter(x => x !== c);
      if (active === c) { active = null; tables = []; $('#active').textContent = 'User: none'; $('#active').classList.remove('live'); renderTables(); }
      renderConns();
    };
    ul.appendChild(li);
  });
}
function renderSaved() {
  const ul = $('#saved'), list = store.get('saved', []);
  ul.innerHTML = list.length ? '' : '<li class="empty">Connections you use are saved here (without passwords).</li>';
  list.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(s.type)}: ${esc(s.host)}/${esc(s.database)}</span><button class="x" title="Forget" aria-label="Forget saved connection">×</button>`;
    li.onclick = () => openDialog(s);
    li.querySelector('.x').onclick = e => { e.stopPropagation(); list.splice(i, 1); store.set('saved', list); renderSaved(); };
    ul.appendChild(li);
  });
}
function renderTables() {
  const ul = $('#schema'), f = $('#tfilter').value.toLowerCase();
  const list = tables.filter(t => t.toLowerCase().includes(f));
  if (!active) ul.innerHTML = '<li class="empty">Select a connection.</li>';
  else if (!list.length) ul.innerHTML = '<li class="empty">Nothing to show.</li>';
  else {
    ul.innerHTML = '';
    list.forEach(n => {
      const li = document.createElement('li');
      li.innerHTML = `<span title="${esc(n)}">${esc(n)}</span>`;
      li.onclick = () => browse(n);
      li.ondblclick = () => editor?.trigger('keyboard', 'type', { text: n });
      ul.appendChild(li);
    });
  }
}
$('#tfilter').oninput = renderTables;

async function select(c) {
  active = c; renderConns();
  $('#active').textContent = 'User: ' + (c.user || '').toUpperCase(); $('#active').classList.add('live'); $('#active').title = `${c.type}: ${c.name}`;
  $('#schemaTitle').textContent = isMongo() ? 'Collections' : 'Tables';
  const t = tabs.find(t => t.id === cur);
  if (t && (t.text === SAMPLE.sql || t.text === SAMPLE.mongo)) t.text = isMongo() ? SAMPLE.mongo : SAMPLE.sql;
  setText(t.text);
  try { tables = await api(`/connections/${c.id}/schema`); } catch (e) { tables = []; setStatus(e.message, true); }
  renderTables();
}
async function browse(name) {
  setStatus('Loading ' + name + '…');
  try {
    const u = encodeURIComponent(name);
    const [r, m] = await Promise.all([api(`/connections/${active.id}/preview?table=${u}`), api(`/connections/${active.id}/columns?table=${u}`)]);
    meta = m.columns; show(r); res.table = name; renderGrid();
  } catch (e) { setStatus(e.message, true); }
}

// Running queries
async function run() {
  if (!active) return setStatus('Connect to a database first.', true);
  const sel = editor.getModel().getValueInRange(editor.getSelection());
  const q = sel.trim() ? sel : editor.getValue();
  setStatus('Running…');
  try { show(await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: q }) })); addHistory(q, true); }
  catch (e) { setStatus(e.message, true); addHistory(q, false); }
}
$('#run').onclick = run;

function view() {
  let rows = res.rows; const f = $('#filter').value.toLowerCase();
  if (f) rows = rows.filter(r => r.some(v => v !== null && String(v).toLowerCase().includes(f)));
  if (sort) {
    const { i, d } = sort;
    rows = [...rows].sort((a, b) => {
      const x = a[i], y = b[i];
      if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * d;
    });
  }
  return rows;
}
function show(r) {
  $('#edit').hidden = true; res = r; sort = null; $('#filter').value = '';
  if (r.columns) {
    setStatus(`Finished in ${r.ms} ms`);
    const num = r.columns.map((_, i) => r.rows.length && r.rows.every(row => row[i] === null || typeof row[i] === 'number'));
    $('#clabel').innerHTML = r.columns.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('');
    $('#cvalue').innerHTML = r.columns.map((c, i) => num[i] ? `<option value="${i}">${esc(c)}</option>` : '').join('');
    if (num.includes(true)) $('#clabel').value = Math.max(0, num.findIndex(n => !n));
    renderGrid();
  } else {
    setStatus(`${r.updateCount} rows changed in ${r.ms} ms`);
    $('#table').innerHTML = `<p class="empty">Statement finished. ${r.updateCount} rows changed.</p>`;
    $('#count').textContent = '';
  }
  drawChart();
}
function renderGrid() {
  if (!res?.columns) return;
  const rows = view(), ed = !!res.table; shown = rows;
  $('#count').textContent = `${rows.length} of ${res.rows.length} rows`;
  $('#edit').hidden = !ed; $('#addCol').hidden = isMongo();
  $('#table').innerHTML = '<table><thead><tr>' + (ed ? '<th></th>' : '') + res.columns.map((c, i) =>
    `<th data-i="${i}">${esc(c)}${sort?.i === i ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r, ri) => `<tr data-r="${ri}">` + (ed ? '<td><button class="del">Delete</button></td>' : '') + r.map((v, ci) => v === null ?
      `<td data-c="${ci}"><i>null</i></td>` :
      `<td data-c="${ci}" class="${typeof v === 'number' ? 'n' : ''}" title="${esc(v)}">${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  document.querySelectorAll('th[data-i]').forEach(th => th.onclick = () => {
    const i = +th.dataset.i; sort = { i, d: sort?.i === i ? -sort.d : 1 }; renderGrid();
  });
  if (ed) {
    document.querySelectorAll('td[data-c]').forEach(td => td.ondblclick = () => editCell(td));
    document.querySelectorAll('.del').forEach(b => b.onclick = () => delRow(shown[+b.closest('tr').dataset.r]));
  }
}

// ---- Editing ----
const mut = (method, path, body) => api(`/connections/${active.id}${path}`, { method, body: JSON.stringify(body) });
const reload = () => browse(res.table);
async function refreshTables() { tables = await api(`/connections/${active.id}/schema`); renderTables(); }
function keyOf(row) {
  const pk = meta.filter(c => c.pk).map(c => c.name), cols = pk.length ? pk : res.columns;
  return Object.fromEntries(cols.map(c => [c, row[res.columns.indexOf(c)]]));
}
function editCell(td) {
  const row = shown[+td.parentNode.dataset.r], ci = +td.dataset.c, old = row[ci];
  const inp = document.createElement('input'); inp.value = old ?? ''; td.innerHTML = ''; td.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    if (!save || inp.value === String(old ?? '')) return renderGrid();
    try { await mut('PUT', '/rows', { table: res.table, key: keyOf(row), values: { [res.columns[ci]]: inp.value } }); setStatus('Row updated.'); await reload(); }
    catch (e) { setStatus(e.message, true); renderGrid(); }
  };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
async function delRow(row) {
  if (!confirm('Delete this row? This cannot be undone.')) return;
  try { await mut('POST', '/rows/delete', { table: res.table, key: keyOf(row) }); setStatus('Row deleted.'); await reload(); }
  catch (e) { setStatus(e.message, true); }
}
const d2 = $('#d2'), d2f = $('#d2f');
function ask(title, html, ok) {
  $('#d2t').textContent = title; $('#d2b').innerHTML = html; $('#d2e').textContent = ''; d2.showModal();
  d2f.onsubmit = async e => {
    e.preventDefault();
    try { await ok(new FormData(d2f)); d2.close(); } catch (err) { $('#d2e').textContent = err.message; }
  };
}
$('#d2c').onclick = () => d2.close();
const TYPES = { postgresql: ['INTEGER', 'BIGINT', 'TEXT', 'VARCHAR(255)', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'NUMERIC(10,2)'],
  mysql: ['INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'DATE', 'DATETIME', 'DECIMAL(10,2)', 'BOOLEAN'],
  oracle: ['NUMBER', 'VARCHAR2(255)', 'DATE', 'TIMESTAMP', 'CLOB'] };
const dl = () => `<datalist id="types">${(TYPES[active.type] || []).map(t => `<option value="${t}">`).join('')}</datalist>`;
const colRow = i => `<div class="row"><input name="cn" placeholder="Column name"><input name="ct" list="types" placeholder="Type"><label class="chk"><input type="checkbox" name="pk${i}"> Key</label></div>`;

$('#addRow').onclick = () => {
  if (isMongo()) return ask('Add document', '<label>Document (JSON)<textarea name="doc" rows="8">{\n  \n}</textarea></label>',
    async f => { await mut('POST', '/rows', { table: res.table, values: JSON.parse(f.get('doc')) }); await reload(); });
  ask('Add row', '<p class="empty">Leave a field empty to use its default or null.</p>' + meta.map(c =>
    `<label>${esc(c.name)} <small>(${esc(c.type)}${c.pk ? ', key' : ''})</small><input name="${esc(c.name)}"></label>`).join(''),
    async f => {
      const values = {}; meta.forEach(c => { const v = f.get(c.name); if (v !== '') values[c.name] = v; });
      await mut('POST', '/rows', { table: res.table, values }); setStatus('Row added.'); await reload();
    });
};
$('#addCol').onclick = () => ask('Add column', dl() + '<label>Column name <input name="name" required></label><label>Type <input name="type" list="types" required></label>',
  async f => { await mut('POST', '/addcolumn', { table: res.table, name: f.get('name').trim(), type: f.get('type').trim() }); setStatus('Column added.'); await reload(); });
$('#dropT').onclick = async () => {
  if (!confirm(`Drop ${res.table} and all its data? This cannot be undone.`)) return;
  try {
    await mut('POST', '/tables/drop', { table: res.table });
    res = null; $('#edit').hidden = true; $('#table').innerHTML = '<p class="empty">Table dropped.</p>'; $('#count').textContent = '';
    await refreshTables();
  } catch (e) { setStatus(e.message, true); }
};
$('#newTable').onclick = () => {
  if (!active) return setStatus('Connect to a database first.', true);
  const mongo = isMongo(); let n = 3;
  ask(mongo ? 'New collection' : 'New table', '<label>Name <input name="name" required></label>' +
    (mongo ? '' : dl() + colRow(0) + colRow(1) + colRow(2) + '<button type="button" id="moreCol">Add another column</button>'),
    async f => {
      const types = f.getAll('ct');
      const cols = f.getAll('cn').map((name, i) => ({ name: name.trim(), type: types[i].trim(), pk: f.has('pk' + i) })).filter(c => c.name);
      const name = f.get('name').trim();
      await api(`/connections/${active.id}/tables`, { method: 'POST', body: JSON.stringify({ name, columns: cols }) });
      await refreshTables(); const t = tables.find(x => x.toLowerCase() === name.toLowerCase()); if (t) browse(t);
    });
  $('#moreCol')?.addEventListener('click', e => e.target.insertAdjacentHTML('beforebegin', colRow(n++)));
};

$('#filter').oninput = renderGrid;

// Chart
function drawChart() {
  if (!window.Chart) return;
  if (chart) chart.destroy();
  const box = $('.cbox'); box.querySelector('p')?.remove();
  if (!res?.columns || !res.rows.length) return;
  if (!$('#cvalue').options.length) { box.insertAdjacentHTML('afterbegin', '<p class="empty">Charts need at least one numeric column.</p>'); return; }
  const li = +$('#clabel').value, vi = +$('#cvalue').value, type = $('#ctype').value;
  const rows = view().slice(0, 200), pie = type === 'pie' || type === 'doughnut';
  chart = new Chart(box.querySelector('canvas'), {
    type,
    data: { labels: rows.map(r => r[li]), datasets: [{ label: res.columns[vi], data: rows.map(r => r[vi]),
      backgroundColor: pie ? rows.map((_, i) => COLORS[i % COLORS.length]) : '#5b5bf0', borderColor: '#5b5bf0' }] },
    options: { maintainAspectRatio: false, responsive: true }
  });
}
['#ctype', '#clabel', '#cvalue'].forEach(s => $(s).onchange = drawChart);

// Export
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
$('#csv').onclick = () => {
  if (!res?.columns) return setStatus('Run a query first.', true);
  const q = v => v === null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
  download('results.csv', [res.columns, ...view()].map(r => r.map(q).join(',')).join('\n'), 'text/csv');
};
$('#json').onclick = () => {
  if (!res?.columns) return setStatus('Run a query first.', true);
  download('results.json', JSON.stringify(view().map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))), null, 2), 'application/json');
};

// History
function addHistory(q, ok) {
  const h = store.get('history', []); h.unshift({ q, ok, t: new Date().toLocaleTimeString(), c: active?.name });
  store.set('history', h.slice(0, 50)); renderHistory();
}
function renderHistory() {
  const h = store.get('history', []), box = $('#history');
  box.innerHTML = h.length ? '<div class="hist"><button id="clearH">Clear history</button></div>' : '<p class="empty">Queries you run appear here. Click one to reuse it.</p>';
  h.forEach(x => {
    const d = document.createElement('div');
    d.className = 'hist' + (x.ok ? '' : ' fail');
    d.innerHTML = `<small>${esc(x.t)}</small><span title="${esc(x.q)}">${esc(x.q.replace(/\s+/g, ' '))}</span>`;
    d.onclick = () => { editor.setValue(x.q); };
    box.appendChild(d);
  });
  $('#clearH')?.addEventListener('click', () => { store.set('history', []); renderHistory(); });
}

// Result tabs and splitter
document.querySelectorAll('.rtabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.rtabs button').forEach(x => x.classList.toggle('on', x === b));
  ['table', 'chart', 'history', 'output'].forEach(p => $('#' + p).hidden = b.dataset.tab !== p);
  if (b.dataset.tab === 'chart') drawChart();
});
$('#split').onmousedown = e => {
  e.preventDefault();
  const move = ev => { $('#editor').style.flexBasis = Math.min(Math.max(100, ev.clientY - $('#editor').getBoundingClientRect().top), innerHeight * 0.7) + 'px'; };
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
};

// Connection dialog
const dlg = $('#dlg'), form = $('#form');
function syncForm() {
  $('#uriRow').hidden = form.type.value !== 'mongodb';
  $('#dbLabel').textContent = form.type.value === 'oracle' ? 'Service name' : 'Database';
}
form.type.onchange = () => { form.port.value = PORTS[form.type.value]; syncForm(); };
function openDialog(s) {
  if (s) { form.type.value = s.type; form.host.value = s.host; form.port.value = s.port ?? PORTS[s.type]; form.database.value = s.database; form.username.value = s.username || ''; form.password.value = ''; }
  syncForm(); $('#err').textContent = ''; dlg.showModal();
}
$('#newConn').onclick = () => openDialog();
$('#cancel').onclick = () => dlg.close();
form.onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  body.port = body.port ? Number(body.port) : null;
  $('#err').textContent = 'Connecting…';
  try {
    const c = await api('/connect', { method: 'POST', body: JSON.stringify(body) });
    c.user = body.username; conns.push(c);
    const { password, uri, ...keep } = body;
    const list = store.get('saved', []).filter(s => !(s.type === keep.type && s.host === keep.host && s.port === keep.port && s.database === keep.database && s.username === keep.username));
    store.set('saved', [keep, ...list].slice(0, 8)); renderSaved();
    dlg.close(); await select(c);
  } catch (err) { $('#err').textContent = err.message; }
};
renderSaved(); renderHistory();

// Plain text fallback if the Monaco editor cannot load (for example, no internet access to the CDN)
setTimeout(() => {
  if (editor) return;
  const ta = document.createElement('textarea'); ta.id = 'fallback'; ta.value = tabs.find(t => t.id === cur).text;
  ta.style.cssText = 'width:100%;height:100%;margin:0;border:0;resize:none'; $('#editor').appendChild(ta);
  ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
  editor = { getValue: () => ta.value, setValue: v => { ta.value = v; }, getSelection: () => null,
    getModel: () => ({ getValueInRange: () => ta.value.slice(ta.selectionStart, ta.selectionEnd) }),
    trigger: (a, b, o) => ta.setRangeText(o.text, ta.selectionStart, ta.selectionEnd, 'end') };
  renderTabs(); setStatus('The code editor could not load, so a plain text box is shown. Check your internet connection.', true);
}, 7000);

// ---- Express-style shell: pages, breadcrumbs, administration ----
const ADMIN = {
  oracle: {
    storage: "SELECT tablespace_name, ROUND(SUM(bytes)/1048576,1) AS allocated_mb FROM dba_data_files GROUP BY tablespace_name ORDER BY 1",
    memory: "SELECT name, value, isdefault FROM v$parameter WHERE name IN ('sga_target','sga_max_size','pga_aggregate_target','shared_pool_size','db_cache_size') ORDER BY name",
    users: "SELECT username, account_status, created, default_tablespace FROM dba_users ORDER BY username",
    monitor: "SELECT username, status, osuser, machine, program, logon_time FROM v$session WHERE username IS NOT NULL ORDER BY logon_time DESC",
    about: "SELECT banner AS information FROM v$version"
  },
  postgresql: {
    storage: "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database ORDER BY 1",
    memory: "SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size')",
    users: "SELECT usename AS username, usesuper AS superuser, valuntil FROM pg_user ORDER BY 1",
    monitor: "SELECT pid, usename, state, query FROM pg_stat_activity ORDER BY pid",
    about: "SELECT version() AS information"
  },
  mysql: {
    storage: "SELECT table_schema AS name, ROUND(SUM(data_length+index_length)/1048576,1) AS size_mb FROM information_schema.tables GROUP BY table_schema",
    memory: "SHOW VARIABLES LIKE '%buffer_size'",
    users: "SELECT user AS username, host FROM mysql.user",
    monitor: "SHOW FULL PROCESSLIST",
    about: "SELECT version() AS information"
  }
};
const NAMES = { storage: 'Storage', memory: 'Memory', users: 'Database Users', monitor: 'Monitor', about: 'About Database' };
const PAGES = { home: ['Home'], admin: ['Home', 'Administration'], browser: ['Home', 'Object Browser'], sql: ['Home', 'SQL', 'SQL Commands'] };

function crumb(parts, page) {
  $('#crumbs').innerHTML = parts.map((p, i) => i === 0 ? (parts.length > 1 ? '<a href="#" data-p="home">Home</a>' : '<b>Home</b>') :
    i < parts.length - 1 ? `<a href="#" data-p="${page}">${esc(p)}</a>` : `<b>${esc(p)}</b>`).join(' &gt; ');
}
function go(p, extra) {
  document.querySelectorAll('.page').forEach(x => x.hidden = x.id !== 'p-' + p);
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.p === p));
  if (p === 'browser' || p === 'sql') $('#p-' + p + ' .slot').appendChild($('#results'));
  crumb(extra ? [...PAGES[p], extra] : PAGES[p], p);
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-p]'); if (a) { e.preventDefault(); go(a.dataset.p); }
});

const gridHtml = r => r.columns
  ? '<div class="scroll"><table><thead><tr>' + r.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    r.rows.map(row => '<tr>' + row.map(v => v === null ? '<td><i>null</i></td>' : `<td>${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>'
  : `<p class="empty">${r.updateCount} rows changed.</p>`;

const APP = { name: 'DBFusion', version: 'vr.1.1.2' };
async function about() {
  const box = $('#adminResult'); go('admin', NAMES.about);
  const lines = [`${APP.name} Database System ${APP.version}`, 'Engines: PostgreSQL, MySQL, Oracle, MongoDB',
    `Workbench Core ${APP.version} - Production`, 'Connection layer: REST API (/api)',
    'Tools: SQL editor, object browser, charts, CSV/JSON export, query history'];
  let live = 'No active connection. Connect to a database to see its server version.';
  if (active) {
    live = `Connected: <b>${esc(active.type)}</b> / ${esc(active.name)}`;
    const q = (ADMIN[active.type] || {}).about;
    if (q) try { const r = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: q }) }); live += `<br>Server: <b>${esc(r.rows[0].slice(0, 2).filter(Boolean).join(' '))}</b>`; } catch {}
  }
  box.innerHTML = `<div class="about"><div class="hd"><span class="mark">DB</span><div><b>${APP.name}</b><small>${APP.version}</small></div></div><pre>${lines.map(esc).join('\n')}</pre><div class="live">${live}</div></div>`;
  setStatus('');
}
async function admin(key) {
  const box = $('#adminResult');
  if (key === 'about') return about();
  if (!active) return setStatus('Connect to a database first (Home).', true);
  const q = (ADMIN[active.type] || {})[key];
  if (!q) { box.innerHTML = '<p class="empty">Not available for MongoDB.</p>'; return; }
  go('admin', NAMES[key]);
  try {
    const r = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: q }) });
    box.innerHTML = `<h4 class="rt">${NAMES[key]}</h4>` + gridHtml(r); setStatus('');
  } catch (e) {
    box.innerHTML = '';
    setStatus(e.message + (active.type === 'oracle' ? ' (Administration pages need a DBA user such as SYSTEM.)' : ''), true);
  }
}
document.querySelectorAll('.tile').forEach(t => t.onclick = e => { e.preventDefault(); admin(t.dataset.a); });

async function logout() {
  if (!active) return setStatus('You are not connected.', true);
  const c = active;
  await api('/connections/' + c.id, { method: 'DELETE' }).catch(() => {});
  conns = conns.filter(x => x !== c); active = null; tables = [];
  $('#active').textContent = 'User: none'; $('#active').classList.remove('live'); $('#adminResult').innerHTML = '';
  renderConns(); renderTables(); setStatus(''); go('home');
}
$('#logout').onclick = e => { e.preventDefault(); logout(); };
$('#logout2').onclick = e => { e.preventDefault(); logout(); };
$('#tNew').onclick = e => { e.preventDefault(); openDialog(); };
$('#help').onclick = e => {
  e.preventDefault();
  alert('Home: connect to a database.\nAdministration: storage, memory, users, sessions and version.\nObject Browser: open a table, then double-click a cell to edit it.\nSQL Commands: write a statement and press Ctrl+Enter.');
};
$('#tPw').onclick = e => {
  e.preventDefault();
  if (!active) return setStatus('Connect to a database first (Home).', true);
  ask('Change My Password', '<label>New password <input type="password" name="p1" required></label><label>Confirm password <input type="password" name="p2" required></label>', async f => {
    const p = f.get('p1'), u = active.user || '';
    if (p !== f.get('p2')) throw new Error('The passwords do not match.');
    if (/["'\\;]/.test(p)) throw new Error('The password cannot contain quotes, semicolons or backslashes.');
    if (!/^[A-Za-z_][\w$#]*$/.test(u)) throw new Error('The password cannot be changed for this user.');
    const sql = { oracle: `ALTER USER ${u} IDENTIFIED BY "${p}"`, postgresql: `ALTER USER ${u} PASSWORD '${p}'`,
      mysql: `ALTER USER CURRENT_USER() IDENTIFIED BY '${p}'` }[active.type];
    if (!sql) throw new Error('Not available for MongoDB.');
    await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: sql }) });
    setStatus('Password changed.');
  });
};

// After a successful connection, open Administration like the Express home flow
const baseSelect = select;
select = async c => { await baseSelect(c); if (!$('#p-home').hidden) go('admin'); };
go('home');
