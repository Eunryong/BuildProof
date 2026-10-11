import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createBuildProofApp } from './app.js';

let vite = null;
if (process.env.NODE_ENV !== 'production') {
  vite = await createViteServer({
    root: path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src'),
    server: { middlewareMode: true },
    appType: 'custom',
  });
}

const { app, ready, port, host } = await createBuildProofApp({ vite });
await ready;
app.listen(port, host, () => {
  console.log(`BuildProof is running at http://${host}:${port}`);
  console.log('Solana network: Devnet (RPC endpoint configured on the server)');
});
