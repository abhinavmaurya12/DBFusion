// DBFusion Oracle User Manager: list users, create users (as SYSTEM), lock/unlock, reset password, expire, drop, inspect grants
PAGES.users = ['Home', 'User Manager'];
const uapi = (p, o) => api(`/connections/${active.id}/oracle/users${p}`, o);
let uRows = [], uPick = null, uInfo = null, uExtra = [];
const _go3 = go; go = (p, x) => { _go3(p, x); if (p === 'users') loadUsers(); };

const sBadge = s => {
  const t = String(s || '').toUpperCase(), c = t === 'OPEN' ? 'ok' : t.includes('LOCKED') ? 'bad' : t.includes('EXPIRED') ? 'warn' : 'mute';
  return `<span class="badge ${c}">${esc(t.replace(/_/g, ' ') || 'UNKNOWN')}</span>`;
};

async function loadUsers() {
  const list = $('#uList'), banner = $('#uBanner');
  $('#uSide').hidden = true; uPick = null;
  if (!isOra()) { uRows = []; banner.hidden = true; list.innerHTML = '<p class="empty">Connect to an Oracle database as SYSTEM (Home) to manage users.</p>'; $('#uCount').textContent = ''; return; }
  list.innerHTML = '<p class="empty">Loading users…</p>';
  try {
    [uInfo, { rows: uRows }] = await Promise.all([uapi('/info'), uapi('')]);
    banner.hidden = false;
    banner.className = 'banner ' + (uInfo.canCreate ? 'ok' : 'warn');
    banner.innerHTML = uInfo.canCreate
      ? `Connected as <b>${esc(uInfo.currentUser)}</b>${uInfo.container ? ` in container <b>${esc(uInfo.container)}</b>` : ''}. You can create and manage users.` +
        (uInfo.cdbRoot ? ' <b>This is the CDB root: new users must be named C##NAME.</b> Connect to a pluggable database (XEPDB1, FREEPDB1) for normal users.' : '')
      : `You are connected as <b>${esc(uInfo.currentUser)}</b>, which does not have the CREATE USER privilege. <button id="uReconnect" class="mini">Reconnect as SYSTEM</button>`;
    $('#uReconnect')?.addEventListener('click', () => openDialog({ ...active.cfg, username: 'SYSTEM', role: '' }));
    drawUsers();
  } catch (e) { list.innerHTML = ''; banner.hidden = true; setStatus(e.message, true); }
}
function drawUsers() {
  const f = $('#uFilter').value.toLowerCase(), sys = $('#uSys').checked;
  const rows = uRows.filter(r => (sys || r[8] !== 'Y') && r[0].toLowerCase().includes(f));
  $('#uCount').textContent = `${rows.length} of ${uRows.length} users`;
  $('#uList').innerHTML = rows.length ? '<table><thead><tr><th>User</th><th>Status</th><th>Created</th><th>Default tablespace</th><th>Profile</th><th>Password expires</th><th></th></tr></thead><tbody>' +
    rows.map(r => `<tr data-u="${esc(r[0])}" class="${uPick === r[0] ? 'cur' : ''}"><td><span class="avatar">${esc(r[0][0])}</span><b>${esc(r[0])}</b>${r[8] === 'Y' ? ' <span class="badge mute">system</span>' : ''}</td>` +
      `<td>${sBadge(r[1])}</td><td>${esc(r[2] ?? '')}</td><td>${esc(r[3] ?? '')}</td><td>${esc(r[5] ?? '')}</td><td>${esc(r[7] ?? '')}</td>` +
      `<td class="acts2"><button data-a="grants" class="mini">Grants</button>` +
      (String(r[1]).includes('LOCKED') ? '<button data-a="unlock" class="mini">Unlock</button>' : '<button data-a="lock" class="mini">Lock</button>') +
      '<button data-a="password" class="mini">Password</button><button data-a="expire" class="mini">Expire</button><button data-a="drop" class="mini danger">Drop</button></td></tr>').join('') + '</tbody></table>'
    : '<p class="empty">No users to show.</p>';
  document.querySelectorAll('#uList tr[data-u]').forEach(tr => {
    tr.onclick = () => showGrants(tr.dataset.u);
    tr.querySelectorAll('button[data-a]').forEach(b => b.onclick = e => { e.stopPropagation(); userAction(tr.dataset.u, b.dataset.a); });
  });
}
$('#uFilter').oninput = $('#uSys').onchange = drawUsers;
$('#uRefresh').onclick = loadUsers;
$('#uCreate').onclick = () => openCreateUser();

