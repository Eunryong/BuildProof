export function registerSystemRoutes(app, { guestRateLimit, rpcUrl, browserRpcMethods, interviewService }) {
app.get('/api/health', (_request, response) => {
  response.json({ ok: true, network: 'devnet' });
});

app.post('/api/solana/rpc', guestRateLimit({ key: 'rpc', max: 120, windowMs: 60_000 }), async (request, response) => {
  const payload = request.body;
  if (!payload || payload.jsonrpc !== '2.0' || !browserRpcMethods.has(payload.method)) {
    return response.status(400).json({ error: 'This Solana RPC method is not available through BuildProof.' });
  }
  try {
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await upstream.json();
    if (!upstream.ok) return response.status(502).json({ error: 'The Devnet RPC request failed.' });
    return response.json(result);
  } catch {
    return response.status(502).json({ error: 'The Devnet RPC service could not be reached.' });
  }
});
}
