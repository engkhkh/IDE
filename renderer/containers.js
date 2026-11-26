// Nova IDE - Containers window (View > Containers): containers and images from the docker CLI; start, stop,
// restart, remove, logs, environment / ports (inspect), open in the browser, a terminal inside (docker exec),
// Build Image from a Dockerfile and Compose Up / Down — their output goes to the Output window.
'use strict';

const CT = { data: null, view: 'containers', selected: null, procs: new Map() };

async function ctRefresh() {
  $('#ctMsg').textContent = 'Loading...';
  // only the latest refresh is shown (an older one can finish later)
  const seq = CT.seq = (CT.seq || 0) + 1;
  const data = await api.docker.list();
  if (seq !== CT.seq) return CT.data;
  CT.data = data;
  ctRender();
  ctFiles();
  return CT.data;
}
function ctRender() {
  const body = $('#ctBody');
  if (!body) return;
  body.innerHTML = '';
  const d = CT.data;
  if (!d) return;
  if (d.error) { $('#ctMsg').textContent = d.error; $('#ctHead').innerHTML = ''; return; }
  const running = d.containers.filter((c) => c.state === 'running').length;
  $('#ctMsg').textContent = `${d.containers.length} container(s), ${running} running · ${d.images.length} image(s)`;
  $$('#ctTabs button').forEach((b) => b.classList.toggle('active', b.dataset.v === CT.view));
  if (CT.view === 'containers') {
    $('#ctHead').innerHTML = '<tr><th></th><th>Name</th><th>Image</th><th>Status</th><th>Ports</th><th>Compose</th></tr>';
    for (const c of d.containers) {
      const tr = document.createElement('tr');
      tr.className = CT.selected === c.id ? 'selected' : '';
      tr.innerHTML = `<td><span class="ct-dot ${c.state === 'running' ? 'on' : ''}"></span></td><td></td><td></td><td></td><td></td><td></td>`;
      tr.children[1].textContent = c.name;
      tr.children[2].textContent = c.image;
      tr.children[3].textContent = c.status;
      tr.children[4].textContent = c.ports.map((p) => `${p.host}→${p.container}`).join(', ');
      tr.children[5].textContent = c.compose || '';
      tr.onclick = (e) => { CT.selected = c.id; ctRender(); if (e.detail === 2) ctLogs(c); };
      tr.oncontextmenu = (e) => { e.preventDefault(); CT.selected = c.id; ctRender(); popup(e.clientX, e.clientY, ctMenu(c)); };
      body.appendChild(tr);
    }
  } else {
    $('#ctHead').innerHTML = '<tr><th>Repository</th><th>Tag</th><th>Image ID</th><th>Size</th><th>Created</th></tr>';
    for (const i of d.images) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
      [i.repo, i.tag, i.id, i.size, i.created].forEach((v, k) => { tr.children[k].textContent = v; });
      tr.oncontextmenu = (e) => { e.preventDefault(); popup(e.clientX, e.clientY, [
        { label: 'Run (docker run -d -P)', run: () => ctRun(`docker run -d -P ${i.repo === '<none>' ? i.id : `${i.repo}:${i.tag}`}`, 'Run') },
        { label: 'Remove Image', run: () => ctAction('removeImage', i.id) }
      ]); };
      body.appendChild(tr);
    }
  }
  const c = ctSelected();
  for (const b of ['ctStart', 'ctStop', 'ctRestart', 'ctRemove', 'ctLogs', 'ctShell', 'ctBrowse']) $(`#${b}`).disabled = !c || CT.view !== 'containers';
  if (c) { $('#ctStart').disabled = c.state === 'running'; $('#ctStop').disabled = $('#ctShell').disabled = c.state !== 'running'; $('#ctBrowse').disabled = !c.ports.length || c.state !== 'running'; }
}
const ctSelected = () => (CT.data && CT.data.containers ? CT.data.containers.find((c) => c.id === CT.selected) : null);
function ctMenu(c) {
  return [
    { label: 'Start', run: () => ctAction('start', c.id), disabled: c.state === 'running' },
    { label: 'Stop', run: () => ctAction('stop', c.id), disabled: c.state !== 'running' },
    { label: 'Restart', run: () => ctAction('restart', c.id) },
    { label: 'View Logs', run: () => ctLogs(c) },
    { label: 'Environment, Ports, Mounts', run: () => ctInspect(c) },
    { label: 'Open Terminal (docker exec)', run: () => ctShell(c), disabled: c.state !== 'running' },
    { label: 'Open in Browser', run: () => ctBrowse(c), disabled: !c.ports.length || c.state !== 'running' },
    { label: 'Remove', run: () => ctAction('remove', c.id) }
  ];
}
async function ctAction(action, id) {
  if ((action === 'remove' || action === 'removeImage') && !confirm(`${action === 'remove' ? 'Remove the container' : 'Remove the image'} ${id.slice(0, 12)}?`)) return;
  status(`docker ${action}...`);
  const r = await api.docker.action(action, id);
  if (r.error) { log(`docker ${action}: ${r.error}\n`, 'stderr'); showPanel('output'); status(r.error.split('\n')[0]); }
  else status(`docker ${action}: done`);
  await ctRefresh();
  return r;
}
async function ctLogs(c) {
  const r = await api.docker.logs(c.id);
  showPanel('output');
  log(`\n------ Logs of ${c.name} (last 500 lines) ------\n${r.error ? r.error : `${r.stdout}${r.stderr}`}\n`, r.error ? 'stderr' : null);
  return r;
}
async function ctInspect(c) {
  const r = await api.docker.inspect(c.id);
  if (r.error) return status(r.error);
  const d = r.data;
  const lines = [`------ ${c.name} (${d.Config.Image}) ------`, 'Environment:', ...(d.Config.Env || []).map((e) => `  ${e}`),
    'Ports:', ...Object.entries(d.NetworkSettings.Ports || {}).map(([k, v]) => `  ${k} -> ${(v || []).map((x) => `${x.HostIp}:${x.HostPort}`).join(', ') || '(not published)'}`),
    'Mounts:', ...(d.Mounts || []).map((m) => `  ${m.Source} -> ${m.Destination}${m.RW ? '' : ' (read-only)'}`)];
  showPanel('output');
  log(`\n${lines.join('\n')}\n`, 'info');
}
async function ctShell(c) {
  const t = await newTerminal(state.root);
  if (!t) return;
  t.title = `${c.name} (container)`;
  renderTermSelect();
  await api.term.write(t.id, `${await api.docker.path()} exec -it ${c.id.slice(0, 12)} sh -c "command -v bash >/dev/null && exec bash || exec sh"\r`);
}
function ctBrowse(c) { const p = c.ports.find((x) => x.proto === 'tcp') || c.ports[0]; if (p) api.openExternal(`http://localhost:${p.host}`); }

