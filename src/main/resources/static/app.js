// DBFusion vr.1.5.0 - main workbench: connections, SQL worksheets, results, browser editing, administration
const $ = s => document.querySelector(s);
const esc = v => String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const api = async (path, opts = {}) => {
  let r;
  try { r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts }); }
  catch { throw new Error('Cannot reach the DBFusion server. Is it still running?'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const SAMPLE = { sql: 'SELECT 1 AS example', mongo: '{\n  "collection": "your_collection",\n  "filter": {},\n  "limit": 50\n}' };
const PORTS = { postgresql: 5432, mysql: 3306, oracle: 1521, mongodb: 27017 };
const COLORS = ['#5b5bf0', '#14b8a6', '#f59e0b', '#ef4a6b', '#38bdf8', '#a78bfa', '#84cc16', '#94a3b8'];
const SQL_WORDS = ('SELECT FROM WHERE GROUP BY ORDER HAVING JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AND OR NOT IN IS NULL LIKE BETWEEN EXISTS DISTINCT AS CASE WHEN THEN ELSE END ASC DESC LIMIT OFFSET FETCH FIRST ROWS ONLY UNION ALL INTERSECT MINUS EXCEPT '
  + 'INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TRUNCATE TABLE VIEW INDEX SEQUENCE TRIGGER PROCEDURE FUNCTION PACKAGE GRANT REVOKE COMMIT ROLLBACK SAVEPOINT WITH PRIMARY KEY FOREIGN REFERENCES DEFAULT CHECK UNIQUE '
  + 'COUNT SUM AVG MIN MAX COALESCE NVL CAST CONCAT UPPER LOWER SUBSTR LENGTH TRIM ROUND TO_CHAR TO_DATE SYSDATE DUAL').split(' ');
let meta = [], shown = [];
let conns = [], active = null, tables = [], editor, fbTa = null, res = null, sort = null, chart, selCell = null;
let tabs = store.get('tabs', null), cur = store.get('curTab', 1), nextId = 2;
if (!Array.isArray(tabs) || !tabs.length) { tabs = [{ id: 1, title: 'Query 1', text: SAMPLE.sql }]; cur = 1; }
if (!tabs.some(t => t.id === cur)) cur = tabs[0].id;
nextId = Math.max(...tabs.map(t => t.id)) + 1;
let theme = store.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
let running = false, runClock = null, errDeco = [], colCache = {}, lastRows = null;
const isMongo = () => active?.type === 'mongodb';

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  if (window.monaco) monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  if ($('#theme')) $('#theme').textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
}
applyTheme();
$('#theme').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; store.set('theme', theme); applyTheme(); drawChart(); };

// ---------------------------------------------------------------- status toast
let stTimer;
function setStatus(msg, bad) {
  const s = $('#status'); s.textContent = msg || ''; s.className = 'grow' + (bad ? ' bad' : '');
  $('#msg').classList.toggle('show', !!msg);
  clearTimeout(stTimer);
  if (msg) stTimer = setTimeout(() => setStatus(''), bad ? 20000 : 4500);
}
$('#msg').onclick = () => setStatus('');
function setText(t) {
  if (!editor) return;
  if (window.monaco && editor.getModel?.()) monaco.editor.setModelLanguage(editor.getModel(), isMongo() ? 'json' : 'sql');
  editor.setValue(t);
}

