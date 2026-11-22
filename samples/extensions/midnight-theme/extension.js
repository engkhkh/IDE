// Sample Nova IDE extension: an editor color theme
nova.register({
  activate(ctx) {
    ctx.themes.define('nova-midnight', {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '6A7FA8', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'C792EA' },
        { token: 'string', foreground: 'C3E88D' },
        { token: 'number', foreground: 'F78C6C' },
        { token: 'type', foreground: 'FFCB6B' },
        { token: 'identifier', foreground: 'D6DEEB' }
      ],
      colors: {
        'editor.background': '#0B1426',
        'editor.foreground': '#D6DEEB',
        'editor.lineHighlightBackground': '#14213D',
        'editorLineNumber.foreground': '#3B4A6B',
        'editor.selectionBackground': '#1D3B66',
        'editorCursor.foreground': '#80CBC4'
      }
    });
    ctx.commands.register('midnight.apply', 'Theme: Midnight', () => ctx.themes.apply('nova-midnight'));
    ctx.commands.register('midnight.reset', 'Theme: Default', () => ctx.themes.apply(ctx.settings.get('theme') === 'light' ? 'vs' : 'vs-dark'));
  }
});
