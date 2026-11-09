// DBFusion Designer: create, rename, change and drop databases/schemas and tables in MySQL, PostgreSQL and Oracle.
// Every change shows its SQL first (the server builds it, see DdlBuilder.java) and only runs after you confirm.
PAGES.design = ['Home', 'Designer'];
const isSqlDb = () => ['mysql', 'postgresql', 'oracle'].includes(active?.type);
const dapi = (p, o) => api(`/connections/${active.id}/design${p}`, o);
const dpost = (p, body) => dapi(p, { method: 'POST', body: JSON.stringify(body) });
const D = { conn: null, ov: null, cont: null, want: null, wantT: null, tables: [], table: null, info: null, tab: 'columns', sys: false, filter: '', log: [], data: null, ddl: null };
let COLL = null;
const DTYPES = {
  mysql: ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'DECIMAL(10,2)', 'DOUBLE', 'BOOLEAN', 'JSON', 'BLOB'],
  postgresql: ['INTEGER', 'BIGINT', 'SMALLINT', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'NUMERIC(10,2)', 'DOUBLE PRECISION', 'BOOLEAN', 'JSONB', 'UUID', 'BYTEA'],
  oracle: ['NUMBER', 'NUMBER(10)', 'NUMBER(10,2)', 'VARCHAR2(255)', 'CHAR(10)', 'CLOB', 'BLOB', 'DATE', 'TIMESTAMP', 'FLOAT', 'RAW(16)']
};
const dq = n => active.type === 'mysql' ? '`' + n + '`' : '"' + n + '"';
const must = async p => { if (!(await p)) throw new Error('Cancelled. Nothing was changed.'); };
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const kindOf = n => D.tables.find(t => t.name === n)?.kind;

// ---------------------------------------------------------------- loading
async function loadDesign() {
  const gone = !active || !isSqlDb();
  if (gone || D.conn !== active.id) { Object.assign(D, { conn: gone ? null : active.id, ov: null, cont: null, tables: [], table: null, info: null, tab: 'columns', log: [], data: null, ddl: null }); COLL = null; }
  if (gone) {
    $('#dCont').innerHTML = ''; $('#dContBtns').innerHTML = ''; $('#dCur').innerHTML = ''; $('#dPg').hidden = true; $('#dTables').innerHTML = '<li class="empty">Nothing to show.</li>';
    $('#dMain').innerHTML = '<p class="empty">Connect to a MySQL, PostgreSQL or Oracle database (Home) to design databases and tables.</p>'; return;
  }
  try {
    D.ov = await dapi('/overview');
    const names = D.ov.containers.map(c => c.name);
    const want = D.want && names.find(n => n.toLowerCase() === D.want.toLowerCase()); D.want = null;
    D.cont = want || (names.includes(D.cont) ? D.cont : names.includes(D.ov.current) ? D.ov.current : (D.ov.containers.find(c => !c.system) || D.ov.containers[0])?.name || null);
    drawSide(); await loadDTables();
  } catch (e) { setStatus(e.message, true); }
}
async function loadDTables() {
  if (!D.cont) { D.tables = []; D.table = null; D.info = null; drawTableList(); drawMain(); return; }
  const r = await dapi('/tables?container=' + enc(D.cont));
  D.tables = r.tables;
  if (D.wantT) { D.table = D.tables.find(t => t.name.toLowerCase() === D.wantT.toLowerCase())?.name || null; D.wantT = null; D.tab = 'columns'; }
  if (D.table && !D.tables.some(t => t.name === D.table)) { D.table = null; D.info = null; }
  drawTableList();
  if (D.table) await openDTable(D.table, true); else drawMain();
}
async function openDTable(name, keepTab) {
  D.table = name; D.data = null; D.ddl = null; if (!keepTab) D.tab = 'columns';
  try { D.info = await dapi(`/table?container=${enc(D.cont)}&name=${enc(name)}`); }
  catch (e) { D.info = null; setStatus(e.message, true); }
  drawTableList(); drawMain();
}
async function loadDdl() {
  try { D.ddl = (await dapi(`/ddl?container=${enc(D.cont)}&name=${enc(D.table)}`)).ddl; } catch (e) { D.ddl = '-- ' + e.message; }
  drawMain();
}
async function loadData() {
  try { D.data = await api(`/connections/${active.id}/query`, { method: 'POST', body: JSON.stringify({ query: `SELECT * FROM ${dq(D.cont)}.${dq(D.table)}`, mode: 'single', maxRows: 100 }) }); }
  catch (e) { D.data = { error: e.message }; }
  drawMain();
}

