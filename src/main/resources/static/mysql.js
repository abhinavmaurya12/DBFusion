// DBFusion MySQL tools: database switcher, objects browser, DDL, describe, maintenance, explain, server info, snippets
const isMy = () => active?.type === 'mysql';
const mapi = (p, o) => api(`/connections/${active.id}/mysql${p}`, o);
PAGES.mysql = ['Home', 'MySQL Tools'];
let mObjs = [], mPick = null;
const M_CODE = ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'VIEW'];

async function mLoad() {
  const ul = $('#mList');
  if (!isMy()) {
    mObjs = []; $('#mDb').innerHTML = ''; $('#mType').innerHTML = '';
    ul.innerHTML = '<li class="empty">Connect to a MySQL database (Home) to use these tools.</li>'; return;
  }
  try {
    const d = await mapi('/databases');
    $('#mDb').innerHTML = (d.current ? '' : '<option value="" selected>Select a database…</option>') +
      d.rows.map(r => `<option${r[0] === d.current ? ' selected' : ''}>${esc(r[0])}</option>`).join('');
    mObjs = d.current ? (await mapi('/objects')).rows : [];
    $('#mType').innerHTML = '<option value="">All types</option>' + [...new Set(mObjs.map(r => r[1]))].sort().map(t => `<option>${esc(t)}</option>`).join('');
    mDraw();
  } catch (e) { setStatus(e.message, true); }
}
function mDraw() {
  const f = $('#mFilter').value.toLowerCase(), t = $('#mType').value, ul = $('#mList');
  const list = mObjs.filter(r => (!t || r[1] === t) && r[0].toLowerCase().includes(f));
  ul.innerHTML = list.length ? '' : `<li class="empty">${$('#mDb').value ? 'No objects found.' : 'Select a database first.'}</li>`;
  list.forEach(r => {
    const li = document.createElement('li');
    li.className = mPick && mPick[0] === r[0] && mPick[1] === r[1] ? 'on' : '';
    li.innerHTML = `<span title="${esc(r[0])}">${esc(r[0])}</span><small>${esc(r[1])}</small>`;
    li.onclick = () => mOpen(r); ul.appendChild(li);
  });
}
function mOpen(r) {
  mPick = r; mDraw();
  const type = r[1], tbl = type === 'TABLE';
  const ts = [['ddl', 'DDL'], ...(tbl ? [['cols', 'Columns'], ['idx', 'Indexes'], ['con', 'Constraints'], ['stats', 'Statistics'], ['trg', 'Triggers'], ['maint', 'Maintenance']] : []),
    ...(tbl || type === 'VIEW' ? [['data', 'Open data']] : [])];
  $('#mTabs').innerHTML = ts.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('');
  $('#mTabs').querySelectorAll('button').forEach(b => b.onclick = () => mTab(b.dataset.k));
  mTab('ddl');
}
async function mTab(k) {
  const [name, type] = mPick, box = $('#mBody');
  $('#mTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (k === 'data') { await browse(name); return go('browser'); }
  box.innerHTML = '<p class="empty">Loading…</p>';
  try {
    if (k === 'ddl') {
      const ddl = (await mapi(`/ddl?name=${enc(name)}&type=${enc(type)}`)).ddl.trim();
      box.innerHTML = `<pre class="code">${esc(ddl)}</pre><p class="acts"><button id="mCopy">Copy DDL</button><button id="mEdit">Open in SQL editor</button></p>`;
      $('#mCopy').onclick = () => navigator.clipboard?.writeText(ddl).then(() => setStatus('DDL copied.'));
      $('#mEdit').onclick = () => { go('sql'); setText(ddl); };
    } else if (k === 'maint') {
      box.innerHTML = '<p class="acts" style="padding-top:12px"><button data-op="ANALYZE">Analyze table</button><button data-op="OPTIMIZE">Optimize table</button><button data-op="CHECK">Check table</button></p><div id="mMaint"></div>';
      box.querySelectorAll('[data-op]').forEach(b => b.onclick = async () => {
        setStatus(`Running ${b.dataset.op.toLowerCase()}…`);
        try { const r = await mapi('/maintenance', { method: 'POST', body: JSON.stringify({ table: name, op: b.dataset.op }) });
          $('#mMaint').innerHTML = gridHtml(r); setStatus(`${b.textContent} finished.`); }
        catch (e) { setStatus(e.message, true); }
      });
    } else {
      const d = await mapi('/describe?table=' + enc(name));
      box.innerHTML = gridHtml(d[{ cols: 'columns', idx: 'indexes', con: 'constraints', stats: 'stats', trg: 'triggers' }[k]]);
    }
    if (k !== 'maint') setStatus('');
  } catch (e) { box.innerHTML = ''; setStatus(e.message, true); }
}
$('#mType').onchange = $('#mFilter').oninput = mDraw;
$('#mRefresh').onclick = mLoad;
$('#mDb').onchange = async e => {
  if (!e.target.value) return;
  try {
    const r = await post('/mysql/use', { database: e.target.value });
    active.name = r.name; renderConns(); mPick = null; $('#mTabs').innerHTML = '';
    $('#mBody').innerHTML = '<p class="empty">Pick an object to see its details.</p>';
    tables = await api(`/connections/${active.id}/schema`); renderTables(); await mLoad(); setStatus(`Now using database ${e.target.value}.`);
  } catch (err) { setStatus(err.message, true); }
};

// Server tools
document.querySelectorAll('#mSrv button').forEach(b => b.onclick = async () => {
  if (!isMy()) return setStatus('Connect to a MySQL database first.', true);
  const path = { status: '/status', procs: '/processlist', grants: '/grants', vars: '/variables?like=' + enc($('#mVar').value) }[b.dataset.s];
  mPick = null; mDraw(); $('#mTabs').innerHTML = '';
  try { $('#mBody').innerHTML = gridHtml(await mapi(path)); setStatus(''); } catch (e) { setStatus(e.message, true); }
});

// Explain plan for MySQL (Oracle keeps its own handler)
const _explainOra = $('#explain').onclick;
$('#explain').onclick = async e => {
  if (!isMy()) return _explainOra(e);
  const q = currentSql();
  setStatus('Building plan…');
  try { showOut((await post('/mysql/explain', { query: q })).plan); setStatus('Execution plan ready.'); } catch (err) { setStatus(err.message, true); }
};

// Snippets per database type
const SNIPS_MY = {
  'Current user, database, version': 'SELECT CURRENT_USER() AS user_name, DATABASE() AS db_name, VERSION() AS version',
  'Tables, engines and sizes (MB)': 'SELECT table_name, engine, table_rows, ROUND((data_length + index_length) / 1048576, 2) AS mb FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY mb DESC',
  'Indexes per table': 'SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS index_columns FROM information_schema.statistics WHERE table_schema = DATABASE() GROUP BY table_name, index_name ORDER BY table_name',
  'Foreign keys': 'SELECT table_name, constraint_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL',
  'Tables without a primary key': "SELECT t.table_name FROM information_schema.tables t LEFT JOIN information_schema.table_constraints c ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY' WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE' AND c.constraint_name IS NULL",
  'Stored routines': 'SELECT routine_name, routine_type, created, last_altered FROM information_schema.routines WHERE routine_schema = DATABASE()',
  'Running queries': 'SHOW FULL PROCESSLIST',
  'Slow query log settings': "SHOW VARIABLES LIKE 'slow_query%'",
  'InnoDB status': 'SHOW ENGINE INNODB STATUS',
  'First 10 rows (LIMIT)': 'SELECT * FROM information_schema.tables LIMIT 10',
  'Stored procedure template': "CREATE PROCEDURE hello_dbfusion(IN p_name VARCHAR(50))\nBEGIN\n  SELECT CONCAT('Hello, ', p_name) AS greeting;\nEND"
};
const snipSet = () => isOra() ? SNIPS : isMy() ? SNIPS_MY : {};
function fillSnips() {
  const set = snipSet(), label = isOra() ? 'Oracle' : isMy() ? 'MySQL' : 'SQL';
  $('#snip').innerHTML = `<option value="">${label} snippets…</option>` + Object.keys(set).map(k => `<option>${esc(k)}</option>`).join('');
  $('#snip').hidden = !Object.keys(set).length;
}
$('#snip').onchange = e => { const t = snipSet()[e.target.value]; if (t) setText(t); e.target.value = ''; };

// Show only the vendor tab that matches the active connection (both are visible when nothing is connected)
function syncTabs() {
  document.querySelector('#tabs [data-p=oracle]').hidden = !!active && !isOra();
  document.querySelector('#tabs [data-p=mysql]').hidden = !!active && !isMy();
  document.querySelector('#tabs [data-p=users]').hidden = !!active && !isOra();
  const ul = document.querySelector('#tUserLi'); if (ul) ul.hidden = !isOra();
}
const _go2 = go; go = (p, x) => { _go2(p, x); if (p === 'mysql') mLoad(); syncTabs(); };
const _sel2 = select; select = async c => { await _sel2(c); fillSnips(); syncTabs(); };
const _rc = renderConns; renderConns = () => { _rc(); syncTabs(); };
fillSnips(); syncTabs();
