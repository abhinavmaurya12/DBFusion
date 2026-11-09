// DBFusion MySQL Workbench: navigator with every schema, schema overview, table inspector
PAGES.wb = ['Home', 'MySQL Workbench'];
const wapi = (p, o) => api(`/connections/${active.id}/mysql/wb${p}`, o);
let wbList = [], wbSystem = [], wbObjs = {}, wbOpen = new Set(), wbCur = null, wbTbl = null, wbPart = 'data';
const _go4 = go; go = (p, x) => { _go4(p, x); if (p === 'wb') loadWb(); };
const q2 = (db, t) => '`' + db + '`.`' + t + '`';
const fmtMb = v => v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB';

async function loadWb() {
  if (!isMy()) { wbList = []; $('#wbTree').innerHTML = '<li class="empty">Connect to a MySQL server (Home) to see its schemas.</li>'; $('#wbMain').innerHTML = '<p class="empty">Connect to a MySQL server (Home) to see its schemas.</p>'; return; }
  try {
    const d = await wapi('/schemas');
    wbList = d.rows.map(r => ({ name: r[0], charset: r[1], collation: r[2], tables: r[3], views: r[4], size: r[5] }));
    wbSystem = d.system; wbCur = wbCur && wbList.some(s => s.name === wbCur) ? wbCur : null;
    drawWbTree(); wbCur ? (wbTbl ? openWbTable(wbCur, wbTbl, wbPart) : openWbSchema(wbCur)) : drawWbOverview();
    if (!wbList.length) setStatus('This MySQL user can not see any schema. Ask an admin to GRANT privileges on your schemas.', true);
  } catch (e) { setStatus(e.message, true); }
}
const visibleSchemas = () => wbList.filter(s => $('#wbSys').checked || !wbSystem.includes(s.name.toLowerCase()));

function drawWbTree() {
  const f = $('#wbFilter').value.toLowerCase(), ul = $('#wbTree'); let html = '';
  for (const s of visibleSchemas()) {
    const o = wbObjs[s.name], tm = o ? o.tables.rows.filter(t => t[0].toLowerCase().includes(f)) : [];
    if (f && !s.name.toLowerCase().includes(f) && !tm.length) continue;
    const open = wbOpen.has(s.name) || (f && tm.length);
    html += `<li class="wbs${wbCur === s.name && !wbTbl ? ' on' : ''}" data-s="${esc(s.name)}"><i class="car">${open ? '▾' : '▸'}</i><span title="${esc(s.name)}">${esc(s.name)}</span><small>${s.tables} tables</small></li>`;
    if (open) {
      if (!o) { html += '<li class="wbn empty">Loading…</li>'; continue; }
      const tbl = o.tables.rows.filter(t => t[1] === 'BASE TABLE' && t[0].toLowerCase().includes(f)), vw = o.tables.rows.filter(t => t[1] === 'VIEW' && t[0].toLowerCase().includes(f)), rt = o.routines.rows;
      const grp = (label, items, kind) => items.length ? `<li class="wbg">${label} (${items.length})</li>` + items.map(t => `<li class="wbn${wbCur === s.name && wbTbl === t[0] ? ' on' : ''}" data-s="${esc(s.name)}" data-t="${esc(t[0])}" data-k="${kind}"><span title="${esc(t[0])}">${esc(t[0])}</span></li>`).join('') : '';
      html += grp('Tables', tbl, 'table') + grp('Views', vw, 'table') + (f ? '' : (rt.length ? `<li class="wbg">Routines (${rt.length})</li>` + rt.map(r => `<li class="wbn r" title="${esc(r[1])}"><span>${esc(r[0])}</span><small>${esc(r[1].toLowerCase())}</small></li>`).join('') : ''));
      if (!tbl.length && !vw.length && !rt.length) html += '<li class="wbn empty">Empty schema</li>';
    }
  }
  ul.innerHTML = html || '<li class="empty">No schemas to show.</li>';
  ul.querySelectorAll('li.wbs').forEach(li => li.onclick = async e => {
    const n = li.dataset.s;
    if (e.target.classList.contains('car')) { await toggleWb(n); return; }
    if (!wbOpen.has(n)) await toggleWb(n, true); openWbSchema(n);
  });
  ul.querySelectorAll('li[data-t]').forEach(li => li.onclick = () => openWbTable(li.dataset.s, li.dataset.t, 'data'));
}
async function toggleWb(n, forceOpen) {
  if (wbOpen.has(n) && !forceOpen) wbOpen.delete(n); else wbOpen.add(n);
  drawWbTree();
  if (wbOpen.has(n) && !wbObjs[n]) { try { wbObjs[n] = await wapi('/objects?db=' + enc(n)); } catch (e) { wbOpen.delete(n); setStatus(e.message, true); } drawWbTree(); }
}
$('#wbFilter').oninput = async () => { const f = $('#wbFilter').value; if (f) for (const s of visibleSchemas()) if (!wbObjs[s.name]) { try { wbObjs[s.name] = await wapi('/objects?db=' + enc(s.name)); } catch {} } drawWbTree(); };
$('#wbSys').onchange = () => { drawWbTree(); if (!wbCur) drawWbOverview(); };
$('#wbRefresh').onclick = () => { wbObjs = {}; loadWb(); };

