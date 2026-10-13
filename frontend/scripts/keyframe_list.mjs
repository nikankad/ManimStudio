// Lists keyframes (frontend/src/keyframes.ts) for scripts/import_fidelity.py (run from here so vite resolves): reads
// [{doc, measured}] from stdin and prints, for each document, every object's keyframes: [{name: Key[]}].
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const kf = await server.ssrLoadModule('/src/keyframes.ts');
  const tl = await server.ssrLoadModule('/src/timeline.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const out = JSON.parse(input).map(({ doc, measured }) => {
    if (measured) measured.doc = doc;
    try {
      const lay = tl.layout(doc, measured);
      return Object.fromEntries(doc.objects.map((o) => [o.name, kf.keyframes(doc, lay, measured, o.name)]));
    } catch (e) {
      return { error: String(e) };
    }
  });
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
