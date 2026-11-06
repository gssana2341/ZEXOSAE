import { networkInterfaces } from 'node:os';
import { build } from 'vite';
import { startServer } from './app';

const port = Number(process.env.PORT) || 3000;

if (process.argv.includes('--build')) await build({ logLevel: 'warn' });

const server = await startServer(port);

console.log(`\nZEXOSAE online server\n`);
console.log(`  This computer:  http://localhost:${server.port}`);
for (const addresses of Object.values(networkInterfaces())) {
  for (const a of addresses ?? []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
      console.log(`  Network:        http://${a.address}:${server.port}`);
    }
  }
}
console.log('');
