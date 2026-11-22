// Nova IDE - "Create a new project" wizard (File > New > Project, Ctrl+Shift+N), Visual Studio style
'use strict';

const PROJECT_TEMPLATES = [
  { short: 'console', name: 'Console App', base: 'ConsoleApp', desc: 'A project for creating a command-line application that can run on .NET on Windows, Linux and macOS', tags: ['Console', 'Windows', 'Linux', 'macOS'] },
  { short: 'classlib', name: 'Class Library', base: 'ClassLibrary', desc: 'A project for creating a class library that targets .NET', tags: ['Library'] },
  { short: 'wpf', name: 'WPF Application', base: 'WpfApp', desc: 'A project for creating a .NET WPF Application', tags: ['Desktop', 'Windows'] },
  { short: 'winforms', name: 'Windows Forms App', base: 'WinFormsApp', desc: 'A project template for creating a .NET Windows Forms (WinForms) App', tags: ['Desktop', 'Windows'] },
  { short: 'webapi', name: 'ASP.NET Core Web API', base: 'WebApplication', desc: 'A project template for creating a RESTful Web API using ASP.NET Core controllers or minimal APIs', tags: ['Web', 'API', 'Cloud'] },
  { short: 'webapp', name: 'ASP.NET Core Web App (Razor Pages)', base: 'WebApplication', desc: 'A project template for creating an ASP.NET Core application with example Razor Pages content', tags: ['Web', 'Cloud'] },
  { short: 'mvc', name: 'ASP.NET Core Web App (Model-View-Controller)', base: 'WebApplication', desc: 'A project template for creating an ASP.NET Core application with example MVC views and controllers', tags: ['Web', 'Cloud'] },
  { short: 'blazor', name: 'Blazor Web App', base: 'BlazorApp', desc: 'A project template for creating a Blazor web app that supports both server-side rendering and client interactivity', tags: ['Web', 'Blazor'] },
  { short: 'web', name: 'ASP.NET Core Empty', base: 'WebApplication', desc: 'An empty project template for creating an ASP.NET Core application', tags: ['Web', 'Empty'] },
  { short: 'worker', name: 'Worker Service', base: 'WorkerService', desc: 'An empty project template for creating a worker service', tags: ['Service', 'Cloud'] },
  { short: 'grpc', name: 'ASP.NET Core gRPC Service', base: 'GrpcService', desc: 'A project template for creating a gRPC service using ASP.NET Core', tags: ['Web', 'gRPC'] },
  { short: 'maui', name: '.NET MAUI App', base: 'MauiApp', desc: 'A project for creating a .NET MAUI application for iOS, Android, Mac Catalyst and Windows', tags: ['Mobile', 'Desktop'] },
  { short: 'xunit', name: 'xUnit Test Project', base: 'TestProject', desc: 'A project that contains xUnit.net tests that can run on .NET', tags: ['Test'] },
  { short: 'nunit', name: 'NUnit Test Project', base: 'TestProject', desc: 'A project that contains NUnit tests that can run on .NET', tags: ['Test'] },
  { short: 'mstest', name: 'MSTest Test Project', base: 'TestProject', desc: 'A project that contains MSTest unit tests that can run on .NET', tags: ['Test'] },
  { short: 'razorclasslib', name: 'Razor Class Library', base: 'RazorClassLibrary', desc: 'A project for creating a Razor class library', tags: ['Web', 'Library'] }
];
const MAIN_FILES = ['Program.cs', 'MainWindow.xaml.cs', 'Form1.cs', 'Class1.cs', 'UnitTest1.cs', 'Test1.cs', 'MainPage.xaml.cs', 'Worker.cs'];

const joinPath = (a, b) => { const s = a.includes('\\') ? '\\' : '/'; return a.replace(/[\\/]+$/, '') + s + b; };
const validName = (n) => /^[A-Za-z_][\w.-]*$/.test(n) && !/\.\./.test(n);

