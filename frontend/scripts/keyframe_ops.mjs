// Applies keyframe edits (frontend/src/keyframes.ts) for tests/test_keyframes.py (run from here so vite resolves): reads
// {doc, measured, cases: [{op: list|set|delete|add|base|args|pin, name, channel, index?, t?, value}]} from stdin and prints, for each case, the edited
// document (or the error) and the object's keyframes before the edit. Each case starts from the same document.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const kf = await server.ssrLoadModule('/src/keyframes.ts');
  const tl = await server.ssrLoadModule('/src/timeline.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { doc, measured, cases } = JSON.parse(input);
  if (measured) measured.doc = doc;
  const out = cases.map((c) => {
    const d = structuredClone(doc);
    const lay = tl.layout(d, measured);
    const keys = kf.keyframes(d, lay, measured, c.name);
    const mine = keys.filter((k) => k.channel === c.channel);
    let error = null;
    let id = null;
    if (c.op === 'list') { /* Only read the current endpoints. */ }
    else if (c.op === 'set') error = kf.setKeyValue(d, lay, measured, mine[c.index], c.value);
    else if (c.op === 'delete') error = kf.deleteKey(d, lay, mine[c.index]);
    else if (c.op === 'add') {
      const r = kf.addKey(d, measured, c.name, c.channel, c.t, c.value);
      error = r.error ?? null;
      id = r.id ?? null;
    } else if (c.op === 'args') error = kf.setKeyArgs(d, mine[c.index], c.value);
    else if (c.op === 'pin') error = kf.fixKey(d, mine[c.index]);
    else if (c.op === 'base') kf.setBaseValue(d.objects.find((o) => o.name === c.name), c.channel, c.value);
    return { doc: d, error, id, keys: mine };
  });
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
