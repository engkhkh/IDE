# Nova IDE — Project Plan

Goal: a Visual Studio–style IDE for Windows: Solution Explorer, tabbed editor,
Build/Run (F5), Output and Error List, then IntelliSense and a real debugger.

## Tech stack
| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Desktop app with full file system + process access |
| Editor | Monaco | The editor engine behind VS Code (syntax, find/replace, minimap, multi-cursor) |
| Build/Run | dotnet / npm / flutter / python CLIs | Reuse real toolchains already on the machine |
| IntelliSense (Phase 3) | Language Server Protocol | Same approach VS Code uses (csharp-ls/Roslyn, tsserver, pyright) |
| Debugger (Phase 4) | Debug Adapter Protocol | netcoredbg for .NET, node inspector for JS |

## Architecture
```
main.js      Electron main process: window, menus, file system, build/run processes, search
preload.js   Secure bridge (contextIsolation) exposing window.ide API
renderer/    UI: toolbar, Solution Explorer, Monaco tabs, Output / Error List / Find Results, status bar
```

## Phases
### Phase 1 — MVP  ✅ (done)
- [x] VS 2022 style layout: toolbar, editor tabs, Solution Explorer (right), bottom panels, status bar
- [x] Open folder/file, recent folders, restore last session
- [x] Monaco editor with 40+ languages, dirty markers, Save / Save All
- [x] Explorer context menu: new file/folder, rename, delete (Recycle Bin), reveal, copy path
- [x] Project detection: .sln/.csproj, Node, Flutter, Python
- [x] Build / Rebuild / Clean / Start (F5) / Stop (Shift+F5) with Debug/Release
- [x] Output window + Error List parsed from MSBuild/tsc/dart output, click to jump, squiggles in editor
- [x] Find in Files (Ctrl+Shift+F), light/dark theme, zoom, resizable panels

### Phase 2 — Productivity  ✅ (done)
- [x] Integrated terminal (xterm.js + prebuilt node-pty): multiple instances, Ctrl+C/V copy-paste, right-click paste, "Open in Terminal" from explorer
- [x] Command palette (Ctrl+Shift+P) with fuzzy search + recently used, Go to File (Ctrl+P), ":" go to line
- [x] Tools > Options dialog + settings.json (theme, font, tab size, word wrap, minimap, auto save, format on save, terminal shell)
- [x] Git Changes window: branch switch/create, stage/unstage/undo, commit (Ctrl+Enter), amend, pull/push/fetch, history
- [x] Diff viewer (Monaco diff editor, side-by-side or inline, editable for working-tree changes)
- [x] Git status colors + badges in Solution Explorer, branch in status bar
- [x] File watcher: explorer auto-refresh (keeps expanded folders), reload files changed outside the IDE
- [x] Solution Explorer search (Ctrl+;) and Collapse All
- [x] Unit tests (`npm test`) + end-to-end test of the running app

### Phase 3 — IntelliSense  ✅ (done)
- [x] Own LSP client (JSON-RPC over stdio in the main process, byte-accurate framing, crash auto-restart)
- [x] Bundled servers: TypeScript/JavaScript (typescript-language-server 4.4 + TS 5.9), Python (Pyright); run on Electron's Node
- [x] C# via csharp-ls (one-click install), Dart/Flutter, clangd, gopls, rust-analyzer when installed; overrides in settings.json
- [x] Completion with snippets/auto-imports, hover, signature help, definition/peek/implementation/type definition, references
- [x] Rename across files (unsaved, like VS), Quick Actions + refactorings, organize imports, format document/selection
- [x] Diagnostics as squiggles + Error List with "Build + IntelliSense" filter and error/warning/message toggles
- [x] Go to All (Ctrl+T) workspace symbols, Go to Member (Alt+\\) file symbols, status bar server state + progress
- [x] One keyboard dispatcher (no double-firing), Visual Studio chords (Ctrl+K,D / Ctrl+K,C / Ctrl+K,U / Ctrl+R,R)
- [x] Tests: 7 unit tests + 25-check end-to-end run against the real TypeScript and Python servers

