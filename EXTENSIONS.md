# Writing Nova IDE extensions

An extension is a folder with two files:

```
my-extension/
  package.json
  extension.js
```

`package.json`:

```json
{
  "name": "my-extension",
  "displayName": "My Extension",
  "version": "1.0.0",
  "description": "What it does",
  "author": "You",
  "main": "extension.js"
}
```

`extension.js` runs inside the Nova IDE window and calls `nova.register`:

```js
nova.register({
  activate(ctx) {
    ctx.commands.register('myExt.hello', 'My Extension: Say Hello', () => {
      ctx.ui.showMessage(`Hello from ${ctx.editor.activeFile() || 'Nova IDE'}`);
    }, { key: 'Ctrl+Alt+H' });
  }
});
```

Install it with **Tools > Extensions > Install from Folder...** (it is copied into
`%APPDATA%\Nova IDE\extensions`), then click **Reload Window**. Commands appear in the
Command Palette (Ctrl+Shift+P). Errors are shown in the Extensions window and the Output panel.

Three samples ship with Nova IDE (Extensions > Samples): **Word Count**, **C# Snippets**, **Midnight Theme**.
Their source is in `samples/extensions`.

## The `ctx` API

| Area | Members |
|---|---|
| `ctx.commands` | `register(id, label, fn, { key })` adds a command (palette + optional shortcut such as `"Ctrl+Alt+H"`); `execute(id, ...args)` runs any Nova IDE command (e.g. `build`, `debugStart`, `saveAll`) |
| `ctx.statusBar` | `add({ text, tooltip, onClick })` returns an item with `text`, `tooltip`, `show()`, `hide()`, `dispose()` |
| `ctx.editor` | `activeFile()`, `language()`, `getText()`, `getSelectedText()`, `replaceSelection(text)`, `insertText(text)`, `onDidChangeText(fn)`, `onDidChangeSelection(fn)`, `onDidChangeActiveFile(fn)`, `onDidSave(fn)`, `monaco` (the Monaco API), `instance` (the editor) |
| `ctx.languages` | `registerSnippets(language, [{ prefix, body, description }])` — body is a string or array of lines, with `$1`, `${2:name}`, `$0` placeholders |
| `ctx.themes` | `define(name, { base, rules, colors })`, `apply(name)` (Monaco theme format) |
| `ctx.ui` | `showMessage(text)` (status bar), `log(text)` (Output panel), `showOutput()`, `ask(prompt, defaultValue)` → Promise of text or null |
| `ctx.terminal` | `run(command, { cwd })` opens a terminal and runs the command |
| `ctx.workspace` | `root()`, `openFile(path, line)`, `readFile(path)`, `writeFile(path, text)`, `onDidOpenFolder(fn)` |
| `ctx.settings` | `get(key)` reads a Nova IDE setting |

Extensions run with the same rights as Nova IDE itself, so only install extensions you trust.
