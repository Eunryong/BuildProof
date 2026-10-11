import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicIpv4, validateResumeUrl } from '../resume-fetch.js';

test('resume link accepts a public HTTPS direct-file URL', () => {
  const url = validateResumeUrl('https://portfolio.example.org/files/resume.pdf');
  assert.equal(url.hostname, 'portfolio.example.org');
});

test('resume link rejects local, private, credentialed, and non-HTTPS URLs', () => {
  for (const value of [
    'http://example.com/resume.pdf',
    'https://localhost/resume.pdf',
    'https://resume.local/resume.pdf',
    'https://192.168.1.2/resume.pdf',
    'https://user:pass@example.com/resume.pdf',
    'https://example.com:8443/resume.pdf',
  ]) {
    assert.throws(() => validateResumeUrl(value), undefined, value);
  }
});

test('resume link DNS addresses must be public IPv4 addresses', () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.1.2', '172.20.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '203.0.113.4', '224.0.0.1']) {
    assert.equal(isPublicIpv4(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '142.250.72.14']) {
    assert.equal(isPublicIpv4(address), true, address);
  }
});