async function newProjectWizard({ addToSolution = null } = {}) {
  const [tpls, sdks] = await Promise.all([api.sln.templates(), api.sln.sdks()]);
  if (!sdks.installed) {
    log('The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download and restart Nova IDE.\n', 'stderr');
    showPanel('output');
    return;
  }
  const available = PROJECT_TEMPLATES.filter((t) => tpls.names.includes(t.short) || (t.short === 'webapp' && tpls.names.includes('razor')));
  const recent = load('recentTemplates', []);
  available.sort((a, b) => (recent.indexOf(b.short) >= 0 ? 100 - recent.indexOf(b.short) : 0) - (recent.indexOf(a.short) >= 0 ? 100 - recent.indexOf(a.short) : 0));
  const canAdd = !!(SOL.model && SOL.model.path);
  let tpl = available[0];

  // ----- step 1: choose a template -----
  const search = h('input', { class: 'dlg-input', placeholder: 'Search for templates', spellcheck: false });
  const list = h('div', { class: 'dlg-list tpl-list' });
  const renderList = () => {
    const qy = search.value.trim().toLowerCase();
    list.innerHTML = '';
    for (const t of available.filter((x) => !qy || `${x.name} ${x.desc} ${x.tags.join(' ')} ${x.short}`.toLowerCase().includes(qy))) {
      const row = h('div', { class: `dlg-item tpl${t === tpl ? ' sel' : ''}` },
        h('div', { class: 'tpl-name' }, t.name, recent.includes(t.short) ? h('span', { class: 'tpl-recent' }, 'recent') : null),
        h('div', { class: 'dlg-desc' }, t.desc),
        h('div', { class: 'tpl-tags' }, ['C#', ...t.tags].map((x) => h('span', {}, x))));
      row.onclick = () => { tpl = t; renderList(); };
      row.ondblclick = () => { tpl = t; showStep(2); };
      list.appendChild(row);
    }
    if (!list.children.length) list.appendChild(h('div', { class: 'dlg-desc' }, 'No templates match. Install more with "dotnet new install <package>".'));
  };
  search.oninput = renderList;
  const step1 = h('div', { class: 'np-step' }, h('div', { class: 'np-title' }, 'Create a new project'), search, list);

  // ----- step 2: configure -----
  const defaultDir = canAdd ? dirName(SOL.model.path) : (load('lastProjectsDir', null) || await api.projectsDir());
  const nameIn = h('input', { class: 'dlg-input', spellcheck: false });
  const locIn = h('input', { class: 'dlg-input', value: defaultDir, spellcheck: false });
  const browse = h('button', {}, '...');
  browse.onclick = async () => { const d = await api.openFolderDialog(); if (d) { locIn.value = d; update(); } };
  const solMode = h('select', { class: 'dlg-input' }, h('option', { value: 'new' }, 'Create new solution'), canAdd ? h('option', { value: 'add' }, `Add to solution '${SOL.model.name}'`) : null);
  if (canAdd) solMode.value = addToSolution === false ? 'new' : 'add';
  const solNameIn = h('input', { class: 'dlg-input', spellcheck: false });
  const sameDir = h('input', { type: 'checkbox' });
  const fwSel = h('select', { class: 'dlg-input' }, sdks.frameworks.map((f) => h('option', { value: f }, `.NET ${f.replace('net', '')}`)));
  const preview = h('div', { class: 'dlg-desc np-preview' });
  const err = h('div', { class: 'np-err' });
  let solNameTouched = false;
  solNameIn.oninput = () => { solNameTouched = true; update(); };
  nameIn.oninput = () => { nameIn.dataset.auto = '0'; if (!solNameTouched) solNameIn.value = nameIn.value; update(); };
  [locIn, solMode, sameDir, fwSel].forEach((e) => { e.oninput = update; e.onchange = update; });
  const row = (label, ...el) => h('label', { class: 'np-row' }, h('span', {}, label), h('div', { class: 'np-field' }, ...el));
  const solRows = h('div', {}, row('Solution name', solNameIn), h('label', { class: 'np-check' }, sameDir, ' Place solution and project in the same directory'));
  const step2 = h('div', { class: 'np-step hidden' },
    h('div', { class: 'np-title' }, 'Configure your new project'),
    h('div', { class: 'np-tpl' }),
    row('Project name', nameIn),
    row('Location', locIn, browse),
    row('Solution', solMode),
    solRows,
    row('Framework', fwSel),
    preview, err);

  function plan() {
    const name = nameIn.value.trim();
    const add = solMode.value === 'add';
    if (add) {
      const solDir = dirName(SOL.model.path);
      return { name, add, solDir, projDir: joinPath(solDir, name), sln: SOL.model.path };
    }
    const loc = locIn.value.trim();
    const solName = (solNameIn.value.trim() || name);
    const solDir = joinPath(loc, sameDir.checked ? name : solName);
    return { name, add, solName, solDir, projDir: sameDir.checked ? solDir : joinPath(solDir, name) };
  }
  async function update() {
    solRows.classList.toggle('hidden', solMode.value === 'add');
    locIn.disabled = browse.disabled = solMode.value === 'add';
    const p = plan();
    preview.textContent = `Project will be created in "${p.projDir}"`;
    let msg = '';
    if (!p.name) msg = 'Enter a project name.';
    else if (!validName(p.name)) msg = 'The project name can contain letters, digits, ".", "_" and "-", and must start with a letter.';
    else if (await api.exists(p.projDir)) msg = `The folder "${p.projDir}" already exists.`;
    err.textContent = msg;
    $('#npCreate').disabled = !!msg;
    return !msg;
  }

  async function uniqueName(base) {
    for (let i = 1; i < 100; i++) {
      const n = `${base}${i}`;
      const dir = solMode.value === 'add' ? joinPath(dirName(SOL.model.path), n) : joinPath(locIn.value.trim(), n);
      if (!(await api.exists(dir))) return n;
    }
    return base;
  }

  async function showStep(n) {
    step1.classList.toggle('hidden', n !== 1);
    step2.classList.toggle('hidden', n !== 2);
    $('#npBack').classList.toggle('hidden', n !== 2);
    $('#npNext').classList.toggle('hidden', n !== 1);
    $('#npCreate').classList.toggle('hidden', n !== 2);
    if (n === 2) {
      step2.querySelector('.np-tpl').textContent = `${tpl.name}   C#  ${tpl.tags.join('  ')}`;
      if (!nameIn.value || nameIn.dataset.auto === '1') { nameIn.value = await uniqueName(tpl.base); nameIn.dataset.auto = '1'; if (!solNameTouched) solNameIn.value = nameIn.value; }
      await update();
      nameIn.focus(); nameIn.select();
    } else search.focus();
  }

  const body = h('div', {}, step1, step2);
  const dlg = makeDialog({
    title: 'New Project', cls: 'dlg-wide np', body,
    buttons: ['spacer',
      { label: 'Back', id: 'npBack', onClick: () => showStep(1) },
      { label: 'Next', id: 'npNext', primary: true, onClick: () => tpl && showStep(2) },
      { label: 'Create', id: 'npCreate', primary: true, onClick: async (close, btn) => { if (!(await update())) return; btn.disabled = true; close(); await createProject(tpl, plan(), fwSel.value); } },
      { label: 'Cancel', onClick: (close) => close() }]
  });
  renderList();
  showStep(1);
  [nameIn, solNameIn, locIn].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#npCreate').click(); }));
  return dlg;
}

