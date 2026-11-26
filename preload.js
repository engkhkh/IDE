// Nova IDE - safe bridge between renderer and main process
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('ide', {
  // dialogs + file system
  openFolderDialog: invoke('dialog:openFolder'),
  openFileDialog: invoke('dialog:openFile'),
  saveAsDialog: invoke('dialog:saveAs'),
  readDir: invoke('fs:readDir'),
  readFile: invoke('fs:readFile'),
  writeFile: invoke('fs:writeFile'),
  createFile: invoke('fs:createFile'),
  createDir: invoke('fs:createDir'),
  rename: invoke('fs:rename'),
  trash: invoke('fs:trash'),
  reveal: invoke('fs:reveal'),
  detectProject: invoke('project:detect'),
  searchInFiles: invoke('search:inFiles'),

  // build / run processes
  run: invoke('proc:run'),
  kill: invoke('proc:kill'),
  confirmClose: () => ipcRenderer.send('app:confirmClose'),

  // settings
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    defaults: invoke('settings:defaults'),
    path: invoke('settings:path')
  },

  // integrated terminal
  term: {
    create: invoke('term:create'),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: invoke('term:kill')
  },

  // git
  git: {
    status: invoke('git:status'),
    show: invoke('git:show'),
    stage: invoke('git:stage'),
    unstage: invoke('git:unstage'),
    discard: invoke('git:discard'),
    commit: invoke('git:commit'),
    branches: invoke('git:branches'),
    checkout: invoke('git:checkout'),
    pull: invoke('git:pull'),
    push: invoke('git:push'),
    fetch: invoke('git:fetch'),
    init: invoke('git:init'),
    log: invoke('git:log')
  },

  // language servers (IntelliSense)
  lsp: {
    ensure: invoke('lsp:ensure'),
    request: invoke('lsp:request'),
    notify: (key, method, params) => ipcRenderer.send('lsp:notify', key, method, params),
    cancel: (key, method) => ipcRenderer.send('lsp:cancel', key, method),
    reply: (fid, result) => ipcRenderer.send('lsp:reply', fid, result),
    stopAll: invoke('lsp:stopAll'),
    restart: invoke('lsp:restart'),
    install: invoke('lsp:install'),
    list: invoke('lsp:list'),
    running: invoke('lsp:running')
  },

  // debugger (Debug Adapter Protocol)
  dap: {
    start: invoke('dap:start'),
    send: (id, msg) => ipcRenderer.send('dap:send', id, msg),
    kill: invoke('dap:kill'),
    resolve: invoke('dap:resolve'),
    install: invoke('dap:install')
  },
  capture: invoke('proc:capture'),

  // solutions, projects, dotnet templates, NuGet
  sln: {
    find: invoke('sln:find'),
    load: invoke('sln:load'),
    projectInfo: invoke('proj:info'),
    addProject: invoke('sln:addProject'),
    removeProject: invoke('sln:removeProject'),
    addRef: invoke('proj:addRef'),
    removeRef: invoke('proj:removeRef'),
    sdks: invoke('dotnet:sdks'),
    templates: invoke('dotnet:templates'),
    dotnet: invoke('dotnet:run')
  },
  nuget: {
    search: invoke('nuget:search'),
    versions: invoke('nuget:versions'),
    latest: invoke('nuget:latest'),
    install: invoke('nuget:install'),
    uninstall: invoke('nuget:uninstall'),
    resetFeed: invoke('nuget:resetFeed')
  },
  openFilteredDialog: invoke('dialog:openFiltered'),
  exists: invoke('fs:exists'),
  projectsDir: invoke('app:projectsDir'),
  openExternal: invoke('app:openExternal'),
  // .http / .rest files
  httpSend: invoke('http:send'),
  httpCancel: invoke('http:cancel'),
  processEnv: invoke('http:processEnv'),

  // app shell: command-line open, logs, About, updates
  app: {
    ready: () => ipcRenderer.send('app:rendererReady'),
    launchPath: invoke('app:launchPath'),
    windowInfo: invoke('app:windowInfo'),
    setFolder: (folder) => ipcRenderer.send('app:folder', folder),
    folderOpenElsewhere: invoke('app:folderOpenElsewhere'),
    newWindow: invoke('app:newWindow'),
    command: (cmd) => ipcRenderer.send('app:command', cmd),
    info: invoke('app:info'),
    openLogs: invoke('app:openLogs'),
    logError: (msg) => ipcRenderer.send('log:renderer', 'error', String(msg).slice(0, 4000))
  },
  update: {
    check: invoke('update:check'),
    download: invoke('update:download'),
    install: invoke('update:install'),
    state: invoke('update:state')
  },
  // extensions
  ext: {
    list: invoke('ext:list'),
    samples: invoke('ext:samples'),
    installSample: invoke('ext:installSample'),
    installFolder: invoke('ext:installFolder'),
    uninstall: invoke('ext:uninstall'),
    setEnabled: invoke('ext:setEnabled'),
    openFolder: invoke('ext:openFolder'),
    dir: invoke('ext:dir')
  },

  // Test Explorer
  tests: {
    scan: invoke('tests:scan'),
    scanText: invoke('tests:scanText'),
    run: invoke('tests:run'),
    cancel: invoke('tests:cancel')
  },
  prof: { prepare: invoke('prof:prepare'), beforeStop: invoke('prof:beforeStop'), finish: invoke('prof:finish'), findMethod: invoke('prof:findMethod'), findType: invoke('prof:findType'), heapSnapshot: invoke('prof:heapSnapshot'), heapPaths: invoke('prof:heapPaths'), heapRefs: invoke('prof:heapRefs') },
  diag: {
    start: invoke('diag:start'),
    stop: invoke('diag:stop'),
    setPid: invoke('diag:setPid')
  },
  wi: {
    info: invoke('wi:info'),
    list: invoke('wi:list'),
    get: invoke('wi:get'),
    types: invoke('wi:types'),
    create: invoke('wi:create'),
    setState: invoke('wi:setState'),
    assignToMe: invoke('wi:assignToMe'),
    comment: invoke('wi:comment'),
    createBranch: invoke('wi:createBranch')
  },
  pr: {
    remote: invoke('pr:remote'),
    list: invoke('pr:list'),
    get: invoke('pr:get'),
    commits: invoke('pr:commits'),
    conversation: invoke('pr:conversation'),
    files: invoke('pr:files'),
    fileAt: invoke('pr:fileAt'),
    comment: invoke('pr:comment'),
    review: invoke('pr:review'),
    merge: invoke('pr:merge'),
    setState: invoke('pr:setState'),
    checkout: invoke('pr:checkout'),
    createInfo: invoke('pr:createInfo'),
    create: invoke('pr:create'),
    accounts: invoke('pr:accounts'),
    signIn: invoke('pr:signIn'),
    signOut: invoke('pr:signOut')
  },
  gitmerge: {
    info: invoke('gitmerge:info'),
    resolve: invoke('gitmerge:resolve'),
    control: invoke('gitmerge:control'),
    stashList: invoke('gitmerge:stashList'),
    stashFiles: invoke('gitmerge:stashFiles'),
    stashFile: invoke('gitmerge:stashFile'),
    stash: invoke('gitmerge:stash')
  },
  githist: {
    log: invoke('githist:log'),
    refs: invoke('githist:refs'),
    details: invoke('githist:details'),
    fileAt: invoke('githist:fileAt'),
    blame: invoke('githist:blame'),
    op: invoke('githist:op')
  },
  coverage: {
    load: invoke('coverage:load'),
    summarize: invoke('coverage:summarize')
  },

  keymap: invoke('menu:keymap'),
  toggleDevTools: () => ipcRenderer.send('app:devtools'),

  // workspace
  ws: {
    listFiles: invoke('ws:listFiles'),
    watch: invoke('ws:watch'),
    stat: invoke('ws:stat')
  },

  on: (channel, fn) => {
    const allowed = ['menu', 'proc:data', 'proc:exit', 'app:beforeClose', 'term:data', 'term:exit', 'fs:changed', 'settings:changed', 'lsp:state', 'lsp:notification', 'lsp:serverRequest', 'lsp:log', 'dap:message', 'dap:closed', 'dap:log', 'dap:installProgress', 'app:openPath', 'update:status', 'tests:output', 'tests:done', 'tests:debugReady', 'diag:sample'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  }
});