// ---------------------------------------------------------------- Monaco editor
const cursorOffset = () => {
  try { if (fbTa) return fbTa.selectionStart; return editor.getModel().getOffsetAt(editor.getPosition()); } catch { return 0; }
};
const selectedText = () => { try { return editor.getModel().getValueInRange(editor.getSelection()) || ''; } catch { return ''; } };
const selectionStart = () => {
  try { if (fbTa) return fbTa.selectionStart; return editor.getModel().getOffsetAt(editor.getSelection().getStartPosition()); } catch { return 0; }
};
function aliasMap(text) {
  const map = {}, re = /\b(?:from|join|update|into)\s+([A-Za-z0-9_$#."]+)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_$#]*))?/gi;
  const stop = /^(where|on|set|inner|left|right|full|cross|join|group|order|having|union|values|using|natural|limit|fetch|select)$/i;
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].replace(/"/g, '').split('.').pop();
    map[t.toLowerCase()] = t;
    if (m[2] && !stop.test(m[2])) map[m[2].toLowerCase()] = t;
  }
  return map;
}
async function columnsOf(t) {
  const real = tables.find(x => x.toLowerCase() === t.toLowerCase());
  if (!real || !active) return [];
  const key = active.id + ':' + real;
  if (!colCache[key]) colCache[key] = api(`/connections/${active.id}/columns?table=${encodeURIComponent(real)}`).then(r => r.columns).catch(() => []);
  return colCache[key];
}
if (window.require) {
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    $('#fallback')?.remove(); fbTa = null;
    editor = monaco.editor.create($('#editor'), {
      value: tabs.find(t => t.id === cur).text, language: 'sql', automaticLayout: true, minimap: { enabled: false },
      fontSize: 14, fontFamily: 'JetBrains Mono, Consolas, monospace', scrollBeyondLastLine: false, renderLineHighlight: 'all',
      smoothScrolling: true, cursorSmoothCaretAnimation: 'on', padding: { top: 8 }, theme: theme === 'dark' ? 'vs-dark' : 'vs'
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run('current'));
    editor.addCommand(monaco.KeyCode.F5, () => run('script'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => run('script'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, formatSql);
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyK, openPalette);
    editor.onDidChangeModelContent(() => { saveTab(); persist(); });
    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, pos) {
        const w = model.getWordUntilPosition(pos);
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        const K = monaco.languages.CompletionItemKind, line = model.getLineContent(pos.lineNumber).slice(0, w.startColumn - 1);
        const dot = /([A-Za-z0-9_$#"]+)\.$/.exec(line);
        if (dot) {
          const t = aliasMap(model.getValue())[dot[1].replace(/"/g, '').toLowerCase()] || dot[1];
          const cols = await columnsOf(t);
          return { suggestions: cols.map(c => ({ label: c.name, kind: K.Field, detail: c.type + (c.pk ? ' (key)' : ''), insertText: c.name, range })) };
        }
        const s = tables.map(t => ({ label: t, kind: K.Struct, detail: isMongo() ? 'collection' : 'table', insertText: t, range }));
        if (!isMongo()) SQL_WORDS.forEach(k => s.push({ label: k, kind: K.Keyword, insertText: k, range }));
        return { suggestions: s };
      }
    });
    renderTabs();
  });
}

// ---------------------------------------------------------------- SQL formatter (SELECT/DML only; PL/SQL is left alone)
function formatSql() {
  if (!editor) return;
  const sel = selectedText(), src = sel.trim() ? sel : editor.getValue();
  if (/^\s*(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type))/i.test(src) || isMongo()) return setStatus('Formatting is for SELECT, INSERT, UPDATE and DELETE statements.', true);
  const parts = src.split(/('(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/)/);
  const kw = /\b(select|from|where|group by|order by|having|union all|union|intersect|minus|except|limit|offset|fetch first|rows only|left outer join|right outer join|full outer join|inner join|left join|right join|full join|cross join|join|on|and|or|not|in|is|null|like|between|exists|distinct|as|case|when|then|else|end|asc|desc|insert into|values|update|set|delete from|with)\b/gi;
  const out = parts.map((p, i) => {
    if (i % 2) return p;
    let t = p.replace(/[ \t\r\n]+/g, ' ').replace(kw, m => m.toUpperCase());
    t = t.replace(/\bBETWEEN\s+(\S+)\s+AND\b/g, 'BETWEEN $1 \u0001');
    t = t.replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|UNION ALL|UNION|INTERSECT|MINUS|EXCEPT|LIMIT|OFFSET|FETCH FIRST|LEFT OUTER JOIN|RIGHT OUTER JOIN|FULL OUTER JOIN|INNER JOIN|LEFT JOIN|RIGHT JOIN|FULL JOIN|CROSS JOIN|JOIN|VALUES|SET)\b/g, '\n$1');
    t = t.replace(/\s+(AND|OR)\b/g, '\n  $1').replace(/\u0001/g, 'AND');
    return t;
  }).join('').replace(/;\s*/g, ';\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (sel.trim()) editor.executeEdits('fmt', [{ range: editor.getSelection(), text: out.trimEnd() }]); else editor.setValue(out);
  setStatus('Formatted.');
}
$('#format').onclick = formatSql;

// Statement at the cursor (used by Explain plan; the server uses its own splitter for Run)
function stmtAt(text, off) {
  const parts = []; let start = 0, i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i++; while (i < n && text[i] !== c) i++; i++; }
    else if (c === '-' && text[i + 1] === '-') { i = text.indexOf('\n', i); if (i < 0) i = n; }
    else if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; }
    else if (c === ';') { parts.push([start, i]); start = ++i; }
    else i++;
  }
  parts.push([start, n]);
  const p = parts.find(([s, e]) => off >= s && off <= e) || parts.at(-1);
  return text.slice(p[0], p[1]).trim();
}
const currentSql = () => (selectedText().trim() || stmtAt(editor.getValue(), cursorOffset()) || editor.getValue()).trim();

// ---------------------------------------------------------------- worksheets (saved in this browser)
let persistT;
const persist = () => { clearTimeout(persistT); persistT = setTimeout(() => { store.set('tabs', tabs); store.set('curTab', cur); }, 400); };
function renderTabs() {
  const box = $('#qtabs'); box.innerHTML = '';
  tabs.forEach(t => {
    const b = document.createElement('button');
    b.className = 'qt' + (t.id === cur ? ' on' : '');
    b.innerHTML = `<span>${esc(t.title)}</span>${tabs.length > 1 ? '<i class="x" aria-label="Close worksheet">×</i>' : ''}`;
    b.onclick = () => switchTab(t.id);
    b.ondblclick = () => { const n = prompt('Worksheet name', t.title); if (n && n.trim()) { t.title = n.trim().slice(0, 30); renderTabs(); persist(); } };
    const x = b.querySelector('.x');
    if (x) x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    box.appendChild(b);
  });
}
function saveTab() { const t = tabs.find(t => t.id === cur); if (t && editor) t.text = editor.getValue(); }
function switchTab(id) { saveTab(); cur = id; setText(tabs.find(t => t.id === id).text); renderTabs(); persist(); }
function closeTab(id) {
  tabs = tabs.filter(t => t.id !== id);
  if (cur === id) { cur = tabs[0].id; setText(tabs[0].text); } renderTabs(); persist();
}
function newTab(text) {
  saveTab(); tabs.push({ id: nextId, title: 'Query ' + nextId, text: text ?? (isMongo() ? SAMPLE.mongo : SAMPLE.sql) });
  cur = nextId++; setText(tabs.at(-1).text); renderTabs(); persist();
}
$('#addTab').onclick = () => newTab();