async function createProject(tpl, p, framework) {
  showPanel('output');
  log(`\n------ Creating ${tpl.name} "${p.name}" ------\n`, 'info');
  status(`Creating ${p.name}...`);
  const q = (x) => `"${x}"`;
  const parent = dirName(p.projDir);
  if (!(await api.exists(parent))) await api.createDir(parent);
  let ok = await dotnetStep(`dotnet new ${tpl.short} -n ${q(p.name)} -o ${q(p.projDir)}${framework ? ` -f ${framework}` : ''}`, parent);
  if (!ok && framework) { log('Retrying without choosing a framework...\n', 'info'); ok = await dotnetStep(`dotnet new ${tpl.short} -n ${q(p.name)} -o ${q(p.projDir)}`, parent); }
  if (!ok) { status('Creating the project failed (see Output)'); return; }
  const projFile = joinPath(p.projDir, `${p.name}.csproj`);

  let sln = p.sln;
  if (!p.add) {
    if (!(await dotnetStep(`dotnet new sln -n ${q(p.solName)} -o ${q(p.solDir)}`, p.solDir))) { status('Creating the solution failed (see Output)'); return; }
    sln = (await api.sln.find(p.solDir)).find((f) => dirName(f) === p.solDir || samePath(dirName(f), p.solDir));
  }
  if (sln && !(await dotnetStep(`dotnet sln ${q(sln)} add ${q(projFile)}`, dirName(sln)))) { status('Adding the project to the solution failed (see Output)'); return; }

  store('recentTemplates', [tpl.short, ...load('recentTemplates', []).filter((x) => x !== tpl.short)].slice(0, 5));
  if (!p.add) store('lastProjectsDir', dirName(p.solDir));
  log(`------ ${p.name} created ------\n`, 'info');

  if (p.add) await reloadSolution();
  else await openFolder(p.solDir);
  const proj = SOL.model && SOL.model.items.find((i) => i.type === 'project' && samePath(i.path, projFile));
  if (proj && proj.info && proj.info.runnable && (!p.add || !SOL.startup)) setStartup(projFile);
  state.expanded.add(`proj:${projFile}`);
  saveExpanded();
  await renderTree();
  for (const f of MAIN_FILES) { const fp = joinPath(p.projDir, f); if (await api.exists(fp)) { await openFile(fp); break; } }
  status(`Created ${p.name}`);
}

Object.assign(commands, {
  newProject: () => newProjectWizard({ addToSolution: false }),
  addNewProject: () => newProjectWizard({ addToSolution: true })
});
window.newProjectWizard = newProjectWizard;
