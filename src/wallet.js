function isSigningProvider(provider) {
  return Boolean(
    provider
      && typeof provider.connect === 'function'
      && typeof provider.signTransaction === 'function',
  );
}

export function detectSolanaWallet(targetWindow = globalThis.window) {
  const phantom = targetWindow?.phantom?.solana;
  if (isSigningProvider(phantom)) return { name: 'Phantom', provider: phantom };

  const legacy = targetWindow?.solana;
  if (isSigningProvider(legacy)) {
    return { name: legacy.isPhantom ? 'Phantom' : 'Solana wallet', provider: legacy };
  }

  return null;
}

export function walletUnavailableMessage(isEmbedded) {
  if (isEmbedded) {
    return 'This preview is embedded and cannot access wallet extensions. Open http://127.0.0.1:8891 directly in Chrome or another browser with Phantom enabled, then connect your wallet.';
  }
  return 'No Solana wallet extension is available in this browser. Install Phantom, reload BuildProof, then connect your wallet.';
}
