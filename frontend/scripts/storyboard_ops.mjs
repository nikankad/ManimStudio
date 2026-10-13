// Exercise the same authoring interface used by the UI, without a browser or alternate model.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const sb = await server.ssrLoadModule('/src/storyboard.ts');
  const tl = await server.ssrLoadModule('/src/timeline.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { doc, measured, ops = [] } = JSON.parse(input);
  if (measured) measured.doc = structuredClone(doc);
  const d = structuredClone(doc), results = [];
  for (const op of ops) {
    if (op.op === 'adopt') d.storyboard = { beats: sb.beatsFor(d) };
    if (op.op === 'append') sb.appendToBeat(d, op.beat, op.steps);
    if (op.op === 'split') results.push(sb.splitBeat(d, op.beat, op.step));
    if (op.op === 'move') results.push(sb.moveBeat(d, op.beat, op.delta));
    if (op.op === 'remove') tl.removeIds(d, tl.layout(d, measured), new Set(op.ids), 'ripple');
    if (op.op === 'add-beat') {
      const beats = sb.beatsFor(d); beats.splice(op.index, 0, op.beat); d.storyboard = { beats };
    }
  }
  const beats = sb.beatsFor(d), lay = tl.layout(d, measured);
  process.stdout.write(JSON.stringify({ doc: d, beats, results, spans: beats.map((b) => sb.beatSpan(b, beats, lay)), boundaries: beats.map((b) => ({ start: sb.beatBoundary(d, b, 'start'), end: sb.beatBoundary(d, b, 'end') })) }));
} finally { await server.close(); }
