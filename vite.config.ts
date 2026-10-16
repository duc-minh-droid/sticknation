import { defineConfig, type Plugin } from 'vite';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Brains are saved as JSON files in ./brains (one per stickman) by the dev server,
// so learning persists on disk across reloads and sessions.
const BRAIN_DIR = resolve(__dirname, 'brains');
const MAX_BYTES = 5 * 1024 * 1024;

function brainStore(): Plugin {
  return {
    name: 'brain-store',
    configureServer(server) {
      server.middlewares.use('/api/brain/', async (req, res) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0]);
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { res.statusCode = 400; res.end('bad name'); return; }
        const file = resolve(BRAIN_DIR, `${name}.json`);
        try {
          if (req.method === 'GET') {
            const text = await readFile(file, 'utf8').catch(() => null);
            if (text === null) { res.statusCode = 404; res.end(); return; }
            res.setHeader('content-type', 'application/json');
            res.end(text);
            return;
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const c of req) {
              size += (c as Buffer).length;
              if (size > MAX_BYTES) { res.statusCode = 413; res.end(); return; }
              chunks.push(c as Buffer);
            }
            const text = Buffer.concat(chunks).toString('utf8');
            JSON.parse(text); // refuse garbage
            await mkdir(BRAIN_DIR, { recursive: true });
            // write-then-rename so a crash mid-write never corrupts the saved brain
            await writeFile(`${file}.tmp`, text);
            await rename(`${file}.tmp`, file);
            res.statusCode = 204;
            res.end();
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [brainStore()],
  // saving a brain must not trigger a page reload
  server: { watch: { ignored: ['**/brains/**'] } },
});
