// Sample Nova IDE extension: live word/line count in the status bar + a command with a shortcut
nova.register({
  activate(ctx) {
    const item = ctx.statusBar.add({ text: '', tooltip: 'Word count (click for details)', onClick: () => ctx.commands.execute('wordCount.show') });

    function count() {
      const sel = ctx.editor.getSelectedText();
      const text = sel || ctx.editor.getText();
      const words = (text.match(/[\p{L}\p{N}_']+/gu) || []).length;
      const lines = text ? text.split(/\r?\n/).length : 0;
      return { words, lines, chars: text.length, selection: !!sel };
    }
    function update() {
      if (!ctx.editor.activeFile()) { item.hide(); return; }
      const c = count();
      item.text = `${c.selection ? 'Selection: ' : ''}${c.words} words`;
      item.show();
    }

    ctx.commands.register('wordCount.show', 'Word Count: Show Details', () => {
      const c = count();
      ctx.ui.showMessage(`${c.selection ? 'Selection' : 'File'}: ${c.words} words, ${c.lines} lines, ${c.chars} characters`);
    }, { key: 'Ctrl+Alt+K' });

    ctx.editor.onDidChangeText(update);
    ctx.editor.onDidChangeSelection(update);
    ctx.editor.onDidChangeActiveFile(update);
    update();
  }
});
