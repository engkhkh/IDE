# Nova IDE next to Visual Studio 2026, JetBrains Rider and VS Code

Written for Nova 0.21.0 (November 2026). The other IDEs are compared at their current releases: Visual Studio 2026
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
| Split editor (two files side by side, editor groups) | ❌ | ✅ | ✅ | ✅ |
| Sticky scroll, minimap, bracket colors, multi-cursor | ✅ (Monaco) | ✅ | ✅ | ✅ |
| Code cleanup on save / format on save | ◐ (format + EditorConfig) | ✅ | ✅ | ✅ |
| Spell checker | ❌ | ✅ | ✅ | Ext. |

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
| Endpoints Explorer (list the API's routes) | ❌ | ✅ | ✅ | ❌ |
| Docker / container tools, Compose | ❌ | ✅ | ✅ | Ext. |
| Database explorer / SQL editor | ❌ | ◐ (SQL Server Object Explorer) | ✅ (DataGrip engine) | Ext. |
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
| AI chat / agent, next-edit suggestions | ❌ | ✅ (GitHub Copilot built in) | ✅ (JetBrains AI, Junie, Claude Agent) | ✅ (Copilot) |
| MCP servers for the AI | ❌ | ✅ | ✅ | ✅ |
| Themes | ◐ (dark / light) | ✅ (Fluent UI, tinted themes) | ✅ (Islands) | ✅ |
| Extensions | ✅ (own API + store) | ✅ | ✅ (plugins) | ✅ (largest marketplace) |
| Settings sync across machines | ❌ | ✅ | ✅ | ✅ |
| Runs on Windows / macOS / Linux | ✅ (Windows installer; runs on Linux) | Windows | ✅ | ✅ |

## What changed in Nova because of this

Phase 21 added everything marked **new** above. Each has unit tests and end-to-end checks in the packaged app.

Still missing, roughly in order of how much they matter to a .NET developer:

1. **AI assistant** — the biggest difference today: all three others ship chat, agent mode and inline suggestions.
2. **Split editor groups** — two files side by side (the diff and merge views are the only split views now).
3. **Docker / containers** — run and debug in a container, Compose.
4. **Endpoints Explorer** — list an ASP.NET Core app's routes and generate .http requests from them.
5. **Database tools**, **remote development** (SSH / WSL), **Live Share**, **settings sync**, **spell checker**.
