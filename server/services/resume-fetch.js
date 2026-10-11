import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

const MAX_RESUME_BYTES = 700 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 12_000;

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function validateResumeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid public HTTPS link to a resume file.');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Resume links must use HTTPS on the standard web port.');
  }
  const localSuffixes = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example', '.onion'];
  if (!hostname || isIP(hostname) || hostname.includes(':') || hostname === 'localhost' || localSuffixes.some((suffix) => hostname.endsWith(suffix)) || hostname === 'home.arpa') {
    throw new Error('Resume links must point to a public website, not a local or private address.');
  }
  if (url.href.length > 2048) throw new Error('The resume link is too long.');
  return url;
}

async function resolvePublicIpv4(hostname) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('The resume link host could not be reached. Check that the link is public.');
  }
  const ipv4 = addresses.filter((entry) => entry.family === 4);
  if (!ipv4.length || ipv4.some((entry) => !isPublicIpv4(entry.address))) {
    throw new Error('The resume link must resolve only to public web addresses.');
  }
  return ipv4[0].address;
}

function requestPinned(url, address) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: {
        Accept: 'application/pdf, text/plain, text/markdown, application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'BuildProof-Resume-Importer/1.0',
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        finish(null, { status, location });
        return;
      }
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > MAX_RESUME_BYTES) {
        response.destroy();
        finish(new Error('Resume files must be smaller than 700 KB.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESUME_BYTES) {
          response.destroy(new Error('Resume files must be smaller than 700 KB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, {
        status,
        contentType: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        body: Buffer.concat(chunks),
      }));
      response.on('error', (error) => finish(error));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('The resume link took too long to respond.')));
    request.on('error', (error) => finish(error));
    request.end();
  });
}

export async function fetchResumeUrl(value) {
  let url = validateResumeUrl(value);
  let response;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateResumeUrl(url.href);
    const address = await resolvePublicIpv4(url.hostname);
    response = await requestPinned(url, address);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (!response.location || redirects === MAX_REDIRECTS) throw new Error('The resume link redirected too many times.');
    try {
      url = new URL(response.location, url);
    } catch {
      throw new Error('The resume link returned an invalid redirect.');
    }
  }
  if (response.status < 200 || response.status >= 300) throw new Error('The resume file could not be downloaded. Check the link permissions.');

  const isPdf = response.body.subarray(0, 5).toString('ascii') === '%PDF-';
  if (isPdf && (response.contentType === 'application/pdf' || response.contentType === 'application/octet-stream')) {
    return { resumeFile: { mimeType: 'application/pdf', data: response.body.toString('base64') } };
  }
  const urlPath = url.pathname.toLowerCase();
  const isTextType = ['text/plain', 'text/markdown', 'application/octet-stream'].includes(response.contentType);
  const isTextPath = /\.(txt|md)$/.test(urlPath);
  if (!isPdf && isTextType && (response.contentType !== 'application/octet-stream' || isTextPath)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(response.body).replace(/^\uFEFF/, '').trim();
    } catch {
      throw new Error('The linked resume text must use UTF-8 encoding.');
    }
    if (text.length < 100) throw new Error('Add at least 100 characters of resume text to the linked file.');
    return { resumeText: text.slice(0, 24_000) };
  }
  throw new Error('Use a direct PDF, TXT, or Markdown file link. Private preview pages are not supported.');
}
