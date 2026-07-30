const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET || 'development-only-change-me';
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const NICK_ANIMATIONS = ['none', 'shimmer', 'rainbow', 'pulse', 'glow'];
const HEX = /^#[0-9a-f]{6}$/i;

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(`${salt}:${key.toString('hex')}`)
    )
  );

async function verifyPassword(password, stored) {
  try {
    const [salt] = stored.split(':');
    const value = await hashPassword(password, salt);
    const actual = Buffer.from(value);
    const expected = Buffer.from(stored);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sign(userId) {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Date.now() + 2_592_000_000 })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verify(token = '') {
  try {
    const [payload, signature] = token.split('.');
    const actual = Buffer.from(signature || '');
    const expected = Buffer.from(
      crypto.createHmac('sha256', SECRET).update(payload || '').digest('base64url')
    );
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url'));
    return parsed.exp > Date.now() ? parsed.sub : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .filter(Boolean)
      .map((value) => value.trim().split(/=(.*)/s).slice(0, 2).map(decodeURIComponent))
  );
}

function setCookie(res, token, maxAge = 2_592_000) {
  res.setHeader(
    'Set-Cookie',
    `viole_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  );
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

function publicChat(chat, currentUserId) {
  const result = { ...chat };
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

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function auth(req, res, next) {
  try {
    const userId = verify(cookies(req).viole_session);
    const user = await repository.getUserById(userId);
    if (!user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

const attempts = new Map();
function authLimit(req, res, next) {
  const key = req.ip || 'local';
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 12) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  recent.push(now);
  attempts.set(key, recent);
  next();
}

const uploadAttempts = new Map();
function uploadLimit(req, res, next) {
  const key = req.user?.id || req.ip || 'local';
  const now = Date.now();
  const recent = (uploadAttempts.get(key) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  recent.push(now);
  uploadAttempts.set(key, recent);
  next();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
);

app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    await repository.healthCheck();
    res.json({ ok: true, service: 'viole', database: 'supabase' });
  })
);

app.get('/api/config', (_req, res) => {
  const urls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .filter(Boolean);
  const iceServers = [{ urls }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

app.post(
  '/api/auth/register',
  authLimit,
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').toLowerCase().trim();
    const password = String(req.body.password || '');
    if (!/^[a-z0-9_]{4,24}$/.test(username)) {
      return res.status(400).json({ error: 'INVALID_USERNAME' });
    }
    if (password.length < 8 || password.length > 128) {
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

    setCookie(res, sign(user.id));
    res.status(201).json({ user: publicUser(user) });
  })
);

app.post(
  '/api/auth/login',
  authLimit,
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').toLowerCase().trim();
    const user = await repository.getUserByUsername(username);
    const valid = user && (await verifyPassword(String(req.body.password || ''), user.password_hash));
    if (!valid) return res.status(401).json({ error: 'BAD_CREDENTIALS' });
    setCookie(res, sign(user.id));
    res.json({ user: publicUser(user) });
  })
);

app.post('/api/auth/logout', (_req, res) => {
  setCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch(
  '/api/me',
  auth,
  asyncRoute(async (req, res) => {
    const user = { ...req.user };
    const name = String(req.body.display_name || '').trim().slice(0, 32);
    const bio = String(req.body.bio || '').trim().slice(0, 160);
    const status = String(req.body.status || '').trim().slice(0, 40);
    const allowedColors = ['violet', 'coral', 'blue', 'green'];

    if (name) user.display_name = name;
    user.bio = bio;
    user.status = status || 'На связи';
    if (allowedColors.includes(req.body.avatar_color)) user.avatar_color = req.body.avatar_color;

    if (typeof req.body.is_premium === 'boolean' && !user.is_owner) {
      user.is_premium = req.body.is_premium;
      if (!user.is_premium) {
        user.avatar_animated = false;
        user.nick_gradient = null;
        user.nick_animation = 'none';
      }
    }

    if (typeof req.body.avatar_animated === 'boolean') {
      user.avatar_animated = Boolean((user.is_premium || user.is_owner) && req.body.avatar_animated);
    }

    const premium = user.is_owner || user.is_premium;
    if (typeof req.body.nick_color === 'string') {
      user.nick_color = HEX.test(req.body.nick_color) ? req.body.nick_color : null;
    }
    if ('nick_gradient' in req.body) {
      const stops = Array.isArray(req.body.nick_gradient)
        ? req.body.nick_gradient.filter((color) => HEX.test(color)).slice(0, 3)
        : [];
      user.nick_gradient = premium && stops.length >= 2 ? stops : null;
    }
    if (
      typeof req.body.nick_animation === 'string' &&
      NICK_ANIMATIONS.includes(req.body.nick_animation)
    ) {
      user.nick_animation = premium ? req.body.nick_animation : 'none';
    }

    const updated = await repository.updateUser(user);
    res.json({ user: publicUser(updated) });
  })
);

const rawUpload = express.raw({ limit: '8mb', type: () => true });

async function removeStorageObject(objectPath) {
  if (!objectPath) return;
  const { error } = await supabase.storage.from(storageBucket).remove([objectPath]);
  if (error) console.error('Could not remove old media:', error.message);
}

async function saveUpload(req, res, field) {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  const extension = MIME_EXT[mime];
  if (!extension) return res.status(400).json({ error: 'INVALID_FILE_TYPE' });
  if (!req.body?.length) return res.status(400).json({ error: 'EMPTY_FILE' });

  const objectPath = `${req.user.id}/${field}_${Date.now()}_${crypto
    .randomBytes(5)
    .toString('hex')}${extension}`;
  const oldPath = req.user[`${field}_path`];

  const { error: uploadError } = await supabase.storage
    .from(storageBucket)
    .upload(objectPath, req.body, {
      cacheControl: '3600',
      contentType: mime,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(objectPath);
  const updatedUser = {
    ...req.user,
    [`${field}_url`]: data.publicUrl,
    [`${field}_path`]: objectPath,
    [`${field}_is_gif`]: mime === 'image/gif',
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
  const saved = await repository.updateUser({
    ...req.user,
    [`${field}_url`]: null,
    [`${field}_path`]: null,
    [`${field}_is_gif`]: false,
  });
  await removeStorageObject(oldPath);
  res.json({ user: publicUser(saved) });
}

app.post(
  '/api/me/avatar',
  auth,
  uploadLimit,
  rawUpload,
  asyncRoute((req, res) => saveUpload(req, res, 'avatar'))
);
app.delete(
  '/api/me/avatar',
  auth,
  asyncRoute((req, res) => deleteUpload(req, res, 'avatar'))
);
app.post(
  '/api/me/banner',
  auth,
  uploadLimit,
  rawUpload,
  asyncRoute((req, res) => saveUpload(req, res, 'banner'))
);
app.delete(
  '/api/me/banner',
  auth,
  asyncRoute((req, res) => deleteUpload(req, res, 'banner'))
);

app.get(
  '/api/users/:id',
  auth,
  asyncRoute(async (req, res) => {
    const user = await repository.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    res.json({ user: publicUser(user) });
  })
);

app.get(
  '/api/users',
  auth,
  asyncRoute(async (req, res) => {
    const users = await repository.searchUsers(req.query.q, req.user.id);
    res.json({ users: users.map(publicUser) });
  })
);

app.get(
  '/api/chats',
  auth,
  asyncRoute(async (req, res) => {
    const chats = await repository.listChatsForUser(req.user.id);
    res.json({ chats: chats.map((chat) => publicChat(chat, req.user.id)) });
  })
);

app.post(
  '/api/chats/group',
  auth,
  asyncRoute(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'INVALID_NAME' });

    const wanted = Array.isArray(req.body.member_ids)
      ? [...new Set(req.body.member_ids.filter((value) => typeof value === 'string'))]
          .filter((userId) => userId !== req.user.id)
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

    for (const userId of chat.member_ids) {
      for (const socketId of sockets.get(userId) || []) {
        io.sockets.sockets.get(socketId)?.join(chat.id);
      }
    }

    const allMembers = await repository.getUsersByIds(chat.member_ids);
    const full = {
      ...chat,
      members: allMembers.map(publicUser),
      last_message: null,
      unread_count: 0,
    };
    for (const userId of chat.member_ids) {
      if (userId === req.user.id) continue;
      for (const socketId of sockets.get(userId) || []) io.to(socketId).emit('chat:new', full);
    }
    res.status(201).json({ chat: full });
  })
);

app.post(
  '/api/chats/:id/members',
  auth,
  asyncRoute(async (req, res) => {
    const chat = await repository.getChat(req.params.id);
    if (!chat || chat.type !== 'group' || !isMember(chat, req.user.id)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const user = await repository.getUserById(req.body.user_id);
    if (!user) return res.status(400).json({ error: 'INVALID_USER' });

    if (!chat.member_ids.includes(user.id)) {
      const updated = await repository.addChatMember(chat.id, user.id);
      for (const socketId of sockets.get(user.id) || []) {
        io.sockets.sockets.get(socketId)?.join(chat.id);
      }
      const members = (await repository.getUsersByIds(updated.member_ids)).map(publicUser);
      const full = {
        ...updated,
        members,
        last_message: await repository.getLastMessage(chat.id),
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
  asyncRoute(async (req, res) => {
    const other = await repository.getUserById(req.body.user_id);
    if (!other || other.id === req.user.id) {
      return res.status(400).json({ error: 'INVALID_USER' });
    }

    const now = new Date().toISOString();
    const chat = await repository.createDirectChat(id('chat'), req.user.id, other.id, now);
    for (const socketId of sockets.get(req.user.id) || []) {
      io.sockets.sockets.get(socketId)?.join(chat.id);
    }
    for (const socketId of sockets.get(other.id) || []) {
      io.sockets.sockets.get(socketId)?.join(chat.id);
    }
    res.json({ chat: { ...chat, other: publicUser(other) } });
  })
);

app.get(
  '/api/chats/:id/messages',
  auth,
  asyncRoute(async (req, res) => {
    const chat = await repository.getChat(req.params.id);
    if (!isMember(chat, req.user.id)) return res.status(403).json({ error: 'FORBIDDEN' });
    res.json({ messages: await repository.listMessages(chat.id, 300) });
  })
);

const sockets = new Map();
const online = (userId) => Boolean(sockets.get(userId)?.size);
const presence = (userId) => io.emit('presence', { user_id: userId, online: online(userId) });

io.use(async (socket, next) => {
  try {
    const userId = verify(cookies(socket.request).viole_session);
    const user = await repository.getUserById(userId);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  } catch (error) {
    next(error);
  }
});

function onSocket(socket, event, handler) {
  socket.on(event, async (data = {}, ack) => {
    try {
      await handler(data, ack);
    } catch (error) {
      console.error(`Socket event ${event} failed:`, error);
      ack?.({ error: 'SERVER_ERROR' });
    }
  });
}

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(socket.id);
  presence(userId);

  try {
    const chatIds = await repository.listChatIdsForUser(userId);
    for (const chatId of chatIds) socket.join(chatId);
  } catch (error) {
    console.error('Could not join initial chat rooms:', error);
  }

  socket.on('presence:query', (ids, ack) => {
    ack?.(Object.fromEntries((ids || []).map((idValue) => [idValue, online(idValue)])));
  });

  onSocket(socket, 'chat:read', async (data, ack) => {
    const chat = await repository.getChat(data.chat_id);
    if (!isMember(chat, userId)) return ack?.({ error: 'FORBIDDEN' });
    await repository.markChatRead(chat.id, userId, new Date().toISOString());
    ack?.({ ok: true });
  });

  onSocket(socket, 'message:send', async (data, ack) => {
    const chat = await repository.getChat(data.chat_id);
    const text = String(data.text || '').trim().slice(0, 4000);
    if (!isMember(chat, userId) || !text) return ack?.({ error: 'INVALID_MESSAGE' });

    let replyTo = null;
    if (data.reply_to) {
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

  onSocket(socket, 'message:react', async (data, ack) => {
    const message = await repository.getMessage(data.message_id);
    const chat = message && (await repository.getChat(message.chat_id));
    const emoji = String(data.emoji || '').slice(0, 8);
    if (!message || !isMember(chat, userId) || !emoji) return ack?.({ error: 'INVALID' });

    const reactions = message.reactions && typeof message.reactions === 'object' ? message.reactions : {};
    const list = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
    const index = list.indexOf(userId);
    if (index >= 0) list.splice(index, 1);
    else list.push(userId);
    if (list.length) reactions[emoji] = list;
    else delete reactions[emoji];

    await repository.updateMessageReactions(message.id, reactions);
    io.to(chat.id).emit('message:reaction', { message_id: message.id, reactions });
    ack?.({ ok: true });
  });

  onSocket(socket, 'typing', async (data) => {
    const chat = await repository.getChat(data.chat_id);
    if (isMember(chat, userId)) {
      socket.to(chat.id).emit('typing', {
        chat_id: chat.id,
        user_id: userId,
        active: Boolean(data.active),
      });
    }
  });

  onSocket(socket, 'call:start', async (data, ack) => {
    const chat = await repository.getChat(data.chat_id);
    if (!isMember(chat, userId)) return ack?.({ error: 'FORBIDDEN' });
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
    const from = publicUser((await repository.getUserById(userId)) || socket.user);
    for (const socketId of sockets.get(target) || []) {
      io.to(socketId).emit('call:incoming', { call, from });
    }
    ack?.({ ok: true, call });
  });

  for (const event of ['call:accept', 'call:reject', 'call:end']) {
    onSocket(socket, event, async (data) => {
      const call = await repository.getCall(data.call_id);
      if (!call || !Array.isArray(call.participant_ids) || !call.participant_ids.includes(userId)) {
        return;
      }
      const state = event.endsWith('accept')
        ? 'active'
        : event.endsWith('reject')
          ? 'rejected'
          : 'ended';
      const patch = { state };
      if (state !== 'active') patch.ended_at = new Date().toISOString();
      await repository.updateCall(call.id, patch);

      const target = call.participant_ids.find((memberId) => memberId !== userId);
      for (const socketId of sockets.get(target) || []) {
        io.to(socketId).emit(event === 'call:accept' ? 'call:accepted' : event, {
          call_id: call.id,
        });
      }
    });
  }

  onSocket(socket, 'call:signal', async (data) => {
    const call = await repository.getCall(data.call_id);
    if (!call || !Array.isArray(call.participant_ids) || !call.participant_ids.includes(userId)) {
      return;
    }
    const target = call.participant_ids.find((memberId) => memberId !== userId);
    for (const socketId of sockets.get(target) || []) {
      io.to(socketId).emit('call:signal', { call_id: call.id, signal: data.signal });
    }
  });

  socket.on('disconnect', () => {
    sockets.get(userId)?.delete(socket.id);
    if (!sockets.get(userId)?.size) sockets.delete(userId);
    presence(userId);
  });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'FILE_TOO_LARGE' });
  }
  if (error?.code === '23505') {
    return res.status(409).json({ error: 'USERNAME_TAKEN' });
  }
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
  if (await repository.getUserByUsername(username)) return;

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
  if (SECRET === 'development-only-change-me') {
    console.warn('WARNING: set a long JWT_SECRET before deploying to production.');
  }
  await repository.healthCheck();
  await seedOwner();
  server.listen(PORT, () => console.log(`Viole: http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Viole failed to start:', error);
  process.exit(1);
});
