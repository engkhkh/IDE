# Nova IDE next to Visual Studio 2026, JetBrains Rider and VS Code

Written for Nova 0.21.0 and updated for 0.22.0, 0.23.0 and 0.24.0 (November 2026). The other IDEs are compared at their current releases: Visual Studio 2026
(18.x, generally available since 11 Nov 2025), Rider 2025.3 and later, and VS Code with its usual C# Dev Kit / REST
Client extensions. "Ext." means the feature comes from an extension rather than the box.

Legend: ✅ has it · ◐ partly · ❌ no · **new** = added to Nova in Phase 21 because of this comparison.

## Editing and navigation

| Feature | Nova 0.21 | Visual Studio 2026 | Rider | VS Code |
|---|---|---|---|---|
| IntelliSense: completion, hover, signature help, go to definition / implementation, references, rename | ✅ (language servers) | ✅ (Roslyn) | ✅ (ReSharper engine) | ✅ |
| Quick actions / refactorings, organize usings, format document | ✅ (from the server) | ✅ | ✅ (many more refactorings) | ✅ |
| Go to All / Go to Member / Go to File | ✅ | ✅ | ✅ (Search Everywhere) | ✅ |
| CodeLens (references, tests) | ✅ | ✅ | ✅ | ✅ |
| **Call hierarchy** (Calls To / Calls From) | ✅ **new** | ✅ | ✅ | ✅ |
| **Inline hints** (parameter names, inferred types) | ✅ **new** (Alt+F1) | ✅ (Alt+F1) | ✅ | ✅ |
| **Bookmarks** + Bookmark window | ✅ **new** | ✅ | ✅ | Ext. |
| **Task List** (TODO / HACK comments) | ✅ **new** | ✅ | ✅ (TODO window) | Ext. |
| **Find / Replace in Files** with regex, whole word, file types | ✅ **new** (Find had no options, no Replace) | ✅ | ✅ | ✅ |
| **EditorConfig** | ✅ **new** | ✅ | ✅ | Ext. |
| **Markdown preview** | ✅ **new** | ✅ | ✅ | ✅ |
| **Split editor** (two files side by side, document groups) | ✅ **new in 0.22** | ✅ | ✅ | ✅ |
| Sticky scroll, minimap, bracket colors, multi-cursor | ✅ (Monaco) | ✅ | ✅ | ✅ |
| Code cleanup on save / format on save | ◐ (format + EditorConfig) | ✅ | ✅ | ✅ |
| **Spell checker** | ✅ **new in 0.22** | ✅ | ✅ | Ext. |

## Build, run and debug

