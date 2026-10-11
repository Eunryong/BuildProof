import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export function createPublicDemoMiddleware({ enabled, secret }) {
  const requestCounts = new Map();

  function signGuestId(id) {
    return createHmac('sha256', secret).update(id).digest('base64url');
  }

  function readGuestId(value) {
    const [id, signature, extra] = String(value || '').split('.');
    if (extra !== undefined || !/^[\da-f-]{36}$/i.test(id || '') || !signature) return null;
    const expected = Buffer.from(signGuestId(id));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? id : null;
  }

  function identifyGuest(request, response, next) {
    request.contextpulseOwnerId = null;
    if (!enabled) return next();
    const cookies = Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
      const separator = part.indexOf('=');
      return separator > -1 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] : ['', ''];
    }).filter(([name]) => name));
    const existing = readGuestId(cookies.buildproof_guest);
    const ownerId = existing || randomUUID();
    request.contextpulseOwnerId = ownerId;
    if (!existing) {
      response.append('Set-Cookie', `buildproof_guest=${ownerId}.${signGuestId(ownerId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    }
    if (request.path.startsWith('/api/') || !path.extname(request.path)) response.setHeader('Cache-Control', 'no-store');
    next();
  }

  function guestRateLimit({ key, max, windowMs }) {
    return (request, response, next) => {
      if (!enabled) return next();
      const id = request.get('cf-connecting-ip') || request.ip || request.contextpulseOwnerId;
      const bucketKey = `${id}:${key}`;
      const now = Date.now();
      const bucket = requestCounts.get(bucketKey);
      if (!bucket || now - bucket.startedAt >= windowMs) {
        if (requestCounts.size > 2000) {
          for (const [storedKey, storedBucket] of requestCounts) {
            if (now - storedBucket.startedAt >= windowMs) requestCounts.delete(storedKey);
            if (requestCounts.size <= 2000) break;
          }
        }
        requestCounts.set(bucketKey, { startedAt: now, count: 1 });
        return next();
      }
      if (bucket.count >= max) {
        response.setHeader('Retry-After', String(Math.ceil((bucket.startedAt + windowMs - now) / 1000)));
        return response.status(429).json({ error: 'This demo has reached its short-term request limit. Please try again later.' });
      }
      bucket.count += 1;
      return next();
    };
  }

  return { identifyGuest, guestRateLimit };
}
