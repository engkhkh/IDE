// Nova IDE - Endpoints Explorer (View > Endpoints Explorer, like Visual Studio): every HTTP endpoint of the folder's
// ASP.NET Core projects. Double-click goes to the code; "Generate Request" adds it to the project's .http file
// (with @<Project>_HostAddress from launchSettings.json), ready for ▷ Send request.
'use strict';

const EP = { projects: [], filter: '', scanning: false };

async function epScan() {
  if (!state.root) { EP.projects = []; epRender(); return; }
  EP.scanning = true;
  epRender();
  EP.projects = (await api.endpoints(state.root)) || [];
  EP.scanning = false;
  epRender();
  return EP.projects;
}
function epRender() {
  const host = $('#epTree');
  if (!host) return;
  const q = EP.filter.toLowerCase();
  host.innerHTML = '';
  const total = EP.projects.reduce((n, p) => n + p.endpoints.length, 0);
  $('#epSummary').textContent = EP.scanning ? 'Scanning...' : `${total} endpoint(s) in ${EP.projects.length} project(s)`;
  if (!EP.scanning && !total) { host.innerHTML = '<div class="ch-empty">No ASP.NET Core endpoints found (app.MapGet(...), [HttpGet] actions).</div>'; return; }
  for (const p of EP.projects) {
    const eps = p.endpoints.filter((e) => !q || `${e.method} ${e.route} ${e.handler || ''}`.toLowerCase().includes(q));
    if (!eps.length) continue;
    const head = document.createElement('div');
    head.className = 'ep-proj';
    head.textContent = `${p.name}  (${p.host})`;
    host.appendChild(head);
    for (const e of eps) {
      const row = document.createElement('div');
      row.className = 'ep-row';
      row.innerHTML = '<span class="ep-verb"></span><span class="ep-route"></span><span class="ch-detail"></span><button class="ep-gen" title="Generate Request in the project\'s .http file">⚡ Generate Request</button>';
      row.children[0].textContent = e.method;
      row.children[0].dataset.verb = e.method;
      row.children[1].textContent = e.route;
      row.children[2].textContent = `${e.handler ? `${e.handler} · ` : ''}${baseName(e.file)}(${e.line})`;
      row.onclick = (ev) => { if (ev.target.closest('.ep-gen')) return; if (ev.detail === 2) openFile(e.file, e.line, 1); };
      row.querySelector('.ep-gen').onclick = () => epGenerate(p, e);
      host.appendChild(row);
    }
  }
}

// the request text Visual Studio writes: route constraints dropped ({id:int} -> {id}), a JSON body for POST/PUT/PATCH
function epRequestText(project, e) {
  const v = `${project.name.replace(/[^\w]/g, '_')}_HostAddress`;
  const route = e.route.replace(/\{(\*{0,2}\w+)(?::[^}]*)?\??\}/g, '{$1}').replace(/\{\*{1,2}/g, '{');
  const method = e.method === 'ANY' ? 'GET' : e.method;
  const body = /^(POST|PUT|PATCH)$/.test(method) ? 'Content-Type: application/json\n\n{\n  \n}\n' : '';
  return { variable: v, text: `${method} {{${v}}}${route}\nAccept: application/json\n${body}` };
}
async function epGenerate(project, e) {
  const dir = project.project.replace(/[\\/][^\\/]*$/, '');
  const file = `${dir}${sep()}${project.name}.http`;
  const { variable, text } = epRequestText(project, e);
  let tab = findTab(file);
  if (!tab) {
    let exists = true;
    try { await api.readFile(file); } catch { exists = false; }
    if (!exists) await api.writeFile(file, `@${variable} = ${project.host}\n`);
    await openFile(file);
    tab = findTab(file);
  } else activate(tab);
  const m = tab.model;
  let value = m.getValue();
  const edits = [];
  if (!new RegExp(`^@${variable}\\s*=`, 'm').test(value)) edits.push({ range: new monacoRef.Range(1, 1, 1, 1), text: `@${variable} = ${project.host}\n\n` });
  const last = m.getLineCount();
  const end = new monacoRef.Range(last, m.getLineMaxColumn(last), last, m.getLineMaxColumn(last));
  const sepText = value.trim() && !/^@[\w.-]+\s*=.*$/.test(value.trim().split('\n').pop()) ? '\n###\n\n' : '\n';
  edits.push({ range: end, text: `${value.endsWith('\n') || !value ? '' : '\n'}${sepText}${text}` });
  m.pushEditOperations([], edits, () => null);
  await saveTab(tab);
  value = m.getValue();
  const line = value.split('\n').findLastIndex((l) => l.startsWith(text.split('\n')[0])) + 1;
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line);
  status(`Added ${e.method} ${e.route} to ${baseName(file)}`);
  return file;
}

commands.showEndpoints = () => { showPanel('endpoints'); if (!EP.projects.length && !EP.scanning) epScan(); else epRender(); };
bus.on('ready', () => {
  $('#epRefresh').onclick = () => epScan();
  $('#epFilter').oninput = (e) => { EP.filter = e.target.value; epRender(); };
});
bus.on('folder', () => { EP.projects = []; epRender(); });
bus.on('saved', (tab) => { if (/\.cs$/i.test(tab.path) && EP.projects.length && $('#panel-endpoints').classList.contains('active')) epScan(); });