// Overview of all schemas
function drawWbOverview() {
  wbCur = null; wbTbl = null; drawWbTree();
  const list = visibleSchemas(), max = Math.max(1, ...list.map(s => s.size));
  $('#wbMain').innerHTML = `<div class="wbhead"><h3>All schemas <small>${list.length} on this server</small></h3></div>` +
    (list.length ? `<div class="wbcards">${list.map(s => `<div class="wbcard" data-s="${esc(s.name)}"><div class="t"><b>${esc(s.name)}</b>${wbSystem.includes(s.name.toLowerCase()) ? '<span class="badge mute">system</span>' : ''}${active.name.endsWith('/' + s.name) ? '<span class="badge ok">default</span>' : ''}</div>` +
      `<div class="st"><span><b>${s.tables}</b> tables</span><span><b>${s.views}</b> views</span><span><b>${fmtMb(s.size)}</b></span></div><div class="bar"><i style="width:${Math.max(3, Math.round(s.size / max * 100))}%"></i></div><small>${esc(s.charset)} · ${esc(s.collation)}</small></div>`).join('')}</div>` : '<p class="empty">No schemas to show.</p>');
  document.querySelectorAll('.wbcard').forEach(c => c.onclick = async () => { await toggleWb(c.dataset.s, true); openWbSchema(c.dataset.s); });
}

// One schema
function openWbSchema(n) {
  wbCur = n; wbTbl = null; drawWbTree();
  const s = wbList.find(x => x.name === n), o = wbObjs[n];
  const isDef = active.name.endsWith('/' + n);
  $('#wbMain').innerHTML = `<div class="wbhead"><h3><a href="#" id="wbBack">All schemas</a> › ${esc(n)}</h3><span class="grow"></span>` +
    `<button id="wbUse" ${isDef ? 'disabled' : ''}>${isDef ? 'Default schema' : 'Set as default schema'}</button><button id="wbQuery">New query</button><button id="wbDrop" class="danger">Drop schema</button></div>` +
    `<div class="wbstats"><span><b>${s.tables}</b> tables</span><span><b>${s.views}</b> views</span><span><b>${fmtMb(s.size)}</b> total</span><span>${esc(s.charset)}</span><span>${esc(s.collation)}</span></div>` +
    (o ? tableGrid(n, o) : '<p class="empty">Loading…</p>');
  $('#wbBack').onclick = e => { e.preventDefault(); drawWbOverview(); };
  $('#wbUse').onclick = async () => {
    try { const r = await post('/mysql/use', { database: n }); active.name = r.name; renderConns(); colCache = {}; tables = await api(`/connections/${active.id}/schema`); renderTables(); loadDbList(); setStatus(`Now using schema ${n}.`); openWbSchema(n); }
    catch (e) { setStatus(e.message, true); }
  };
  $('#wbQuery').onclick = () => { go('sql'); newTab(`SELECT * FROM ${q2(n, o?.tables.rows[0]?.[0] || 'table_name')} LIMIT 100;`); };
  $('#wbDrop').onclick = async () => {
    const t = prompt(`Drop schema ${n} and everything in it? This cannot be undone.\n\nType the schema name to confirm:`);
    if (t !== n) return t === null ? 0 : setStatus('Name did not match. Nothing was dropped.', true);
    try { await wapi('/schema/drop', { method: 'POST', body: JSON.stringify({ name: n }) }); delete wbObjs[n]; wbOpen.delete(n); wbCur = null; setStatus(`Schema ${n} dropped.`); loadWb(); }
    catch (e) { setStatus(e.message, true); }
  };
  document.querySelectorAll('#wbMain tr[data-t]').forEach(tr => tr.onclick = () => openWbTable(n, tr.dataset.t, 'data'));
  if (!o) toggleWb(n, true).then(() => wbObjs[n] && wbCur === n && !wbTbl && openWbSchema(n));
}
function tableGrid(n, o) {
  const rows = o.tables.rows;
  return rows.length ? '<div class="scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Engine</th><th>Rows (approx.)</th><th>Size</th></tr></thead><tbody>' +
    rows.map(t => `<tr data-t="${esc(t[0])}" style="cursor:pointer"><td><b>${esc(t[0])}</b></td><td>${t[1] === 'VIEW' ? '<span class="badge warn">VIEW</span>' : 'TABLE'}</td><td>${esc(t[2])}</td><td class="n">${t[3]}</td><td class="n">${t[4]} KB</td></tr>`).join('') + '</tbody></table></div>'
    : '<p class="empty">This schema has no tables or views yet.</p>';
}

