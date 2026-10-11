import { Connection, PublicKey } from '@solana/web3.js';

const rpcUrl = new URL('/api/solana/rpc', location.origin).toString();

export const solanaConnection = new Connection(rpcUrl, 'confirmed');
export const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
