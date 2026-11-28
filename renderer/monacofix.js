// Nova IDE - works around a Monaco 0.52 bug: every new editor makes itself the global "hover delegate factory";
// when that editor (a diff view, the merge editor...) is disposed, later hovers and suggestion details in the main
// editor fail with "InstantiationService has been disposed". After any editor is disposed, a small hidden editor
// is created to take that role again (the previous one is then let go).
'use strict';

const MF = { keeper: null, host: null };
function mfRefresh() {
  const old = MF.keeper, oldHost = MF.host;
  // a fresh element each time: Monaco marks the element an editor lives in
  MF.host = document.createElement('div');
  MF.host.style.cssText = 'position:absolute;width:1px;height:1px;left:-10px;top:-10px;overflow:hidden';
  document.body.appendChild(MF.host);
  MF.keeper = MF.create(MF.host, { model: null, automaticLayout: false, minimap: { enabled: false } });
  if (old) old.dispose();
  if (oldHost) oldHost.remove();
}
bus.on('ready', () => {
  const E = monacoRef.editor;
  MF.create = E.create.bind(E);
  const wrap = (factory) => function (...args) {
    const ed = factory(...args);
    const dispose = ed.dispose.bind(ed);
    ed.__mfDispose = dispose;
    ed.dispose = () => { dispose(); try { mfRefresh(); } catch (e) { console.warn('monacofix', e); } };
    return ed;
  };
  E.create = wrap(E.create.bind(E));
  E.createDiffEditor = wrap(E.createDiffEditor.bind(E));
});
