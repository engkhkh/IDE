// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseSln, parseSlnx, parseProject, compareVersions, newest } = require('../main/solution');
const fx = (n) => path.join(__dirname, 'fixtures', n);

test('classic .sln: projects, solution folders and nesting', () => {
  const p = fx('Demo.sln');
  const s = parseSln(fs.readFileSync(p, 'utf8'), p);
  const projects = s.items.filter((i) => i.type === 'project');
  const folders = s.items.filter((i) => i.type === 'folder');
  assert.deepStrictEqual(projects.map((x) => x.name), ['App', 'Lib']);
  assert.strictEqual(folders.length, 1);
  assert.strictEqual(folders[0].name, 'src');
  assert.ok(projects.every((x) => x.parent === folders[0].id), 'both projects are inside "src"');
  assert.strictEqual(projects[0].path, path.join(path.dirname(p), 'src', 'App', 'App.csproj'));
  assert.strictEqual(projects[0].lang, 'csharp');
  assert.deepStrictEqual(s.configurations, ['Debug', 'Release']);
});

test('.slnx: nested folders, projects at the root, build types', () => {
  const p = fx('Demo.slnx');
  const s = parseSlnx(fs.readFileSync(p, 'utf8'), p);
  const byName = Object.fromEntries(s.items.map((i) => [i.name, i]));
  assert.strictEqual(byName.src.parent, null);
  assert.strictEqual(byName.tests.parent, byName.src.id);
  assert.strictEqual(byName.App.parent, byName.src.id);
  assert.strictEqual(byName['App.Tests'].parent, byName.tests.id);
  assert.strictEqual(byName.Tool.parent, null);
  assert.strictEqual(byName.Tool.lang, 'fsharp');
  assert.deepStrictEqual(s.configurations, ['Debug', 'Release', 'Staging']);
});

test('project file: framework, kind, packages (attribute + element), references', () => {
  const text = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks><RootNamespace>My.Api</RootNamespace></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="4.0.1" />
    <PackageReference Include="Dapper"><Version>2.1.35</Version></PackageReference>
    <ProjectReference Include="..\\Lib\\Lib.csproj" />
  </ItemGroup>
</Project>`;
  const p = path.join('/repo', 'Api', 'Api.csproj');
  const info = parseProject(text, p);
  assert.deepStrictEqual(info.frameworks, ['net8.0', 'net9.0']);
  assert.strictEqual(info.kind, 'web');
  assert.strictEqual(info.runnable, true);
  assert.strictEqual(info.rootNamespace, 'My.Api');
  assert.deepStrictEqual(info.packages, [{ id: 'Serilog', version: '4.0.1' }, { id: 'Dapper', version: '2.1.35' }]);
  assert.deepStrictEqual(info.references, [path.join('/repo', 'Lib', 'Lib.csproj')]);
  const lib = parseProject('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>', '/r/Lib.csproj');
  assert.strictEqual(lib.kind, 'library');
  assert.strictEqual(lib.runnable, false);
  const t = parseProject('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>', '/r/T.csproj');
  assert.strictEqual(t.kind, 'test');
  assert.strictEqual(t.runnable, false);
});

test('NuGet version ordering', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0-beta', '2.0.0') < 0);
  assert.strictEqual(newest(['1.0.0', '1.2.0', '2.0.0-rc1']), '1.2.0');
  assert.strictEqual(newest(['1.0.0', '1.2.0', '2.0.0-rc1'], true), '2.0.0-rc1');
});
