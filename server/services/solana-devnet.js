export const browserRpcMethods = new Set(['getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getTransaction']);
export const memoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export async function fetchDevnetTransaction(rpcUrl, signature) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'buildproof',
      method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Devnet RPC returned an error.');
  return payload.result;
}
