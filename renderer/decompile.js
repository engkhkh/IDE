// Nova IDE - decompile assemblies you have no source for (Tools > Decompile Assembly..., or right-click a .dll):
// ILSpy's command-line decompiler (dotnet tool ilspycmd) lists the types, the chosen one opens as read-only C#.
'use strict';

const DC = { dll: null, types: [], filter: '' };

async function dcOpen(dll) {
  if (!dll) {
    const guess = state.root ? `${state.root}${sep()}` : '';
    dll = await ask('Assembly to decompile (.dll or .exe)', DC.dll || guess);
    if (!dll) return;
  }
  DC.dll = dll;
  status(`Reading ${baseName(dll)}...`);
  const r = await api.ilspy.types(dll);
  if (r.missing) return dcOfferInstall();
  if (r.error) { status(r.error); log(`Decompile: ${r.error}\n`, 'stderr'); return r; }
  DC.types = r.types;
  DC.filter = '';
  $('#dcFilter').value = '';
  $('#dcTitle').textContent = `${baseName(dll)} — ${r.types.length} type(s)`;
  $('#dcDlg').classList.remove('hidden');
  dcRender();
  setTimeout(() => focusIfIdle($('#dcFilter')), 30);
  return r.types;
}
function dcRender() {
  const host = $('#dcList');
  host.innerHTML = '';
  const q = DC.filter.toLowerCase();
  for (const t of DC.types.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 500)) {
    const row = document.createElement('div');
    row.className = 'th-row dc-row';
    row.innerHTML = '<span class="dc-kind"></span><span class="th-name"></span>';
    row.children[0].textContent = { Class: '🟧', Interface: '🔷', Struct: '🟦', Enum: '🟨', Delegate: '🟪' }[t.kind] || '◇';
    row.children[1].textContent = t.name;
    row.onclick = () => dcType(t.name);
    host.appendChild(row);
  }
}
async function dcType(type) {
  $('#dcDlg').classList.add('hidden');
  status(`Decompiling ${type}...`);
  const r = await api.ilspy.decompile(DC.dll, type);
  if (r.error) { status(r.error); log(`Decompile: ${r.error}\n`, 'stderr'); return r; }
  await openFile(r.file);
  const tab = findTab(r.file);
  if (tab) { tab.readOnly = true; editor.updateOptions({ readOnly: true }); }
  status(`Decompiled ${type} (read-only)`);
  return r.file;
}
async function dcOfferInstall() {
  if (!confirm('Decompiling needs ILSpy\'s command-line tool (ilspycmd). Install it now with "dotnet tool install -g ilspycmd"?')) return;
  showPanel('output');
  log('\n------ Installing ilspycmd ------\n', 'info');
  const id = await api.run({ command: 'dotnet tool install -g ilspycmd', cwd: state.root || undefined });
  status('Installing ilspycmd: see the Output window, then decompile again');
  return id;
}
// read-only tabs (decompiled code) stay read-only when you come back to them
const dcActivate = activate;
activate = function (tab) { dcActivate(tab); if (editor) editor.updateOptions({ readOnly: !!(tab && tab.readOnly) }); }; // eslint-disable-line no-func-assign

commands.decompileAssembly = () => dcOpen();
bus.on('ready', () => {
  $('#dcFilter').oninput = (e) => { DC.filter = e.target.value; dcRender(); };
  $('#dcFilter').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = $('#dcList .dc-row .th-name'); if (first) dcType(first.textContent); } });
  $('#dcClose').onclick = () => $('#dcDlg').classList.add('hidden');
});
