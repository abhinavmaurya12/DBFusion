// DBFusion connection gate: without a connection only the Home page works.
// Every other tab and button looks disabled, and clicking one explains why instead of opening it.
const gateDlg = $('#dGate');
function showGate() {
  if (!gateDlg.open) gateDlg.showModal();
}
$('#gateClose').onclick = () => gateDlg.close();
$('#gateNew').onclick = () => { gateDlg.close(); go('home'); openDialog(); };

const GATED = '#tabs a[data-p]:not([data-p=home]), #logout, #cmdBtn';
document.querySelectorAll(GATED).forEach(el => { el.dataset.t0 = el.title; });   // normal tooltips, restored after connecting
function syncGate() {
  const lock = !active;
  document.querySelectorAll(GATED).forEach(el => {
    el.classList.toggle('locked', lock);
    el.setAttribute('aria-disabled', String(lock));
    el.title = lock ? 'Connect to a database first' : el.dataset.t0;
  });
  document.body.classList.toggle('nodb', lock);
  if (lock && $('#p-home').hidden && $('#p-dev').hidden) go('home');   // Home and Developer stay open
}

const _goGate = go;
go = (p, x) => { if (!active && p !== 'home' && p !== 'dev') { showGate(); return; } _goGate(p, x); };

const _openPalette = openPalette;
openPalette = () => { if (!active) showGate(); else _openPalette(); };
$('#cmdBtn').onclick = () => openPalette();

const _logoutGate = logout;
$('#logout').onclick = e => { e.preventDefault(); e.stopPropagation(); if (!active) showGate(); else _logoutGate(); };

const _renderGate = renderConns;
renderConns = () => { _renderGate(); syncGate(); };
syncGate();