async function showGrants(name) {
  uPick = name; drawUsers();
  const side = $('#uSide'); side.hidden = false; side.innerHTML = `<h4>${esc(name)}</h4><div class="inner"><p class="empty">Loading…</p></div>`;
  try {
    const g = await uapi('/grants?name=' + encodeURIComponent(name));
    const chips = (r, i, cls) => r.rows.length ? r.rows.map(x => `<span class="chip ${cls}">${esc(x[i])}${x[1] === 'YES' && i === 0 ? ' <small>+admin</small>' : ''}</span>`).join('') : '<span class="muted">None</span>';
    side.innerHTML = `<h4>${esc(name)} <button class="x" id="uClose" aria-label="Close">×</button></h4><div class="inner">` +
      `<h5>Roles</h5><div class="chips">${chips(g.roles, 0, 'role')}</div>` +
      `<h5>System privileges</h5><div class="chips">${chips(g.systemPrivileges, 0, 'priv')}</div>` +
      `<h5>Tablespace quotas</h5>${g.quotas.rows.length ? gridHtml(g.quotas) : '<span class="muted">No quota. This user cannot store data until you grant one.</span>'}` +
      `<p class="acts" style="padding:12px 0 0"><button id="uSql">Open GRANT script in SQL editor</button></p></div>`;
    $('#uClose').onclick = () => { uPick = null; side.hidden = true; drawUsers(); };
    $('#uSql').onclick = () => { go('sql'); newTab(`-- Grant more to ${name}\nGRANT CREATE SESSION TO ${name};\n-- GRANT SELECT ON schema.table TO ${name};\n-- ALTER USER ${name} QUOTA UNLIMITED ON users;`); };
  } catch (e) { side.innerHTML = ''; side.hidden = true; setStatus(e.message, true); }
}

async function userAction(name, a) {
  const run = async (body, msg) => { try { const r = await uapi('/action', { method: 'POST', body: JSON.stringify({ username: name, ...body }) }); setStatus(msg || r.sql + ' ✔'); await loadUsers(); } catch (e) { setStatus(e.message, true); } };
  if (a === 'grants') return showGrants(name);
  if (a === 'lock') return run({ action: 'lock' }, `${name} is locked.`);
  if (a === 'unlock') return run({ action: 'unlock' }, `${name} is unlocked.`);
  if (a === 'expire') { if (!confirm(`Force ${name} to choose a new password at next login?`)) return; return run({ action: 'expire' }, `${name}'s password is expired.`); }
  if (a === 'drop') {
    if (!confirm(`Drop user ${name}? This cannot be undone.`)) return;
    const cascade = confirm(`Also delete every object owned by ${name} (CASCADE)?\n\nOK = delete the objects too\nCancel = drop only if the user owns nothing`);
    return run({ action: 'drop', cascade }, `${name} was dropped.`);
  }
  if (a === 'password') ask(`Reset password for ${name}`, '<label>New password <input type="password" name="p1" required></label><label>Confirm <input type="password" name="p2" required></label><label class="chk"><input type="checkbox" name="unl" checked> Also unlock the account</label>', async f => {
    if (f.get('p1') !== f.get('p2')) throw new Error('The passwords do not match.');
    await uapi('/action', { method: 'POST', body: JSON.stringify({ username: name, action: 'password', password: f.get('p1') }) });
    if (f.has('unl')) await uapi('/action', { method: 'POST', body: JSON.stringify({ username: name, action: 'unlock' }) }).catch(() => {});
    setStatus(`Password changed for ${name}.`); loadUsers();
  });
}