// ---------------------------------------------------------------- connections
const ABBR = { oracle: 'ORA', mysql: 'MY', postgresql: 'PG', mongodb: 'MDB' };
function renderConns() {
  const ul = $('#conns');
  ul.innerHTML = conns.length ? '' : '<li class="empty">None yet. Add one to begin.</li>';
  conns.forEach(c => {
    const li = document.createElement('li');
    li.className = c === active ? 'on' : '';
    li.innerHTML = `<i class="eng ${esc(c.type)}">${ABBR[c.type] || '?'}</i><span>${esc((c.user || '').toUpperCase())} @ ${esc(c.name)}</span><button class="x" title="Disconnect" aria-label="Disconnect">×</button>`;
    li.onclick = () => select(c);
    li.querySelector('.x').onclick = async e => {
      e.stopPropagation();
      await api('/connections/' + c.id, { method: 'DELETE' }).catch(() => {});
      conns = conns.filter(x => x !== c);
      if (active === c) { active = null; tables = []; resetActive(); renderTables(); }
      renderConns();
    };
    ul.appendChild(li);
  });
}
function resetActive() { $('#active').textContent = 'User: none'; $('#active').classList.remove('live'); setDirty(false); }
function renderSaved() {
  const ul = $('#saved'), list = store.get('saved', []);
  ul.innerHTML = list.length ? '' : '<li class="empty">Connections you use are saved here (without passwords).</li>';
  list.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<i class="eng ${esc(s.type)}">${ABBR[s.type] || '?'}</i><span>${esc(s.username || '')} @ ${esc(s.host)}/${esc(s.database)}</span><button class="x" title="Forget" aria-label="Forget saved connection">×</button>`;
    li.onclick = () => openDialog(s);
    li.querySelector('.x').onclick = e => { e.stopPropagation(); list.splice(i, 1); store.set('saved', list); renderSaved(); };
    ul.appendChild(li);
  });
}
function renderTables() {
  const ul = $('#schema'), f = $('#tfilter').value.toLowerCase();
  const list = tables.filter(t => t.toLowerCase().includes(f));
  if (!active) ul.innerHTML = '<li class="empty">Select a connection.</li>';
  else if (active.type === 'mysql' && !$('#bDb').value) ul.innerHTML = '<li class="empty">Choose a database above to see its tables.</li>';
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

// MySQL: list every database (schema) this user can see, and let the browser switch between them
async function loadDbList() {
  const bar = $('#bDbBar'); bar.hidden = active?.type !== 'mysql';
  if (bar.hidden) return;
  try {
    const d = await api(`/connections/${active.id}/mysql/databases`);
    $('#bDb').innerHTML = (d.current ? '' : '<option value="" selected>Select a database…</option>') +
      d.rows.map(r => `<option${r[0] === d.current ? ' selected' : ''}>${esc(r[0])}</option>`).join('');
    if (!d.rows.length) setStatus('This MySQL user can not see any database. Ask an admin to GRANT privileges on your schemas.', true);
  } catch (e) { setStatus(e.message, true); }
}
$('#bDbReload').onclick = loadDbList;
$('#bDb').onchange = async e => {
  if (!e.target.value || !active) return;
  try {
    const r = await api(`/connections/${active.id}/mysql/use`, { method: 'POST', body: JSON.stringify({ database: e.target.value }) });
    active.name = r.name; renderConns(); colCache = {};
    tables = await api(`/connections/${active.id}/schema`); renderTables();
    if (typeof mLoad === 'function') mLoad();
    setStatus(`Now using database ${e.target.value}.`);
  } catch (err) { setStatus(err.message, true); }
};

async function select(c) {
  active = c; colCache = {}; renderConns();
  $('#active').textContent = 'User: ' + (c.user || '').toUpperCase(); $('#active').classList.add('live'); $('#active').title = `${c.type}: ${c.name}`;
  $('#schemaTitle').textContent = isMongo() ? 'Collections' : 'Tables';
  const t = tabs.find(t => t.id === cur);
  if (t && (t.text === SAMPLE.sql || t.text === SAMPLE.mongo)) t.text = isMongo() ? SAMPLE.mongo : SAMPLE.sql;
  setText(t.text);
  try { tables = await api(`/connections/${c.id}/schema`); } catch (e) { tables = []; setStatus(e.message, true); }
  renderTables(); loadDbList();
}
async function browse(name) {
  setStatus('Loading ' + name + '…');
  try {
    const u = encodeURIComponent(name);
    const [r, m] = await Promise.all([api(`/connections/${active.id}/preview?table=${u}`), api(`/connections/${active.id}/columns?table=${u}`)]);
    meta = m.columns; r.table = name; show(r); renderGrid(); go('browser');
  } catch (e) { setStatus(e.message, true); }
}

// ---------------------------------------------------------------- running statements
function setRunning(on) {
  running = on; $('#run').disabled = on; $('#runAll').disabled = on; $('#stop').hidden = !on;
  clearInterval(runClock);
  if (on) { const t0 = Date.now(); $('#rstat').textContent = 'Running…'; runClock = setInterval(() => { $('#rstat').textContent = `Running… ${((Date.now() - t0) / 1000).toFixed(1)} s`; }, 150); }
}
function markError(offset) {
  if (!editor?.deltaDecorations || offset == null || offset < 0) return;
  const p = editor.getModel().getPositionAt(offset);
  errDeco = editor.deltaDecorations(errDeco, [{ range: new monaco.Range(p.lineNumber, 1, p.lineNumber, 1), options: { isWholeLine: true, className: 'errline', glyphMarginClassName: 'errglyph' } }]);
}
function clearError() { if (editor?.deltaDecorations && errDeco.length) errDeco = editor.deltaDecorations(errDeco, []); }

/** mode: 'current' (statement at the cursor) or 'script' (all statements). A selection always runs as a script. */
async function run(mode = 'current') {
  if (!active) return setStatus('Connect to a database first.', true);
  if (running) return;
  const sel = selectedText().trim() ? selectedText() : null;
  const q = sel ?? editor.getValue();
  if (!q.trim()) return setStatus('Type a statement first.', true);
  const m = isMongo() ? 'single' : sel ? 'script' : mode;
  clearError(); setRunning(true);
  try {
    const r = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({
      query: q, mode: m, offset: sel ? 0 : cursorOffset(), maxRows: +$('#maxRows').value, timeout: +$('#qTimeout').value }) });
    if (sel) {                                                // offsets are relative to the selection: map them back to the editor
      const base = selectionStart();
      if (r.errorOffset >= 0) r.errorOffset += base;
      r.log?.forEach(l => { if (l.offset >= 0) l.offset += base; });
    }
    onResult(r, q);
  } catch (e) {
    setStatus(e.message, true); addHistory(q, false);
    renderLog({ log: [{ n: 1, ok: false, sql: q.replace(/\s+/g, ' ').slice(0, 160), error: e.message, ms: 0 }] }); flag('messages', true); activateTab('messages');
    $('#rstat').textContent = 'Failed'; $('#rstat').className = 'bad';
  } finally { setRunning(false); }
}
function onResult(r, q) {
  renderLog(r);
  if (r.error) addHistory(q, false); else addHistory(q, true);
  show(r);
  if (r.error) { markError(r.errorOffset); setStatus(r.error, true); activateTab(r.columns ? 'table' : 'messages'); }
  const multi = r.log && r.log.length > 1, warn = r.log?.some(l => l.warnings?.length);
  flag('messages', !!(r.error || warn || multi));
  if (!r.error && (multi || warn) && !r.columns) activateTab('messages');
  trackTx(r);
}
$('#run').onclick = () => run('current');
$('#runAll').onclick = () => run('script');
$('#stop').onclick = async () => { try { const r = await api(`/connections/${active.id}/cancel`, { method: 'POST', body: '{}' }); if (!r.cancelled) setStatus('Nothing is running.'); } catch (e) { setStatus(e.message, true); } };

// Uncommitted-changes indicator for manual commit mode
let dirty = false;
function setDirty(v) { dirty = v; $('#txPill').hidden = !v; }
function trackTx(r) {
  if ($('#autoc').checked || r.error && !r.log?.some(l => l.ok)) return;
  const wrote = r.log ? r.log.some(l => l.ok && l.rows === undefined && !/^\s*(commit|rollback|set|desc|show|prompt)/i.test(l.sql)) : (r.updateCount > 0);
  if (wrote) setDirty(true);
  if (r.log?.some(l => l.ok && /^\s*(commit|rollback)/i.test(l.sql))) setDirty(false);
}

// ---------------------------------------------------------------- results
function activateTab(name) {
  document.querySelectorAll('.rtabs button[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
  ['table', 'messages', 'chart', 'history', 'output'].forEach(p => $('#' + p).hidden = name !== p);
  if (name !== 'table') closeDrawer();
  if (name === 'chart') drawChart();
}
function flag(tab, on) { const d = document.querySelector(`.rtabs [data-tab=${tab}] .dot`); if (d) d.hidden = !on; }
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
  $('#edit').hidden = true; res = r; sort = null; selCell = null; $('#filter').value = ''; closeDrawer(); $('#sel').textContent = '';
  const ok = !r.error, rf = $('#rflags'); rf.innerHTML = '';
  $('#rstat').className = ok ? 'okc' : 'bad';
  if (r.columns) {
    const num = r.columns.map((_, i) => r.rows.length && r.rows.every(row => row[i] === null || typeof row[i] === 'number'));
    $('#clabel').innerHTML = r.columns.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('');
    $('#cvalue').innerHTML = r.columns.map((c, i) => num[i] ? `<option value="${i}">${esc(c)}</option>` : '').join('');
    if (num.includes(true)) $('#clabel').value = Math.max(0, num.findIndex(n => !n));
    renderGrid();
    $('#rstat').textContent = (ok ? '✔ ' : '✖ ') + `${r.rows.length} row${r.rows.length === 1 ? '' : 's'} in ${r.ms} ms`;
    if (r.truncated) rf.innerHTML = `<span class="pill warn" title="Raise the row limit in the toolbar to fetch more">Limited to ${r.rows.length} rows</span>`;
    if (ok) setStatus(`Finished in ${r.ms} ms`);
    if (!r.error) activateTab('table');
  } else {
    const msg = r.message || (r.updateCount !== undefined ? `${r.updateCount} rows changed.` : 'Statement finished.');
    const warn = (r.warnings || r.log?.flatMap(l => l.warnings || []) || []);
    $('#table').innerHTML = r.error && !r.updateCount && !r.message ? `<div class="msgcard bad">✖ <b>${esc(r.error)}</b></div>`
      : `<div class="msgcard ${warn.length ? 'warn' : 'ok'}">${warn.length ? '⚠' : '✔'} <b>${esc(msg)}</b><span> ${r.ms} ms</span></div>`
        + (warn.length ? `<ul class="warnlist">${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
    $('#count').textContent = '';
    $('#rstat').textContent = (ok ? '✔ ' : '✖ ') + `${msg} (${r.ms} ms)`;
    if (ok) setStatus(msg, !!warn.length);
    activateTab('table');
  }
  flag('output', !!r.output); flag('messages', false);
  drawChart();
}
function renderGrid() {
  if (!res?.columns) return;
  const rows = view(), ed = !!res.table; shown = rows;
  $('#count').textContent = `${rows.length} of ${res.rows.length} rows`;
  $('#edit').hidden = !ed; $('#addCol').hidden = isMongo();
  $('#table').innerHTML = '<table><thead><tr><th class="rn">#</th>' + (ed ? '<th></th>' : '') + res.columns.map((c, i) =>
    `<th data-i="${i}">${esc(c)}${sort?.i === i ? (sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r, ri) => `<tr data-r="${ri}"><td class="rn" title="Open row inspector">${ri + 1}<b>&#8594;</b></td>` + (ed ? '<td><button class="del">Delete</button></td>' : '') + r.map((v, ci) => v === null ?
      `<td data-c="${ci}"><i>null</i></td>` :
      `<td data-c="${ci}" class="${typeof v === 'number' ? 'n' : ''}" title="${esc(v)}">${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  document.querySelectorAll('th[data-i]').forEach(th => th.onclick = () => {
    const i = +th.dataset.i; sort = { i, d: sort?.i === i ? -sort.d : 1 }; renderGrid();
  });
  document.querySelectorAll('#table td.rn').forEach(td => td.onclick = () => openDrawer(+td.parentNode.dataset.r));
  document.querySelectorAll('#table td[data-c]').forEach(td => td.onclick = () => pickCell(td));
  if (ed) {
    document.querySelectorAll('td[data-c]').forEach(td => td.ondblclick = () => editCell(td));
    document.querySelectorAll('.del').forEach(b => b.onclick = () => delRow(shown[+b.closest('tr').dataset.r]));
  }
}
function pickCell(td) {
  document.querySelectorAll('#table td.sel').forEach(x => x.classList.remove('sel')); td.classList.add('sel');
  const v = shown[+td.parentNode.dataset.r][+td.dataset.c], col = res.columns[+td.dataset.c];
  selCell = v === null ? '' : String(v);
  $('#sel').innerHTML = `<b>${esc(col)}</b>: ${esc(selCell.length > 80 ? selCell.slice(0, 80) + '…' : (v === null ? 'null' : selCell))} <button id="copyCell" class="mini">Copy</button>`;
  $('#copyCell').onclick = () => copyText(selCell, 'Cell copied.');
}
const copyText = (t, msg) => navigator.clipboard?.writeText(t).then(() => setStatus(msg || 'Copied.'), () => setStatus('Copy is blocked by the browser.', true));

// Row inspector
let drRow = 0;
function openDrawer(ri) {
  if (!res?.columns || !shown[ri]) return;
  drRow = ri; const row = shown[ri];
  $('#drTitle').textContent = `Row ${ri + 1} of ${shown.length}`;
  $('#drBody').innerHTML = res.columns.map((c, i) => `<div class="kv"><label>${esc(c)}</label><div class="v${row[i] === null ? ' nul' : ''}">${row[i] === null ? 'null' : esc(row[i])}</div></div>`).join('');
  $('#drawer').hidden = false;
  document.querySelectorAll('#table tr.cur').forEach(x => x.classList.remove('cur'));
  document.querySelector(`#table tr[data-r="${ri}"]`)?.classList.add('cur');
}
function closeDrawer() { $('#drawer').hidden = true; document.querySelectorAll('#table tr.cur').forEach(x => x.classList.remove('cur')); }
$('#drClose').onclick = closeDrawer;
$('#drPrev').onclick = () => openDrawer(Math.max(0, drRow - 1));
$('#drNext').onclick = () => openDrawer(Math.min(shown.length - 1, drRow + 1));
$('#drCopy').onclick = () => copyText(JSON.stringify(Object.fromEntries(res.columns.map((c, i) => [c, shown[drRow][i]])), null, 2), 'Row copied as JSON.');

// Messages (log of each statement)
function renderLog(r) {
  const box = $('#messages'), log = r.log || [];
  if (!log.length) { box.innerHTML = '<p class="empty">Run a script to see the result of each statement here.</p>'; return; }
  const bad = log.filter(l => !l.ok).length;
  box.innerHTML = `<div class="loghead"><b>${log.length} statement${log.length === 1 ? '' : 's'}</b> · ${log.length - bad} succeeded${bad ? ` · <span class="badc">${bad} failed</span>` : ''}${r.statements > log.length ? ` · ${r.statements - log.length} not run` : ''}<span class="grow"></span><span>${r.ms ?? ''} ms</span></div>` +
    log.map(l => `<div class="log ${l.ok ? 'ok' : 'bad'}" data-off="${l.offset ?? -1}"><i class="st">${l.ok ? '✔' : '✖'}</i><span class="n">#${l.n}</span><code title="${esc(l.sql)}">${esc(l.sql)}</code>` +
      `<span class="res">${l.ok ? esc(l.rows !== undefined ? `${l.rows} row${l.rows === 1 ? '' : 's'}` : (l.message || 'OK')) : ''}</span><small>${l.ms} ms</small></div>` +
      (l.ok ? '' : `<pre class="logerr">${esc(l.error)}</pre>`) +
      (l.warnings?.length ? `<ul class="warnlist">${l.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '')).join('');
  box.querySelectorAll('.log').forEach(d => d.onclick = () => {
    const off = +d.dataset.off; if (off < 0 || !window.monaco || !editor.getModel) return;
    const p = editor.getModel().getPositionAt(off); editor.setPosition(p); editor.revealPositionInCenter(p); editor.focus();
  });
}

// ---------------------------------------------------------------- editing (Object Browser)
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

// ---------------------------------------------------------------- chart
function drawChart() {
  if (!window.Chart) return;
  if (chart) chart.destroy();
  const box = $('.cbox'); box.querySelector('p')?.remove();
  if (!res?.columns || !res.rows.length) return;
  if (!$('#cvalue').options.length) { box.insertAdjacentHTML('afterbegin', '<p class="empty">Charts need at least one numeric column.</p>'); return; }
  const li = +$('#clabel').value, vi = +$('#cvalue').value, type = $('#ctype').value;
  const rows = view().slice(0, 200), pie = type === 'pie' || type === 'doughnut';
  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#666';
  Chart.defaults.borderColor = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#ddd';
  chart = new Chart(box.querySelector('canvas'), {
    type,
    data: { labels: rows.map(r => r[li]), datasets: [{ label: res.columns[vi], data: rows.map(r => r[vi]),
      backgroundColor: pie ? rows.map((_, i) => COLORS[i % COLORS.length]) : '#5b5bf0', borderColor: '#5b5bf0', tension: .25 }] },
    options: { maintainAspectRatio: false, responsive: true }
  });
}
['#ctype', '#clabel', '#cvalue'].forEach(s => $(s).onchange = drawChart);

// ---------------------------------------------------------------- export
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const sqlLit = v => v === null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
document.querySelectorAll('#exp [data-x]').forEach(b => b.onclick = () => {
  $('#exp').open = false;
  if (!res?.columns) return setStatus('Run a query first.', true);
  const rows = view(), k = b.dataset.x, cols = res.columns;
  if (k === 'csv') { const q = v => v === null ? '' : '"' + String(v).replace(/"/g, '""') + '"'; download('results.csv', [cols, ...rows].map(r => r.map(q).join(',')).join('\n'), 'text/csv'); }
  else if (k === 'json') download('results.json', JSON.stringify(rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), null, 2), 'application/json');
  else if (k === 'sql') download('results.sql', rows.map(r => `INSERT INTO ${res.table || 'table_name'} (${cols.join(', ')}) VALUES (${r.map(sqlLit).join(', ')});`).join('\n') + '\n', 'text/plain');
  else if (k === 'tsv') copyText([cols, ...rows].map(r => r.map(v => v === null ? '' : String(v).replace(/[\t\n]/g, ' ')).join('\t')).join('\n'), `${rows.length} rows copied.`);
  else if (k === 'md') copyText(`| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n` + rows.map(r => `| ${r.map(v => v === null ? '' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n'), `${rows.length} rows copied as Markdown.`);
});
document.addEventListener('click', e => { if (!e.target.closest('#exp')) $('#exp').open = false; });

// ---------------------------------------------------------------- history
function addHistory(q, ok) {
  const h = store.get('history', []); h.unshift({ q: q.slice(0, 4000), ok, t: new Date().toLocaleTimeString(), c: active?.name });
  store.set('history', h.slice(0, 60)); renderHistory();
}
function renderHistory() {
  const h = store.get('history', []), box = $('#history');
  box.innerHTML = h.length ? '<div class="hist"><button id="clearH">Clear history</button></div>' : '<p class="empty">Queries you run appear here. Click one to reuse it.</p>';
  h.forEach(x => {
    const d = document.createElement('div');
    d.className = 'hist' + (x.ok ? '' : ' fail');
    d.innerHTML = `<small>${esc(x.t)}</small><span title="${esc(x.q)}">${esc(x.q.replace(/\s+/g, ' '))}</span>`;
    d.onclick = () => { editor.setValue(x.q); go('sql'); };
    box.appendChild(d);
  });
  $('#clearH')?.addEventListener('click', () => { store.set('history', []); renderHistory(); });
}

// ---------------------------------------------------------------- result tabs and splitter
document.querySelectorAll('.rtabs button[data-tab]').forEach(b => b.onclick = () => { activateTab(b.dataset.tab); if (b.dataset.tab === 'output') flag('output', false); if (b.dataset.tab === 'messages') flag('messages', false); });
$('#split').onmousedown = e => {
  e.preventDefault();
  const move = ev => { $('#editor').style.flexBasis = Math.min(Math.max(100, ev.clientY - $('#editor').getBoundingClientRect().top), innerHeight * 0.7) + 'px'; };
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
};

// ---------------------------------------------------------------- connection dialog
const dlg = $('#dlg'), form = $('#form');
function syncForm() {
  const t = form.type.value;
  $('#uriRow').hidden = t !== 'mongodb';
  $('#roleRow').hidden = t !== 'oracle';
  $('#dbLabel').textContent = t === 'oracle' ? 'Service name' : t === 'mysql' ? 'Database (optional)' : 'Database';
  $('#dbHint').textContent = t === 'oracle' ? 'Service name such as XEPDB1 or FREEPDB1. Use sid:XE for a SID. To log in as SYS choose SYSDBA below.' : '';
  if (t === 'oracle') form.database.setAttribute('list', 'oraDbs'); else form.database.removeAttribute('list');
}
form.type.onchange = () => { form.port.value = PORTS[form.type.value]; syncForm(); };
function openDialog(s = {}) {
  const t = s.type || form.type.value;
  form.type.value = t; form.host.value = s.host || 'localhost'; form.port.value = s.port ?? PORTS[t]; form.database.value = s.database || '';
  form.username.value = s.username || ''; form.password.value = s.password || ''; form.role.value = s.role || '';
  syncForm(); $('#err').textContent = ''; dlg.showModal(); (form.username.value ? form.password : form.database).focus();
}
$('#newConn').onclick = () => openDialog();
document.querySelectorAll('.engine').forEach(b => b.onclick = () => openDialog({ type: b.dataset.type, username: b.dataset.type === 'oracle' ? 'SYSTEM' : '', database: b.dataset.type === 'oracle' ? 'XEPDB1' : '' }));
$('#cancel').onclick = () => dlg.close();
form.onsubmit = async e => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  body.port = body.port ? Number(body.port) : null;
  $('#err').textContent = 'Connecting…';
  try {
    const c = await api('/connect', { method: 'POST', body: JSON.stringify(body) });
    c.user = body.username.replace(/\s+as\s+(sysdba|sysoper)$/i, ''); c.cfg = { type: body.type, host: body.host, port: body.port, database: body.database, role: body.role };
    conns.push(c);
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
  const ta = fbTa = document.createElement('textarea'); ta.id = 'fallback'; ta.value = tabs.find(t => t.id === cur).text;
  ta.style.cssText = 'width:100%;height:100%;margin:0;border:0;resize:none;font:13px/1.5 Consolas,monospace'; $('#editor').appendChild(ta);
  ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(e.shiftKey ? 'script' : 'current'); if (e.key === 'F5') { e.preventDefault(); run('script'); } });
  ta.addEventListener('input', () => { saveTab(); persist(); });
  editor = { getValue: () => ta.value, setValue: v => { ta.value = v; }, getSelection: () => null,
    getModel: () => ({ getValueInRange: () => ta.value.slice(ta.selectionStart, ta.selectionEnd) }),
    trigger: (a, b, o) => ta.setRangeText(o.text, ta.selectionStart, ta.selectionEnd, 'end'),
    executeEdits: (n, ed) => ta.setRangeText(ed[0].text, ta.selectionStart, ta.selectionEnd, 'end') };
  renderTabs(); setStatus('The code editor could not load, so a plain text box is shown. Check your internet connection.', true);
}, 7000);

// ---------------------------------------------------------------- shell: pages, breadcrumbs, administration
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
const PAGES = { home: ['Home'], admin: ['Home', 'Administration'], browser: ['Home', 'Object Browser'], sql: ['Home', 'SQL', 'SQL Commands'], dev: ['Home', 'Developer'] };

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
  ? (r.rows.length ? '<div class="scroll"><table><thead><tr>' + r.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    r.rows.map(row => '<tr>' + row.map(v => v === null ? '<td><i>null</i></td>' : `<td title="${esc(v)}">${esc(v)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>' : '<p class="empty">No rows.</p>')
  : `<p class="empty">${r.updateCount} rows changed.</p>`;

const APP = { name: 'DBFusion', version: 'vr.1.5.0' };
async function about() {
  const box = $('#adminResult'); go('admin', NAMES.about);
  const lines = [`${APP.name} Database System ${APP.version}`, 'Engines: PostgreSQL, MySQL, Oracle, MongoDB',
    `Workbench Core ${APP.version} - Production`, 'Connection layer: REST API (/api)',
    'Tools: SQL scripts, object browser, charts, CSV/JSON/INSERT export, query history, Oracle user manager'];
  let live = 'No active connection. Connect to a database to see its server version.';
  if (active) {
    live = `Connected: <b>${esc(active.type)}</b> / ${esc(active.name)}`;
    const q = (ADMIN[active.type] || {}).about;
    if (q) try { const r = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: q }) }); live += `<br>Server: <b>${esc(r.rows[0].slice(0, 2).filter(Boolean).join(' '))}</b>`; } catch {}
  }
  box.innerHTML = `<div class="about"><div class="hd"><img class="mark" src="logo-mark.svg" alt="DBFusion logo"><div><b>${APP.name}</b><small>${APP.version}</small></div></div><pre>${lines.map(esc).join('\n')}</pre><div class="live">${live}</div></div>`;
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
  resetActive(); $('#adminResult').innerHTML = '';
  renderConns(); renderTables(); setStatus(''); go('home');
}
$('#logout').onclick = e => { e.preventDefault(); logout(); };
$('#logout2').onclick = e => { e.preventDefault(); logout(); };
$('#tNew').onclick = e => { e.preventDefault(); openDialog(); };
$('#help').onclick = e => { e.preventDefault(); $('#dHelp').showModal(); };
$('#helpClose').onclick = () => $('#dHelp').close();
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

// ---------------------------------------------------------------- command palette (Ctrl+K)
const cmdk = $('#cmdk'); let cmdItems = [], cmdSel = 0;
function paletteItems() {
  const it = [], page = (p, label, hint) => it.push({ label: 'Go to ' + label, hint: hint || 'page', run: () => go(p) });
  page('home', 'Home'); page('dev', 'Developer (about the author)'); page('admin', 'Administration'); page('browser', 'Object Browser'); page('sql', 'SQL Commands');
  if (!active || ['mysql', 'postgresql', 'oracle'].includes(active.type)) page('design', 'Designer (databases and tables)');
  if (!active || active.type === 'oracle') { page('oracle', 'Oracle Tools'); page('users', 'Oracle User Manager'); }
  if (!active || active.type === 'mysql') { page('wb', 'MySQL Workbench'); page('mysql', 'MySQL Tools'); }
  it.push({ label: 'New connection', hint: 'action', run: () => openDialog() });
  it.push({ label: 'Switch light/dark theme', hint: 'action', run: () => $('#theme').click() });
  it.push({ label: 'New worksheet', hint: 'action', run: () => { go('sql'); newTab(); } });
  it.push({ label: 'Run script', hint: 'F5', run: () => { go('sql'); run('script'); } });
  it.push({ label: 'Format SQL', hint: 'Ctrl+Shift+F', run: () => { go('sql'); formatSql(); } });
  it.push({ label: 'Show help and shortcuts', hint: 'action', run: () => $('#dHelp').showModal() });
  if (active?.type === 'oracle') it.push({ label: 'Create Oracle user…', hint: 'Oracle', run: () => { go('users'); window.openCreateUser?.(); } });
  if (active) it.push({ label: 'Disconnect', hint: 'action', run: logout });
  if (typeof snipSet === 'function') Object.entries(snipSet()).forEach(([k, v]) => it.push({ label: 'Snippet: ' + k, hint: 'SQL', run: () => { go('sql'); newTab(v); } }));
  tables.forEach(t => it.push({ label: 'Open ' + (isMongo() ? 'collection ' : 'table ') + t, hint: 'data', run: () => browse(t) }));
  return it;
}
function drawPalette() {
  const q = $('#cmdIn').value.toLowerCase().trim();
  cmdItems = paletteItems().filter(x => q.split(/\s+/).every(w => x.label.toLowerCase().includes(w))).slice(0, 40);
  cmdSel = Math.min(cmdSel, Math.max(0, cmdItems.length - 1));
  $('#cmdList').innerHTML = cmdItems.length ? cmdItems.map((x, i) => `<li class="${i === cmdSel ? 'on' : ''}" data-i="${i}"><span>${esc(x.label)}</span><small>${esc(x.hint)}</small></li>`).join('') : '<li class="none">No match</li>';
  $('#cmdList .on')?.scrollIntoView({ block: 'nearest' });
  $('#cmdList').querySelectorAll('li[data-i]').forEach(li => li.onclick = () => pickCmd(+li.dataset.i));
}
function pickCmd(i) { const x = cmdItems[i]; if (!x) return; cmdk.close(); x.run(); }
function openPalette() { if (cmdk.open) return; $('#cmdIn').value = ''; cmdSel = 0; drawPalette(); cmdk.showModal(); $('#cmdIn').focus(); }
$('#cmdIn').oninput = () => { cmdSel = 0; drawPalette(); };
$('#cmdIn').onkeydown = e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdSel = Math.min(cmdItems.length - 1, cmdSel + 1); drawPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdSel = Math.max(0, cmdSel - 1); drawPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); pickCmd(cmdSel); }
};
cmdk.addEventListener('click', e => { if (e.target === cmdk) cmdk.close(); });
$('#cmdBtn').onclick = openPalette;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.target.closest?.('.monaco-editor')) { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
});
window.addEventListener('beforeunload', () => { saveTab(); store.set('tabs', tabs); store.set('curTab', cur); });

// After a successful connection, open Administration like the Express home flow
const baseSelect = select;
select = async c => { await baseSelect(c); if (!$('#p-home').hidden) go(c.type === 'mysql' ? 'wb' : 'admin'); };
go('home');
