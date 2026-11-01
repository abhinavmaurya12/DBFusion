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
const CODE = ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER', 'TYPE', 'TYPE BODY', 'VIEW'];
function openObj(r) {
  pick = r; drawObjects();
  const [, type] = r, tbl = type === 'TABLE', code = CODE.includes(type);
  const ts = [['ddl', 'DDL'], ...(tbl ? [['cols', 'Columns'], ['idx', 'Indexes'], ['con', 'Constraints'], ['stats', 'Statistics'], ['trg', 'Triggers']] : []),
    ...(tbl || type === 'VIEW' ? [['prv', 'Privileges']] : []), ...(tbl || code ? [['dep', 'Dependencies']] : []),
    ...(code ? [['err', 'Compile errors']] : []), ...(type === 'SEQUENCE' ? [['seq', 'Sequence info']] : []),
    ...(tbl || type === 'VIEW' ? [['data', 'Open data']] : [])];
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
      box.innerHTML = `<pre class="code">${esc(ddl)}</pre><p class="acts"><button id="oCopy">Copy DDL</button><button id="oEdit">Open in SQL editor</button>${CODE.includes(type) ? '<button id="oComp">Recompile</button>' : ''}</p>`;
      $('#oCopy').onclick = () => navigator.clipboard?.writeText(ddl).then(() => setStatus('DDL copied.'));
      $('#oEdit').onclick = () => { go('sql'); setText(ddl); };
      if ($('#oComp')) $('#oComp').onclick = async () => {
        try { const c = await post('/oracle/compile', { name, type }); await loadObjects();
          setStatus(c.status === 'VALID' ? 'Compiled: object is VALID.' : 'Compiled with errors. Open the Compile errors tab.', c.status !== 'VALID'); }
        catch (e) { setStatus(e.message, true); }
      };
    } else if (k === 'err') {
      const r = await oapi('/errors?name=' + enc(name));
      box.innerHTML = r.rows.length ? gridHtml(r) : '<p class="empty">No compile errors.</p>';
    } else if (k === 'trg') {
      box.innerHTML = gridHtml(await oapi('/triggers?table=' + enc(name)));
    } else if (k === 'prv') {
      box.innerHTML = gridHtml(await oapi('/privileges?name=' + enc(name)));
    } else if (k === 'seq') {
      box.innerHTML = gridHtml(await oapi('/sequence?name=' + enc(name)));
    } else if (k === 'dep') {
      const d = await oapi(`/dependencies?name=${enc(name)}&type=${enc(type)}`);
      box.innerHTML = '<h5 class="sub">Uses</h5>' + gridHtml(d.uses) + '<h5 class="sub">Used by</h5>' + gridHtml(d.usedBy);
    } else {
      const d = await oapi('/describe?table=' + enc(name));
      box.innerHTML = gridHtml(d[{ cols: 'columns', idx: 'indexes', con: 'constraints', stats: 'stats' }[k]]);
      if (k === 'stats') {
        box.insertAdjacentHTML('beforeend', '<p class="acts" style="padding-top:12px"><button id="oGather">Gather statistics</button></p>');
        $('#oGather').onclick = async () => { try { await post('/oracle/stats', { name }); setStatus('Statistics gathered.'); showTab('stats'); } catch (e) { setStatus(e.message, true); } };
      }
    }
    setStatus('');
  } catch (e) { box.innerHTML = ''; setStatus(e.message, true); }
}
$('#oType').onchange = $('#oFilter').oninput = drawObjects;
$('#oRefresh').onclick = loadObjects;
const _go = go; go = (p, x) => { _go(p, x); if (p === 'oracle') loadObjects(); };

// Output tab: DBMS_OUTPUT text and execution plans
const showOut = text => { $('#outtxt').textContent = text; flag('output', false); activateTab('output'); };
const _show = show;
show = r => {
  _show(r);
  if (r.output) { $('#outtxt').textContent = r.output; if (r.columns || r.error) flag('output', true); else activateTab('output'); }
};
$('#explain').onclick = async () => {
  if (!isOra()) return setStatus('Explain plan works on Oracle and MySQL connections.', true);
  const q = currentSql();
  setStatus('Building plan…');
  try { showOut((await post('/explain', { query: q })).plan); setStatus('Execution plan ready.'); } catch (e) { setStatus(e.message, true); }
};

// Transactions
$('#autoc').onchange = async e => {
  try { await post('/autocommit', { on: e.target.checked }); active.auto = e.target.checked; if (e.target.checked) setDirty(false);
    setStatus(e.target.checked ? 'Auto-commit is on.' : 'Auto-commit is off. Use Commit or Rollback to finish your changes.'); }
  catch (err) { e.target.checked = !e.target.checked; setStatus(err.message, true); }
};
const tx = (path, msg) => async () => { if (!active) return setStatus('Connect to a database first.', true); try { await post(path); setDirty(false); setStatus(msg); } catch (e) { setStatus(e.message, true); } };
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
  'DESC a table (SQL*Plus)': "DESC user_tables",
  'Compilation errors': "SHOW ERRORS",
  'Create user template': "CREATE USER app_user IDENTIFIED BY \"ChangeMe_123\"\n  DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp QUOTA UNLIMITED ON users;\nGRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE TO app_user;",
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
  if (isOra() && key === 'users') { go('users'); return; }
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

// Oracle server tools: recompile invalid objects, scheduler jobs, recycle bin
document.querySelectorAll('#oSrv button').forEach(b => b.onclick = async () => {
  if (!isOra()) return setStatus('Connect to an Oracle database first.', true);
  const k = b.dataset.s, box = $('#oBody');
  try {
    if (k === 'compile') {
      const r = await post('/oracle/compile-all'); await loadObjects();
      return setStatus(r.tried ? `Recompiled ${r.tried} object(s). ${r.stillInvalid} still invalid.` : 'No invalid objects found.', r.stillInvalid > 0);
    }
    if (k === 'purge') {
      if (!confirm('Permanently empty your recycle bin? Dropped tables cannot be restored afterwards.')) return;
      await post('/oracle/recyclebin/purge'); return setStatus('Recycle bin purged.');
    }
    pick = null; drawObjects(); $('#oTabs').innerHTML = '';
    box.innerHTML = gridHtml(await oapi(k === 'jobs' ? '/jobs' : '/recyclebin')); setStatus('');
  } catch (e) { setStatus(e.message, true); }
});
