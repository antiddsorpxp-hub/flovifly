const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const sharp = require('sharp');

try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const { Server } = require('socket.io');
const repository = require('./lib/repository');
const { supabase, storageBucket } = require('./lib/supabase');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const configuredSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET || '';
if (
  IS_PRODUCTION &&
  (!configuredSecret ||
    configuredSecret === 'development-only-change-me' ||
    Buffer.byteLength(configuredSecret, 'utf8') < 32)
) {
  throw new Error(
    'SESSION_SECRET or JWT_SECRET must be set to at least 32 random bytes in production.'
  );
}
const SECRET = configuredSecret || crypto.randomBytes(32).toString('base64url');
const SESSION_COOKIE = IS_PRODUCTION ? '__Host-viole_session' : 'viole_session';
const SESSION_MAX_AGE_SECONDS = clampNumber(
  process.env.SESSION_MAX_AGE_SECONDS,
  3600,
  2_592_000,
  604_800
);
const SESSION_IDLE_SECONDS = clampNumber(
  process.env.SESSION_IDLE_SECONDS,
  900,
  SESSION_MAX_AGE_SECONDS,
  86_400
);
const SESSION_TOUCH_SECONDS = 300;
const PREMIUM_BETA_ENABLED = process.env.PREMIUM_BETA_ENABLED !== 'false';
const MAX_GROUP_MEMBERS = 50;
const MAX_SOCKET_PACKET = 64 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_FRAMES = 120;
const REACTION_SET = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥']);
const NICK_ANIMATIONS = ['none', 'shimmer', 'rainbow', 'pulse', 'glow'];
const HEX = /^#[0-9a-f]{6}$/i;
const SAFE_ID = /^[a-z]+_[A-Za-z0-9_-]{6,96}$/;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(candidate), min), max);
}

function normalizedOrigins() {
  const configured = [process.env.APP_ORIGIN, process.env.RENDER_EXTERNAL_URL]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return new Set(configured);
}

const allowedOrigins = normalizedOrigins();

function isAllowedOrigin(origin, headers = {}) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const normalized = parsed.origin.replace(/\/$/, '');
  if (allowedOrigins.size) return allowedOrigins.has(normalized);
  const host = String(headers.host || '').toLowerCase();
  if (!host) return !IS_PRODUCTION;
  const expectedProtocols = IS_PRODUCTION ? ['https:'] : ['http:', 'https:'];
  return expectedProtocols.includes(parsed.protocol) && parsed.host.toLowerCase() === host;
}

const app = express();
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_PACKET,
  allowRequest: (request, callback) => {
    callback(null, isAllowedOrigin(request.headers.origin, request.headers));
  },
});

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)
    )
  );

async function verifyPassword(password, stored) {
  try {
    const [salt] = String(stored || '').split(':');
    if (!salt) return false;
    const value = await hashPassword(password, salt);
    const actual = Buffer.from(value);
    const expected = Buffer.from(String(stored));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHmac('sha256', SECRET).update(String(token || '')).digest('hex');
}

function privacyHash(value) {
  if (!value) return null;
  return crypto.createHmac('sha256', SECRET).update(String(value)).digest('hex');
}

function cookies(req) {
  const result = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function readSessionToken(req) {
  const parsed = cookies(req);
  return parsed[SESSION_COOKIE] || parsed.__Host-viole_session || parsed.viole_session || '';
}

function sessionCookie(token, maxAge = SESSION_MAX_AGE_SECONDS) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.max(0, maxAge)}`,
    'Priority=High',
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookies(res) {
  const expired = 'HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; ${expired}${IS_PRODUCTION ? '; Secure' : ''}`,
    `viole_session=; ${expired}${IS_PRODUCTION ? '; Secure' : ''}`,
    `__Host-viole_session=; ${expired}; Secure`,
  ]);
}

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 128);
}

async function createLoginSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  await repository.createSession({
    id: id('ses'),
    user_id: userId,
    token_hash: tokenHash(token),
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    user_agent_hash: privacyHash(req.headers?.['user-agent']),
    ip_hash: privacyHash(requestIp(req)),
  });
  res.setHeader('Set-Cookie', sessionCookie(token));
}

