// Nova IDE - editing project files (.csproj, .fsproj, .vbproj, .props, .targets) like Passenger / Rider:
// completion of MSBuild properties, items and their values, NuGet package ids and versions (from your feeds),
// and hovers that show a property's evaluated value as MSBuild sees it (dotnet msbuild -getProperty).
'use strict';

const PJ_PROPS = {
  TargetFramework: ['The framework to build for', ['net10.0', 'net9.0', 'net8.0', 'net48', 'netstandard2.1', 'netstandard2.0']],
  TargetFrameworks: ['Several frameworks, separated by ;', ['net10.0;net8.0', 'net8.0;netstandard2.0']],
  OutputType: ['What the project builds', ['Exe', 'Library', 'WinExe']],
  Nullable: ['Nullable reference types', ['enable', 'disable', 'warnings', 'annotations']],
  ImplicitUsings: ['Global usings for the SDK', ['enable', 'disable']],
  LangVersion: ['C# version', ['latest', 'preview', 'default', '14', '13', '12']],
  RootNamespace: ['Default namespace of new files', []], AssemblyName: ['Name of the built assembly', []],
  Version: ['Package / assembly version', ['1.0.0']], Authors: ['Package authors', []], Description: ['Package description', []],
  PackageId: ['NuGet package id', []], IsPackable: ['Can be packed with dotnet pack', ['true', 'false']],
  GenerateDocumentationFile: ['Write the /// docs to an XML file', ['true', 'false']],
  TreatWarningsAsErrors: ['Warnings fail the build', ['true', 'false']], WarningsAsErrors: ['These warnings fail the build', ['nullable']],
  NoWarn: ['Warnings to hide', ['$(NoWarn);CS1591']], InvariantGlobalization: ['No culture data (smaller apps)', ['true', 'false']],
  PublishAot: ['Native AOT publishing', ['true', 'false']], PublishSingleFile: ['One-file publishing', ['true', 'false']],
  SelfContained: ['Include the .NET runtime', ['true', 'false']], RuntimeIdentifier: ['Target platform', ['win-x64', 'linux-x64', 'osx-arm64', 'win-arm64']],
  UserSecretsId: ['dotnet user-secrets id', []], IsTestProject: ['Marks a test project', ['true', 'false']],
  EnableNETAnalyzers: ['.NET code analyzers', ['true', 'false']], AnalysisLevel: ['Analyzer rule set', ['latest', 'latest-recommended', 'latest-all']],
  UseWPF: ['WPF', ['true']], UseWindowsForms: ['Windows Forms', ['true']], OutputPath: ['Where the build goes', ['bin\\$(Configuration)\\']],
  Configuration: ['Debug or Release', ['Debug', 'Release']], Platform: ['Platform', ['AnyCPU', 'x64', 'ARM64']],
  ManagePackageVersionsCentrally: ['Central package management (Directory.Packages.props)', ['true']],
  ContainerRepository: ['Image name for dotnet publish -t:PublishContainer', []]
};
const PJ_ITEMS = {
  PackageReference: ['A NuGet package', 'PackageReference Include="$1" Version="$2" />'],
  ProjectReference: ['Another project', 'ProjectReference Include="$1" />'],
  PackageVersion: ['A version in Directory.Packages.props', 'PackageVersion Include="$1" Version="$2" />'],
  Compile: ['C# files (Remove / Include)', 'Compile Remove="$1" />'], None: ['Other files', 'None Include="$1" CopyToOutputDirectory="PreserveNewest" />'],
  Content: ['Content files', 'Content Include="$1" CopyToOutputDirectory="PreserveNewest" />'], EmbeddedResource: ['Embedded files', 'EmbeddedResource Include="$1" />'],
  Using: ['A global using', 'Using Include="$1" />'], InternalsVisibleTo: ['Friend assembly (tests)', 'InternalsVisibleTo Include="$1" />'],
  FrameworkReference: ['A shared framework', 'FrameworkReference Include="Microsoft.AspNetCore.App" />']
};
const pjIsProject = (model) => /\.(csproj|fsproj|vbproj|props|targets)$/i.test(model.uri.path);

// where the cursor is: inside which element, typing an element name, or an attribute value
function pjContext(text) {
  const attr = text.match(/<(\w+)\b[^<>]*\b(Include|Update|Version)="([^"]*)$/);
  if (attr) {
    const tag = text.slice(text.lastIndexOf('<')).match(/<(\w+)/)[1];
    const inc = text.slice(text.lastIndexOf('<')).match(/\bInclude="([^"]*)"/);
    return { kind: 'attr', tag, attr: attr[2], typed: attr[3], include: inc ? inc[1] : null };
  }
  const open = text.match(/<(\w*)$/);
  const stack = [];
  for (const m of text.matchAll(/<(\/?)(\w+)[^<>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.length = i; } else stack.push(m[2]);
  }
  const parent = stack[stack.length - 1] || '';
  if (open) return { kind: 'element', parent, typed: open[1] };
  const val = text.match(/<(\w+)>([^<]*)$/);
  if (val && val[1] === parent) return { kind: 'value', prop: parent, typed: val[2] };
  return { kind: 'none', parent };
}