// One table
async function openWbTable(db, t, part) {
  wbCur = db; wbTbl = t; wbPart = part; drawWbTree();
  const tab = (k, l) => `<button data-p="${k}" class="${part === k ? 'on' : ''}">${l}</button>`;
  $('#wbMain').innerHTML = `<div class="wbhead"><h3><a href="#" id="wbBack">All schemas</a> › <a href="#" id="wbSch">${esc(db)}</a> › ${esc(t)}</h3><span class="grow"></span>` +
    `<button id="wbSql">Open in SQL editor</button><button id="wbCopy">Copy name</button></div>` +
    `<div class="rtabs wbtabs">${tab('data', 'Data')}${tab('columns', 'Columns')}${tab('indexes', 'Indexes')}${tab('ddl', 'DDL')}</div><div class="pane wbpane" id="wbPane"><p class="empty">Loading…</p></div>`;
  $('#wbBack').onclick = e => { e.preventDefault(); drawWbOverview(); };
  $('#wbSch').onclick = e => { e.preventDefault(); openWbSchema(db); };
  $('#wbSql').onclick = () => { go('sql'); newTab(`SELECT * FROM ${q2(db, t)} LIMIT 100;`); };
  $('#wbCopy').onclick = () => copyText(q2(db, t), 'Name copied.');
  document.querySelectorAll('.wbtabs button').forEach(b => b.onclick = () => openWbTable(db, t, b.dataset.p));
  try {
    const r = await wapi(`/table?db=${enc(db)}&name=${enc(t)}&part=${part}`);
    if (wbTbl !== t || wbPart !== part) return;
    $('#wbPane').innerHTML = part === 'ddl' ? `<pre class="code">${esc(r.ddl)}</pre><p class="acts"><button id="wbDdl">Copy DDL</button></p>` : gridHtml(r) + (part === 'data' ? `<p class="sub">${r.truncated ? 'First 200 rows. ' : ''}${r.rows.length} rows shown.</p>` : '');
    $('#wbDdl')?.addEventListener('click', () => copyText(r.ddl, 'DDL copied.'));
  } catch (e) { $('#wbPane').innerHTML = `<div class="msgcard bad">${esc(e.message)}</div>`; }
}

$('#wbNew').onclick = () => {
  if (!isMy()) return setStatus('Connect to a MySQL server first.', true);
  ask('Create schema', '<label>Schema name <input name="name" required maxlength="64"></label><label>Character set <select name="cs"><option>utf8mb4</option><option>utf8mb3</option><option>latin1</option><option>ascii</option></select></label><label>Collation (optional) <input name="co" placeholder="utf8mb4_0900_ai_ci"></label>',
    async f => { const r = await wapi('/schema', { method: 'POST', body: JSON.stringify({ name: f.get('name').trim(), charset: f.get('cs'), collation: f.get('co').trim() }) }); setStatus(r.sql + ' ✔'); wbObjs = {}; await loadWb(); });
};