async function resolveSession(req) {
  const token = readSessionToken(req);
  if (!token || token.length > 256) return null;
  const digest = tokenHash(token);
  const session = await repository.getSessionByTokenHash(digest);
  if (!session) return null;

  const lastSeen = new Date(session.last_seen_at || session.created_at).getTime();
  const now = Date.now();
  if (!Number.isFinite(lastSeen) || now - lastSeen > SESSION_IDLE_SECONDS * 1000) {
    await repository.revokeSessionByTokenHash(digest);
    return null;
  }

  const user = await repository.getUserById(session.user_id);
  if (!user) {
    await repository.revokeSessionByTokenHash(digest);
    return null;
  }

  if (now - lastSeen > SESSION_TOUCH_SECONDS * 1000) {
    session.last_seen_at = new Date(now).toISOString();
    repository.touchSession(session.id, session.last_seen_at).catch((error) => {
      console.error('Could not touch session:', error.message);
    });
  }

  return { user, session, tokenHash: digest };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    bio: user.bio || '',
    status: user.status || 'На связи',
    avatar_color: user.avatar_color,
    is_owner: Boolean(user.is_owner),
    is_premium: Boolean(user.is_owner || user.is_premium),
    avatar_animated: Boolean(user.avatar_animated),
    avatar_url: user.avatar_url || null,
    avatar_is_gif: Boolean(user.avatar_is_gif),
    banner_url: user.banner_url || null,
    banner_is_gif: Boolean(user.banner_is_gif),
    nick_color: user.nick_color || null,
    nick_gradient: Array.isArray(user.nick_gradient) ? user.nick_gradient : null,
    nick_animation: NICK_ANIMATIONS.includes(user.nick_animation) ? user.nick_animation : 'none',
    created_at: user.created_at,
  };
}

function publicChat(chat) {
  const result = { ...chat };
  delete result.read_at;
  if (Array.isArray(result.members)) result.members = result.members.map(publicUser);
  if (result.other) result.other = publicUser(result.other);
  if (!result.other && result.type === 'direct' && Array.isArray(result.member_ids)) {
    result.other = null;
  }
  return result;
}

function isMember(chat, userId) {
  return Boolean(chat?.member_ids?.includes(userId));
}

function validId(value, prefix) {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    SAFE_ID.test(value) &&
    (!prefix || value.startsWith(`${prefix}_`))
  );
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function payloadSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Infinity;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function auth(req, res, next) {
  try {
    const resolved = await resolveSession(req);
    if (!resolved) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
    req.user = resolved.user;
    req.session = resolved.session;
    req.sessionTokenHash = resolved.tokenHash;
    next();
  } catch (error) {
    next(error);
  }
}

class WindowLimiter {
  constructor({ limit, windowMs, maxKeys = 20_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  take(key) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > this.maxKeys) this.sweep(now, true);
    return entry.count <= this.limit;
  }

  sweep(now = Date.now(), force = false) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now || (force && this.entries.size > this.maxKeys)) this.entries.delete(key);
      if (force && this.entries.size <= this.maxKeys) break;
    }
  }
}

const allLimiters = [];
function limiter(options) {
  const value = new WindowLimiter(options);
  allLimiters.push(value);
  return value;
}

const apiIpLimiter = limiter({ limit: 300, windowMs: 60_000 });
const registerLimiter = limiter({ limit: 5, windowMs: 10 * 60_000 });
const loginIpLimiter = limiter({ limit: 30, windowMs: 10 * 60_000 });
const loginAccountLimiter = limiter({ limit: 12, windowMs: 10 * 60_000 });
const uploadLimiter = limiter({ limit: 8, windowMs: 10 * 60_000 });
const searchLimiter = limiter({ limit: 60, windowMs: 60_000 });
const chatCreateLimiter = limiter({ limit: 20, windowMs: 10 * 60_000 });
const socketLimiters = {
  presence: limiter({ limit: 20, windowMs: 60_000 }),
  read: limiter({ limit: 120, windowMs: 60_000 }),
  message: limiter({ limit: 60, windowMs: 60_000 }),
  reaction: limiter({ limit: 90, windowMs: 60_000 }),
  typing: limiter({ limit: 60, windowMs: 30_000 }),
  callStart: limiter({ limit: 10, windowMs: 60_000 }),
  callControl: limiter({ limit: 40, windowMs: 60_000 }),
  callSignal: limiter({ limit: 300, windowMs: 60_000 }),
};

setInterval(() => allLimiters.forEach((item) => item.sweep()), 60_000).unref();

function rateMiddleware(rateLimiter, keyFactory) {
  return (req, res, next) => {
    const key = keyFactory(req);
    if (!rateLimiter.take(key)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    }
    next();
  };
}

app.use((req, res, next) => {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
  ];
  if (IS_PRODUCTION) directives.push('upgrade-insecure-requests');
  res.setHeader('Content-Security-Policy', directives.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use((req, res, next) => {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (
    unsafe &&
    (fetchSite === 'cross-site' || !isAllowedOrigin(req.headers.origin, req.headers))
  ) {
    return res.status(403).json({ error: 'INVALID_ORIGIN' });
  }
  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  if (!apiIpLimiter.take(requestIp(req) || 'local')) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }
  next();
});

app.use(express.json({ limit: '100kb', strict: true }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: IS_PRODUCTION ? '1h' : 0,
    immutable: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    await repository.healthCheck();
    res.json({ ok: true, service: 'viole', database: 'supabase' });
  })
);

