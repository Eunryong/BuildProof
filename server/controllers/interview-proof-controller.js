export function registerInterviewProofRoutes(app, { cleanText, isPublicKey, getInterviewService, readInterviewProofs, writeInterviewProofs, createInterviewManifest, hashInterviewManifest, isInterviewProofManifest, interviewMemoForHash, publicInterviewProof, fetchDevnetTransaction, memoProgram }) {
app.post('/api/interview-proofs/drafts', async (request, response, next) => {
  try {
    if (request.body?.consentToPublish !== true) {
      return response.status(400).json({ error: 'Confirm that you want to publish this interview report before anchoring it.' });
    }
    const reportId = cleanText(request.body?.reportId, 80);
    const subjectWallet = cleanText(request.body?.subjectWallet, 64);
    if (!reportId || !isPublicKey(subjectWallet)) {
      return response.status(400).json({ error: 'The completed interview and a valid Solana wallet are required.' });
    }
    const completed = getInterviewService(request).getCompletedReport(reportId, request.contextpulseOwnerId);
    if (!completed) return response.status(404).json({ error: 'The completed interview expired. Start another interview to create a proof.' });

    const records = await readInterviewProofs();
    const existing = records.find((record) => record.reportId === reportId);
    if (existing) {
      if (existing.status === 'issued') {
        if (existing.subjectWallet !== subjectWallet) {
          return response.status(409).json({ error: 'This interview report is already anchored by a different wallet.' });
        }
        return response.json({ status: 'issued', proofId: existing.id, proof: publicInterviewProof(existing), reused: true });
      }
      if (existing.status !== 'pending' || !isInterviewProofManifest(existing.manifest) ||
          existing.manifest.subjectWallet !== existing.subjectWallet ||
          hashInterviewManifest(existing.manifest) !== existing.manifestHash) {
        return response.status(409).json({ error: 'The existing proof draft is invalid and cannot be resumed.' });
      }
      if (existing.subjectWallet !== subjectWallet) {
        return response.status(409).json({ error: 'A proof draft for this interview belongs to another wallet. Reconnect the wallet that started it to continue.' });
      }
      return response.json({
        status: 'pending',
        proofId: existing.id,
        manifest: existing.manifest,
        manifestHash: existing.manifestHash,
        memo: interviewMemoForHash(existing.manifestHash),
        reused: true,
      });
    }
    const issuedAt = new Date().toISOString();
    const manifest = createInterviewManifest({
      proofId: crypto.randomUUID(),
      subjectWallet,
      issuedAt,
      model: completed.model,
      questionCount: completed.questionCount,
      report: completed.report,
    });
    const manifestHash = hashInterviewManifest(manifest);
    const record = {
      id: manifest.proofId,
      reportId,
      ...(request.contextpulseOwnerId ? { ownerId: request.contextpulseOwnerId } : {}),
      status: 'pending',
      subjectWallet,
      issuedAt,
      manifest,
      manifestHash,
      signature: null,
      chainSlot: null,
      chainTime: null,
    };
    records.push(record);
    await writeInterviewProofs(records);
    return response.status(201).json({
      status: 'pending',
      proofId: record.id,
      manifest,
      manifestHash,
      memo: interviewMemoForHash(manifestHash),
      reused: false,
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/interview-proofs/:id/issue', async (request, response, next) => {
  try {
    const signature = cleanText(request.body?.signature, 100);
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      return response.status(400).json({ error: 'A valid Devnet transaction signature is required.' });
    }
    const records = await readInterviewProofs();
    const record = records.find((item) => item.id === request.params.id);
    if (!record) return response.status(404).json({ error: 'Interview proof draft not found.' });
    if (request.contextpulseOwnerId && record.ownerId !== request.contextpulseOwnerId) return response.status(404).json({ error: 'Interview proof draft not found.' });
    if (record.status === 'issued') {
      if (record.signature === signature) return response.json(publicInterviewProof(record));
      return response.status(409).json({ error: 'This interview report already has an on-chain proof.' });
    }
    if (record.status !== 'pending' || !isInterviewProofManifest(record.manifest) || hashInterviewManifest(record.manifest) !== record.manifestHash) {
      return response.status(409).json({ error: 'The interview proof draft is invalid or no longer available.' });
    }
    const transaction = await fetchDevnetTransaction(signature);
    if (!transaction || transaction.meta?.err) {
      return response.status(422).json({ error: 'Devnet has not confirmed this transaction yet.' });
    }
    const signedByCandidate = transaction.transaction.message.accountKeys.some((key) => key.pubkey === record.subjectWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId === memoProgram);
    if (!signedByCandidate || memo?.parsed !== interviewMemoForHash(record.manifestHash)) {
      return response.status(422).json({ error: 'The Devnet transaction does not contain this candidate-signed interview report hash.' });
    }
    record.status = 'issued';
    record.signature = signature;
    record.chainSlot = Number.isInteger(transaction.slot) ? transaction.slot : null;
    record.chainTime = Number.isInteger(transaction.blockTime) ? new Date(transaction.blockTime * 1000).toISOString() : null;
    await writeInterviewProofs(records);
    return response.status(201).json(publicInterviewProof(record));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/interview-proofs/:id', async (request, response, next) => {
  try {
    const records = await readInterviewProofs();
    const record = records.find((item) => item.id === request.params.id && item.status === 'issued');
    if (!record) return response.status(404).json({ error: 'Issued interview proof not found.' });
    if (!isInterviewProofManifest(record.manifest) || hashInterviewManifest(record.manifest) !== record.manifestHash) {
      return response.status(409).json({ error: 'The saved interview report failed its integrity check.' });
    }
    return response.json(publicInterviewProof(record));
  } catch (error) {
    return next(error);
  }
});
}
