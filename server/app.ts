// One port serves both the built game and the WebSocket, so friends only need one link.

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { parseClientMessage, SNAPSHOT_HZ, type ServerMessage } from '../src/net/protocol';
import { Lobby, type Room } from './rooms';

const DIST = join(process.cwd(), 'dist');
const PING_MS = 15000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function createHttpServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(DIST, relative));

    // Refuses paths such as /../server/app.ts.
    if (file !== DIST && !file.startsWith(DIST + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found. Run "npm run build" first.');
    }
  });
}

interface Connection {
  room: Room | null;
  id: number;
  alive: boolean;
}

export interface GameServer {
  port: number;
  lobby: Lobby;
  close(): Promise<void>;
}

export function startServer(port: number): Promise<GameServer> {
  const http = createHttpServer();
  const sockets = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
  const lobby = new Lobby();
  const connections = new Map<WebSocket, Connection>();

  sockets.on('connection', (socket) => {
    const connection: Connection = { room: null, id: 0, alive: true };
    connections.set(socket, connection);

    const client = {
      send(message: ServerMessage) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
    };

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (data) => {
      const message = parseClientMessage(data.toString());
      if (!message) return;

      if (message.t === 'list') {
        client.send({ t: 'rooms', rooms: lobby.list() });
        return;
      }

      if (message.t === 'create' || message.t === 'join') {
        if (connection.room) return;
        const result =
          message.t === 'create'
            ? lobby.create(client, message.name, message.maxPlayers)
            : lobby.join(client, message.code, message.name);
        if (typeof result === 'string') {
          client.send({ t: 'error', reason: result });
        } else {
          connection.room = result.room;
          connection.id = result.id;
        }
        return;
      }

      connection.room?.handle(connection.id, message);
    });

    socket.on('close', () => {
      if (connection.room) lobby.leave(connection.room, connection.id);
      connections.delete(socket);
    });
    socket.on('error', () => socket.terminate());
  });

  const tick = setInterval(() => lobby.tick(), 1000 / SNAPSHOT_HZ);

  // Drops players whose connection died without saying goodbye.
  const ping = setInterval(() => {
    for (const [socket, connection] of connections) {
      if (!connection.alive) {
        socket.terminate();
        continue;
      }
      connection.alive = false;
      socket.ping();
    }
  }, PING_MS);

  return new Promise((resolve) => {
    http.listen(port, () => {
      const address = http.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        lobby,
        close: () =>
          new Promise((done) => {
            clearInterval(tick);
            clearInterval(ping);
            for (const socket of connections.keys()) socket.terminate();
            sockets.close();
            http.close(() => done());
          }),
      });
    });
  });
}
