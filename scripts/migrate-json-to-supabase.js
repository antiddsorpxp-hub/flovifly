const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const { supabase, storageBucket } = require('../lib/supabase');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');

function directKey(memberIds) {
  return [...memberIds].sort().join(':');
}

function chunks(items, size = 200) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function upsert(table, records, onConflict = 'id') {
  for (const batch of chunks(records)) {
    if (!batch.length) continue;
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function migrateMedia(user, field) {
  const currentUrl = user[`${field}_url`];
  if (!currentUrl || !currentUrl.startsWith('/uploads/')) return user;

  const filename = path.basename(currentUrl);
  const localPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(localPath)) {
    console.warn(`Missing local file: ${localPath}`);
    return user;
  }

  const input = fs.readFileSync(localPath);
  const metadata = await sharp(input, {
    animated: true,
    failOn: 'error',
    limitInputPixels: 16_000_000,
  }).metadata();
  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) {
    console.warn(`Unsupported image skipped: ${localPath}`);
    return user;
  }
  if ((metadata.width || 0) * (metadata.height || 0) > 16_000_000 || (metadata.pages || 1) > 120) {
    console.warn(`Oversized image skipped: ${localPath}`);
    return user;
  }

  const dimensions = field === 'avatar' ? { width: 1024, height: 1024 } : { width: 2048, height: 1024 };
  const isGif = metadata.format === 'gif';
  const body = isGif
    ? await sharp(input, { animated: true, failOn: 'error', limitInputPixels: 16_000_000 })
        .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
        .gif({ effort: 5 })
        .toBuffer()
    : await sharp(input, { failOn: 'error', limitInputPixels: 16_000_000 })
        .rotate()
        .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 86, effort: 4 })
        .toBuffer();
  if (body.length > 8 * 1024 * 1024) {
    console.warn(`Image remains larger than 8 MB and was skipped: ${localPath}`);
    return user;
  }

  const extension = isGif ? '.gif' : '.webp';
  const contentType = isGif ? 'image/gif' : 'image/webp';
  const stem = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const objectPath = `${user.id}/${field}_migrated_${stem}${extension}`;
  const { error } = await supabase.storage.from(storageBucket).upload(objectPath, body, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Upload ${filename}: ${error.message}`);

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(objectPath);
  return {
    ...user,
    [`${field}_url`]: data.publicUrl,
    [`${field}_path`]: objectPath,
    [`${field}_is_gif`]: isGif,
  };
}

function mapUser(user) {
  return {
    id: user.id,
    username: user.username,
    password_hash: user.password_hash,
    display_name: user.display_name || user.username,
    bio: user.bio || '',
    status: user.status || 'На связи',
    avatar_color: user.avatar_color || 'violet',
    is_owner: Boolean(user.is_owner),
    is_premium: Boolean(user.is_premium),
    avatar_animated: Boolean(user.avatar_animated),
    avatar_url: user.avatar_url || null,
    avatar_path: user.avatar_path || null,
    avatar_is_gif: Boolean(user.avatar_is_gif),
    banner_url: user.banner_url || null,
    banner_path: user.banner_path || null,
    banner_is_gif: Boolean(user.banner_is_gif),
    nick_color: user.nick_color || null,
    nick_gradient: Array.isArray(user.nick_gradient) ? user.nick_gradient : null,
    nick_animation: user.nick_animation || 'none',
    created_at: user.created_at || new Date().toISOString(),
  };
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`Local database was not found: ${DB_FILE}`);
  }

  const source = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const users = [];
  for (const rawUser of source.users || []) {
    let user = await migrateMedia(rawUser, 'avatar');
    user = await migrateMedia(user, 'banner');
    users.push(mapUser(user));
  }
  await upsert('viole_users', users);
  console.log(`Users migrated: ${users.length}`);

  const chats = (source.chats || []).map((chat) => ({
    id: chat.id,
    type: chat.type,
    name: chat.name || null,
    avatar_color: chat.avatar_color || null,
    owner_id: chat.owner_id || null,
    direct_key: chat.type === 'direct' ? directKey(chat.member_ids || []) : null,
    created_at: chat.created_at || new Date().toISOString(),
    updated_at: chat.updated_at || chat.created_at || new Date().toISOString(),
  }));
  await upsert('viole_chats', chats);

  const memberships = (source.chats || []).flatMap((chat) =>
    (chat.member_ids || []).map((userId) => ({
      chat_id: chat.id,
      user_id: userId,
      read_at: chat.read_at?.[userId] || null,
      joined_at: chat.created_at || new Date().toISOString(),
    }))
  );
  await upsert('viole_chat_members', memberships, 'chat_id,user_id');
  console.log(`Chats migrated: ${chats.length}`);

  const messages = (source.messages || []).map((message) => ({
    id: message.id,
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    text: message.text,
    reply_to: message.reply_to || null,
    reactions: message.reactions || {},
    created_at: message.created_at || new Date().toISOString(),
  }));
  await upsert('viole_messages', messages);
  console.log(`Messages migrated: ${messages.length}`);

  const calls = (source.calls || []).map((call) => ({
    id: call.id,
    chat_id: call.chat_id,
    participant_ids: call.participant_ids || [],
    type: call.type === 'video' ? 'video' : 'audio',
    state: call.state || 'ended',
    started_at: call.started_at || new Date().toISOString(),
    ended_at: call.ended_at || null,
  }));
  await upsert('viole_calls', calls);
  console.log(`Calls migrated: ${calls.length}`);
  console.log('Migration completed. Keep a backup of data/db.json until you verify the site.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
