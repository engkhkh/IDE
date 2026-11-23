// Nova IDE - NuGet Package Manager (Browse / Installed / Updates), Visual Studio style
'use strict';

const metaCache = {};
const fmtDownloads = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));

function nugetManager(projPath, opts = {}) {
  const projects = SOL.model ? SOL.model.items.filter((i) => i.type === 'project' && i.info && !i.info.error) : [];
  if (!projects.length) { status('Open a .NET solution or project first'); return; }
  const st = {
    proj: (projPath && projects.find((p) => samePath(p.path, projPath))) || projects.find((p) => SOL.startup && samePath(p.path, SOL.startup)) || projects[0],
    tab: opts.tab || 'browse', items: [], selected: null, latest: {}, busy: false, token: 0,
    pre: !!state.settings.nugetPrerelease
  };

  const tabs = h('div', { class: 'ng-tabs' });
  const search = h('input', { class: 'dlg-input ng-search', placeholder: 'Search (Ctrl+L)', spellcheck: false });
  const pre = h('input', { type: 'checkbox' }); pre.checked = st.pre;
  const projSel = h('select', { class: 'dlg-input ng-proj' }, projects.map((p) => h('option', { value: p.path }, p.name)));
  projSel.value = st.proj.path;
  const refreshBtn = h('button', { title: 'Refresh' }, '⟳');
  const updateAll = h('button', { class: 'primary hidden' }, 'Update All');
  const list = h('div', { class: 'ng-list' });
  const details = h('div', { class: 'ng-details' });
  const busy = h('div', { class: 'ng-busy hidden' }, h('span', {}, 'Working...'));
  const body = h('div', { class: 'ng' },
    h('div', { class: 'ng-top' }, tabs, h('span', { class: 'tb-spacer' }), h('label', { class: 'ng-label' }, 'Project'), projSel),
    h('div', { class: 'ng-bar' }, search, refreshBtn, h('label', { class: 'np-check' }, pre, ' Include prerelease'), h('span', { class: 'tb-spacer' }), updateAll, h('span', { class: 'ng-source', title: state.settings.nugetSource }, `Package source: ${/nuget\.org/i.test(state.settings.nugetSource || 'nuget.org') ? 'nuget.org' : state.settings.nugetSource}`)),
    h('div', { class: 'ng-main' }, list, details), busy);
  const dlg = makeDialog({ title: `NuGet - ${st.proj.name}`, cls: 'dlg-xl', body, buttons: ['spacer', { label: 'Close', onClick: (close) => close() }] });
  const titleEl = dlg.el.querySelector('.dlg-head b');

  const installed = () => (st.proj.info.packages || []);
  const installedVersion = (id) => { const p = installed().find((x) => x.id.toLowerCase() === id.toLowerCase()); return p ? p.version || '(central)' : null; };
  const hasUpdate = (id) => { const v = installedVersion(id); const l = st.latest[id.toLowerCase()]; return !!(v && l && v !== l && compareVer(l, v) > 0); };

  function renderTabs() {
    tabs.innerHTML = '';
    const nUpd = installed().filter((p) => hasUpdate(p.id)).length;
    for (const [id, label] of [['browse', 'Browse'], ['installed', 'Installed'], ['updates', `Updates${nUpd ? ` ${nUpd}` : ''}`]]) {
      const b = h('button', { class: st.tab === id ? 'active' : '' }, label);
      b.onclick = () => { st.tab = id; st.selected = null; load(); };
      tabs.appendChild(b);
    }
    updateAll.classList.toggle('hidden', st.tab !== 'updates' || !nUpd);
  }

  async function load() {
    const token = ++st.token;
    renderTabs();
    list.innerHTML = '';
    list.appendChild(h('div', { class: 'dlg-desc ng-msg' }, 'Loading...'));
    let items = [];
    if (st.tab === 'browse') {
      const r = await api.nuget.search(search.value.trim(), st.pre, 0);
      if (token !== st.token) return;
      if (r.error) { list.innerHTML = ''; list.appendChild(h('div', { class: 'np-err ng-msg' }, `Could not reach the package source: ${r.error}`)); renderDetails(); return; }
      items = r.items;
    } else {
      const ids = installed().map((p) => p.id);
      if (ids.length) Object.assign(st.latest, Object.fromEntries(Object.entries(await api.nuget.latest(ids, st.pre)).map(([k, v]) => [k.toLowerCase(), v])));
      if (token !== st.token) return;
      const qy = search.value.trim().toLowerCase();
      items = installed().filter((p) => !qy || p.id.toLowerCase().includes(qy)).map((p) => ({ id: p.id, version: st.latest[p.id.toLowerCase()] || p.version, description: '', downloads: null, ...(metaCache[p.id.toLowerCase()] || {}) }));
      // fill in description/authors from the package source (cached)
      const missing = items.filter((i) => !metaCache[i.id.toLowerCase()]);
      if (missing.length) {
        await Promise.all(missing.map(async (i) => {
          const r = await api.nuget.search(i.id, st.pre, 0);
          const m = (r.items || []).find((x) => x.id.toLowerCase() === i.id.toLowerCase());
          if (m) metaCache[i.id.toLowerCase()] = { description: m.description, authors: m.authors, downloads: m.downloads, projectUrl: m.projectUrl, versions: m.versions };
        }));
        if (token !== st.token) return;
        items = items.map((i) => ({ ...i, ...(metaCache[i.id.toLowerCase()] || {}), version: i.version }));
      }
      if (st.tab === 'updates') items = items.filter((i) => hasUpdate(i.id));
    }
    st.items = items;
    if (!st.selected && opts.select) st.selected = items.find((i) => i.id.toLowerCase() === opts.select.toLowerCase()) || null;
    if (st.selected) st.selected = items.find((i) => i.id === st.selected.id) || null;
    if (!st.selected) st.selected = items[0] || null;
    renderTabs();
    renderList();
    renderDetails();
  }

  function renderList() {
    list.innerHTML = '';
    if (!st.items.length) {
      list.appendChild(h('div', { class: 'dlg-desc ng-msg' }, st.tab === 'browse' ? 'No packages found.' : st.tab === 'updates' ? 'All packages are up to date.' : 'No packages installed in this project.'));
      return;
    }
    for (const it of st.items) {
      const inst = installedVersion(it.id);
      const upd = hasUpdate(it.id);
      const row = h('div', { class: `ng-item${st.selected && st.selected.id === it.id ? ' sel' : ''}` },
        h('div', { class: 'ng-icon' }, it.id.slice(0, 1).toUpperCase()),
        h('div', { class: 'ng-text' },
          h('div', {}, h('b', {}, it.id), it.authors ? h('span', { class: 'dlg-desc' }, ` by ${it.authors}`) : null, it.downloads != null ? h('span', { class: 'dlg-desc' }, `, ${fmtDownloads(it.downloads)} downloads`) : null),
          it.description ? h('div', { class: 'dlg-desc ng-descline' }, it.description) : null),
        h('div', { class: 'ng-ver' },
          inst ? h('div', { class: 'ng-inst', title: 'Installed version' }, `✓ ${inst}`) : null,
          upd ? h('div', { class: 'ng-upd', title: 'Update available' }, `↑ ${st.latest[it.id.toLowerCase()]}`) : (!inst ? h('div', {}, it.version) : null)));
      row.onclick = () => { st.selected = it; renderList(); renderDetails(); };
      list.appendChild(row);
    }
  }

  async function renderDetails() {
    details.innerHTML = '';
    const it = st.selected;
    if (!it) return;
    const inst = installedVersion(it.id);
    const verSel = h('select', { class: 'dlg-input' }, h('option', {}, 'Loading...'));
    const installBtn = h('button', { class: 'primary' }, inst ? 'Update' : 'Install');
    const removeBtn = h('button', {}, 'Uninstall');
    removeBtn.classList.toggle('hidden', !inst);
    details.append(...[
      h('div', { class: 'ng-dtitle' }, h('div', { class: 'ng-icon big' }, it.id.slice(0, 1).toUpperCase()), h('b', {}, it.id)),
      inst ? h('div', { class: 'np-row' }, h('span', {}, 'Installed:'), h('div', { class: 'np-field' }, h('b', {}, inst), removeBtn)) : null,
      h('div', { class: 'np-row' }, h('span', {}, 'Version:'), h('div', { class: 'np-field' }, verSel, installBtn)),
      it.description ? h('div', { class: 'ng-section' }, h('b', {}, 'Description'), h('div', {}, it.description)) : null,
      it.authors ? h('div', { class: 'ng-meta' }, h('span', {}, 'Author(s): '), it.authors) : null,
      it.downloads != null ? h('div', { class: 'ng-meta' }, h('span', {}, 'Downloads: '), fmtDownloads(it.downloads)) : null,
      it.projectUrl ? h('div', { class: 'ng-meta' }, h('span', {}, 'Project URL: '), (() => { const a = h('a', { href: '#' }, it.projectUrl); a.onclick = (e) => { e.preventDefault(); api.openExternal(it.projectUrl); }; return a; })()) : null
    ].filter(Boolean));
    let versions = it.versions && it.versions.length ? it.versions : null;
    if (!versions) { const r = await api.nuget.versions(it.id); versions = r.versions || [it.version]; }
    if (st.selected !== it) return;
    if (!st.pre) versions = versions.filter((v) => !v.includes('-') || v === inst);
    const latest = versions.slice().sort(compareVer).pop();
    verSel.innerHTML = '';
    for (const v of versions.slice().sort(compareVer).reverse()) {
      const tag = v === latest ? (v.includes('-') ? '  (Latest prerelease)' : '  (Latest stable)') : '';
      verSel.appendChild(h('option', { value: v }, `${v}${tag}${v === inst ? '  (Installed)' : ''}`));
    }
    verSel.value = latest;
    const syncBtn = () => { installBtn.textContent = !inst ? 'Install' : verSel.value === inst ? 'Installed' : compareVer(verSel.value, inst) > 0 ? 'Update' : 'Downgrade'; installBtn.disabled = inst === verSel.value; };
    verSel.onchange = syncBtn; syncBtn();
    installBtn.onclick = () => act(`${inst ? 'Updating' : 'Installing'} ${it.id} ${verSel.value}`, () => api.nuget.install(st.proj.path, it.id, verSel.value));
    removeBtn.onclick = () => { if (confirm(`Uninstall ${it.id} from ${st.proj.name}?`)) act(`Uninstalling ${it.id}`, () => api.nuget.uninstall(st.proj.path, it.id)); };
  }

  async function act(label, fn) {
    if (st.busy) return;
    st.busy = true;
    busy.classList.remove('hidden');
    busy.querySelector('span').textContent = `${label}...`;
    status(`${label}...`);
    log(`\n------ ${label} (${st.proj.name}) ------\n`, 'info');
    const r = await fn();
    log(`${(r.stdout || '') + (r.stderr || '')}\n`, r.ok ? null : 'stderr');
    if (!r.ok) { status(`${label} failed (see Output)`); showPanel('output'); }
    else status(`${label}: done`);
    await refreshProject(st.proj.path);
    st.proj = SOL.model.items.find((i) => i.type === 'project' && samePath(i.path, st.proj.path)) || st.proj;
    busy.classList.add('hidden');
    st.busy = false;
    await load();
    return r.ok;
  }

  updateAll.onclick = async () => {
    for (const p of installed().filter((x) => hasUpdate(x.id))) if (!(await act(`Updating ${p.id} ${st.latest[p.id.toLowerCase()]}`, () => api.nuget.install(st.proj.path, p.id, st.latest[p.id.toLowerCase()])))) break;
  };
  let searchTimer = null;
  search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 350); };
  search.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); load(); } };
  pre.onchange = () => { st.pre = pre.checked; st.latest = {}; updateSetting({ nugetPrerelease: st.pre }); load(); };
  projSel.onchange = () => { st.proj = projects.find((p) => p.path === projSel.value); titleEl.textContent = `NuGet - ${st.proj.name}`; st.latest = {}; load(); };
  refreshBtn.onclick = async () => { await api.nuget.resetFeed(); st.latest = {}; load(); };
  dlg.el.addEventListener('keydown', (e) => { if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); search.focus(); } });
  load();
  setTimeout(() => focusIfIdle(search), 0); // don't steal focus from a field the user is already in
  window.__nuget = { st, load };
}

function compareVer(a, b) {
  const [pa, ra] = String(a).split('-'); const [pb, rb] = String(b).split('-');
  const na = pa.split('.').map(Number); const nb = pb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) { const d = (na[i] || 0) - (nb[i] || 0); if (d) return d; }
  if (ra && !rb) return -1; if (!ra && rb) return 1;
  return (ra || '').localeCompare(rb || '');
}

commands.manageNuget = (projPath, opts) => nugetManager(typeof projPath === 'string' ? projPath : (SOL.selectedProject || SOL.startup), opts || {});
