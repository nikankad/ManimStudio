// Applies timeline edits (frontend/src/timeline.ts) for tests/test_blocks.py (run from here so vite resolves): reads
// {doc, measured, cases: [{op: layout|remove|ripple|move, ids?, t?}]} from stdin and prints, for each case, the edited
// document and the layout (of the edited document). Each case starts from the same document.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const plain = (lay) => ({ ...lay, steps: Object.fromEntries(lay.steps), anims: Object.fromEntries(lay.anims) });
try {
  const tl = await server.ssrLoadModule('/src/timeline.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { doc, measured, cases } = JSON.parse(input);
  if (measured) measured.doc = structuredClone(doc);
  const out = cases.map((c) => {
    const d = structuredClone(doc);
    const lay = tl.layout(d, measured);
    if (c.op === 'remove' || c.op === 'ripple') tl.removeIds(d, lay, new Set(c.ids), c.op === 'remove' ? 'lift' : 'ripple');
    else if (c.op === 'move') tl.moveSteps(d, measured, c.ids, c.t, false);
    return { doc: d, layout: plain(tl.layout(d, measured)) };
  });
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
