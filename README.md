# Nova IDE

A Visual Studio style IDE built with Electron + Monaco. See PLAN.md for the roadmap.

## Install (Windows)
Run **NovaIDE-Setup-<version>.exe**. It installs for your user (no admin needed), adds Start menu and desktop
shortcuts, and adds:
- **Open with > Nova IDE** for .sln, .slnx, .csproj, .fsproj and .vbproj files (Visual Studio stays the default app);
- **Open with Nova IDE** when you right-click a folder (or empty space inside one) in File Explorer.

The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC":
click **More info > Run anyway**. Uninstall from Settings > Apps; your settings and extensions are kept
in `%APPDATA%\Nova IDE`.

Command line: `NovaIDE.exe C:\src\Shop\Shop.sln` (or a folder, project or file). If Nova IDE is already
running, the path opens in the existing window.

## Run from source
Requires Node.js 18+ (and the .NET SDK for C#, Git for the Git Changes window).

```
cd C:\projects-claude\NovaIDE
npm install
npm start
```
Or double-click `start.bat`.

## Build the installer yourself
Double-click `build-installer.bat` (or `npm run dist`). The result is in `dist\`:
`NovaIDE-Setup-<version>.exe`, plus `latest.yml` and a `.blockmap` used for updates.

## Updates
Help > Check for Updates. Updates are off until you publish them somewhere: upload the three files from
`dist\` for each new version (bump `version` in package.json first), then add to settings.json
(Tools > Options > Edit JSON) either `"updateUrl": "https://your-server/nova-ide/"` (a folder holding those
files) or `"updateGithub": "owner/repo"` (GitHub Releases). Nova IDE then checks shortly after starting,
shows "Update available" in the status bar, downloads in the background and installs on restart.

## Extensions
Tools > Extensions (Ctrl+Shift+X). The Samples tab installs **Word Count**, **C# Snippets** and
**Midnight Theme**. To write your own, see [EXTENSIONS.md](EXTENSIONS.md).

## Logs
Help > Open Logs Folder (`%APPDATA%\Nova IDE\logs\main.log`) has startup info, crashes and errors.

## Try it
1. File > Open Folder (Ctrl+Shift+O) and pick `samples\HelloNova`
2. Open `Program.cs`, press **F5** to run, **Ctrl+Shift+B** to build
3. Break the code (delete a `;`) and build: the error appears in the Error List; click it to jump to the line
4. Press **Ctrl+`** for a terminal, **Ctrl+P** to jump to any file, **Ctrl+Shift+P** for every command
5. Open **Git Changes** (Ctrl+Alt+G): click a changed file to see the diff, type a message and press Ctrl+Enter to commit

## Solutions and projects
- **File > New > Project** (Ctrl+Shift+N): Console, Class Library, WPF, WinForms, ASP.NET Core (Web API, Razor Pages, MVC, Empty),
  Blazor, Worker, gRPC, MAUI, xUnit/NUnit/MSTest, Razor Class Library (whatever your .NET SDK has). New projects go to
  `source\repos` by default; you can create a new solution or add to the open one.
- **File > Open Project/Solution**: .sln, .slnx (.NET 9+) or a .csproj.
- **Solution Explorer** shows Solution > solution folders > projects > Dependencies (Frameworks, Packages, Projects) > files,
  hides bin/obj, and has a button to switch between Solution view and Folder view.
- **Startup project**: shown in bold and in the dropdown next to Start; right-click a project > Set as Startup Project.
  F5, Ctrl+F5 and the Start button use it; Ctrl+Shift+B builds the whole solution.
- Right-click a project: Build / Rebuild / Clean, Add Class (Shift+Alt+C), Add New Item (Ctrl+Shift+A), Add New Folder,
  Add Project Reference (Reference Manager), Manage NuGet Packages, Edit Project File, Open in Terminal, Remove from Solution.
- **Manage NuGet Packages**: Browse / Installed / Updates tabs, prerelease toggle, pick a version, Install / Update /
  Uninstall, Update All. Uses nuget.org by default; set `"nugetSource"` in settings.json for another v3 feed.

## Test Explorer
Test > Test Explorer (Ctrl+E, T), or the Test Explorer tab next to Solution Explorer. Works with xUnit, NUnit and
MSTest projects (anything `dotnet test` runs):
- tests appear as soon as a solution opens (found in the source, no build needed): Project > Namespace > Class > Test,
  theory / test-case rows under their method after a run
- Run All (Ctrl+R, A), Run Failed (Ctrl+R, F), run the test at the cursor or the tests in the file (Ctrl+R, T),
  debug them (Ctrl+R, Ctrl+T), Repeat Last Run (Ctrl+R, L), Cancel; or right-click any node
- pass/fail icons, durations, a progress bar, filter (Failed / Passed / Skipped / Not Run) and search
- the details pane shows the failure message, the stack trace (click a file:line to jump there) and test output
- above every test method in the editor: "✔ Passed | Run | Debug" (CodeLens)
- Debug runs the test under the .NET debugger, so breakpoints in tests and in your code are hit

## Git history and blame
Git > Git Repository (Ctrl+0, Ctrl+R), the 🕘 button in Git Changes, or Git > View Branch History:
- every commit of all branches (or one branch) with a graph of branches and merges, branch / remote / tag labels,
  author, date and ID; scrolls through any number of commits
- branch list (local, remotes, tags): click to show a branch's history, double-click to check it out, right-click to
  merge, branch from it or delete it
- search by message, author or commit ID
- commit details: full message, author, parents (click to jump), changed files with +/− lines; click a file to see
  what that commit changed (side-by-side or inline diff)
- right-click a commit: New Branch, New Tag, Checkout, Cherry-Pick, Revert, Reset (keep or delete changes), Copy ID
- **View File History** (Git menu, editor or Solution Explorer right-click): the commits that changed a file,
  following renames; double-click one to see that change
- **Blame (Annotate)** (Git menu, editor or Solution Explorer right-click): date and author next to every line;
  click an annotation to open that commit. Unsaved lines show as "Uncommitted"
- **inline blame**: the line with the cursor shows who changed it last ("Alice, 3 days ago • Fix login").
  Turn it off in Git > Show Inline Blame or Settings

## Pull requests (GitHub, GitHub Enterprise, Azure DevOps)
Git > View Pull Requests, Git > New Pull Request..., Git > Accounts...
- **Accounts**: sign in with a personal access token (GitHub scope `repo`; Azure DevOps "Code: Read & write").
  Tokens are stored encrypted with Windows (DPAPI). A signed-in GitHub CLI (`gh`) or GITHUB_TOKEN also works
- **Pull Requests window**: Open / Merged / Closed / All, filter box; details with author, branches, checks,
  reviewers and labels. Overview (description in Markdown + conversation, including code comments; add a
  comment with Ctrl+Enter), Files (fetched with git, +/- per file, click for the diff), Commits
- actions: Checkout (the branch, or pr/<n> for forks), Open in Browser, Review (Approve / Request Changes /
  Comment; Azure DevOps votes), Merge (merge commit / squash / rebase), Close (Abandon) / Reopen (Reactivate)
- **New Pull Request**: target branch, title and description filled in from your commits, draft option; an
  unpushed branch is pushed first. After pushing a branch Git Changes offers "Create a Pull Request"
- the status bar shows the pull request of the current branch (⇄ #12); click to open it
- the repository's `origin` decides the service (github.com, a GitHub Enterprise host, dev.azure.com,
  *.visualstudio.com). Settings: githubApiUrl / azureDevOpsUrl for GitHub Enterprise or Azure DevOps Server

## Work items (GitHub Issues, Azure Boards)
Git > View Work Items, Git > New Work Item... (same sign-in as pull requests: Git > Accounts...)
- queries: Assigned to me, Created by me, Mentioning me (GitHub), All open, Recently changed (Azure), Recently
  closed; search by title or #id
- details: type, state, author, assignee, labels/tags, description, comments (add one with Ctrl+Enter) and
  Development: linked pull requests, commits and branches
- State ▾ (Azure: the states of that work item type; GitHub: Close / Close as not planned / Reopen),
  Assign to Me, Open in Browser
- **Create Branch...**: `feature/<id>-short-title` from origin/main (Azure Boards also links the branch)
- **Add to Commit Message**: `#12` or `Fixes #12`; or type `#` in the commit message box for suggestions
- `#12` in commit messages (Git Repository window) and pull request descriptions are links to the work item
- New Pull Request lists the work items mentioned in your commits or branch name (Azure DevOps links them)

## Multiple windows
- File > New Window (Ctrl+Alt+Shift+N), File > Open Folder in New Window..., File > Close Window; on the welcome
  page Ctrl+click (or right-click) a recent folder to open it in a new window
- the Window menu lists the open windows (by folder) and switches between them
- every window is independent: its own folder or solution, terminals, builds, tests, debugger, language servers
  and file watching; closing a window stops what it started. Settings changes apply to all windows
- opening a folder that is already open in another window brings that window to the front
- starting Nova IDE again ("Open with Nova IDE", NovaIDE.exe <path>) opens the path in a new window
  (or in the window that already has it open)
- quitting remembers the open windows; the next start opens them again with their files

## Merge conflicts and stashes
When a merge, rebase, cherry-pick or revert stops on conflicts (started in Nova IDE with Git > Merge Branch into
Current..., from the Git Repository window, or on the command line), Git Changes shows what is going on and a
**Merge Changes** list:
- **merge editor** (click a conflicted file): Incoming on the left, Current on the right, Result below, lined up at
  every conflict. Tick ☐ Take Incoming and/or ☐ Take Current per conflict (both = both, in the order you tick),
  or type in the Result. Take Incoming / Take Current for all, ▲▼ to move between conflicts, then **Accept Merge**
- files deleted on one side ask Keep or Delete; binary files ask which side to take
- right-click a conflict: Take Incoming, Take Current, Mark as Resolved (after fixing it by hand)
- files with conflict markers get Accept Current / Accept Incoming / Accept Both actions above each conflict
- the banner offers Commit Merge / Continue, Skip (rebase) and Abort; the status bar shows MERGING / REBASING

**Stashes**: Stash ▾ in Git Changes (or the Git menu) - Stash All, Stash All and Keep Staged, Stash All (Include
Untracked); the text in the commit box becomes the stash message. The Stashes list shows each stash: expand it to
see its files and click one for a diff; right-click to Apply, Pop, create a branch from it, or Drop it.

## Code coverage
Test > Analyze Code Coverage for All Tests (or the ▦ button / right-click in Test Explorer for selected tests):
- runs the tests with a coverage collector: coverlet (`coverlet.collector`, included in the standard dotnet xUnit/NUnit/MSTest templates)
  when the project has it, otherwise Microsoft Code Coverage. If nothing is collected, Nova IDE offers to add
  coverlet.collector and runs again
- **Code Coverage Results** window: Module > Namespace > Class > Method with covered / not covered lines, % and
  branches; double-click to jump to the code
- the editor colors lines like Visual Studio: blue = covered, tan = partly covered (some branches not taken),
  red = not covered; hover the gutter bar for details. Test > Show Code Coverage Coloring turns it on/off
- the status bar shows the total; results are marked "out of date" when you change a covered file
- Test > Import Coverage Results... reads Cobertura XML or LCOV from other tools too, e.g. Jest / c8 / nyc
  (`lcov.info`) or Python (`coverage xml`, `coverage lcov`)

## IntelliSense
Works through language servers (the same technology VS Code uses):

| Language | Server | Setup |
|---|---|---|
| TypeScript / JavaScript | typescript-language-server | built in |
| Python | Pyright | built in |
| C# | csharp-ls | run once: `dotnet tool install --global csharp-ls` (or Tools > IntelliSense: Install C# Language Server) |
| Dart / Flutter | Dart SDK | found automatically (PATH, C:\flutter, fvm) |
| C / C++ | clangd | install LLVM |
| Go / Rust | gopls / rust-analyzer | install with go / rustup |

Features: completion (Ctrl+Space), Quick Info on hover, Parameter Info, Go to Definition (F12), Peek Definition (Alt+F12),
Go to Implementation (Ctrl+F12), Find All References (Shift+F12), Rename (Ctrl+R, Ctrl+R or F2), Quick Actions (Ctrl+.),
Format Document (Ctrl+K, Ctrl+D), Go to All (Ctrl+T), Go to Member (Alt+\\), live errors in the editor and the Error List.

The status bar shows the language server for the current file; click it for details. For C#, open the folder that
contains your .sln or .csproj. Custom server paths go in settings.json:
`"lspServers": { "csharp": { "command": "C:\\tools\\csharp-ls.exe", "args": [] } }`

## Debugging
Press **F5** to debug, **F9** to set a breakpoint (or click left of the line numbers).

| Language | Debugger | Setup |
|---|---|---|
| C# / .NET | netcoredbg | downloaded automatically the first time (about 10 MB) |
| Node.js | js-debug (the one VS Code uses) | downloaded automatically the first time (about 3 MB) |
| Python | debugpy | installed with pip the first time (asks first) |

What F5 debugs: the startup .NET project (built first), otherwise the open Python or JavaScript file.
For anything else, add `.nova/launch.json` in VS Code format (`program`, `args`, `cwd`, `env`, `${workspaceFolder}`, `${file}`).

While stopped: Locals, Watch, Call Stack, Breakpoints and Immediate windows (bottom panel), hover a variable for its value,
double-click a value in Locals to change it, right-click the margin for conditional breakpoints or Run to Cursor.

## Launch profiles (launchSettings.json)
Like Visual Studio, Nova starts a .NET project with its launch profile from `Properties/launchSettings.json`:
the profile's `applicationUrl` (ASPNETCORE_URLS), `environmentVariables`, `commandLineArgs` and `workingDirectory`,
and opens the browser at `launchUrl` when `launchBrowser` is set (once the app says it is listening).
- F5 (debugger) and the Performance Profiler apply the profile themselves; Ctrl+F5 and Hot Reload pass
  `--launch-profile` to `dotnet run` / `dotnet watch`.
- The profile used is shown next to the startup project; click it (or Debug > Launch Profile...) to pick another.
  By default it's the profile named like the project, else the first one; IIS Express / Docker profiles are skipped.

While debugging .NET, an exception that only passes from an `await` into the async method's Task (and is handled
by the code awaiting it) is logged in the Output window and the program continues, as in Visual Studio.
Options > Debugging has a setting to break on those too.