function buildIceServers(userId) {
  const urls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8);
  const iceServers = [{ urls }];
  const turnUrl = String(process.env.TURN_URL || '').trim();
  const sharedSecret = String(process.env.TURN_SHARED_SECRET || '');
  if (turnUrl && sharedSecret) {
    const ttl = clampNumber(process.env.TURN_TTL_SECONDS, 300, 86_400, 3600);
    const expires = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expires}:${userId}`;
    const credential = crypto
      .createHmac('sha1', sharedSecret)
      .update(username)
      .digest('base64');
    iceServers.push({ urls: turnUrl.split(',').map((value) => value.trim()).filter(Boolean), username, credential });
  }
  return iceServers;
}

app.get('/api/config', auth, (req, res) => {
  res.json({ iceServers: buildIceServers(req.user.id) });
});

app.post(
  '/api/auth/register',
  rateMiddleware(registerLimiter, (req) => requestIp(req) || 'local'),
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').toLowerCase().trim();
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9_]{4,24}$/.test(username)) {
      return res.status(400).json({ error: 'INVALID_USERNAME' });
    }
    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_PASSWORD' });
    }
    if (await repository.getUserByUsername(username)) {
      return res.status(409).json({ error: 'USERNAME_TAKEN' });
    }

    const colors = ['violet', 'coral', 'blue', 'green'];
    const count = await repository.countUsers();
    const user = await repository.createUser({
      id: id('usr'),
      username,
      display_name: username,
      bio: '',
      status: 'На связи',
      avatar_color: colors[count % colors.length],
      password_hash: await hashPassword(password),
      created_at: new Date().toISOString(),
    });

    await createLoginSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  })
);

app.post(
  '/api/auth/login',
  (req, res, next) => {
    const username = String(req.body?.username || '').toLowerCase().trim().slice(0, 24);
    const ip = requestIp(req) || 'local';
    if (!loginIpLimiter.take(ip) || !loginAccountLimiter.take(`${ip}:${username || '?'}`)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    }
    next();
  },
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').toLowerCase().trim();
    const user = await repository.getAuthUserByUsername(username);
    const valid = user && (await verifyPassword(String(req.body?.password || ''), user.password_hash));
    if (!valid) return res.status(401).json({ error: 'BAD_CREDENTIALS' });
    await createLoginSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  })
);

const sessionSockets = new Map();
function disconnectSessionSockets(sessionId) {
  for (const socketId of sessionSockets.get(sessionId) || []) {
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
  sessionSockets.delete(sessionId);
}

app.post(
  '/api/auth/logout',
  asyncRoute(async (req, res) => {
    const token = readSessionToken(req);
    const revoked = token ? await repository.revokeSessionByTokenHash(tokenHash(token)) : null;
    if (revoked?.id) disconnectSessionSockets(revoked.id);
    clearSessionCookies(res);
    res.json({ ok: true });
  })
);

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch(
  '/api/me',
  auth,
  asyncRoute(async (req, res) => {
    const user = { ...req.user };
    const name = String(req.body?.display_name || '').trim().slice(0, 32);
    const bio = String(req.body?.bio || '').trim().slice(0, 160);
    const status = String(req.body?.status || '').trim().slice(0, 40);
    const allowedColors = ['violet', 'coral', 'blue', 'green'];

    if (name) user.display_name = name;
    user.bio = bio;
    user.status = status || 'На связи';
    if (allowedColors.includes(req.body?.avatar_color)) user.avatar_color = req.body.avatar_color;

    if (typeof req.body?.is_premium === 'boolean' && !user.is_owner) {
      if (!PREMIUM_BETA_ENABLED) return res.status(403).json({ error: 'PREMIUM_MANAGED' });
      user.is_premium = req.body.is_premium;
      if (!user.is_premium) {
        user.avatar_animated = false;
        user.nick_gradient = null;
        user.nick_animation = 'none';
      }
    }

    if (typeof req.body?.avatar_animated === 'boolean') {
      user.avatar_animated = Boolean((user.is_premium || user.is_owner) && req.body.avatar_animated);
    }

    const premium = user.is_owner || user.is_premium;
    if (typeof req.body?.nick_color === 'string') {
      user.nick_color = HEX.test(req.body.nick_color) ? req.body.nick_color : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'nick_gradient')) {
      const stops = Array.isArray(req.body.nick_gradient)
        ? req.body.nick_gradient.filter((color) => typeof color === 'string' && HEX.test(color)).slice(0, 3)
        : [];
      user.nick_gradient = premium && stops.length >= 2 ? stops : null;
    }
    if (
      typeof req.body?.nick_animation === 'string' &&
      NICK_ANIMATIONS.includes(req.body.nick_animation)
    ) {
      user.nick_animation = premium ? req.body.nick_animation : 'none';
    }

    const updated = await repository.updateUser(user);
    res.json({ user: publicUser(updated) });
  })
);

const rawUpload = express.raw({ limit: MAX_IMAGE_BYTES, type: () => true });
let activeImageJobs = 0;
const MAX_IMAGE_JOBS = 4;

async function normalizeImage(buffer, field) {
  let metadata;
  try {
    metadata = await sharp(buffer, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch {
    const error = new Error('INVALID_IMAGE');
    error.statusCode = 400;
    throw error;
  }

  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) {
    const error = new Error('INVALID_FILE_TYPE');
    error.statusCode = 400;
    throw error;
  }
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const frames = Number(metadata.pages || 1);
  if (
    !width ||
    !height ||
    width * height > MAX_IMAGE_PIXELS ||
    width > 8192 ||
    height > 8192 ||
    frames > MAX_IMAGE_FRAMES
  ) {
    const error = new Error('IMAGE_TOO_LARGE');
    error.statusCode = 400;
    throw error;
  }

  const dimensions = field === 'avatar' ? { width: 1024, height: 1024 } : { width: 2048, height: 1024 };
  let body;
  let contentType;
  let extension;
  if (metadata.format === 'gif') {
    body = await sharp(buffer, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
      .gif({ effort: 5 })
      .toBuffer();
    contentType = 'image/gif';
    extension = '.gif';
  } else {
    body = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .rotate()
      .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();
    contentType = 'image/webp';
    extension = '.webp';
  }

  if (!body.length || body.length > MAX_IMAGE_BYTES) {
    const error = new Error('FILE_TOO_LARGE');
    error.statusCode = 413;
    throw error;
  }
  return { body, contentType, extension, isGif: contentType === 'image/gif' };
}

async function removeStorageObject(objectPath, queueOnFailure = true) {
  if (!objectPath) return true;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.storage.from(storageBucket).remove([objectPath]);
    if (!error) return true;
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
  }
  console.error('Could not remove media:', objectPath, lastError?.message);
  if (queueOnFailure) {
    await repository.queueStorageCleanup(objectPath, lastError?.message).catch((error) => {
      console.error('Could not queue media cleanup:', error.message);
    });
  }
  return false;
}

async function processStorageCleanup() {
  const items = await repository.listDueStorageCleanup(20);
  for (const item of items) {
    const removed = await removeStorageObject(item.object_path, false);
    if (removed) {
      await repository.deleteStorageCleanup(item.id);
      continue;
    }
    const attempts = Number(item.attempts || 0) + 1;
    const delayMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
    await repository.markStorageCleanupFailure(
      item.id,
      attempts,
      'Storage remove failed',
      new Date(Date.now() + delayMinutes * 60_000).toISOString()
    );
  }
}

async function saveUpload(req, res, field) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'EMPTY_FILE' });
  }
  if (activeImageJobs >= MAX_IMAGE_JOBS) {
    return res.status(503).json({ error: 'UPLOAD_BUSY' });
  }

  activeImageJobs += 1;
  let normalized;
  try {
    normalized = await normalizeImage(req.body, field);
  } finally {
    activeImageJobs -= 1;
  }

  const objectPath = `${req.user.id}/${field}_${Date.now()}_${crypto
    .randomBytes(6)
    .toString('hex')}${normalized.extension}`;
  const oldPath = req.user[`${field}_path`];

  const { error: uploadError } = await supabase.storage
    .from(storageBucket)
    .upload(objectPath, normalized.body, {
      cacheControl: '3600',
      contentType: normalized.contentType,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(objectPath);
  const updatedUser = {
    ...req.user,
    [`${field}_url`]: data.publicUrl,
    [`${field}_path`]: objectPath,
    [`${field}_is_gif`]: normalized.isGif,
  };

  try {
    const saved = await repository.updateUser(updatedUser);
    await removeStorageObject(oldPath);
    res.json({ user: publicUser(saved) });
  } catch (error) {
    await removeStorageObject(objectPath);
    throw error;
  }
}

async function deleteUpload(req, res, field) {
  const oldPath = req.user[`${field}_path`];
  if (oldPath) {
    const removed = await removeStorageObject(oldPath, false);
    if (!removed) return res.status(502).json({ error: 'STORAGE_DELETE_FAILED' });
  }
  const saved = await repository.updateUser({
    ...req.user,
    [`${field}_url`]: null,
    [`${field}_path`]: null,
    [`${field}_is_gif`]: false,
  });
  res.json({ user: publicUser(saved) });
}

const uploadRate = rateMiddleware(uploadLimiter, (req) => req.user?.id || requestIp(req) || 'local');
app.post('/api/me/avatar', auth, uploadRate, rawUpload, asyncRoute((req, res) => saveUpload(req, res, 'avatar')));
app.delete('/api/me/avatar', auth, asyncRoute((req, res) => deleteUpload(req, res, 'avatar')));
app.post('/api/me/banner', auth, uploadRate, rawUpload, asyncRoute((req, res) => saveUpload(req, res, 'banner')));
app.delete('/api/me/banner', auth, asyncRoute((req, res) => deleteUpload(req, res, 'banner')));

app.get(
  '/api/users/:id',
  auth,
  asyncRoute(async (req, res) => {
    if (!validId(req.params.id, 'usr')) return res.status(400).json({ error: 'INVALID_USER' });
    const user = await repository.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    res.json({ user: publicUser(user) });
  })
);

app.get(
  '/api/users',
  auth,
  rateMiddleware(searchLimiter, (req) => req.user?.id || requestIp(req) || 'local'),
  asyncRoute(async (req, res) => {
    const users = await repository.searchUsers(req.query.q, req.user.id);
    res.json({ users: users.map(publicUser) });
  })
);

const createChatRate = rateMiddleware(chatCreateLimiter, (req) => req.user?.id || requestIp(req) || 'local');

app.get(
  '/api/chats',
  auth,
  asyncRoute(async (req, res) => {
    const chats = await repository.listChatsForUser(req.user.id);
    res.json({ chats: chats.map(publicChat) });
  })
);

app.post(
  '/api/chats/group',
  auth,
  createChatRate,
  asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'INVALID_NAME' });

    const wanted = Array.isArray(req.body?.member_ids)
      ? [...new Set(req.body.member_ids.filter((value) => validId(value, 'usr')))]
          .filter((userId) => userId !== req.user.id)
          .slice(0, MAX_GROUP_MEMBERS - 1)
      : [];
    const members = await repository.getUsersByIds(wanted);
    if (!members.length) return res.status(400).json({ error: 'NO_MEMBERS' });

    const now = new Date().toISOString();
    const colors = ['violet', 'coral', 'blue', 'green'];
    const chat = await repository.createGroupChat(
      {
        id: id('chat'),
        type: 'group',
        name,
        avatar_color: colors[Math.floor(Math.random() * colors.length)],
        owner_id: req.user.id,
        created_at: now,
        updated_at: now,
      },
      members.map((user) => user.id)
    );

    for (const memberId of chat.member_ids) {
      for (const socketId of sockets.get(memberId) || []) io.sockets.sockets.get(socketId)?.join(chat.id);
    }

    const allMembers = await repository.getUsersByIds(chat.member_ids);
    const full = {
      ...chat,
      members: allMembers.map(publicUser),
      last_message: null,
      unread_count: 0,
    };
    for (const memberId of chat.member_ids) {
      if (memberId === req.user.id) continue;
      for (const socketId of sockets.get(memberId) || []) io.to(socketId).emit('chat:new', full);
    }
    res.status(201).json({ chat: full });
  })
);

app.post(
  '/api/chats/:id/members',
  auth,
  createChatRate,
  asyncRoute(async (req, res) => {
    if (!validId(req.params.id, 'chat')) return res.status(400).json({ error: 'INVALID_CHAT' });
    const chat = await repository.getChat(req.params.id);
    if (!chat || chat.type !== 'group' || chat.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    if (chat.member_ids.length >= MAX_GROUP_MEMBERS) {
      return res.status(409).json({ error: 'GROUP_FULL' });
    }

    const newUserId = req.body?.user_id;
    if (!validId(newUserId, 'usr')) return res.status(400).json({ error: 'INVALID_USER' });
    const user = await repository.getUserById(newUserId);
    if (!user) return res.status(400).json({ error: 'INVALID_USER' });

    if (!chat.member_ids.includes(user.id)) {
      const joinedAt = new Date().toISOString();
      const updated = await repository.addChatMember(chat.id, user.id, joinedAt);
      for (const socketId of sockets.get(user.id) || []) io.sockets.sockets.get(socketId)?.join(chat.id);
      const members = (await repository.getUsersByIds(updated.member_ids)).map(publicUser);
      const full = {
        ...updated,
        members,
        last_message: null,
        unread_count: 0,
      };
      for (const socketId of sockets.get(user.id) || []) io.to(socketId).emit('chat:new', full);
      io.to(chat.id).emit('chat:members', { chat_id: chat.id, members });
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/chats/direct',
  auth,
  createChatRate,
  asyncRoute(async (req, res) => {
    const otherId = req.body?.user_id;
    if (!validId(otherId, 'usr')) return res.status(400).json({ error: 'INVALID_USER' });
    const other = await repository.getUserById(otherId);
    if (!other || other.id === req.user.id) return res.status(400).json({ error: 'INVALID_USER' });

    const now = new Date().toISOString();
    const chat = await repository.createDirectChat(id('chat'), req.user.id, other.id, now);
    for (const socketId of sockets.get(req.user.id) || []) io.sockets.sockets.get(socketId)?.join(chat.id);
    for (const socketId of sockets.get(other.id) || []) io.sockets.sockets.get(socketId)?.join(chat.id);
    res.json({ chat: { ...chat, other: publicUser(other) } });
  })
);

app.get(
  '/api/chats/:id/messages',
  auth,
  asyncRoute(async (req, res) => {
    if (!validId(req.params.id, 'chat')) return res.status(400).json({ error: 'INVALID_CHAT' });
    const chat = await repository.getChat(req.params.id);
    const membership = await repository.getChatMembership(req.params.id, req.user.id);
    if (!chat || !membership) return res.status(403).json({ error: 'FORBIDDEN' });
    const since = chat.type === 'group' ? membership.joined_at : null;
    res.json({ messages: await repository.listMessages(chat.id, 300, since) });
  })
);

const sockets = new Map();
const online = (userId) => Boolean(sockets.get(userId)?.size);

async function emitPresence(userId) {
  const recipients = new Set(await repository.listRelatedUserIds(userId));
  recipients.add(userId);
  const payload = { user_id: userId, online: online(userId) };
  for (const recipientId of recipients) {
    for (const socketId of sockets.get(recipientId) || []) io.to(socketId).emit('presence', payload);
  }
}

io.use(async (socket, next) => {
  try {
    const resolved = await resolveSession(socket.request);
    if (!resolved) return next(new Error('unauthorized'));
    socket.user = resolved.user;
    socket.session = resolved.session;
    socket.sessionTokenHash = resolved.tokenHash;
    next();
  } catch (error) {
    next(error);
  }
});

function socketRate(socket, rateLimiter, event) {
  return rateLimiter.take(`${socket.user.id}:${event}`);
}

function onSocket(socket, event, options, handler) {
  socket.on(event, async (data = {}, ack) => {
    try {
      socket.touchSessionActivity?.();
      if (!socketRate(socket, options.limiter, event)) {
        return typeof ack === 'function' ? ack({ error: 'TOO_MANY_ATTEMPTS' }) : undefined;
      }
      if (options.object !== false && !plainObject(data)) {
        return typeof ack === 'function' ? ack({ error: 'INVALID_PAYLOAD' }) : undefined;
      }
      if (payloadSize(data) > (options.maxBytes || 16 * 1024)) {
        return typeof ack === 'function' ? ack({ error: 'INVALID_PAYLOAD' }) : undefined;
      }
      await handler(data, typeof ack === 'function' ? ack : undefined);
    } catch (error) {
      console.error(`Socket event ${event} failed:`, error);
      if (typeof ack === 'function') ack({ error: 'SERVER_ERROR' });
    }
  });
}

function normalizeSignal(signal) {
  if (!plainObject(signal)) return null;
  if (plainObject(signal.description)) {
    const type = signal.description.type;
    const sdp = signal.description.sdp;
    if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 40_000) return null;
    return { description: { type, sdp } };
  }
  if (plainObject(signal.candidate)) {
    const candidate = signal.candidate.candidate;
    if (typeof candidate !== 'string' || candidate.length > 4096) return null;
    return {
      candidate: {
        candidate,
        sdpMid:
          typeof signal.candidate.sdpMid === 'string'
            ? signal.candidate.sdpMid.slice(0, 64)
            : null,
        sdpMLineIndex: Number.isInteger(signal.candidate.sdpMLineIndex)
          ? signal.candidate.sdpMLineIndex
          : null,
        usernameFragment:
          typeof signal.candidate.usernameFragment === 'string'
            ? signal.candidate.usernameFragment.slice(0, 256)
            : null,
      },
    };
  }
  return null;
}

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  const wasOnline = online(userId);
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket.id);
  if (!sessionSockets.has(socket.session.id)) sessionSockets.set(socket.session.id, new Set());
  sessionSockets.get(socket.session.id).add(socket.id);

  const expiresIn = new Date(socket.session.expires_at).getTime() - Date.now();
  const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(1000, expiresIn));
  let idleTimer;
  let lastSessionTouch = new Date(socket.session.last_seen_at || socket.session.created_at).getTime();
  socket.touchSessionActivity = () => {
    const now = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => socket.disconnect(true), SESSION_IDLE_SECONDS * 1000);
    if (now - lastSessionTouch > SESSION_TOUCH_SECONDS * 1000) {
      lastSessionTouch = now;
      repository.touchSession(socket.session.id, new Date(now).toISOString()).catch((error) => {
        console.error('Could not touch socket session:', error.message);
      });
    }
  };
  socket.touchSessionActivity();
  if (!wasOnline) emitPresence(userId).catch((error) => console.error('Presence failed:', error.message));

  try {
    const chatIds = await repository.listChatIdsForUser(userId);
    for (const chatId of chatIds) socket.join(chatId);
  } catch (error) {
    console.error('Could not join initial chat rooms:', error);
  }

  onSocket(
    socket,
    'presence:query',
    { limiter: socketLimiters.presence, object: false, maxBytes: 12 * 1024 },
    async (ids, ack) => {
      if (!Array.isArray(ids)) return ack?.({ error: 'INVALID_PAYLOAD' });
      const requested = [...new Set(ids.filter((value) => validId(value, 'usr')))].slice(0, 100);
      const visible = new Set(await repository.filterVisibleUserIds(userId, requested));
      visible.add(userId);
      const result = Object.fromEntries(
        requested.map((requestedId) => [requestedId, visible.has(requestedId) && online(requestedId)])
      );
      ack?.(result);
    }
  );

  onSocket(socket, 'chat:read', { limiter: socketLimiters.read }, async (data, ack) => {
    if (!validId(data.chat_id, 'chat')) return ack?.({ error: 'INVALID_CHAT' });
    const membership = await repository.getChatMembership(data.chat_id, userId);
    if (!membership) return ack?.({ error: 'FORBIDDEN' });
    await repository.markChatRead(data.chat_id, userId, new Date().toISOString());
    ack?.({ ok: true });
  });

  onSocket(socket, 'message:send', { limiter: socketLimiters.message, maxBytes: 8 * 1024 }, async (data, ack) => {
    if (!validId(data.chat_id, 'chat')) return ack?.({ error: 'INVALID_MESSAGE' });
    const chat = await repository.getChat(data.chat_id);
    const text = String(data.text || '').trim().slice(0, 4000);
    if (!isMember(chat, userId) || !text) return ack?.({ error: 'INVALID_MESSAGE' });

    let replyTo = null;
    if (data.reply_to && validId(data.reply_to, 'msg')) {
      const source = await repository.getMessage(data.reply_to);
      if (source?.chat_id === chat.id) {
        replyTo = { id: source.id, text: source.text.slice(0, 140), sender_id: source.sender_id };
      }
    }

    const message = await repository.createMessage({
      id: id('msg'),
      chat_id: chat.id,
      sender_id: userId,
      text,
      reply_to: replyTo,
      reactions: {},
      created_at: new Date().toISOString(),
    });
    io.to(chat.id).emit('message:new', message);
    ack?.({ ok: true });
  });

  onSocket(socket, 'message:react', { limiter: socketLimiters.reaction }, async (data, ack) => {
    if (!validId(data.message_id, 'msg') || !REACTION_SET.has(data.emoji)) {
      return ack?.({ error: 'INVALID' });
    }
    const message = await repository.getMessage(data.message_id);
    const chat = message && (await repository.getChat(message.chat_id));
    if (!message || !isMember(chat, userId)) return ack?.({ error: 'INVALID' });

    const current = plainObject(message.reactions) ? message.reactions : {};
    const reactions = {};
    for (const emoji of REACTION_SET) {
      if (Array.isArray(current[emoji])) reactions[emoji] = [...new Set(current[emoji].filter((value) => validId(value, 'usr')))].slice(0, MAX_GROUP_MEMBERS);
    }
    const list = reactions[data.emoji] ? [...reactions[data.emoji]] : [];
    const index = list.indexOf(userId);
    if (index >= 0) list.splice(index, 1);
    else list.push(userId);
    if (list.length) reactions[data.emoji] = list;
    else delete reactions[data.emoji];

    await repository.updateMessageReactions(message.id, reactions);
    io.to(chat.id).emit('message:reaction', { message_id: message.id, reactions });
    ack?.({ ok: true });
  });

  onSocket(socket, 'typing', { limiter: socketLimiters.typing }, async (data) => {
    if (!validId(data.chat_id, 'chat')) return;
    const membership = await repository.getChatMembership(data.chat_id, userId);
    if (membership) {
      socket.to(data.chat_id).emit('typing', {
        chat_id: data.chat_id,
        user_id: userId,
        active: Boolean(data.active),
      });
    }
  });

  onSocket(socket, 'call:start', { limiter: socketLimiters.callStart }, async (data, ack) => {
    if (!validId(data.chat_id, 'chat')) return ack?.({ error: 'FORBIDDEN' });
    const chat = await repository.getChat(data.chat_id);
    if (!isMember(chat, userId) || chat.type !== 'direct' || chat.member_ids.length !== 2) {
      return ack?.({ error: 'FORBIDDEN' });
    }
    const target = chat.member_ids.find((memberId) => memberId !== userId);
    if (!target) return ack?.({ error: 'INVALID_CALL' });

    const call = await repository.createCall({
      id: id('call'),
      chat_id: chat.id,
      participant_ids: chat.member_ids,
      type: data.type === 'video' ? 'video' : 'audio',
      state: 'ringing',
      started_at: new Date().toISOString(),
    });
    const from = publicUser(socket.user);
    for (const socketId of sockets.get(target) || []) io.to(socketId).emit('call:incoming', { call, from });
    ack?.({ ok: true, call });
  });

  for (const event of ['call:accept', 'call:reject', 'call:end']) {
    onSocket(socket, event, { limiter: socketLimiters.callControl }, async (data, ack) => {
      if (!validId(data.call_id, 'call')) return ack?.({ error: 'INVALID_CALL' });
      const call = await repository.getCall(data.call_id);
      if (!call || !Array.isArray(call.participant_ids) || !call.participant_ids.includes(userId)) {
        return ack?.({ error: 'FORBIDDEN' });
      }
      const state = event.endsWith('accept')
        ? 'active'
        : event.endsWith('reject')
          ? 'rejected'
          : 'ended';
      if (state === 'active' && call.state !== 'ringing') return ack?.({ error: 'INVALID_STATE' });
      const patch = { state };
      if (state !== 'active') patch.ended_at = new Date().toISOString();
      await repository.updateCall(call.id, patch);

      const target = call.participant_ids.find((memberId) => memberId !== userId);
      for (const socketId of sockets.get(target) || []) {
        io.to(socketId).emit(event === 'call:accept' ? 'call:accepted' : event, { call_id: call.id });
      }
      ack?.({ ok: true });
    });
  }

  onSocket(
    socket,
    'call:signal',
    { limiter: socketLimiters.callSignal, maxBytes: 48 * 1024 },
    async (data, ack) => {
      if (!validId(data.call_id, 'call')) return ack?.({ error: 'INVALID_CALL' });
      const signal = normalizeSignal(data.signal);
      if (!signal) return ack?.({ error: 'INVALID_SIGNAL' });
      const call = await repository.getCall(data.call_id);
      if (
        !call ||
        !Array.isArray(call.participant_ids) ||
        !call.participant_ids.includes(userId) ||
        !['ringing', 'active'].includes(call.state)
      ) {
        return ack?.({ error: 'FORBIDDEN' });
      }
      const target = call.participant_ids.find((memberId) => memberId !== userId);
      for (const socketId of sockets.get(target) || []) {
        io.to(socketId).emit('call:signal', { call_id: call.id, signal });
      }
      ack?.({ ok: true });
    }
  );

  socket.on('disconnect', () => {
    clearTimeout(expiryTimer);
    clearTimeout(idleTimer);
    sockets.get(userId)?.delete(socket.id);
    if (!sockets.get(userId)?.size) sockets.delete(userId);
    sessionSockets.get(socket.session.id)?.delete(socket.id);
    if (!sessionSockets.get(socket.session.id)?.size) sessionSockets.delete(socket.session.id);
    if (!online(userId)) emitPresence(userId).catch((error) => console.error('Presence failed:', error.message));
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large' || error?.statusCode === 413) {
    return res.status(413).json({ error: 'FILE_TOO_LARGE' });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }
  if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
  if (error?.code === '23505') return res.status(409).json({ error: 'USERNAME_TAKEN' });
  console.error(error);
  res.status(500).json({ error: 'SERVER_ERROR' });
});

async function seedOwner() {
  const username = String(process.env.OWNER_USERNAME || 'flovifly').toLowerCase().trim();
  const password = String(process.env.OWNER_PASSWORD || '');
  if (!password) {
    console.log('OWNER_PASSWORD is empty; owner auto-creation is skipped.');
    return;
  }
  if (!/^[a-z0-9_]{4,24}$/.test(username)) throw new Error('OWNER_USERNAME is invalid.');
  if (await repository.getUserByUsername(username)) return;
  if (password.length < 12) throw new Error('OWNER_PASSWORD must contain at least 12 characters.');

  await repository.createUser({
    id: id('usr'),
    username,
    display_name: username,
    bio: '',
    status: 'На связи',
    avatar_color: 'violet',
    is_owner: true,
    is_premium: true,
    avatar_animated: true,
    nick_animation: 'rainbow',
    password_hash: await hashPassword(password),
    created_at: new Date().toISOString(),
  });
  console.log(`Owner @${username} was created.`);
}

async function start() {
  if (!configuredSecret) console.warn('Development session secret was generated for this process.');
  if (process.env.TURN_URL && !process.env.TURN_SHARED_SECRET) {
    console.warn('TURN_URL is set without TURN_SHARED_SECRET; only STUN will be returned.');
  }
  await repository.healthCheck();
  await repository.cleanupExpiredSessions();
  await processStorageCleanup().catch((error) => console.error('Storage cleanup failed:', error.message));
  await seedOwner();
  setInterval(() => repository.cleanupExpiredSessions().catch((error) => console.error(error.message)), 6 * 60 * 60_000).unref();
  setInterval(() => processStorageCleanup().catch((error) => console.error(error.message)), 15 * 60_000).unref();
  server.listen(PORT, () => console.log(`Viole: http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Viole failed to start:', error);
  process.exit(1);
});
