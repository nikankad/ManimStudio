// Clip names in words (frontend/src/words.ts) for tests: reads {doc, overrides, constants} on stdin and prints, in
// timeline order, [kind, name, sub] for every statement and animation.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const w = await server.ssrLoadModule('/src/words.ts');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { doc, overrides, constants } = JSON.parse(input);
  w.setOverrides(overrides ?? {});
  w.setConstants(constants ?? []);
  const out = [];
  const anims = (list) => {
    for (const a of list ?? []) {
      const x = w.animWords(a);
      out.push(['anim', x.name, x.sub]);
      anims(a.anims);
    }
  };
  for (const s of doc.timeline) {
    const x = w.stepWords(s);
    out.push([s.kind, x.name, x.sub]);
    anims(s.anims);
  }
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