### Phase 4 — Debugger  ✅ (done)
- [x] Debug Adapter Protocol client (stdio + TCP adapters, js-debug child sessions)
- [x] .NET via netcoredbg 3.2, Node via js-debug 1.105, Python via debugpy; .NET/Node debuggers download on first use
- [x] F5 builds the .NET startup project first, then debugs the built dll; .nova/launch.json for custom setups
- [x] Breakpoints: click the margin / F9, conditional, enable/disable, persisted per folder, move with edits, verified state
- [x] Stepping F10 / F11 / Shift+F11, Run to Cursor (Ctrl+F10), Break All, Restart, Stop
- [x] Locals (with changed values in red, edit by double-click), Watch, Call Stack ([External Code] folded), Breakpoints, Immediate
- [x] Hover data tips, yellow current-statement arrow, orange status bar while debugging, Break on uncaught exceptions
- [x] Tests: 51 end-to-end checks (17 each for C#, Python, Node) against the real debuggers; earlier suites still pass

### Phase 5 — Solution system  ✅ (done)
- [x] .sln (with solution folders / nesting / configurations) and .slnx parsing; .csproj info (frameworks, kind, packages, references)
- [x] Solution Explorer: Solution > folders > projects > Dependencies > files, bin/obj hidden, Solution/Folder view switch
- [x] Startup project: bold, toolbar dropdown, Start button shows its name, used by F5/Ctrl+F5; persisted per solution
- [x] New Project wizard (Ctrl+Shift+N): available dotnet templates, name/location/solution/framework, add to existing solution
- [x] Project menu: Build/Rebuild/Clean, Add Class/New Item (namespace from folder), Reference Manager, Remove from Solution
- [x] NuGet Package Manager: Browse/Installed/Updates, versions, Install/Update/Uninstall/Update All, custom v3 source
- [x] Tests: 4 parser unit tests; end-to-end run creating a solution + 2 projects, reference, NuGet install/update with real packages, build, run, debug

### Phase 6 — Ship  ✅ (done)
- [x] App icon; electron-builder NSIS installer (per-user, choose folder, shortcuts), exe icon + version info
- [x] "Open with" for .sln/.slnx/.csproj/.fsproj/.vbproj (does not take over the default app) + folder "Open with Nova IDE"
- [x] Single instance: opening a path while running sends it to the existing window; command-line paths
- [x] Updates via electron-updater (generic URL or GitHub Releases from settings), status bar badge, install on restart
- [x] Log file (crashes, renderer errors), About dialog, new welcome page
- [x] Extensions API (commands + shortcuts, status bar, editor, snippets, themes, terminal, workspace), Extensions window, 3 samples
- [x] Packaging fixes found by testing the packaged app: servers run from app.asar.unpacked, TypeScript lib .d.ts restored, typeshed kept
- [x] Tests: Phase 6 suite (19) + all earlier suites pass against the packaged app (137 checks); installer registry steps verified under Wine

### Phase 7 — Test Explorer  ✅ (done)
- [x] Test discovery from source (xUnit/NUnit/MSTest attributes, namespaces, nested classes) with file + line, no build needed
- [x] Runs through `dotnet test` with VSTest filters and a TRX logger; results parsed from TRX (outcome, duration, message, stack, output)
- [x] Test Explorer tab: toolbar, summary + progress bar, filter/search, Project > Namespace > Class > Test > data rows, details pane with clickable stack
- [x] Run All / Run Failed / Run in context / Repeat / Cancel (stops the test host), Debug Tests (attaches netcoredbg via VSTEST_HOST_DEBUG)
- [x] CodeLens "✔ Passed | Run | Debug" above test methods; failed-count badge; auto re-discovery when files change
- [x] Visual Studio chord keys: Ctrl+R, A / T / Ctrl+T / F / L and Ctrl+E, T (dispatcher now supports two-key chords)
- [x] Tests: scanner + TRX unit tests; end-to-end run against the real `dotnet test` pipeline (offline xUnit-shaped framework + adapter)


### Phase 8 — Code Coverage  ✅ (done)
- [x] Analyze Code Coverage for All Tests / Selected Tests (Test menu, Test Explorer button + right-click)
- [x] Collector: coverlet ("XPlat Code Coverage") when referenced, else Microsoft Code Coverage (Format=cobertura); offers to add coverlet.collector when nothing is collected
- [x] Cobertura + LCOV readers; reports from several test projects merged; async/lambda/nested compiler names folded into their methods; deterministic (/_/) paths matched to workspace files
- [x] Code Coverage Results window (Module > Namespace > Class > Method, lines, %, branches, double-click to code), status bar total, "out of date" after edits
- [x] Editor coloring (covered / partly covered / not covered + gutter bars + overview ruler), toggle; follows edits
- [x] Import Coverage Results (coverage.py, Jest/c8/nyc LCOV, any Cobertura); Clear
- [x] Tests: 5 unit tests (real coverlet report, coverage.py, LCOV, helpers, path matching); end-to-end with the real coverlet 6.0.4 collector

### Phase 9 — Git History & Blame  ✅ (done)
- [x] Git Repository window (Git menu, Ctrl+0, Ctrl+R, Git Changes 🕘): all branches or one branch, commit graph (lanes, merges, curves), branch/remote/tag labels, virtual scrolling + paging
- [x] Branch list (local / remotes / tags): filter, checkout (double-click), merge, new branch, delete
- [x] Search by message, author or commit ID
- [x] Commit details: message, author, parents, changed files with +/−; per-file diff of a commit
- [x] Commit actions: New Branch, New Tag, Checkout (detached), Cherry-Pick, Revert, Reset (mixed / hard), Copy ID
- [x] File history (follows renames) from Git menu, editor and Solution Explorer
- [x] Blame (annotate) with click-through to the commit; unsaved lines = "Uncommitted"; inline blame for the cursor line (setting)
- [x] Tests: 5 unit tests (parsers, graph layout incl. paging, real repository); 43 end-to-end checks

### Phase 10 — Merge Conflicts & Stashes  ✅ (done)
- [x] Conflicts detected in git status (UU/AA/DU/UD/AU/UA/DD) + operation in progress (merge, rebase with step, cherry-pick, revert)
- [x] Git Changes: banner (Resolve Conflicts / Commit Merge or Continue / Skip / Abort), Merge Changes list, MERGING in the status bar; commit blocked while conflicts remain
- [x] 3-pane merge editor: Incoming | Current | Result, built from the index stages with `git merge-file --diff3`; per-conflict checkboxes, typing resolves, Reset, Take all, navigation, panes aligned + scroll-synced, Accept Merge -> next conflict
- [x] Delete/modify and binary conflicts: Keep / Delete / Take side dialog; context menu Take Incoming / Take Current / Mark as Resolved
- [x] Conflict markers in normal editors: colored + CodeLens Accept Current / Incoming / Both / Open Merge Editor
- [x] Stashes: Stash All / Keep Staged / Include Untracked (message from the commit box), list with files + diffs, Apply / Pop / Branch / Drop
- [x] Tests: 3 unit tests (parser, status, real repo merge/abort/stash); 37 end-to-end checks incl. a real rebase conflict

### Phase 11 — Multiple Windows  ✅ (done)
- [x] Window registry in the main process; every IPC request runs in its window's context (AsyncLocalStorage), so replies and events (terminal, builds, tests, debugger, LSP, Git) reach only that window; settings changes are broadcast
- [x] Per-window file watcher, language servers (opening a folder in one window no longer stops another's), terminals, debug sessions, test runs, build processes; all stopped when the window closes
- [x] File > New Window / Open Folder in New Window / Close Window, Window menu with the open windows, menu commands go to the window they were used in
- [x] Folder already open elsewhere -> that window comes to the front; second start with a path -> new window (or the window that has it)
- [x] Session: quitting saves the open windows (windows.json); next start reopens them with their tabs
- [x] Tests: 26 end-to-end checks with up to 4 windows (isolation, LSP per window, second start, close cleanup, restore)

### Phase 12 — Pull Requests  ✅ (done)
- [x] Service from the origin URL: GitHub, GitHub Enterprise, Azure DevOps (dev.azure.com, ssh, *.visualstudio.com); API URLs configurable
- [x] Accounts: PAT checked against the service, stored with Electron safeStorage (DPAPI); falls back to GitHub CLI / GITHUB_TOKEN / AZURE_DEVOPS_EXT_PAT
- [x] Pull Requests window: list with state filter + search; details (checks, reviewers, labels, Markdown description rendered safely, conversation incl. code comments, comment box), Files via git fetch of the PR refs (+/-, diffs), Commits
- [x] Actions: checkout (branch or pr/<n> for forks), review/vote, merge/squash/rebase, close/reopen, open in browser
- [x] New Pull Request dialog (title/description from commits, draft, pushes first); "Create a Pull Request" in Git Changes; current branch's PR in the status bar
- [x] Windows no longer get background-throttled (builds/tests in a window behind another keep running)
- [x] Tests: mock GitHub/Azure DevOps server over real bare repos; 4 unit tests (+ a renderer duplicate-global check); 36 end-to-end checks

### Phase 13 — Work Items  ✅ (done)
- [x] GitHub Issues (pull requests filtered out of /issues) and Azure Boards (WIQL queries, JSON Patch updates, work item types + states, comments API)
- [x] Work Items window: queries, search, details (description — Azure HTML turned into safe text —, comments, Development links to PRs/commits/branches), State, Assign to Me, comment
- [x] New Work Item (types on Azure), Create Branch (feature/<id>-title, --no-track; Azure links the branch)
- [x] "#" suggestions in the commit message box, Add to Commit Message (#id / Fixes #id)
- [x] #123 links in Git history commit details and PR descriptions (a #number that is a PR opens the PR)
- [x] New Pull Request adds "Related work items" (commits + branch name); Azure sends workItemRefs
- [x] Fixed: push of a branch whose upstream has another name (started from origin/main) now publishes it under its own name
- [x] Tests: 3 unit tests (helpers, GitHub, Azure); 43 end-to-end checks

### Phase 14 — Diagnostic Tools + Performance Profiler  ✅ (done)
- [x] Process sampler (main/diagnostics.js): the program's process tree (not the debug adapter), CPU % of all processors + memory (private bytes on Windows via one long-lived PowerShell/CIM, RSS from /proc or ps elsewhere)
- [x] Diagnostic Tools window opens with F5 (setting to keep it closed): events lane, Process Memory + CPU charts, paused time shaded, hover tooltip across charts
- [x] Events: breakpoints, steps, exceptions (with message + file:line, click to go there), output, process start/exit, snapshots
- [x] Summary / Events / Memory Usage (snapshots + diff) / CPU Usage (average while running, busiest moments)
- [x] Debug > Performance Profiler (Alt+F2): runs without the debugger, records, shows a performance report at exit; Stop from the window
- [x] Fixed: Stop (Shift+F5) on Linux/macOS now ends the program, not only the shell around it (process group)
- [x] Tests: 4 unit tests (parsers, process tree, Windows sampler protocol, live sampling); 35 end-to-end checks

### Phase 15 — CPU Usage by function + Memory Allocations  ✅ (done)
- [x] Performance Profiler options (Alt+F2): CPU Usage, Memory Allocations, charts; target = startup project or open file
- [x] .NET without dotnet-trace: own diagnostics IPC client (DOTNET_DiagnosticPorts=<port>,suspend, CollectTracing2, ResumeRuntime, StopTracing) + nettrace reader (V5 compressed headers, stack blocks, MethodLoadVerbose/rundown names, GCAllocationTick)
- [x] Node.js: V8 --cpu-prof through NODE_OPTIONS (+ a hook so Stop still writes it), allocation sampling via the inspector; Python: cProfile from sitecustomize.py
- [x] Report: Functions / Call Tree (hot path) / Caller/Callee, Just My Code ([External Code]), search, sort, go to source (.NET: method found by name in the .cs files)
- [x] Allocations: .NET by type with "allocated by" methods; Node.js by function
- [x] Hot Lines in the editor (time per line for Node.js, per function elsewhere); top functions in the Diagnostic Tools summary
- [x] Tests: 8 unit tests (IPC bytes, a hand-built nettrace, V8 + cProfile conversion, method lookup, live .NET / Node / Python runs); 36 end-to-end checks

### Phase 16 — .NET source lines + heap snapshots  ✅ (done)
- [x] Portable PDB reader (main/pdb.js): metadata streams, Document + MethodDebugInformation tables, sequence points, document names
- [x] Trace: ModuleLoad (module path -> PDB), MethodILToNativeMap; sample address -> native offset -> IL offset -> line
- [x] Report: .NET functions carry file:line (Go to Source exact), Hot Lines in C# files, allocations show the allocating line
- [x] Heap snapshots: GC heap dump over EventPipe (GCBulkType / GCBulkNode, induced GC), through the profiler's port or the port every .NET process opens (debugging)
- [x] Diagnostic Tools Memory Usage: Objects / Heap Size with diffs; heap view by type with compare, search, hide framework types, go to declaration
- [x] Fixed: Pause on a .NET program that never stopped (asks the debugger for its threads first)
- [x] Tests: 3 more unit tests (compressed integers, type lookup, live PDB lines + heap snapshot); 28 end-to-end checks
