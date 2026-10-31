// DBFusion Oracle tools: objects browser, DDL, describe, explain plan, PL/SQL output, transactions, snippets
const isOra = () => active?.type === 'oracle', enc = encodeURIComponent;
const oapi = (p, o) => api(`/connections/${active.id}/oracle${p}`, o);
const post = (p, b) => api(`/connections/${active.id}${p}`, { method: 'POST', body: JSON.stringify(b ?? {}) });
PAGES.oracle = ['Home', 'Oracle Tools'];
let objs = [], pick = null;

async function loadObjects() {
  const ul = $('#oList');
  if (!isOra()) { objs = []; ul.innerHTML = '<li class="empty">Connect to an Oracle database (Home) to use these tools.</li>'; return; }
  try {
    objs = (await oapi('/objects')).rows;
    $('#oType').innerHTML = '<option value="">All types</option>' + [...new Set(objs.map(r => r[1]))].sort().map(t => `<option>${esc(t)}</option>`).join('');
    drawObjects();
  } catch (e) { setStatus(e.message, true); }
}
function drawObjects() {
  const f = $('#oFilter').value.toLowerCase(), t = $('#oType').value, ul = $('#oList');
  const list = objs.filter(r => (!t || r[1] === t) && r[0].toLowerCase().includes(f));
  ul.innerHTML = list.length ? '' : '<li class="empty">No objects found.</li>';
  list.forEach(r => {
    const li = document.createElement('li'), bad = r[2] !== 'VALID';
    li.className = pick && pick[0] === r[0] && pick[1] === r[1] ? 'on' : '';
    li.innerHTML = `<span title="${esc(r[0])}">${esc(r[0])}</span><small class="${bad ? 'bad' : ''}">${esc(r[1])}${bad ? ' (invalid)' : ''}</small>`;
    li.onclick = () => openObj(r); ul.appendChild(li);
  });
}
const CODE = ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER', 'TYPE', 'VIEW'];
function openObj(r) {
  pick = r; drawObjects();
  const [, type] = r, tbl = type === 'TABLE';
  const ts = [['ddl', 'DDL'], ...(tbl ? [['cols', 'Columns'], ['idx', 'Indexes'], ['con', 'Constraints'], ['stats', 'Statistics']] : []),
    ...(CODE.includes(type) ? [['err', 'Compile errors']] : []), ...(tbl || type === 'VIEW' ? [['data', 'Open data']] : [])];
  $('#oTabs').innerHTML = ts.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('');
  $('#oTabs').querySelectorAll('button').forEach(b => b.onclick = () => showTab(b.dataset.k));
  showTab('ddl');
}
async function showTab(k) {
  const [name, type] = pick, box = $('#oBody');
  $('#oTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (k === 'data') { await browse(name); return go('browser'); }
  box.innerHTML = '<p class="empty">Loading…</p>';
  try {
    if (k === 'ddl') {
      const ddl = (await oapi(`/ddl?name=${enc(name)}&type=${enc(type)}`)).ddl.trim();
      box.innerHTML = `<pre class="code">${esc(ddl)}</pre><p class="acts"><button id="oCopy">Copy DDL</button><button id="oEdit">Open in SQL editor</button></p>`;
      $('#oCopy').onclick = () => navigator.clipboard?.writeText(ddl).then(() => setStatus('DDL copied.'));
      $('#oEdit').onclick = () => { go('sql'); setText(ddl); };
    } else if (k === 'err') {
      const r = await oapi('/errors?name=' + enc(name));
      box.innerHTML = r.rows.length ? gridHtml(r) : '<p class="empty">No compile errors.</p>';
    } else {
      const d = await oapi('/describe?table=' + enc(name));
      box.innerHTML = gridHtml(d[{ cols: 'columns', idx: 'indexes', con: 'constraints', stats: 'stats' }[k]]);
    }
    setStatus('');
  } catch (e) { box.innerHTML = ''; setStatus(e.message, true); }
}
$('#oType').onchange = $('#oFilter').oninput = drawObjects;
$('#oRefresh').onclick = loadObjects;
const _go = go; go = (p, x) => { _go(p, x); if (p === 'oracle') loadObjects(); };

// Output tab: DBMS_OUTPUT text and execution plans
const showOut = text => { $('#outtxt').textContent = text; document.querySelector('.rtabs [data-tab=output]').click(); };
const _show = show; show = r => { _show(r); if (r.output) showOut(r.output); };
$('#explain').onclick = async () => {
  if (!isOra()) return setStatus('Explain plan works on Oracle connections.', true);
  const q = (editor.getModel().getValueInRange(editor.getSelection()).trim() || editor.getValue()).trim();
  setStatus('Building plan…');
  try { showOut((await post('/explain', { query: q })).plan); setStatus('Execution plan ready.'); } catch (e) { setStatus(e.message, true); }
};

// Transactions
$('#autoc').onchange = async e => {
  try { await post('/autocommit', { on: e.target.checked }); active.auto = e.target.checked;
    setStatus(e.target.checked ? 'Auto-commit is on.' : 'Auto-commit is off. Use Commit or Rollback to finish your changes.'); }
  catch (err) { e.target.checked = !e.target.checked; setStatus(err.message, true); }
};
const tx = (path, msg) => async () => { if (!active) return setStatus('Connect to a database first.', true); try { await post(path); setStatus(msg); } catch (e) { setStatus(e.message, true); } };
$('#commit').onclick = tx('/commit', 'Changes committed.');
$('#rollback').onclick = tx('/rollback', 'Changes rolled back.');
const _sel = select; select = async c => { await _sel(c); $('#autoc').checked = c.auto !== false; };

// Snippets
const SNIPS = {
  'Current user and instance': "SELECT USER AS username, SYS_CONTEXT('USERENV','DB_NAME') AS db_name, SYS_CONTEXT('USERENV','SERVICE_NAME') AS service_name FROM dual",
  'My tables and row counts': "SELECT table_name, num_rows, last_analyzed FROM user_tables ORDER BY table_name",
  'Table sizes (MB)': "SELECT segment_name, ROUND(SUM(bytes)/1048576, 2) AS mb FROM user_segments WHERE segment_type LIKE 'TABLE%' GROUP BY segment_name ORDER BY mb DESC",
  'Invalid objects': "SELECT object_name, object_type, status FROM user_objects WHERE status = 'INVALID'",
  'Sequences': "SELECT sequence_name, last_number, increment_by, max_value FROM user_sequences",
  'Foreign keys': "SELECT c.table_name, c.constraint_name, r.table_name AS references_table FROM user_constraints c JOIN user_constraints r ON r.constraint_name = c.r_constraint_name WHERE c.constraint_type = 'R'",
  'Active sessions (needs DBA)': "SELECT sid, serial# AS serial, username, status, program FROM v$session WHERE username IS NOT NULL",
  'Locks (needs DBA)': "SELECT s.sid, s.username, l.type, l.lmode, l.request FROM v$lock l JOIN v$session s ON s.sid = l.sid WHERE s.username IS NOT NULL",
  'First 10 rows (FETCH FIRST)': "SELECT * FROM user_tables FETCH FIRST 10 ROWS ONLY",
  'PL/SQL: DBMS_OUTPUT hello': "BEGIN\n  FOR i IN 1..3 LOOP\n    DBMS_OUTPUT.PUT_LINE('Hello from DBFusion, row ' || i);\n  END LOOP;\nEND;"
};
$('#snip').innerHTML = '<option value="">Oracle snippets…</option>' + Object.keys(SNIPS).map(k => `<option>${esc(k)}</option>`).join('');
$('#snip').onchange = e => { if (e.target.value) setText(SNIPS[e.target.value]); e.target.value = ''; };

// Administration: Oracle fallbacks for users without DBA rights
ADMIN.oracle.about = "SELECT product AS information, version, status FROM product_component_version";
const ORA_USER = {
  storage: "SELECT tablespace_name, ROUND(SUM(bytes)/1048576,1) AS used_mb FROM user_segments GROUP BY tablespace_name",
  memory: "SELECT parameter AS name, value FROM nls_session_parameters",
  users: "SELECT username, account_status, created, default_tablespace FROM user_users",
  monitor: "SELECT table_name, num_rows, last_analyzed FROM user_tables ORDER BY table_name"
};
const _admin = admin;
admin = async key => {
  if (!isOra() || key === 'about') return _admin(key);
  const box = $('#adminResult'); go('admin', NAMES[key]); let err;
  for (const sql of [ADMIN.oracle[key], ORA_USER[key]]) {
    try {
      const r = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: sql }) });
      box.innerHTML = `<h4 class="rt">${NAMES[key]}${sql === ORA_USER[key] ? ' (your own schema only: no DBA rights)' : ''}</h4>` + gridHtml(r); setStatus(''); return;
    } catch (e) { err = e; }
  }
  box.innerHTML = ''; setStatus(err.message, true);
};
