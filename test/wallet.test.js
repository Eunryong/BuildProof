import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSolanaWallet, walletUnavailableMessage } from '../src/wallet.js';

test('prefers the current Phantom provider and accepts the legacy alias', () => {
  const phantomProvider = { connect() {}, signTransaction() {}, isPhantom: true };
  const legacyProvider = { connect() {}, signTransaction() {} };

  assert.deepEqual(detectSolanaWallet({
    phantom: { solana: phantomProvider },
    solana: legacyProvider,
  }), { name: 'Phantom', provider: phantomProvider });

  assert.deepEqual(detectSolanaWallet({ solana: phantomProvider }), {
    name: 'Phantom', provider: phantomProvider,
  });
  assert.deepEqual(detectSolanaWallet({ solana: legacyProvider }), {
    name: 'Solana wallet', provider: legacyProvider,
  });
});

test('does not advertise wallets that cannot sign the proof transaction', () => {
  assert.equal(detectSolanaWallet({ phantom: { solana: { connect() {} } } }), null);
  assert.equal(detectSolanaWallet({}), null);
});

test('explains how to get out of an embedded preview', () => {
  assert.match(walletUnavailableMessage(true), /embedded/);
  assert.match(walletUnavailableMessage(true), /127\.0\.0\.1:8891/);
  assert.match(walletUnavailableMessage(false), /Install Phantom/);
});
