// Store-level authoring/undo checks. Stub only the backend; edits use the production store.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const timers = [];
globalThis.document = { querySelector: () => null };
globalThis.window = { setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.push(timer); return timer; } };
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { api } = await server.ssrLoadModule('/src/api.ts');
  const calls = [];
  api.run = async (_doc, t, _render, _width, boundary) => { calls.push({ t, boundary }); return { image: null, error: null, steps: [], anims: [], duration: 0 }; };
  api.setPref = async () => ({});
  const store = await server.ssrLoadModule('/src/store.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { doc, beat, edits } = JSON.parse(input);
  store.setState({ doc, autoRender: false, activeBeat: beat, targetEdit: true });
  const originalKey = store.docKey(doc);
  for (const edit of edits) {
    if (edit.op === 'transform') store.commitTransform(edit.id, edit.delta, edit.center);
    if (edit.op === 'animate') store.animateParam(edit.name, edit.value, edit.duration);
    if (edit.op === 'rename') store.updateDoc((d) => { d.storyboard.beats[0].title = edit.title; });
    if (edit.op === 'undo') store.undo();
    if (edit.op === 'redo') store.redo();
  }
  const state = store.getState();
  process.stdout.write(JSON.stringify({ doc: state.doc, past: state.past.length, dirty: state.dirty, keyChanged: store.docKey(state.doc) !== originalKey, boundary: store.frameBoundary(), calls }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  await server.close();
}
