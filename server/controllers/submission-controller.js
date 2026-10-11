export function registerSubmissionRoutes(app, { guestRateLimit, submissionFields, validateSubmissionFields, readStore, writeStore, publicRecord, cleanText, isPublicKey, claimFor, hashClaim, fetchDevnetTransaction, memoProgram }) {
app.get('/api/submissions', async (_request, response, next) => {
  try {
    const records = await readStore();
    response.json(records.filter((record) => !_request.contextpulseOwnerId || record.ownerId === _request.contextpulseOwnerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRecord));
  } catch (error) {
    next(error);
  }
});

app.post('/api/submissions', guestRateLimit({ key: 'submission-create', max: 10, windowMs: 60 * 60_000 }), async (request, response, next) => {
  try {
    const fields = submissionFields(request.body);
    if (!validateSubmissionFields(fields, response)) return;
    const records = await readStore();
    const record = {
      id: crypto.randomUUID(),
      ...fields,
      ...(request.contextpulseOwnerId ? { ownerId: request.contextpulseOwnerId } : {}),
      rubric: { worksAsShown: false, learnerContribution: false, skillFit: false },
      reviewerNote: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      issuedAt: null,
      issuerWallet: null,
      claimHash: null,
      signature: null,
    };
    records.push(record);
    await writeStore(records);
    return response.status(201).json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/submissions/:id', async (request, response, next) => {
  try {
    const fields = submissionFields(request.body);
    if (!validateSubmissionFields(fields, response)) return;
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status !== 'rejected') return response.status(409).json({ error: 'Only a submission with requested changes can be edited.' });
    Object.assign(record, fields, {
      status: 'pending',
      rubric: { worksAsShown: false, learnerContribution: false, skillFit: false },
      reviewerNote: '',
      reviewedAt: null,
    });
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/submissions/:id/review', async (request, response, next) => {
  try {
    const decision = request.body?.decision;
    const reviewerNote = cleanText(request.body?.reviewerNote, 500);
    const rubric = request.body?.rubric;
    if (!['approved', 'rejected', 'pending'].includes(decision)) {
      return response.status(400).json({ error: 'Choose approve or request changes.' });
    }
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status === 'issued') return response.status(409).json({ error: 'An issued proof cannot be reviewed again.' });
    if (decision === 'pending' && record.status !== 'rejected') {
      return response.status(409).json({ error: 'Only a submission with requested changes can return to review.' });
    }
    if (decision === 'approved' && (!rubric || !rubric.worksAsShown || !rubric.learnerContribution || !rubric.skillFit)) {
      return response.status(400).json({ error: 'All three review checks must pass before approval.' });
    }
    record.status = decision;
    record.rubric = {
      worksAsShown: Boolean(rubric?.worksAsShown),
      learnerContribution: Boolean(rubric?.learnerContribution),
      skillFit: Boolean(rubric?.skillFit),
    };
    record.reviewerNote = reviewerNote;
    record.reviewedAt = decision === 'pending' ? null : new Date().toISOString();
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/submissions/:id/issue', async (request, response, next) => {
  try {
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && (!request.contextpulseOwnerId || item.ownerId === request.contextpulseOwnerId));
    if (!record) return response.status(404).json({ error: 'Submission not found.' });
    if (record.status !== 'approved') return response.status(409).json({ error: 'Approve the submission before issuing proof.' });
    if (record.signature) return response.status(409).json({ error: 'This submission already has an on-chain proof.' });

    const signature = cleanText(request.body?.signature, 100);
    const issuerWallet = cleanText(request.body?.issuerWallet, 64);
    const issuedAt = cleanText(request.body?.issuedAt, 40);
    const claimHash = cleanText(request.body?.claimHash, 64).toLowerCase();
    if (!signature || !isPublicKey(issuerWallet) || !/^\d{4}-\d\d-\d\dT/.test(issuedAt) || !/^[a-f0-9]{64}$/.test(claimHash)) {
      return response.status(400).json({ error: 'The signed proof details are incomplete.' });
    }
    const issuedMilliseconds = Date.parse(issuedAt);
    if (!Number.isFinite(issuedMilliseconds) || Math.abs(Date.now() - issuedMilliseconds) > 5 * 60_000) {
      return response.status(400).json({ error: 'The proof timestamp is stale. Please issue it again.' });
    }
    const expectedHash = hashClaim(claimFor(record, issuerWallet, issuedAt));
    if (expectedHash !== claimHash) {
      return response.status(400).json({ error: 'The proof details changed after signing. Please issue it again.' });
    }

    const transaction = await fetchDevnetTransaction(signature);
    if (!transaction || transaction.meta?.err) {
      return response.status(422).json({ error: 'Devnet has not confirmed this transaction yet.' });
    }
    const signedByIssuer = transaction.transaction.message.accountKeys.some((key) => key.pubkey === issuerWallet && key.signer);
    const memo = transaction.transaction.message.instructions.find((instruction) => instruction.programId === memoProgram);
    if (!signedByIssuer || !memo || memo.parsed !== `BuildProof:v1:${claimHash}`) {
      return response.status(422).json({ error: 'The Devnet transaction does not contain this signed BuildProof claim.' });
    }

    record.status = 'issued';
    record.issuerWallet = issuerWallet;
    record.issuedAt = issuedAt;
    record.claimHash = claimHash;
    record.signature = signature;
    await writeStore(records);
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/proofs/:id', async (request, response, next) => {
  try {
    const records = await readStore();
    const record = records.find((item) => item.id === request.params.id && item.status === 'issued');
    if (!record) return response.status(404).json({ error: 'Issued proof not found.' });
    return response.json(publicRecord(record));
  } catch (error) {
    return next(error);
  }
});
}
