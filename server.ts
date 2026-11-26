import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePublicDemoFromServer } from './src/services/judging/serverDemoProbe.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

async function startServer(): Promise<void> {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.post('/api/demo-probe', async (req, res) => {
    const body = req.body as { url?: unknown } | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!rawUrl || rawUrl.length > 2048) {
      res.status(400).json({
        ok: false,
        status: 'BLOCKED',
        blockedReason: 'A valid HTTP(S) demo URL string (<= 2048 chars) is required.',
        manualVerificationRequired: true,
        probeMethod: 'server_http_probe'
      });
      return;
    }

    const result = await probePublicDemoFromServer(rawUrl);
    res.status(result.ssrfBlocked ? 403 : 200).json(result);
  });

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HackMind Server] Listening on http://0.0.0.0:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  });
}

void startServer();
