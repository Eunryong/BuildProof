import { createHash } from 'node:crypto';

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function isPublicKey(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let number = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  const leadingZeroBytes = value.match(/^1*/)[0].length;
  const significantBytes = number === 0n ? 0 : Math.ceil(number.toString(2).length / 8);
  return leadingZeroBytes + significantBytes === 32;
}

export function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function submissionFields(body) {
  return {
    projectName: cleanText(body?.projectName, 80),
    skill: cleanText(body?.skill, 48),
    learnerWallet: cleanText(body?.learnerWallet, 64),
    evidenceUrl: cleanText(body?.evidenceUrl, 500),
    evidenceRef: cleanText(body?.evidenceRef, 80),
  };
}

export function validateSubmissionFields(fields, response) {
  if (!fields.projectName || !fields.skill || !fields.learnerWallet || !fields.evidenceUrl) {
    response.status(400).json({ error: 'Add a project name, skill, wallet, and evidence URL.' });
    return false;
  }
  if (!isPublicKey(fields.learnerWallet)) {
    response.status(400).json({ error: 'Enter a valid Solana wallet address.' });
    return false;
  }
  if (!validHttpUrl(fields.evidenceUrl)) {
    response.status(400).json({ error: 'Evidence must be a valid http or https link.' });
    return false;
  }
  return true;
}

export function claimFor(record, issuerWallet, issuedAt) {
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

export function hashClaim(claim) {
  return createHash('sha256').update(JSON.stringify(claim)).digest('hex');
}

export function publicRecord(record) {
  const { ownerId: _ownerId, ...visible } = record;
  return visible;
}

export function publicInterviewProof(record) {
  return {
    id: record.id,
    status: record.status,
    subjectWallet: record.subjectWallet,
    issuedAt: record.issuedAt,
    manifest: record.manifest,
    manifestHash: record.manifestHash,
    signature: record.signature,
    chainSlot: record.chainSlot,
    chainTime: record.chainTime,
  };
}
