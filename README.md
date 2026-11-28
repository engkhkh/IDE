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

## Multiple startup projects
Like Visual Studio, F5 can start several projects of a solution at once: pick a profile in the startup project box
(next to Start), or Project > Configure Startup Projects... to make one. For each project choose Start (with the
debugger), Start without debugging, or None, its launch profile (Debug Target), and the order.
- Profiles are Visual Studio's multi-project launch profiles: `<Solution>.slnLaunch` (shared with the team) or
  `<Solution>.slnLaunch.user` (yours), next to the solution. Profiles made in either IDE work in both.
- F5 builds the solution once, debugs the "Start" projects (each its own debugger; breakpoints in any of them)
  and runs the others; Ctrl+F5 runs them all without the debugger. Output lines start with `[Project]`.
- A program that ends leaves the others running; Shift+F5 stops them all.

## Editing and navigation (Phase 21)
Features Visual Studio, Rider and VS Code all have, added after comparing them (see [docs/COMPARISON.md](docs/COMPARISON.md)):
- **Bookmarks**: Ctrl+K, Ctrl+K toggles one on the current line; Ctrl+K, Ctrl+N / Ctrl+P go to the next / previous
  across all files; Ctrl+K, Ctrl+L clears them; Ctrl+K, Ctrl+W opens the Bookmark window (double-click a name to rename).
  A bookmark moves with its line as you edit, and they are kept per folder.
- **Task List** (View > Task List): the `TODO`, `HACK`, `UNDONE` and `FIXME` comments of the whole folder, in any
  language. Saved files update at once. Change the tokens in Options > Text Editor.
- **Find / Replace in Files** (Ctrl+Shift+F / Ctrl+Shift+H): match case, whole word, regular expressions (`$1` in the
  replacement), file types (`*.cs; *.json`). Replace All edits open files in the editor (one Undo step, you save
  them) and writes the other files.
- **EditorConfig**: `.editorconfig` files are followed — indent style and size, tab width, line endings, trailing
  whitespace and final newline on save. The status bar shows ⚙ EditorConfig when one applies (hover for the values).
- **Markdown preview** (Ctrl+Shift+V or 👁 Preview in the status bar): beside the editor, updated as you type, code
  blocks colored, relative links open the file. HTML in the Markdown is shown as text.