async function pjComplete(model, pos) {
  const L = monacoRef.languages;
  const K = L.CompletionItemKind;
  const text = model.getValueInRange(new monacoRef.Range(1, 1, pos.lineNumber, pos.column));
  const c = pjContext(text);
  const word = model.getWordUntilPosition(pos);
  const range = new monacoRef.Range(pos.lineNumber, word.startColumn, pos.lineNumber, pos.column);
  if (c.kind === 'element' && c.parent === 'PropertyGroup') {
    return Object.entries(PJ_PROPS).map(([n, [doc, vals]]) => ({ label: n, kind: K.Property, documentation: doc, insertText: `${n}>${vals[0] ? `\${1:${vals[0]}}` : '$1'}</${n}>`, insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet, range }));
  }
  if (c.kind === 'element' && c.parent === 'ItemGroup') {
    return Object.entries(PJ_ITEMS).map(([n, [doc, snip]]) => ({ label: n, kind: K.Class, documentation: doc, insertText: snip, insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet, range }));
  }
  if (c.kind === 'element' && /^(Project|)$/.test(c.parent)) {
    return ['PropertyGroup', 'ItemGroup', 'Import', 'Target'].map((n) => ({ label: n, kind: K.Module, insertText: n === 'Import' ? 'Import Project="$1" />' : n === 'Target' ? 'Target Name="$1" AfterTargets="Build">\n\t$0\n</Target>' : `${n}>\n\t$0\n</${n}>`, insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet, range }));
  }
  if (c.kind === 'value' && PJ_PROPS[c.prop]) return PJ_PROPS[c.prop][1].map((v) => ({ label: v, kind: K.Value, insertText: v, range: new monacoRef.Range(pos.lineNumber, pos.column - c.typed.length, pos.lineNumber, pos.column) }));
  const vRange = () => new monacoRef.Range(pos.lineNumber, pos.column - c.typed.length, pos.lineNumber, pos.column);
  if (c.kind === 'attr' && /^Package(Reference|Version)$/.test(c.tag) && c.attr === 'Include' && c.typed.length >= 2) {
    const r = await api.nuget.search(c.typed, false, 0);
    return (r.items || []).slice(0, 20).map((p, i) => ({ label: p.id, kind: K.Module, detail: p.version, documentation: p.description, insertText: p.id, sortText: String(i).padStart(3, '0'), range: vRange() }));
  }
  if (c.kind === 'attr' && /^Package(Reference|Version)$/.test(c.tag) && c.attr === 'Version' && c.include) {
    const r = await api.nuget.versions(c.include);
    return (r.versions || []).slice().reverse().slice(0, 30).map((v, i) => ({ label: v, kind: K.Value, insertText: v, sortText: String(i).padStart(3, '0'), range: vRange() }));
  }
  if (c.kind === 'attr' && c.tag === 'ProjectReference' && c.attr === 'Include') {
    const here = dirName(model.uri.fsPath || model.uri.path);
    const files = (await api.ws.listFiles(state.root || here).catch(() => [])).filter((f) => /\.(cs|fs|vb)proj$/i.test(f) && !samePath(f, model.uri.fsPath || ''));
    return files.map((f) => { const rel = pjRelative(here, f); return { label: rel, kind: K.File, insertText: rel, range: vRange() }; });
  }
  return [];
}
function pjRelative(from, to) {
  const a = from.split(/[\\/]/), b = to.split(/[\\/]/);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('\\');
}

// hover: <TargetFramework> or $(OutputPath) -> the value MSBuild evaluates (for .csproj files)
async function pjHover(model, pos) {
  const line = model.getLineContent(pos.lineNumber);
  let name = null;
  for (const m of line.matchAll(/\$\((\w+)\)|<\/?(\w+)\b/g)) if (pos.column - 1 >= m.index && pos.column - 1 <= m.index + m[0].length) name = m[1] || m[2];
  if (!name || /^(Project|PropertyGroup|ItemGroup|Target|Import)$/.test(name) || PJ_ITEMS[name]) return null;
  const doc = PJ_PROPS[name] ? PJ_PROPS[name][0] : '';
  const file = model.uri.fsPath || model.uri.path;
  const tab = state.tabs.find((t) => t.model === model);
  if (!/\.(cs|fs|vb)proj$/i.test(file) || !tab) return doc ? { contents: [{ value: `**${name}**: ${doc}` }] } : null;
  if (tab && isDirty(tab)) return { contents: [{ value: `**${name}**${doc ? `: ${doc}` : ''}\n\nSave the file to see the evaluated value.` }] };
  const cfg = ($('#config') && $('#config').value) || 'Debug';
  const r = await api.msbuild(tab.path, [name], cfg);
  const v = r.properties ? r.properties[name] : null;
  return { contents: [{ value: `**${name}**${doc ? `: ${doc}` : ''}` }, { value: r.error ? `MSBuild: ${r.error}` : `Evaluated (${cfg}): \`${v === '' ? '(empty)' : v}\`` }] };
}

bus.on('ready', () => {
  const L = monacoRef.languages;
  L.registerCompletionItemProvider('xml', {
    triggerCharacters: ['<', '"', '.'],
    async provideCompletionItems(model, pos) { if (!pjIsProject(model)) return { suggestions: [] }; return { suggestions: await pjComplete(model, pos) }; }
  });
  L.registerHoverProvider('xml', { async provideHover(model, pos) { if (!pjIsProject(model)) return null; return pjHover(model, pos); } });
});