## Hot Reload (.NET)
**Debug > Start With Hot Reload (Alt+Shift+F5)** or the 🔥 toolbar button runs the startup project under `dotnet watch`.
Edit code while the app runs and save: the change is applied to the running app, no restart.
**Apply Code Changes (Alt+F10)** (or 🔥 while running) saves all files and applies them.
- The status bar shows Ready / Applying / Changes applied / Build errors / Rude edit; click it for recent events.
- Compile errors go to the Error List; the app keeps running the last good code until you fix them.
- Edits that can't be applied to a running app (rude edits) restart it automatically.
- Hot Reload runs without the debugger (like Visual Studio's Ctrl+F5 + Hot Reload). Web apps open the browser
  (turn off "Hot Reload: open the browser for web apps" in Options > Debugging).

## Diagnostic Tools and Performance Profiler
When debugging starts, the **Diagnostic Tools** window opens (right side; Debug > Windows > Show Diagnostic Tools, Ctrl+Alt+F2):
- Events lane: breakpoints, steps and exceptions (red), program output, process start and exit, snapshots
- Process Memory (MB) and CPU (% of all processors) charts of your program (not of the debugger); time paused in the debugger is shaded
- Hover for the time, memory and CPU at that moment; click a diamond to find the event
- Tabs: Summary, Events (click to go to the file and line), Memory Usage (Take Snapshot, growth between snapshots), CPU Usage (average while running, busiest moments)

**Debug > Performance Profiler... (Alt+F2)** runs the startup project or the open file without the debugger. Pick the tools:
- **CPU Usage**: where the time goes, by function. The report has **Functions** (total and self time, sortable, searchable),
  **Call Tree** (with the 🔥 hot path expanded), and **Caller/Callee** (who calls a function and what it calls).
  **Just My Code** groups framework and library code as [External Code]. Double-click a function to go to its source.
  **⏱ Hot Lines** shows the time per line (Node.js) and per function in the editor.
- **Memory Allocations**: what allocates memory, .NET by object type (and the method that allocated it), Node.js by function.
- The Diagnostic Tools charts are always recorded; the summary lists the top functions.

| Program | CPU Usage | Allocations | How |
|---|---|---|---|
| .NET (startup project) | ✓ | ✓ by type | Built first, then started with the .NET diagnostics port (EventPipe); no extra tools needed |
| Node.js (file or npm start) | ✓ with lines | ✓ by function | V8 CPU profile + allocation sampling |
| Python (file) | ✓ with call counts | | cProfile |

For .NET the report knows the source line of every sample from the program's PDB (portable PDBs, the SDK default):
functions open at their first line, ⏱ Hot Lines work in C# files, and allocations name the allocating line.
Stop (⏹ or Shift+F5) ends a profiled run and still gives the report (.NET; Node.js and Python write theirs as they exit).

### .NET heap snapshots
For .NET programs, **Take Snapshot** in Diagnostic Tools (while debugging or profiling) also takes a heap snapshot:
a full GC that lists every live object. The Memory Usage tab shows Objects and Heap Size with the change since the
previous snapshot; click them to see the types (Count, Size, and their diff against another snapshot you pick;
search, hide framework types, double-click a type to go to its declaration). While paused in the debugger only the
process memory is recorded: continue, then take the snapshot.

Each snapshot keeps the object graph, so the view also shows:
- **Inclusive Size**: the objects plus everything only they keep alive (from the dominator tree), with its diff.
- **Paths to Root** (select a type): what keeps its objects alive, merged by type along the shortest path from a GC
  root: `[Static variable Recent]`, `[Stack]`, `[Strong handle]`, `[Finalizer queue]`... A growing count under a
  static variable is the classic leak.
- **Referenced Types**: what the objects of a type reference; expand to go deeper.
Debug > Open Last Performance Report reopens it.
Turn off "Show Diagnostic Tools when debugging starts" in Options > Debugging to keep the window closed (it still records).
Memory is private bytes on Windows and resident memory on Linux/macOS.

## Shortcuts
| Action | Key |
|---|---|
| Open folder / file | Ctrl+Shift+O / Ctrl+O |
| Save / Save All | Ctrl+S / Ctrl+Shift+S |
| Start Debugging / Continue | F5 |
| Start Without Debugging / Stop / Restart | Ctrl+F5 / Shift+F5 / Ctrl+Shift+F5 |
| Toggle Breakpoint / Delete All | F9 / Ctrl+Shift+F9 |
| Step Over / Into / Out / Run to Cursor | F10 / F11 / Shift+F11 / Ctrl+F10 |
| Locals / Watch / Call Stack / Breakpoints / Immediate | Ctrl+Alt+V / W / C / B / I |
| Diagnostic Tools / Performance Profiler | Ctrl+Alt+F2 / Alt+F2 |
| Start With Hot Reload / Apply Code Changes | Alt+Shift+F5 / Alt+F10 |
| Build | Ctrl+Shift+B |
| Find / Replace / Find in Files | Ctrl+F / Ctrl+H / Ctrl+Shift+F |
| Go to line | Ctrl+G |
| Solution Explorer / Output | Ctrl+Alt+L / Ctrl+Alt+O |
| Command Palette / Go to File | Ctrl+Shift+P / Ctrl+P |
| Terminal / New Terminal | Ctrl+` / Ctrl+Shift+` |
| Git Changes | Ctrl+Alt+G |
| Search Solution Explorer | Ctrl+; |
| Options / Extensions | Ctrl+, / Ctrl+Shift+X |
| Go to Definition / Peek / Implementation | F12 / Alt+F12 / Ctrl+F12 |
| Find All References / Rename | Shift+F12 / Ctrl+R, Ctrl+R |
| Test Explorer / Run All / Run Failed | Ctrl+E, T / Ctrl+R, A / Ctrl+R, F |
| Git Repository (history) | Ctrl+0, Ctrl+R |
| Run / Debug tests at cursor / Repeat last | Ctrl+R, T / Ctrl+R, Ctrl+T / Ctrl+R, L |
| Quick Actions / List Members / Parameter Info | Ctrl+. / Ctrl+Space / Ctrl+Shift+Space |
| Format Document / Comment / Uncomment | Ctrl+K, Ctrl+D / Ctrl+K, Ctrl+C / Ctrl+K, Ctrl+U |
| Go to All / Go to Member | Ctrl+T / Alt+\\ |
| Dev tools | Ctrl+Shift+I |

## Project layout
```
main.js           app window, menus, file system, build/run
main/             settings, terminal (node-pty), git, workspace (file index + watcher)
main/dap.js       debugger transport + one-click debugger install
main/solution.js  .sln/.slnx/.csproj parsing, dotnet templates, NuGet v3 client
main/updater.js   updates (electron-updater); main/extensions.js extension store; main/log.js log file
main/tests.js     Test Explorer back end: test scanner, dotnet test runner, TRX parser
main/coverage.js  coverage: Cobertura + LCOV readers, merging, results tree
main/githistory.js Git history: log + graph lanes, commit details, file history, blame, history operations
main/gitmerge.js  merge conflicts (stages, diff3 blocks, resolve, continue/abort) and stashes
main/pullrequests.js pull requests: GitHub + Azure DevOps REST, accounts (safeStorage), fetch/checkout via git
main/workitems.js work items: GitHub Issues + Azure Boards (WIQL, JSON Patch), branches for work items
main/diagnostics.js process CPU/memory sampling (/proc, ps, PowerShell CIM) for Diagnostic Tools + profiler
main/eventpipe.js   .NET diagnostics IPC + nettrace reader (CPU samples, method names, allocation ticks, heap dumps)
main/pdb.js         portable PDB reader (documents, sequence points) for .NET source lines
main/heapgraph.js   heap graph: dominators / retained sizes, paths to root, referenced types
main/profiler.js    Performance Profiler sessions: .NET / Node.js / Python, report building
main/lsp/         language server client: connection (JSON-RPC), servers (registry), index (manager)
preload.js        secure bridge -> window.ide
renderer/         renderer.js (core UI), settings.js, terminal.js, palette.js, git.js, workspace.js,
                  keymap.js (all shortcuts), lsp.js (IntelliSense), debug.js (debugger),
                  solution.js (Solution Explorer), newproject.js (New Project), nuget.js (NuGet),
                  extensions.js (extension API + manager), app.js (welcome, About, updates, open from Explorer),
                  tests.js (Test Explorer + CodeLens), coverage.js (coverage results + coloring),
                  githistory.js (Git Repository window, file history, blame),
                  gitmerge.js (merge editor, conflict actions, stashes),
                  pullrequests.js (Pull Requests window, create dialog, accounts),
                  workitems.js (Work Items window, # suggestions, #123 links),
                  diagnostics.js (Diagnostic Tools window), profiler.js (profiler options, performance report),
                  heapsnap.js (.NET heap snapshot view), hotreload.js (.NET Hot Reload)
build/            installer icon and installer.nsh (Open with / folder menu registry entries)
samples/          HelloNova sample project and sample extensions
test/             unit tests (npm test)
```

If the terminal shows "basic mode", run `npm install` again: the native terminal module didn't load.