// Build Image / Compose: output into the Output window, then refresh
async function ctRun(command, what, cwd = state.root) {
  showPanel('output');
  log(`\n------ ${what}: ${command} ------\n`, 'info');
  const id = await api.run({ command, cwd });
  return new Promise((resolve) => CT.procs.set(id, { what, resolve }));
}
async function ctFiles() {
  if (!state.root) return;
  const files = await api.ws.listFiles(state.root).catch(() => []);
  const rel = (f) => f.slice(state.root.length + 1);
  CT.dockerfiles = (files || []).filter((f) => /(^|[\\/])Dockerfile$/i.test(f) && !/[\\/](bin|obj|node_modules)[\\/]/.test(f));
  CT.compose = (files || []).filter((f) => /(^|[\\/])(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(f) && !/[\\/]node_modules[\\/]/.test(f));
  $('#ctBuild').disabled = !CT.dockerfiles.length;
  $('#ctBuild').title = CT.dockerfiles.length ? `docker build: ${CT.dockerfiles.map(rel).join(', ')}` : 'No Dockerfile in the folder';
  $('#ctUp').disabled = $('#ctDown').disabled = !CT.compose.length;
  $('#ctUp').title = CT.compose.length ? `docker compose up -d: ${rel(CT.compose[0])}` : 'No compose file in the folder';
}
// the image name Visual Studio uses: the project (or folder) name, lower case
const ctImageName = (dockerfile) => baseName(dirName(dockerfile)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'app';
async function ctBuild() {
  const df = (state.active && /Dockerfile$/i.test(state.active.path) && state.active.path) || CT.dockerfiles[0];
  if (!df) return;
  const docker = await api.docker.path();
  // .NET templates put the Dockerfile in the project but build from the solution folder
  const ctx = state.root;
  const code = await ctRun(`"${docker}" build -f "${df}" -t ${ctImageName(df)}:dev "${ctx}"`, 'Build Image');
  await ctRefresh();
  return code;
}
async function ctCompose(up) {
  const f = CT.compose[0];
  if (!f) return;
  const docker = await api.docker.path();
  const code = await ctRun(`"${docker}" compose -f "${f}" ${up ? 'up -d --build' : 'down'}`, up ? 'Compose Up' : 'Compose Down', dirName(f));
  await ctRefresh();
  return code;
}

api.on('proc:data', ({ id, data, stream }) => { if (CT.procs.has(id)) log(data, stream === 'stderr' ? 'stderr' : null); });
api.on('proc:exit', ({ id, code }) => {
  const p = CT.procs.get(id);
  if (!p) return;
  CT.procs.delete(id);
  log(`====== ${p.what} finished with exit code ${code} ======\n`, code ? 'stderr' : 'info');
  p.resolve(code);
});

commands.showContainers = () => { showPanel('containers'); ctRefresh(); };
bus.on('ready', () => {
  $('#ctRefresh').onclick = () => ctRefresh();
  $$('#ctTabs button').forEach((b) => { b.onclick = () => { CT.view = b.dataset.v; ctRender(); }; });
  const withSel = (fn) => () => { const c = ctSelected(); if (c) fn(c); };
  $('#ctStart').onclick = withSel((c) => ctAction('start', c.id));
  $('#ctStop').onclick = withSel((c) => ctAction('stop', c.id));
  $('#ctRestart').onclick = withSel((c) => ctAction('restart', c.id));
  $('#ctRemove').onclick = withSel((c) => ctAction('remove', c.id));
  $('#ctLogs').onclick = withSel(ctLogs);
  $('#ctShell').onclick = withSel(ctShell);
  $('#ctBrowse').onclick = withSel(ctBrowse);
  $('#ctBuild').onclick = () => ctBuild();
  $('#ctUp').onclick = () => ctCompose(true);
  $('#ctDown').onclick = () => ctCompose(false);
});
bus.on('folder', () => { CT.data = null; ctRender(); });
