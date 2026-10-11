import { detectSolanaWallet, walletUnavailableMessage } from '../wallet.js';

export function createWalletController({ state, render, setNotice, setPersistentNotice, shortKey }) {
  async function connectWallet() {
    const wallet = detectSolanaWallet(window);
    if (!wallet) {
      const isEmbedded = window.top !== window.self;
      setPersistentNotice(
        walletUnavailableMessage(isEmbedded),
        'error',
        { label: 'Get Phantom', url: 'https://phantom.com/download' },
      );
      return;
    }
    try {
      const response = await wallet.provider.connect();
      state.walletProvider = wallet.provider;
      state.wallet = response.publicKey?.toString() || wallet.provider.publicKey?.toString() || null;
      render();
      setNotice(state.wallet ? `Connected ${wallet.name} ${shortKey(state.wallet)}. The issuer account needs Devnet SOL to issue a proof.` : 'Wallet connection returned no address.', state.wallet ? 'success' : 'error');
    } catch (error) {
      setNotice(error.message || 'Wallet connection was cancelled.', 'error');
    }
  }

  return { connectWallet };
}
