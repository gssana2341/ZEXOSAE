import type { IncomingMessage } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { memoryStore } from './api/_memory-store';

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** Runs the room API inside the dev server, with memory in place of Redis. */
function devRoomApi(): Plugin {
  const store = memoryStore();
  return {
    name: 'dev-room-api',
    configureServer(server) {
      server.middlewares.use('/api/rooms', async (req, res) => {
        const { handle } = await server.ssrLoadModule('/api/rooms.ts');
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const response: Response = await handle(
          new Request('http://localhost/api/rooms', { method: req.method, body }),
          store,
        );
        res.statusCode = response.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig({ plugins: [devRoomApi()] });
