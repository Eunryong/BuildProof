import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

export function createProofController({ state, app, api, loadRecords, render, setNotice, recordById, connectWallet, shortKey, connection, memoProgram, detectWallet }) {
  function claimFor(record, issuerWallet, issuedAt) {
    return {
      version: 1,
      id: record.id,
      projectName: record.projectName,
      skill: record.skill,
      learnerWallet: record.learnerWallet,
      evidenceUrl: record.evidenceUrl,
      evidenceRef: record.evidenceRef,
      rubricVersion: 'v1',
      rubric: record.rubric,
      reviewerNote: record.reviewerNote,
      issuedAt,
      issuerWallet,
    };
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  async function sha256Stable(value) {
    const bytes = new TextEncoder().encode(stableStringify(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function finishInterviewProofSubmission() {
    const interview = state.interview;
    const pending = interview.pendingProofSubmission;
    if (!pending) return;
    if (pending.latestBlockhash) {
      const signatureStatus = async () => {
        const response = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
        const status = response.value[0];
        if (status?.err) throw new Error('Devnet rejected the proof transaction. The existing draft is still available to retry.');
        return status && ['confirmed', 'finalized'].includes(status.confirmationStatus);
      };
      if (!(await signatureStatus())) {
        try {
          const confirmation = await connection.confirmTransaction({ signature: pending.signature, ...pending.latestBlockhash }, 'confirmed');
          if (confirmation.value.err) throw new Error('Devnet rejected the proof transaction. The existing draft is still available to retry.');
        } catch (error) {
          // A transaction may have landed just as the blockhash expired. Check its signature before reporting failure.
          if (!(await signatureStatus())) throw error;
        }
      }
    }
    const issued = await api(`/api/interview-proofs/${encodeURIComponent(pending.proofId)}/issue`, {
      method: 'POST', body: JSON.stringify({ signature: pending.signature }),
    });
    interview.publishedProof = issued;
    interview.pendingProofDraft = null;
    interview.pendingProofSubmission = null;
  }

  async function issueInterviewProof() {
    const interview = state.interview;
    if (!interview.reportId || !interview.publishConsent) return;
    if (!state.wallet || !state.walletProvider) {
      await connectWallet();
      if (!state.wallet || !state.walletProvider) return;
    }

    interview.busy = true;
    render();
    try {
      if (interview.pendingProofSubmission) {
        await finishInterviewProofSubmission();
      } else {
        if (!interview.pendingProofDraft) {
          const draft = await api('/api/interview-proofs/drafts', {
            method: 'POST',
            body: JSON.stringify({ reportId: interview.reportId, subjectWallet: state.wallet, consentToPublish: true }),
          });
          if (draft.status === 'issued') interview.publishedProof = draft.proof;
          else interview.pendingProofDraft = draft;
        }
        if (!interview.publishedProof) {
          const draft = interview.pendingProofDraft;
          if (draft.manifest.subjectWallet !== state.wallet) throw new Error('The connected wallet changed. Reconnect the wallet that started this proof draft.');
          const latestBlockhash = await connection.getLatestBlockhash('confirmed');
          const transaction = new Transaction({
            feePayer: new PublicKey(state.wallet),
            recentBlockhash: latestBlockhash.blockhash,
          }).add(new TransactionInstruction({
            programId: memoProgram,
            keys: [],
            data: new TextEncoder().encode(draft.memo),
          }));
          const signed = await state.walletProvider.signTransaction(transaction);
          const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
          interview.pendingProofSubmission = { proofId: draft.proofId, signature, latestBlockhash };
          await finishInterviewProofSubmission();
        }
      }
      interview.busy = false;
      render();
      setNotice('The interview report is anchored and saved for public verification.', 'success');
    } catch (error) {
      interview.busy = false;
      render();
      setNotice(error.message || 'The interview report could not be anchored. You can retry this step.', 'error');
    }
  }

  async function issueProof() {
    const record = recordById();
    if (!record) return;
    const wallet = detectWallet(window);
    if (!state.wallet || !wallet) { await connectWallet(); if (!state.wallet) return; }
    state.walletProvider = wallet?.provider || state.walletProvider;
    const provider = state.walletProvider;
    if (provider?.isConnected === false) { await connectWallet(); if (!state.wallet) return; }
    state.busy = true;
    render();
    try {
      const issuerWallet = state.wallet;
      const issuedAt = new Date().toISOString();
      const claimHash = await sha256(claimFor(record, issuerWallet, issuedAt));
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        feePayer: new PublicKey(issuerWallet),
        recentBlockhash: latestBlockhash.blockhash,
      }).add(new TransactionInstruction({
        programId: memoProgram,
        keys: [],
        data: new TextEncoder().encode(`BuildProof:v1:${claimHash}`),
      }));
      const signed = await provider.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
      await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed');
      const issued = await api(`/api/submissions/${record.id}/issue`, {
        method: 'POST',
        body: JSON.stringify({ signature, issuerWallet, issuedAt, claimHash }),
      });
      await loadRecords(false);
      state.selectedId = issued.id;
      state.busy = false;
      render();
      setNotice('Proof issued and confirmed on Solana Devnet.', 'success');
    } catch (error) {
      state.busy = false;
      render();
      setNotice(error.message || 'The Devnet proof could not be issued. Check the wallet network and try again.', 'error');
    }
  }

  async function verifyProof(id) {
    state.busy = true;
    state.verification = null;
    render();
    try {
      const record = await api(`/api/proofs/${id}`);
      const expectedHash = await sha256(claimFor(record, record.issuerWallet, record.issuedAt));
      if (expectedHash !== record.claimHash) throw new Error('The saved claim does not match its SHA-256 commitment.');
      const transaction = await connection.getParsedTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err) throw new Error('Devnet returned no successful transaction for this receipt.');
      const signerPresent = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === record.issuerWallet && key.signer);
      const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId.toBase58() === memoProgram.toBase58() && 'parsed' in instruction);
      if (!signerPresent || memo?.parsed !== `BuildProof:v1:${expectedHash}`) throw new Error('The receipt signer or claim hash does not match the transaction.');
      state.verification = { id, ok: true, message: `Claim hash, issuer signature, and Devnet transaction all match. Transaction ${shortKey(record.signature)}.` };
    } catch (error) {
      state.verification = { id, ok: false, message: error.message || 'Could not verify this receipt.' };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function verifyInterviewProof(id) {
    state.busy = true;
    state.verification = null;
    render();
    try {
      const record = state.interviewProofRecord;
      if (!record || record.id !== id || record.status !== 'issued') throw new Error('The public interview proof is not available.');
      const expectedHash = await sha256Stable(record.manifest);
      if (expectedHash !== record.manifestHash) throw new Error('The saved report does not match its SHA-256 commitment.');
      const transaction = await connection.getParsedTransaction(record.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!transaction || transaction.meta?.err) throw new Error('Devnet returned no successful transaction for this report.');
      const signerPresent = transaction.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === record.subjectWallet && key.signer);
      const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId.toBase58() === memoProgram.toBase58() && 'parsed' in instruction);
      if (!signerPresent || memo?.parsed !== `BuildProof:interview:v1:${expectedHash}`) throw new Error('The candidate wallet or report hash does not match the Devnet transaction.');
      state.verification = { id: `interview-${id}`, ok: true, message: `Report hash, candidate wallet, and Devnet transaction match. Transaction ${shortKey(record.signature)}.` };
    } catch (error) {
      state.verification = { id: `interview-${id}`, ok: false, message: error.message || 'Could not verify this interview proof.' };
    } finally {
      state.busy = false;
      render();
    }
  }

  return { issueProof, issueInterviewProof, verifyProof, verifyInterviewProof };
}