| Feature | Nova 0.21 | Visual Studio 2026 | Rider | VS Code |
|---|---|---|---|---|
| .sln / .slnx solutions, Solution Explorer, project references | ✅ | ✅ | ✅ | ✅ (C# Dev Kit) |
| NuGet package manager | ✅ | ✅ | ✅ | ◐ |
| Debugger: breakpoints (conditions), locals, watch, call stack, immediate | ✅ (netcoredbg, Node, Python) | ✅ | ✅ | ✅ |
| launchSettings.json profiles | ✅ | ✅ | ✅ | ◐ |
| Multiple startup projects (.slnLaunch) | ✅ | ✅ | ✅ (compound configs) | ✅ (compounds) |
| Hot Reload (.NET) | ✅ (dotnet watch) | ✅ (also while debugging) | ✅ | ◐ |
| Diagnostic Tools, CPU / memory profiler, heap snapshots | ✅ | ✅ | ✅ (dotTrace / dotMemory) | ❌ |
| Test Explorer, run / debug tests, code coverage | ✅ | ✅ (coverage in all editions since 17.x) | ✅ (dotCover) | ✅ |
| **HTTP files** (.http with environments, request variables) | ✅ **new** | ✅ | ✅ (HTTP Client) | Ext. (REST Client) |
| **Endpoints Explorer** (list the API's routes, generate .http requests) | ✅ **new in 0.22** | ✅ | ✅ | ❌ |
| **Docker / container tools, Compose** | ✅ **new in 0.23** (Containers window; no debugging inside containers) | ✅ | ✅ | Ext. |
| **Database explorer / SQL editor** | ◐ **new in 0.23** (SQLite) | ◐ (SQL Server Object Explorer) | ✅ (DataGrip engine) | Ext. |
| Remote development (SSH, WSL, containers) | ❌ | ◐ | ✅ (Gateway) | ✅ |
| Publish (folder, Azure) | ❌ | ✅ | ✅ | Ext. |

## Source control and collaboration

| Feature | Nova 0.21 | Visual Studio 2026 | Rider | VS Code |
|---|---|---|---|---|
| Git: changes, commit, branches, history graph, blame, stash | ✅ | ✅ | ✅ | ✅ (graph via ext.) |
| Merge editor for conflicts | ✅ | ✅ | ✅ | ✅ |
| Pull requests (GitHub, Azure DevOps) and work items | ✅ | ✅ | ◐ | Ext. |
| Live Share / Code With Me | ❌ | ✅ | ✅ | Ext. |

## AI and environment

| Feature | Nova 0.21 | Visual Studio 2026 | Rider | VS Code |
|---|---|---|---|---|
| **AI chat** / agent, next-edit suggestions | ◐ **new in 0.23** (chat + Explain / Fix / Tests / Document; Claude, OpenAI-compatible, Ollama; no agent mode or inline completions) | ✅ (GitHub Copilot built in) | ✅ (JetBrains AI, Junie, Claude Agent) | ✅ (Copilot) |
| MCP servers for the AI | ❌ | ✅ | ✅ | ✅ |
| Themes | ◐ (dark / light) | ✅ (Fluent UI, tinted themes) | ✅ (Islands) | ✅ |
| Extensions | ✅ (own API + store) | ✅ | ✅ (plugins) | ✅ (largest marketplace) |
| **Settings sync** across machines | ✅ **new in 0.23** (GitHub Gist or a file) | ✅ | ✅ | ✅ |
| Runs on Windows / macOS / Linux | ✅ (Windows installer; runs on Linux) | Windows | ✅ | ✅ |

## What changed in Nova because of this

Phase 21 added everything marked **new** above. Each has unit tests and end-to-end checks in the packaged app.

Still missing after 0.23.0:

1. **Remote development** (SSH / WSL / containers as the place the code runs) and **Live Share / Code With Me** —
   both need a server-side component (a remote agent, a relay service) that Nova does not have.
2. **AI agent mode and inline (ghost-text) completions** — Nova's AI is chat plus selection actions.
3. **Debugging inside containers**, **SQL Server / PostgreSQL** connections, **Publish** (folder, Azure).

0.22.0 added the split editor (document groups), split terminal, spell checker and Endpoints Explorer; 0.23.0 the AI
Chat, Containers window, Database Explorer (SQLite) and Settings Sync.

## Nova next to Passenger (added for 0.24.0)

[Passenger](https://passenger-ide.net) is a free, open-source C# / .NET IDE (Windows, macOS, Linux) whose agent
integration works through an MCP server. What it had that Nova lacked, and what 0.24.0 did about it:

| Passenger | Nova 0.24 |
|---|---|
| An agent that drives the IDE (MCP: build, debug, test, see the windows) | ✅ **new**: MCP server with 10 tools, `.mcp.json` for the team |
| Code that waits for your trust | ✅ **new**: Workspace Trust / Restricted Mode |
| Values where you read them (line values, return values) | ✅ **new** (return values where the debugger reports them) |
| Breakpoints: hit counts, log messages, Set Next Statement | ✅ **new** (hit counts / log messages also emulated for netcoredbg; Set Next Statement where the debugger supports goto) |
| Local History (5 days) | ✅ **new** |
| Live previews for HTML, Markdown, SVG | ✅ HTML and SVG **new** (Markdown since 0.21) |
| Vim mode | ✅ **new** |
| Project files: MSBuild completion and evaluated-property hovers | ✅ **new** |
| Hot Reload while debugging | ❌ (Nova's Hot Reload runs without the debugger) |
| Attach to anything, decompile libraries without symbols | ❌ |
| XAML editing, XAML Preview, Live Visual Tree, XAML Hot Reload | ❌ |
| .NET MAUI / Android / iOS on devices, Godot 4, Blazor WebAssembly, Aspire, debugging in containers | ❌ (need SDKs and devices) |
| Live requests with their SQL, EF Core migrations | ❌ |
| Reqnroll / SpecFlow | ❌ |
| .resx / XLIFF editors | ❌ |
| Partial commits, signed commits | ❌ |
| Flame graphs, heap snapshot comparison | ◐ (heap snapshot diff yes; no flame graph) |
| VS Code themes from Open VSX, screen-reader support | ❌ / ◐ |