- **View Call Hierarchy** (Ctrl+K, Ctrl+T or the editor's context menu): Calls To / Calls From a method, expandable,
  click to go to the call (from the language server: TypeScript/JavaScript, C#, Python, ...).
- **Inline hints** (Alt+F1 or Options > IntelliSense): parameter names and inferred types from the language server.

## Document groups, split terminal, spell checker, Endpoints Explorer (Phase 22)
- **Split editor** (Window > New Vertical Document Group, Ctrl+Alt+\\ or the editor's context menu "Split Editor
  Right"): a second group beside the editor with its own tabs. Both groups edit the same documents. Ctrl+S and
  Close work on the group you are typing in; Ctrl+Alt+PageDown switches groups; ✕ closes the group.
- **Split terminal** (◫ in the Terminal window or Ctrl+Shift+5): terminals side by side in one group; click one to
  make it the active one. A new terminal (＋) gets the whole panel again.
- **Spell checker** (on by default; Edit > Advanced > Toggle Spell Checker, Options > Text Editor): comments and prose
  strings in code, every word of Markdown / text files (not code blocks). Identifiers are split (`GetOrderTotl`
  flags "Totl"); URLs, paths, e-mail addresses and short acronyms are skipped. Ctrl+. offers corrections, Ignore
  and Add to dictionary (your words: `exclusion.dic` in Nova's user data folder; `.editorconfig`'s
  `spelling_exclusion_path` adds a word list for the code base). English (Hunspell dictionary).
- **Endpoints Explorer** (View > Endpoints Explorer): the HTTP endpoints of the folder's ASP.NET Core projects, read
  from the source — minimal APIs (`app.MapGet`, nested `MapGroup` prefixes, `MapMethods`) and controllers (`[Route]`,
  `[HttpGet("...")]`, `[controller]` / `[action]`). Double-click goes to the code; ⚡ Generate Request adds it to
  `<Project>.http` with `@<Project>_HostAddress` from launchSettings.json, ready for ▷ Send request.

## AI Chat, Containers, Database Explorer, Settings Sync (Phase 23)
- **AI Chat** (the AI Chat tab beside Solution Explorer, View > AI Chat, Ctrl+Alt+Shift+I): ask about your code with
  the selection or the active file as context; answers stream in as Markdown, code blocks have ⤵ Insert (replaces
  the selection, one Undo) and Copy. The editor's context menu (and Tools > AI) has Explain, Fix, Write Tests and
  Document. ⚙ picks the provider: **Claude** (Anthropic API, default model `claude-sonnet-5-5`), **OpenAI or any
  OpenAI-compatible API** (Azure OpenAI's /v1, LM Studio, vLLM...), or **Ollama** on your PC (no key, nothing leaves
  the machine). Bring your own API key: it is kept encrypted by the OS (or read from ANTHROPIC_API_KEY /
  OPENAI_API_KEY), never in settings.json. ■ Stop ends an answer.
- **Containers** (View > Containers): containers (state, ports, Compose project) and images through the docker CLI —
  Start, Stop, Restart, Remove, Logs (double-click), Environment / Ports / Mounts, ⌨ Terminal inside the container
  (docker exec), 🌐 open the published port, 🔨 Build Image from the folder's Dockerfile (tagged `<folder>:dev`,
  built from the solution folder like Visual Studio's .NET templates), ⬆ Compose Up / ⬇ Down. Works with Docker
  Desktop, Podman (Options > docker command) or a remote DOCKER_HOST.
- **Database Explorer** (View > Database Explorer): the folder's SQLite databases (`*.db`, `*.sqlite`, `*.sqlite3`,
  `*.db3`) or any you add with ＋ (a new path creates one) — tables and views with row counts, columns (🔑 keys,
  🔗 foreign keys), indexes; double-click a table for its first 200 rows; a query box (Ctrl+Enter) and Ctrl+Shift+E
  in a `.sql` file run SQL on the chosen database. Changes are written to the file (not if it changed meanwhile).
  SQLite through sql.js (WebAssembly): nothing to install. SQL Server / PostgreSQL are not supported yet.
- **Settings Sync** (Tools > Settings Sync): Upload puts your Options, dictionary words and extension list in a secret
  GitHub Gist (the GitHub sign-in of Git > Accounts, GITHUB_TOKEN or the GitHub CLI; the token needs the `gist`
  scope); Download on another PC applies them and installs the extensions it can. Export / Import a file does the
  same without GitHub.

## Agents, Workspace Trust, debugger values, Local History (Phase 24, ideas from Passenger)
- **Agents (MCP server)** — Tools > Agents, or Options > Agents: Nova runs an MCP server on `127.0.0.1:7811/mcp`
  (Streamable HTTP; a web page can't call it). Coding agents — Claude Code, Codex, OpenCode, Cursor — then work
  through the IDE: `get_workspace`, `get_editor_text` (with unsaved changes), `open_file`, `get_diagnostics` (the
  Error List), `build`, `run_tests`, `find_symbol`, `set_breakpoint`, `debug` (start / step / continue / stop / state
  with locals) and `screenshot`. "Write .mcp.json" adds the server to the folder for the whole team; "Copy the
  claude mcp add command" for your own Claude Code. 🤖 MCP in the status bar while it runs.
- **Workspace Trust** — a folder you haven't trusted opens in Restricted Mode: you can read and edit, but building,
  running, debugging, tests, Hot Reload, the profiler, Docker builds, .http requests and agent builds first ask
  "Do you trust the authors of this folder?". Trusting a folder trusts its subfolders (Tools > Workspace Trust).
- **Debugger**: values where you read them — while paused, the lines of the current method show the locals they use
  at the line end, and a function's return value shows at the call after stepping out (Python; C# where netcoredbg
  reports it). **Breakpoint Settings** (right-click the breakpoint, or Debug > Breakpoint Settings): hit count
  (`5`, `>= 5`, `% 5`) and a **log message** (`i = {i}`: a tracepoint, ◆, logs and continues) — handed to the
  debugger when it supports them, otherwise Nova counts and logs itself (netcoredbg). **Set Next Statement**
  (Ctrl+Shift+F10) where the debugger supports it (Python).
- **Local History** (View > Local History): every save of every file is kept for 5 days (also files Git doesn't
  track); Compare shows a version beside the file, Restore puts it back (Ctrl+Z undoes it).
- **Live preview** of HTML (in a sandboxed frame: scripts run but can't reach Nova) and SVG, next to Markdown (👁 Preview,
  Ctrl+Shift+V).
- **Vim mode** (Options > Text Editor, Edit > Advanced > Toggle Vim Mode): normal / insert / visual / command line;
  `:w`, `:q`, `:wq`.
- **Project files**: in .csproj / .props / .targets, completion of MSBuild properties and items, their values
  (TargetFramework, OutputType, Nullable...), NuGet package ids and versions, project references; hovering a property
  or `$(Property)` shows the value MSBuild evaluates (`dotnet msbuild -getProperty`).

## HTTP files (.http / .rest)
Test web APIs without leaving the IDE, with the same file format as Visual Studio (also read by Rider and the VS Code
REST Client):
```http
@base = {{HostAddress}}/api

# @name login
POST {{base}}/token
Content-Type: application/json

{ "user": "{{User}}" }

###
GET {{base}}/orders
Authorization: Bearer {{login.response.body.$.token}}
```
- **▷ Send request** above each request (or Ctrl+Alt+S at the cursor); the response opens beside the editor:
  status, time, size, pretty-printed body, headers, the request that was sent, raw. gzip/deflate/br are unpacked.
- Environments: the nearest `http-client.env.json` (in the file's folder or a parent), with `$shared` defaults and
  your own values in `http-client.env.json.user`; pick one in the box at the top right of the editor.
  Variables in the .http file win over the environment.
- Request variables: `{{name.response.body.$.json.path}}`, `{{name.response.headers.Location}}`,
  `{{name.request.body.*}}` — send the named request first.
- Dynamic variables: `{{$guid}}`, `{{$randomInt 1 100}}`, `{{$timestamp}}`, `{{$datetime iso8601 1 d}}`,
  `{{$localDatetime "dd-MM-yyyy"}}`, `{{$processEnv NAME}}`, `{{$dotenv NAME}}`. `{{` completes variable names.
- Requests go out from Nova itself (no browser CORS); the ASP.NET Core development certificate is accepted for
  localhost. Secrets stored in Azure Key Vault / DPAPI providers are not read: put them in the `.user` file.

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
| Find / Replace / Find in Files / Replace in Files | Ctrl+F / Ctrl+H / Ctrl+Shift+F / Ctrl+Shift+H |
| Bookmark: toggle / next / previous / clear / window | Ctrl+K, Ctrl+K / Ctrl+K, Ctrl+N / Ctrl+K, Ctrl+P / Ctrl+K, Ctrl+L / Ctrl+K, Ctrl+W |
| Call Hierarchy / Inline hints | Ctrl+K, Ctrl+T / Alt+F1 |
| Markdown Preview / Send HTTP request | Ctrl+Shift+V / Ctrl+Alt+S |
| Split editor / switch group / split terminal | Ctrl+Alt+\\ / Ctrl+Alt+PageDown / Ctrl+Shift+5 |
| AI Chat / Execute SQL | Ctrl+Alt+Shift+I / Ctrl+Shift+E |
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
main/httpclient.js  sends the requests of .http files (no CORS; dev certificate on localhost)
main/spellcheck.js  spell checker (nspell + Hunspell English dictionary, user words)
main/endpoints.js   Endpoints Explorer: ASP.NET Core routes from minimal APIs and controllers
main/ai.js          AI Chat: Anthropic / OpenAI-compatible / Ollama streaming, keys in safeStorage
main/containers.js  Containers window (docker CLI)
main/database.js    Database Explorer: SQLite through sql.js
main/settingssync.js Settings Sync through a GitHub Gist
main/mcp.js         MCP server for coding agents (tools run in the renderer: renderer/agents.js)
main/trust.js       Workspace Trust; main/localhistory.js Local History; main/projectfiles.js MSBuild evaluation
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
                  heapsnap.js (.NET heap snapshot view), hotreload.js (.NET Hot Reload),
                  launchprofiles.js (launchSettings.json), multistart.js (multiple startup projects),
                  editorconfig.js, bookmarks.js, tasklist.js, replaceinfiles.js (Find/Replace in Files),
                  markdown.js (Markdown preview + side pane), httpclient.js (.http files),
                  callhierarchy.js (call hierarchy + inline hints), splitview.js (second document group),
                  spellcheck.js, endpoints.js (Endpoints Explorer), ai.js (AI Chat), containers.js,
                  database.js (Database Explorer), settingssync.js, debuginline.js (values while paused),
                  localhistory.js, vim.js, projectfiles.js, agents.js (MCP tools), trust.js (Restricted Mode)
docs/             COMPARISON.md: Nova next to Visual Studio 2026, Rider and VS Code
build/            installer icon and installer.nsh (Open with / folder menu registry entries)
samples/          HelloNova sample project and sample extensions
test/             unit tests (npm test)
```

If the terminal shows "basic mode", run `npm install` again: the native terminal module didn't load.