// ---------------------------------------------------------------- left side
function drawSide() {
  const o = D.ov, my = o.type === 'mysql';
  $('#dLabel').textContent = o.label + 's';
  $('#dCont').innerHTML = o.containers.filter(c => D.sys || !c.system || c.name === D.cont).map(c => `<option${c.name === D.cont ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $('#dContBtns').innerHTML = o.canManageContainers
    ? `<button data-a="cNew">New</button><button data-a="cRename">Rename</button>${my ? '<button data-a="cCharset">Charset</button>' : ''}<button data-a="cDrop" class="danger">Drop</button>`
    : '<span class="muted">An Oracle schema is a user.</span> <button data-a="toUsers">User Manager</button>';
  $('#dCur').innerHTML = D.cont && D.cont !== o.current
    ? `SQL and Object Browser use <b>${esc(o.current || 'none')}</b>. <button class="mini" data-a="cUse">Use ${esc(D.cont)}</button>` : `SQL and Object Browser use <b>${esc(o.current || 'none')}</b>.`;
  const pgBox = $('#dPg');
  pgBox.hidden = o.type !== 'postgresql';
  if (!pgBox.hidden) {
    pgBox.querySelector('ul').innerHTML = (o.databases || []).map(d => `<li><span>${esc(d.name)}</span>${d.current ? '<small>connected</small>' : `<button class="mini" data-a="dbRename" data-n="${esc(d.name)}">Rename</button><button class="mini danger" data-a="dbDrop" data-n="${esc(d.name)}">Drop</button>`}</li>`).join('') || '<li class="empty">None.</li>';
  }
}
function drawTableList() {
  const f = $('#dFilter').value.toLowerCase(), ul = $('#dTables');
  const list = D.tables.filter(t => t.name.toLowerCase().includes(f));
  ul.innerHTML = !D.cont ? '<li class="empty">Nothing to show.</li>' : list.length ? list.map(t => `<li data-a="tOpen" data-n="${esc(t.name)}" class="${t.name === D.table ? 'on' : ''}"><span title="${esc(t.name)}">${esc(t.name)}</span>${t.kind === 'VIEW' ? '<small>view</small>' : ''}</li>`).join('') : '<li class="empty">No tables.</li>';
}
$('#dCont').onchange = async e => { D.cont = e.target.value; D.table = null; D.info = null; try { drawSide(); await loadDTables(); } catch (x) { setStatus(x.message, true); } };
$('#dSys').onchange = e => { D.sys = e.target.checked; if (D.ov) drawSide(); };
$('#dFilter').oninput = drawTableList;
$('#dNewTable').onclick = () => guard(() => tNew());
$('#dReload').onclick = () => guard(loadDesign);

// ---------------------------------------------------------------- main area
function drawMain() {
  const m = $('#dMain');
  if (!D.cont) { m.innerHTML = '<p class="empty">No databases or schemas to show.</p>'; return; }
  if (!D.table || !D.info) {
    m.innerHTML = `<div class="wbhead"><h3>${esc(D.cont)} <small>${D.tables.length} table${D.tables.length === 1 ? '' : 's'}</small></h3><span class="grow"></span><button data-a="erd">ER diagram</button><button data-a="vNew">New view</button><button class="primary" data-a="tNew">New table</button></div>` +
      (D.tables.length ? '<p class="muted">Pick a table on the left to change its columns, keys, indexes and checks, or open the ER diagram to see how the tables connect.</p>' : `<p class="empty">This ${D.ov.label.toLowerCase()} has no tables yet.</p>`);
    return;
  }
  const i = D.info, view = kindOf(D.table) === 'VIEW', tab = view && ['indexes', 'fks', 'checks'].includes(D.tab) ? 'columns' : D.tab;
  const tabs = [['columns', `Columns (${i.columns.length})`], ...(view ? [] : [['indexes', `Indexes & keys (${i.indexes.length})`], ['fks', `Foreign keys (${i.foreignKeys.length})`], ['checks', `Checks (${i.checks.length})`]]), ['ddl', 'DDL'], ['data', 'Data'], ['log', `Changes (${D.log.length})`]];
  m.innerHTML = `<div class="wbhead"><h3>${esc(D.table)} <small>${view ? 'view' : 'table'} in ${esc(D.cont)}</small></h3><span class="grow"></span>` +
    `<button data-a="editData" class="primary" title="Open in the Object Browser: double-click cells to edit, add and delete rows">Edit data</button>` +
    (view ? '<button data-a="vEdit">Edit view</button><button data-a="vDrop" class="danger">Drop view</button>' : '<button data-a="tComment">Comment</button><button data-a="tRename">Rename</button><button data-a="tDup">Duplicate</button><button data-a="tTrunc" class="danger">Empty</button><button data-a="tDrop" class="danger">Drop</button>') + '</div>' +
    (i.comment ? `<p class="muted dnote">${esc(i.comment)}</p>` : '') +
    `<div class="rtabs wbtabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="pane wbpane dpane">${tabHtml(tab, view)}</div>`;
  m.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { D.tab = b.dataset.tab; if (D.tab === 'data' && !D.data) { drawMain(); loadData(); } else if (D.tab === 'ddl' && D.ddl == null) { drawMain(); loadDdl(); } else drawMain(); });
  if (tab === 'data' && !D.data) loadData();
  if (tab === 'ddl' && D.ddl == null) loadDdl();
}
function tabHtml(tab, view) {
  const i = D.info;
  if (tab === 'columns') return (view ? '' : '<div class="dtools"><button data-a="colAdd" class="primary">Add column</button></div>') +
    `<div class="scroll"><table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th>Comment</th><th></th></tr></thead><tbody>${i.columns.map((c, n) =>
      `<tr><td>${n + 1}</td><td><b>${esc(c.name)}</b></td><td><code>${esc(c.type)}</code></td><td>${c.nullable ? 'yes' : '<b>no</b>'}</td><td>${c.default == null ? '<i>none</i>' : `<code>${esc(c.default)}</code>`}</td>` +
      `<td>${c.pk ? '<span class="badge ok">PK</span>' : ''}${c.auto ? ' <span class="badge mute">auto</span>' : ''}</td><td class="muted" title="${esc(c.comment || '')}">${esc(c.comment || '')}</td><td class="act">${view ? '' : `<button class="mini" data-a="colEdit" data-n="${esc(c.name)}">Edit</button> <button class="mini danger" data-a="colDrop" data-n="${esc(c.name)}">Drop</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  if (tab === 'indexes') return `<div class="dtools"><button data-a="ixNew" class="primary">Add index</button><button data-a="uqNew">Add unique constraint</button>${i.primaryKey.columns.length ? '' : '<button data-a="pkNew">Add primary key</button>'}</div>` +
    (i.indexes.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Kind</th><th>Columns</th><th></th></tr></thead><tbody>${i.indexes.map(x =>
      `<tr><td><b>${esc(x.name)}</b></td><td>${x.primary ? '<span class="badge ok">PRIMARY KEY</span>' : x.unique ? '<span class="badge warn">UNIQUE</span>' : '<span class="badge mute">INDEX</span>'}</td><td><code>${esc(x.columns.join(', '))}</code></td>` +
      `<td class="act"><button class="mini danger" data-a="${x.primary ? 'pkDrop' : 'ixDrop'}" data-n="${esc(x.name)}">Drop</button></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No indexes or keys on this table.</p>');
  if (tab === 'fks') return '<div class="dtools"><button data-a="fkNew" class="primary">Add foreign key</button></div>' +
    (i.foreignKeys.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Columns</th><th>References</th><th>On delete</th><th></th></tr></thead><tbody>${i.foreignKeys.map(x =>
      `<tr><td><b>${esc(x.name)}</b></td><td><code>${esc(x.columns.join(', '))}</code></td><td><code>${esc(x.refTable)} (${esc(x.refColumns.join(', '))})</code>${x.refContainer && x.refContainer !== D.cont ? ` <small>in ${esc(x.refContainer)}</small>` : ''}</td><td>${esc(x.onDelete)}</td>` +
      `<td class="act"><button class="mini danger" data-a="fkDrop" data-n="${esc(x.name)}">Drop</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No foreign keys on this table.</p>');
  if (tab === 'checks') return '<div class="dtools"><button data-a="chkNew" class="primary">Add check</button></div>' +
    (i.checks.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Condition</th><th></th></tr></thead><tbody>${i.checks.map(x => `<tr><td><b>${esc(x.name)}</b></td><td><code>${esc(x.expr)}</code></td><td class="act"><button class="mini danger" data-a="chkDrop" data-n="${esc(x.name)}">Drop</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No check constraints on this table.</p>');
  if (tab === 'ddl') return D.ddl == null ? '<p class="empty">Loading…</p>' : `<div class="dtools"><button data-a="copyDdl">Copy</button></div><pre class="sqlpre">${esc(D.ddl)}</pre>`;
  if (tab === 'data') return D.data ? (D.data.error ? `<p class="empty">${esc(D.data.error)}</p>` : `<p class="muted dnote">First 100 rows, read only. Use <b>Edit data</b> to change rows.</p>` + gridHtml(D.data)) : '<p class="empty">Loading…</p>';
  return D.log.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>SQL</th></tr></thead><tbody>${D.log.map(l => `<tr><td>${esc(l.t)}</td><td><code>${esc(l.q)}</code></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Changes you make here this session appear in this list.</p>';
}

// ---------------------------------------------------------------- review and run
const dSql = $('#dSql');
function review(list, opt = {}) {
  return new Promise(resolve => {
    $('#dSqlT').textContent = opt.title || 'Review SQL';
    $('#dSqlPre').textContent = list.map(q => q + ';').join('\n\n');
    $('#dSqlWarn').textContent = opt.note || '';
    const yes = $('#dSqlYes'), need = opt.type;
    $('#dSqlTypeRow').hidden = !need; $('#dSqlName').textContent = need || ''; $('#dSqlType').value = '';
    yes.disabled = !!need; yes.textContent = opt.button || 'Run';
    $('#dSqlType').oninput = () => { yes.disabled = $('#dSqlType').value !== need; };
    let done = false;
    const fin = v => { if (done) return; done = true; if (dSql.open) dSql.close(); resolve(v); };
    $('#dSqlNo').onclick = () => fin(false);
    dSql.onclose = () => fin(false);
    $('#dSqlF').onsubmit = e => { e.preventDefault(); if (!yes.disabled) fin(true); };
    $('#dSqlCopy').onclick = () => copyText(list.map(q => q + ';').join('\n'), 'SQL copied.');
    dSql.showModal();
  });
}
/** Builds the SQL on the server (nothing runs yet), shows it, and runs it after you confirm. Returns false if you cancel. */
async function change(ops, opt = {}) {
  const all = ops.map(o => ({ container: D.cont, ...o }));
  const sqls = [];
  for (const o of all) sqls.push(...(await dpost('/apply', { ...o, dryRun: true })).sql);
  if (!(await review(sqls, opt))) return false;
  let last = null;
  try { for (const o of all) last = await dpost('/apply', o); }
  catch (e) { loadDesign().catch(() => {}); throw e; }
  const t = new Date().toLocaleTimeString();
  sqls.slice().reverse().forEach(q => D.log.unshift({ t, q }));
  colCache = {};
  if (D.ov && D.cont === D.ov.current) refreshTables().catch(() => {});
  setStatus(last?.pending ? 'Done. PostgreSQL has not committed this yet: press Commit on SQL Commands, or turn Auto-commit on.' : 'Done.');
  return true;
}
async function guard(fn) { try { await fn(); } catch (e) { if (e?.message) setStatus(e.message, true); } }
function dask(title, html, ok, o = {}) {
  ask(title, `<datalist id="dtypes">${(DTYPES[active.type] || []).map(t => `<option value="${t}">`).join('')}</datalist>` + html, ok);
  d2.classList.toggle('wide', !!o.wide);
  d2f.querySelector('button.primary').textContent = o.btn || 'Review SQL…';
}
const names = () => D.info.columns.map(c => c.name);
const colChecks = (field, cols, pre = []) => cols.map(c => `<label class="chk"><input type="checkbox" name="${field}" value="${esc(c.name)}"${pre.includes(c.name) ? ' checked' : ''}> ${esc(c.name)} <small>${esc(c.type)}</small></label>`).join('');

// ---------------------------------------------------------------- databases and schemas
async function collations() {
  if (COLL) return COLL;
  try { COLL = (await api(`/connections/${active.id}/mysql/wb/collations`)).rows.map(r => ({ cs: r[0], co: r[1] })); } catch { COLL = []; }
  return COLL;
}
const collLists = c => `<datalist id="dcs">${[...new Set(c.map(x => x.cs))].map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="dco">${c.map(x => `<option value="${esc(x.co)}">`).join('')}</datalist>`;
const refreshAll = async () => { D.table = null; D.info = null; await loadDesign(); };

async function cNew() {
  const my = D.ov.type === 'mysql', c = my ? await collations() : [];
  dask('New ' + D.ov.label.toLowerCase(), '<label>Name <input name="name" required autocomplete="off"></label>' + (my ?
    collLists(c) + '<label>Character set (optional) <input name="cs" list="dcs" placeholder="utf8mb4" autocomplete="off"></label><label>Collation (optional) <input name="co" list="dco" autocomplete="off"></label>' : ''),
  async f => {
    const name = f.get('name').trim();
    await must(change([{ op: 'createContainer', name, charset: f.get('cs'), collation: f.get('co') }], { title: 'Create ' + D.ov.label.toLowerCase(), button: 'Create' }));
    D.want = name; await refreshAll();
  });
}
function cRename() {
  const my = D.ov.type === 'mysql';
  dask('Rename ' + D.ov.label.toLowerCase(), `<label>New name <input name="name" required autocomplete="off" value="${esc(D.cont)}"></label>` +
    (my ? '<p class="hint">MySQL has no rename for databases. DBFusion creates the new database, moves every table into it and drops the old one. It refuses if the database has views, routines or events. Privileges granted on the old database are not copied.</p>' : ''),
  async f => {
    const name = f.get('name').trim();
    await must(change([{ op: 'renameContainer', name: D.cont, newName: name }], { title: 'Rename ' + D.ov.label.toLowerCase(), button: 'Rename' }));
    D.want = name; await refreshAll();
  });
}
async function cCharset() {
  const c = await collations();
  dask('Character set of ' + D.cont, collLists(c) + '<label>Character set <input name="cs" list="dcs" autocomplete="off"></label><label>Collation <input name="co" list="dco" autocomplete="off"></label><p class="hint">This only changes the default for new tables. Existing tables keep theirs.</p>',
    async f => { await must(change([{ op: 'alterContainer', name: D.cont, charset: f.get('cs'), collation: f.get('co') }], { title: 'Change defaults', button: 'Change' })); await refreshAll(); });
}
async function cDrop() {
  const n = D.cont, drop = cascade => must(change([{ op: 'dropContainer', name: n, cascade }], { title: `Drop ${D.ov.label.toLowerCase()} ${n}`, type: n, button: 'Drop', note: 'Everything inside it is deleted. This cannot be undone.' })).then(() => { D.cont = null; return refreshAll(); });
  if (D.ov.type === 'postgresql') dask('Drop schema ' + n, '<label class="chk"><input type="checkbox" name="cascade"> Also drop every table and object inside it (CASCADE)</label><p class="hint">Without CASCADE, PostgreSQL refuses to drop a schema that still has objects.</p>', f => drop(f.has('cascade')), { btn: 'Continue…' });
  else await drop(false);
}
const cUse = async () => { await dpost('/use', { container: D.cont }); setStatus(`SQL and Object Browser now use ${D.cont}.`); await loadDesign(); await refreshTables().catch(() => {}); };

// PostgreSQL databases on the server
function dbNew() {
  dask('New database', '<label>Name <input name="name" required autocomplete="off"></label><p class="hint">To work inside it, connect to it from Home. A connection stays in one database.</p>',
    async f => { await must(change([{ op: 'createDatabase', name: f.get('name').trim() }], { title: 'Create database', button: 'Create' })); await loadDesign(); });
}
function dbRename(n) {
  dask('Rename database ' + n, `<label>New name <input name="name" required autocomplete="off" value="${esc(n)}"></label><p class="hint">PostgreSQL needs nobody else connected to it.</p>`,
    async f => { await must(change([{ op: 'renameDatabase', name: n, newName: f.get('name').trim() }], { title: 'Rename database', button: 'Rename' })); await loadDesign(); });
}
const dbDrop = n => change([{ op: 'dropDatabase', name: n }], { title: 'Drop database ' + n, type: n, button: 'Drop', note: 'Every schema and table in it is deleted. This cannot be undone.' }).then(ok => ok && loadDesign());

// ---------------------------------------------------------------- tables
const colRow = () => '<div class="dcol"><input class="n" placeholder="name" autocomplete="off"><input class="t" list="dtypes" placeholder="type" autocomplete="off"><input class="df" placeholder="default" autocomplete="off">' +
  '<label class="chk" title="Primary key"><input type="checkbox" class="pk">PK</label><label class="chk" title="Not null"><input type="checkbox" class="nn">NN</label><label class="chk" title="Unique"><input type="checkbox" class="uq">UQ</label><label class="chk" title="Auto-increment / identity"><input type="checkbox" class="ai">Auto</label></div>';
const readCols = () => [...d2f.querySelectorAll('.dcol')].map(r => ({ name: r.querySelector('.n').value.trim(), type: r.querySelector('.t').value.trim(), def: r.querySelector('.df').value,
  pk: r.querySelector('.pk').checked, notNull: r.querySelector('.nn').checked, unique: r.querySelector('.uq').checked, auto: r.querySelector('.ai').checked })).filter(c => c.name || c.type);

function tNew() {
  dask('New table', '<label>Table name <input name="name" required autocomplete="off"></label><div class="dcolhead"><span>Column</span><span>Type</span><span>Default</span><span>PK</span><span>NN</span><span>UQ</span><span>Auto</span></div>' +
    `<div id="dcols">${colRow().repeat(3)}</div><button type="button" id="dMore">Add another column</button><p class="hint">Text defaults are quoted for you. Numbers, NULL and CURRENT_TIMESTAMP are used as they are. Auto = AUTO_INCREMENT (MySQL) or IDENTITY (PostgreSQL, Oracle 12c+).</p>`,
  async f => {
    const name = f.get('name').trim();
    await must(change([{ op: 'createTable', name, columns: readCols() }], { title: 'Create table', button: 'Create' }));
    D.wantT = name; await loadDTables();
  }, { wide: true });
  $('#dMore').onclick = () => $('#dcols').insertAdjacentHTML('beforeend', colRow());
}
function tRename() {
  dask('Rename table', `<label>New name <input name="name" required autocomplete="off" value="${esc(D.table)}"></label>`,
    async f => { const name = f.get('name').trim(); await must(change([{ op: 'renameTable', table: D.table, name }], { title: 'Rename table', button: 'Rename' })); D.wantT = name; await loadDTables(); });
}
function tDup() {
  dask('Duplicate table', `<label>Name of the copy <input name="name" required autocomplete="off" value="${esc(D.table)}_copy"></label><label class="chk"><input type="checkbox" name="data" checked> Copy the rows too</label><p class="hint">The database copies columns and rows only. Keys, indexes and defaults are not copied.</p>`,
    async f => { const name = f.get('name').trim(); await must(change([{ op: 'duplicate', table: D.table, name, withData: f.has('data') }], { title: 'Duplicate table', button: 'Create copy' })); D.wantT = name; await loadDTables(); });
}
const tTrunc = () => change([{ op: 'truncate', table: D.table }], { title: 'Delete all rows of ' + D.table, type: D.table, button: 'Delete all rows', note: 'Every row is removed and the table structure stays. This cannot be undone.' }).then(ok => ok && openDTable(D.table, true));
function tDrop() {
  const drop = cascade => must(change([{ op: 'dropTable', table: D.table, cascade }], { title: 'Drop table ' + D.table, type: D.table, button: 'Drop table', note: 'The table and all its rows are deleted. This cannot be undone.' })).then(() => { D.table = null; D.info = null; return loadDTables(); });
  if (active.type === 'mysql') return drop(false);
  dask('Drop table ' + D.table, `<label class="chk"><input type="checkbox" name="cascade"> Also drop things that depend on it (${active.type === 'oracle' ? 'foreign keys from other tables' : 'views and foreign keys'})</label>`, f => drop(f.has('cascade')), { btn: 'Continue…' });
}

// ---------------------------------------------------------------- columns
function colAdd() {
  dask('Add column to ' + D.table, '<label>Name <input name="name" required autocomplete="off"></label><label>Type <input name="type" list="dtypes" required autocomplete="off" placeholder="e.g. VARCHAR(100)"></label><label>Default (optional) <input name="def" autocomplete="off"></label>' +
    '<label class="chk"><input type="checkbox" name="nn"> Not null</label><label class="chk"><input type="checkbox" name="uq"> Unique</label><p class="hint">Not null on a table that already has rows needs a default.</p>',
  async f => {
    await must(change([{ op: 'addColumn', table: D.table, col: { name: f.get('name').trim(), type: f.get('type').trim(), def: f.get('def'), notNull: f.has('nn'), unique: f.has('uq') } }], { title: 'Add column', button: 'Add column' }));
    await openDTable(D.table, true);
  });
}
function colEdit(n) {
  const c = D.info.columns.find(x => x.name === n); if (!c) return;
  dask('Edit column ' + n, `<label>Name <input name="name" required autocomplete="off" value="${esc(c.name)}"></label><label>Type <input name="type" list="dtypes" required autocomplete="off" value="${esc(c.type)}"></label>` +
    `<label class="chk"><input type="checkbox" name="nul"${c.nullable ? ' checked' : ''}> Allow NULL</label><label>Default <input name="def" autocomplete="off" value="${esc(c.default ?? '')}"></label><label>Comment <input name="cm" autocomplete="off" value="${esc(c.comment || '')}"></label><p class="hint">Leave the default empty for none. Changing the type converts the existing values and fails if some do not fit.</p>`,
  async f => {
    const o = { op: 'modifyColumn', table: D.table, column: c.name }, ops = [];
    const type = f.get('type').trim(), nul = f.has('nul'), def = f.get('def'), name = f.get('name').trim();
    if (norm(type) !== norm(c.type)) o.type = type;
    if (nul !== c.nullable) o.nullable = nul;
    if (def !== (c.default ?? '')) { o.defMode = def === '' ? 'drop' : 'set'; o.defValue = def; }
    const cm = f.get('cm'), cmChanged = cm !== (c.comment || '');
    if (cmChanged && active.type === 'mysql') o.comment = cm;
    if (o.type !== undefined || o.nullable !== undefined || o.defMode || o.comment !== undefined) ops.push(o);
    if (cmChanged && active.type !== 'mysql') ops.push({ op: 'commentColumn', table: D.table, column: c.name, text: cm });
    if (name !== c.name) ops.push({ op: 'renameColumn', table: D.table, column: c.name, name });
    if (!ops.length) throw new Error('Nothing changed.');
    await must(change(ops, { title: 'Change column ' + c.name, button: 'Apply' }));
    await openDTable(D.table, true);
  });
}
const colDrop = n => change([{ op: 'dropColumn', table: D.table, column: n }], { title: `Drop column ${n}`, button: 'Drop column', note: 'The data in this column is deleted. This cannot be undone.' }).then(ok => ok && openDTable(D.table, true));

// ---------------------------------------------------------------- indexes, keys, foreign keys
function keyDlg(kind) {
  const titles = { index: 'New index', unique: 'New unique constraint', primary: 'New primary key' }, req = kind === 'index';
  dask(titles[kind], `<label>Name${req ? '' : ' (optional)'} <input name="name" ${req ? 'required' : ''} autocomplete="off" placeholder="${req ? 'ix_' + esc(D.table).toLowerCase() : ''}"></label><p class="hint">Columns (used in table order):</p>${colChecks('col', D.info.columns)}` +
    (req ? '<label class="chk"><input type="checkbox" name="unique"> Unique index</label>' : ''),
  async f => {
    const columns = f.getAll('col'); if (!columns.length) throw new Error('Tick at least one column.');
    const op = { index: 'addIndex', unique: 'addUnique', primary: 'addPrimaryKey' }[kind], name = f.get('name').trim();
    await must(change([{ op, table: D.table, name: name || undefined, columns, unique: f.has('unique') }], { title: titles[kind], button: 'Create' }));
    await openDTable(D.table, true);
  });
}
const ixDrop = n => change([{ op: 'dropIndex', table: D.table, name: n }], { title: 'Drop ' + n, button: 'Drop' }).then(ok => ok && openDTable(D.table, true));
const pkDrop = () => change([{ op: 'dropPrimaryKey', table: D.table }], { title: 'Drop primary key', button: 'Drop primary key', note: 'This fails if another table has a foreign key that points at it.' }).then(ok => ok && openDTable(D.table, true));
const fkDrop = n => change([{ op: 'dropForeignKey', table: D.table, name: n }], { title: 'Drop foreign key ' + n, button: 'Drop' }).then(ok => ok && openDTable(D.table, true));

function fkNew() {
  const refs = D.tables.filter(t => t.kind === 'TABLE');
  if (!refs.length) throw new Error('There is no table to point at.');
  dask('New foreign key', `<label>Name (optional) <input name="name" autocomplete="off"></label><p class="hint">Columns in ${esc(D.table)}:</p>${colChecks('col', D.info.columns)}` +
    `<label>References table <select name="rt" id="fkRt">${refs.map(t => `<option${t.name === D.table ? '' : ''}>${esc(t.name)}</option>`).join('')}</select></label><p class="hint">Columns there (same number and order):</p><div id="fkRc"></div>` +
    `<label>When the referenced row is deleted <select name="od"><option value="">Do nothing (default)</option><option>CASCADE</option><option>SET NULL</option>${active.type === 'oracle' ? '' : '<option>RESTRICT</option><option>NO ACTION</option>'}</select></label>`,
  async f => {
    const columns = f.getAll('col'), refColumns = f.getAll('rcol');
    if (!columns.length || columns.length !== refColumns.length) throw new Error('Tick the same number of columns on both sides.');
    await must(change([{ op: 'addForeignKey', table: D.table, name: f.get('name').trim() || undefined, columns, refTable: f.get('rt'), refColumns, onDelete: f.get('od') }], { title: 'Create foreign key', button: 'Create' }));
    D.tab = 'fks'; await openDTable(D.table, true);
  });
  const fill = async () => {
    const box = $('#fkRc'), t = $('#fkRt').value; box.innerHTML = '<span class="muted">Loading…</span>';
    try { const r = t === D.table ? D.info : await dapi(`/table?container=${enc(D.cont)}&name=${enc(t)}`); box.innerHTML = colChecks('rcol', r.columns, r.primaryKey.columns); }
    catch (e) { box.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  $('#fkRt').onchange = fill; fill();
}

// ---------------------------------------------------------------- checks, comments, views
function chkNew() {
  dask('New check on ' + D.table, '<label>Name (optional) <input name="name" autocomplete="off"></label><label>Condition <input name="expr" required autocomplete="off" placeholder="price > 0"></label><p class="hint">Every existing row must satisfy it. One condition, no semicolons. MySQL needs 8.0.19 or newer.</p>',
    async f => { await must(change([{ op: 'addCheck', table: D.table, name: f.get('name').trim() || undefined, expr: f.get('expr') }], { title: 'Create check', button: 'Create' })); D.tab = 'checks'; await openDTable(D.table, true); });
}
const chkDrop = n => change([{ op: 'dropCheck', table: D.table, name: n }], { title: 'Drop check ' + n, button: 'Drop' }).then(ok => ok && openDTable(D.table, true));
function tComment() {
  dask('Comment on ' + D.table, `<label>Comment <input name="text" autocomplete="off" value="${esc(D.info.comment || '')}"></label><p class="hint">Leave empty to remove it.</p>`,
    async f => { await must(change([{ op: 'commentTable', table: D.table, text: f.get('text') }], { title: 'Table comment', button: 'Save' })); await openDTable(D.table, true); });
}
function viewDlg(name, def) {
  const edit = !!name;
  dask(edit ? 'Edit view ' + name : 'New view', (edit ? '' : '<label>Name <input name="name" required autocomplete="off"></label>') +
    `<label>SELECT statement <textarea name="sel" rows="9" required spellcheck="false" style="font-family:var(--mono)">${esc(def || '')}</textarea></label>` +
    (edit ? '' : '<label class="chk"><input type="checkbox" name="rep"> Replace it if it already exists</label>') + '<p class="hint">One SELECT (or WITH ... SELECT), no semicolons or comments. The view is created in the selected ' + D.ov.label.toLowerCase() + '.</p>',
  async f => {
    const n = edit ? name : f.get('name').trim();
    await must(change([{ op: 'createView', name: n, select: f.get('sel'), replace: edit || f.has('rep') }], { title: edit ? 'Change view' : 'Create view', button: edit ? 'Change view' : 'Create view' }));
    D.wantT = n; await loadDTables();
  }, { wide: true });
}
const vNew = () => viewDlg();
async function vEdit() { viewDlg(D.table, (await dapi(`/view?container=${enc(D.cont)}&name=${enc(D.table)}`)).definition); }
const vDrop = () => change([{ op: 'dropView', table: D.table }], { title: 'Drop view ' + D.table, button: 'Drop view', type: D.table }).then(ok => { if (ok) { D.table = null; D.info = null; return loadDTables(); } });

// ---------------------------------------------------------------- ER diagram
let erdSvgText = '';
async function erd() {
  const m = $('#dMain'); m.innerHTML = '<p class="empty">Drawing…</p>';
  const r = await dapi('/erd?container=' + enc(D.cont));
  const W = 210, H = 22, PAD = 40, cols = Math.max(1, Math.ceil(Math.sqrt(r.tables.length))), pos = {}, rowH = [];
  r.tables.forEach((t, i) => { const rw = Math.floor(i / cols); rowH[rw] = Math.max(rowH[rw] || 0, H * (t.columns.length + 1) + 8); });
  const rowY = []; let y = PAD; rowH.forEach((h, i) => { rowY[i] = y; y += h + PAD; });
  r.tables.forEach((t, i) => { pos[t.name] = { x: PAD + (i % cols) * (W + PAD * 1.4), y: rowY[Math.floor(i / cols)], h: H * (t.columns.length + 1) + 8, t }; });
  const fkCols = new Set(r.links.flatMap(l => l.columns.map(c => l.from + '.' + c)));
  const width = PAD * 2 + cols * (W + PAD * 1.4), height = y;
  const line = l => { const a = pos[l.from], b = pos[l.to]; if (!a || !b) return '';
    return `<line x1="${a.x + W / 2}" y1="${a.y + a.h / 2}" x2="${b.x + W / 2}" y2="${b.y + b.h / 2}" stroke="#5b5bf0" stroke-width="1.5" opacity=".7"><title>${esc(l.from)}(${esc(l.columns.join(','))}) -> ${esc(l.to)}(${esc(l.refColumns.join(','))})</title></line>`; };
  const box = p => `<g><rect x="${p.x}" y="${p.y}" width="${W}" height="${p.h}" rx="8" fill="#fff" stroke="#5b5bf0"/><rect x="${p.x}" y="${p.y}" width="${W}" height="${H + 4}" rx="8" fill="#5b5bf0"/>` +
    `<text x="${p.x + 10}" y="${p.y + 17}" fill="#fff" font-weight="700" font-size="13" font-family="sans-serif">${esc(p.t.name)}</text>` +
    p.t.columns.map((c, i) => `<text x="${p.x + 10}" y="${p.y + H + 20 + i * H}" font-size="12" font-family="monospace" fill="#0f1b33"${c.pk ? ' font-weight="700"' : ''}${fkCols.has(p.t.name + '.' + c.name) ? ' font-style="italic"' : ''}>${esc(c.name)}</text>`).join('') + '</g>';
  erdSvgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f2f5fb"/>${r.links.map(line).join('')}${Object.values(pos).map(box).join('')}</svg>`;
  m.innerHTML = `<div class="wbhead"><h3>ER diagram <small>${esc(D.cont)} · ${r.tables.length} tables · ${r.links.length} foreign keys${r.truncated ? ' · first 40 tables only' : ''}</small></h3><span class="grow"></span><button data-a="erdSvg">Download SVG</button><button data-a="erdBack">Back</button></div>` +
    (r.tables.length ? `<div class="pane wbpane erdbox">${erdSvgText}</div><p class="muted dnote">Bold = primary key, italic = foreign key column. Lines join a table to the table it references.</p>` : '<p class="empty">No tables to draw.</p>');
}
function erdSvg() {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([erdSvgText], { type: 'image/svg+xml' })); a.download = `${D.cont}-er-diagram.svg`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- Edit data hands over to the Object Browser
async function editData() {
  if (D.ov.current !== D.cont) { await dpost('/use', { container: D.cont }); D.ov.current = D.cont; drawSide(); setStatus(`SQL and Object Browser now use ${D.cont}.`); }
  await refreshTables(); colCache = {}; await browse(D.table);
}

// ---------------------------------------------------------------- clicks
const DACT = { cNew, cRename, cCharset, cDrop, cUse, dbNew, dbRename, dbDrop, tNew, tRename, tDup, tTrunc, tDrop, colAdd, colEdit, colDrop, ixNew: () => keyDlg('index'), uqNew: () => keyDlg('unique'), pkNew: () => keyDlg('primary'),
  ixDrop, pkDrop, fkNew, fkDrop, editData, toUsers: () => go('users'), tOpen: n => openDTable(n), chkNew, chkDrop, tComment, vNew, vEdit, vDrop, erd, erdSvg, erdBack: () => drawMain(), copyDdl: () => copyText(D.ddl || '', 'DDL copied.') };
$('#p-design').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || !DACT[b.dataset.a] || !$('#p-design').contains(b)) return;
  if (b.tagName === 'LI' && e.target.closest('button')) return;
  guard(() => DACT[b.dataset.a](b.dataset.n));
});

// page hooks: load when opened, hide the tab for MongoDB
const _goD = go; go = (p, x) => { _goD(p, x); if (p === 'design') loadDesign(); };
const _syncD = syncTabs; syncTabs = () => { _syncD(); const t = document.querySelector('#tabs [data-p=design]'); if (t) t.hidden = !!active && !isSqlDb(); };
syncTabs();