// ---------------------------------------------------------------- Create user wizard
const COMMON_ROLES = ['CONNECT', 'RESOURCE', 'DBA', 'SELECT_CATALOG_ROLE', 'EXP_FULL_DATABASE', 'IMP_FULL_DATABASE', 'DATAPUMP_EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE', 'SCHEDULER_ADMIN'];
const DEV_PRIVS = ['CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE', 'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE TYPE', 'CREATE SYNONYM'];
const opts = (list, sel, none) => (none ? `<option value="">${none}</option>` : '') + list.map(x => `<option${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('');
const dUser = $('#dUser'), uForm = $('#uForm');

function genPassword() {
  const L = 'abcdefghijkmnopqrstuvwxyz', U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', S = '_#$', all = L + U + D + S;
  const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const pick = s => s[rnd(s.length)], chars = [pick(U), pick(L), pick(D), pick(S)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  if (!/[A-Za-z]/.test(chars[0])) chars.unshift(pick(U));
  return chars.join('');
}
function strength(p) {
  let n = 0; if (p.length >= 8) n++; if (p.length >= 12) n++; if (/[a-z]/.test(p) && /[A-Z]/.test(p)) n++; if (/\d/.test(p)) n++; if (/[^A-Za-z0-9]/.test(p)) n++;
  return p ? ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Strong'][n] + '|' + Math.min(4, n) : '|0';
}
function uPayload() {
  const f = new FormData(uForm), mode = f.get('qmode');
  const quota = mode === 'unlimited' ? 'UNLIMITED' : mode === 'custom' && f.get('qsize') ? f.get('qsize') + f.get('qunit') : '';
  return { username: (f.get('username') || '').trim(), password: f.get('password') || '', defaultTablespace: f.get('ts') || null, tempTablespace: f.get('temp') || null,
    profile: f.get('profile') || null, quota, quotaTablespace: f.get('ts') || null, passwordExpire: f.has('expire'), accountLocked: f.has('lock'),
    privileges: f.getAll('priv'), roles: [...new Set([...f.getAll('role'), ...uExtra])] };
}
let prevT;
function refreshPreview() {
  clearTimeout(prevT);
  prevT = setTimeout(async () => {
    const box = $('#uSql'); if (!box) return;
    const p = uPayload();
    if (!p.username) { box.className = 'sqlprev'; box.textContent = '-- Enter a user name to see the SQL.'; return; }
    try { const r = await uapi('/preview', { method: 'POST', body: JSON.stringify(p) }); box.className = 'sqlprev'; box.textContent = r.sql.join(';\n') + ';'; }
    catch (e) { box.className = 'sqlprev bad'; box.textContent = e.message; }
  }, 300);
}
function setPreset(name) {
  const checks = (n, vals) => uForm.querySelectorAll(`input[name=${n}]`).forEach(c => { c.checked = vals.includes(c.value); });
  if (name === 'login') { checks('priv', ['CREATE SESSION']); checks('role', []); }
  if (name === 'dev') { checks('priv', DEV_PRIVS); checks('role', []); uForm.qmode.value = 'unlimited'; }
  if (name === 'dba') { checks('priv', ['CREATE SESSION']); checks('role', ['DBA']); uForm.qmode.value = 'unlimited'; }
  if (name === 'clear') { checks('priv', []); checks('role', []); uExtra = []; drawExtra(); }
  syncUser();
}
function drawExtra() { const b = $('#uExtra'); if (b) b.innerHTML = uExtra.map((r, i) => `<span class="chip role">${esc(r)} <button type="button" data-i="${i}" class="x">×</button></span>`).join(''); b?.querySelectorAll('button').forEach(x => x.onclick = () => { uExtra.splice(+x.dataset.i, 1); drawExtra(); refreshPreview(); }); }
function syncUser() {
  const pw = uForm.password.value, [label, lvl] = strength(pw).split('|');
  $('#uStr').dataset.l = lvl; $('#uStrT').textContent = label;
  $('#uCust').hidden = uForm.qmode.value !== 'custom';
  const dba = uForm.querySelector('input[name=role][value=DBA]')?.checked;
  $('#uWarn').hidden = !dba;
  const noLogin = !uForm.querySelector('input[name=priv][value="CREATE SESSION"]')?.checked && !uForm.querySelector('input[name=role][value=CONNECT]')?.checked && !dba;
  $('#uNoLogin').hidden = !noLogin;
  refreshPreview();
}

async function openCreateUser() {
  if (!isOra()) return setStatus('Connect to an Oracle database as SYSTEM first.', true);
  let info; try { info = uInfo = await uapi('/info'); } catch (e) { return setStatus(e.message, true); }
  uExtra = [];
  const roles = info.roles.length ? COMMON_ROLES.filter(r => info.roles.includes(r)) : COMMON_ROLES;
  $('#uWho').textContent = `connected as ${info.currentUser}${info.container ? ' · ' + info.container : ''}`;
  $('#uBody').innerHTML = `
    ${info.canCreate ? '' : `<div class="banner warn">Your account (<b>${esc(info.currentUser)}</b>) lacks the CREATE USER privilege. Connect as SYSTEM to create users.</div>`}
    ${info.cdbRoot ? '<div class="banner warn">You are in the CDB root. Name the user C##NAME, or connect to a pluggable database (XEPDB1 / FREEPDB1).</div>' : ''}
    <div class="ugrid2">
      <div>
        <h5>Account</h5>
        <label>User name <input name="username" required maxlength="128" placeholder="APP_USER" style="text-transform:uppercase" pattern="[A-Za-z][A-Za-z0-9_$#]*"></label>
        <label>Password <span class="pwrow"><input name="password" type="password" required autocomplete="new-password"><button type="button" id="uShow" class="mini">Show</button><button type="button" id="uGen" class="mini">Generate</button></span></label>
        <div class="strength"><i id="uStr" data-l="0"></i><small id="uStrT"></small></div>
        <label>Confirm password <input name="confirm" type="password" required autocomplete="new-password"></label>
        <h5>Storage</h5>
        <div class="row"><label>Default tablespace <select name="ts">${opts(info.tablespaces, info.defaultTablespace, '(database default)')}</select></label>
          <label>Temporary tablespace <select name="temp">${opts(info.tempTablespaces, info.defaultTemp, '(database default)')}</select></label></div>
        <div class="row"><label>Profile <select name="profile">${opts(info.profiles, 'DEFAULT', '(database default)')}</select></label>
          <label>Quota <select name="qmode"><option value="unlimited">Unlimited</option><option value="custom">Custom size</option><option value="none">No quota</option></select></label></div>
        <div class="row" id="uCust" hidden><label>Size <input name="qsize" type="number" min="1" value="100"></label><label>Unit <select name="qunit"><option>K</option><option selected>M</option><option>G</option></select></label></div>
        <h5>Account options</h5>
        <label class="chk"><input type="checkbox" name="expire"> Force a new password at first login</label>
        <label class="chk"><input type="checkbox" name="lock"> Create the account locked</label>
      </div>
      <div>
        <h5>Privileges <span class="presets"><button type="button" class="mini" data-p="login">Login only</button><button type="button" class="mini" data-p="dev">Developer</button><button type="button" class="mini danger" data-p="dba">DBA</button><button type="button" class="mini" data-p="clear">Clear</button></span></h5>
        <div class="checks">${info.privileges.map(p => `<label class="chk"><input type="checkbox" name="priv" value="${esc(p)}"${p === 'CREATE SESSION' ? ' checked' : ''}> ${esc(p)}</label>`).join('')}</div>
        <h5>Roles</h5>
        <div class="checks">${roles.map(r => `<label class="chk"><input type="checkbox" name="role" value="${esc(r)}"> ${esc(r)}</label>`).join('')}</div>
        <div class="row"><label>Add another role <input id="uRole" list="uRoleList" placeholder="Role name"></label><button type="button" id="uAddRole" class="mini" style="align-self:end;margin-bottom:10px">Add</button></div>
        <datalist id="uRoleList">${info.roles.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
        <div class="chips" id="uExtra"></div>
        <div class="banner warn" id="uWarn" hidden>The DBA role gives this user full control of the database.</div>
        <div class="banner warn" id="uNoLogin" hidden>Without CREATE SESSION (or the CONNECT role) this user cannot log in.</div>
      </div>
    </div>
    <h5>SQL that will run <small class="muted">(password hidden)</small></h5>
    <pre id="uSql" class="sqlprev">-- Enter a user name to see the SQL.</pre>
    <p id="uErr" class="err"></p>
    <div class="row end"><button type="button" id="uCopy">Copy SQL</button><button type="button" id="uCancel">Cancel</button><button class="primary" id="uGo"${info.canCreate ? '' : ' disabled'}>Create user</button></div>`;
  uForm.onsubmit = async e => {
    e.preventDefault(); $('#uErr').textContent = '';
    if (uForm.password.value !== uForm.confirm.value) return $('#uErr').textContent = 'The passwords do not match.';
    const go1 = $('#uGo'); go1.disabled = true; go1.textContent = 'Creating…';
    const p = uPayload();
    try { const r = await uapi('', { method: 'POST', body: JSON.stringify(p) }); done(r, p); }
    catch (err) { $('#uErr').textContent = err.message; go1.disabled = false; go1.textContent = 'Create user'; loadUsers(); }
  };
  uForm.oninput = uForm.onchange = syncUser;
  $('#uShow').onclick = e => { const t = uForm.password.type === 'password'; uForm.password.type = uForm.confirm.type = t ? 'text' : 'password'; e.target.textContent = t ? 'Hide' : 'Show'; };
  $('#uGen').onclick = () => { const p = genPassword(); uForm.password.value = uForm.confirm.value = p; uForm.password.type = uForm.confirm.type = 'text'; $('#uShow').textContent = 'Hide'; syncUser(); };
  uForm.querySelectorAll('[data-p]').forEach(b => b.onclick = () => setPreset(b.dataset.p));
  $('#uAddRole').onclick = () => { const v = $('#uRole').value.trim().toUpperCase(); if (v && !uExtra.includes(v)) { uExtra.push(v); drawExtra(); refreshPreview(); } $('#uRole').value = ''; };
  $('#uCancel').onclick = () => dUser.close();
  $('#uCopy').onclick = () => copyText($('#uSql').textContent, 'SQL copied.');
  syncUser(); if (!dUser.open) dUser.showModal(); uForm.username.focus();
}
window.openCreateUser = openCreateUser;
$('#tUser').onclick = e => { e.preventDefault(); go('users'); openCreateUser(); };

function done(r, p) {
  setStatus(`User ${r.username} created.`);
  $('#uBody').innerHTML = `<div class="success"><div class="tick">✔</div><h4>User ${esc(r.username)} created</h4>
    <pre class="sqlprev">${esc(r.statements.join(';\n') + ';')}</pre>
    <div class="row end"><button type="button" id="uAgain">Create another</button><button type="button" id="uLogin">Connect as ${esc(r.username)}</button><button type="button" class="primary" id="uOk">Done</button></div></div>`;
  $('#uOk').onclick = () => dUser.close();
  $('#uAgain').onclick = () => openCreateUser();
  $('#uLogin').onclick = () => { dUser.close(); openDialog({ ...active.cfg, username: r.username, password: p.password, role: '' }); };
  loadUsers();
}
