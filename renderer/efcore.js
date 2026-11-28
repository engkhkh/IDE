// Nova IDE - EF Core Migrations window (View > EF Core Migrations, like Passenger / Rider's EF Core UI): the
// migrations of a project that references Entity Framework Core, applied or pending; Add, Remove Last,
// Update Database (to a migration), Generate SQL Script — through the EF Core tools (dotnet ef).
'use strict';

const EF = { project: null, startup: null, list: [], busy: false };

async function efProjects() {
  const out = [];
  for (const p of projects()) {
    let text = '';
    try { text = await api.readFile(p.path); } catch {}
    if (/Microsoft\.EntityFrameworkCore/i.test(text)) out.push(p);
  }
  return out;
}
async function efRefresh() {
  const sel = $('#efProject');
  const list = await efProjects();
  sel.innerHTML = list.length ? '' : '<option value="">No project references Entity Framework Core</option>';
  for (const p of list) { const o = document.createElement('option'); o.value = p.path; o.textContent = p.name; sel.appendChild(o); }
  if (!list.some((p) => samePath(p.path, EF.project || ''))) EF.project = list[0] ? list[0].path : null;
  if (EF.project) sel.value = EF.project;
  const st = $('#efStartup');
  st.innerHTML = '<option value="">(same project)</option>';
  for (const p of runnable()) { const o = document.createElement('option'); o.value = p.path; o.textContent = p.name; st.appendChild(o); }
  if (EF.startup) st.value = EF.startup;
  return efList();
}
async function efList() {
  const body = $('#efBody');
  body.innerHTML = '';
  if (!EF.project) { $('#efMsg').textContent = ''; return; }
  $('#efMsg').textContent = 'Reading migrations (builds the project)...';
  const r = await api.ef.migrations(EF.project, EF.startup || null);
  if (r.missing) { $('#efMsg').textContent = 'The EF Core tools are not installed: '; const b = document.createElement('button'); b.textContent = 'Install dotnet-ef'; b.onclick = () => efInstall(); $('#efMsg').appendChild(b); return r; }
  if (r.error) { $('#efMsg').textContent = r.error.split('\n')[0]; if (r.output) log(`${r.output}\n`, 'stderr'); return r; }
  EF.list = r.migrations;
  const pending = r.migrations.filter((m) => !m.applied).length;
  $('#efMsg').textContent = `${r.migrations.length} migration(s)${r.migrations.some((m) => m.applied != null) ? `, ${pending} pending` : ''}`;
  for (const m of [...r.migrations].reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td class="lh-actions"><button class="ef-to">Update to here</button></td>';
    tr.children[0].textContent = m.applied === true ? '✔ applied' : m.applied === false ? '○ pending' : '';
    tr.children[0].className = m.applied ? 'ef-applied' : 'ef-pending';
    tr.children[1].textContent = m.name;
    tr.children[2].textContent = m.id;
    tr.querySelector('.ef-to').onclick = () => efDo(['database', 'update', m.name], `Update database to ${m.name}`);
    tr.ondblclick = () => efOpenMigration(m);
    body.appendChild(tr);
  }
  return r.migrations;
}
async function efOpenMigration(m) {
  const files = await api.ws.listFiles(dirName(EF.project)).catch(() => []);
  const f = files.find((x) => baseName(x) === `${m.id}.cs`);
  if (f) openFile(f);
}
async function efDo(args, what) {
  if (!EF.project || EF.busy) return;
  EF.busy = true;
  showPanel('output');
  log(`\n------ EF Core: ${what} ------\n> ${state.settings.efCommand || 'dotnet ef'} ${args.join(' ')}\n`, 'info');
  const r = await api.ef.run(EF.project, args, EF.startup || null);
  EF.busy = false;
  if (r.missing) { log('The EF Core tools are not installed (dotnet tool install -g dotnet-ef)\n', 'stderr'); return r; }
  log(`${r.output}\n====== EF Core: ${what} ${r.ok ? 'done' : `failed (exit code ${r.code})`} ======\n`, r.ok ? 'info' : 'stderr');
  status(`EF Core: ${what} ${r.ok ? 'done' : 'failed'}`);
  showPanel('efcore');
  await efList();
  return r;
}
async function efAdd() {
  const name = await ask('New migration name', 'AddSomething');
  if (!name) return;
  if (!/^[A-Za-z_]\w*$/.test(name.trim())) return status('A migration name is a C# identifier');
  return efDo(['migrations', 'add', name.trim()], `Add migration ${name.trim()}`);
}
async function efScript() {
  const r = await api.ef.run(EF.project, ['migrations', 'script', '--idempotent'], EF.startup || null);
  if (r.error || !r.ok) { status('EF Core: script failed (see Output)'); log(`${r.output || r.error}\n`, 'stderr'); return r; }
  const file = `${dirName(EF.project)}${sep()}migrations.sql`;
  await api.writeFile(file, r.data || r.output);
  await openFile(file);
  status('EF Core: idempotent SQL script written to migrations.sql');
  return file;
}
function efInstall() { showPanel('output'); log('\n------ Installing dotnet-ef ------\n', 'info'); api.run({ command: 'dotnet tool install -g dotnet-ef', cwd: state.root || undefined }); }

commands.showEfCore = () => { showPanel('efcore'); efRefresh(); };
bus.on('ready', () => {
  $('#efProject').onchange = (e) => { EF.project = e.target.value || null; efList(); };
  $('#efStartup').onchange = (e) => { EF.startup = e.target.value || null; efList(); };
  $('#efRefreshBtn').onclick = () => efRefresh();
  $('#efAdd').onclick = () => efAdd();
  $('#efRemove').onclick = () => { if (confirm('Remove the last migration (its files; it must not be applied)?')) efDo(['migrations', 'remove'], 'Remove last migration'); };
  $('#efUpdate').onclick = () => efDo(['database', 'update'], 'Update database');
  $('#efScript').onclick = () => efScript();
});
