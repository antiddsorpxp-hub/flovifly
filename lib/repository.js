const { supabase } = require('./supabase');

const USER_FIELDS = [
  'id',
  'username',
  'display_name',
  'bio',
  'status',
  'avatar_color',
  'is_owner',
  'is_premium',
  'avatar_animated',
  'avatar_url',
  'avatar_path',
  'avatar_is_gif',
  'banner_url',
  'banner_path',
  'banner_is_gif',
  'nick_color',
  'nick_gradient',
  'nick_animation',
  'created_at',
].join(',');
const AUTH_USER_FIELDS = `${USER_FIELDS},password_hash`;
const MUTABLE_USER_FIELDS = [
  'display_name',
  'bio',
  'status',
  'avatar_color',
  'is_owner',
  'is_premium',
  'avatar_animated',
  'avatar_url',
  'avatar_path',
  'avatar_is_gif',
  'banner_url',
  'banner_path',
  'banner_is_gif',
  'nick_color',
  'nick_gradient',
  'nick_animation',
];

function fail(context, error) {
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.code = error.code;
  wrapped.details = error.details;
  throw wrapped;
}

async function rows(context, query) {
  const { data, error } = await query;
  if (error) fail(context, error);
  return data || [];
}

async function maybeOne(context, query) {
  const { data, error } = await query.maybeSingle();
  if (error) fail(context, error);
  return data || null;
}


function chunks(items, size = 100) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function directKey(a, b) {
  return [a, b].sort().join(':');
}

function chatFromRow(row, memberships = []) {
  return {
    id: row.id,
    type: row.type,
    name: row.name || undefined,
    avatar_color: row.avatar_color || undefined,
    owner_id: row.owner_id || undefined,
    member_ids: memberships.map((item) => item.user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function healthCheck() {
  const { error } = await supabase.from('viole_users').select('id').limit(1);
  if (error) fail('database health check', error);
  return true;
}

async function getUserById(id) {
  if (!id) return null;
  return maybeOne('get user by id', supabase.from('viole_users').select(USER_FIELDS).eq('id', id));
}

async function getUserByUsername(username) {
  if (!username) return null;
  return maybeOne(
    'get user by username',
    supabase.from('viole_users').select(USER_FIELDS).eq('username', username)
  );
}

async function getAuthUserByUsername(username) {
  if (!username) return null;
  return maybeOne(
    'get auth user by username',
    supabase.from('viole_users').select(AUTH_USER_FIELDS).eq('username', username)
  );
}

async function countUsers() {
  const { count, error } = await supabase
    .from('viole_users')
    .select('id', { count: 'exact', head: true });
  if (error) fail('count users', error);
  return count || 0;
}

async function createUser(user) {
  const created = await rows(
    'create user',
    supabase.from('viole_users').insert(user).select(USER_FIELDS)
  );
  return created[0];
}

async function updateUser(user) {
  const patch = {};
  for (const field of MUTABLE_USER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(user, field)) patch[field] = user[field];
  }
  const updated = await rows(
    'update user',
    supabase.from('viole_users').update(patch).eq('id', user.id).select(USER_FIELDS)
  );
  return updated[0];
}

async function searchUsers(query, exceptUserId) {
  const safe = String(query || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  if (safe.length < 2) return [];

  return rows(
    'search users',
    supabase
      .from('viole_users')
      .select(USER_FIELDS)
      .ilike('username', `%${safe}%`)
      .neq('id', exceptUserId)
      .order('username')
      .limit(20)
  );
}

async function getUsersByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 2000);
  if (!unique.length) return [];
  const result = [];
  for (const batch of chunks(unique)) {
    result.push(
      ...(await rows(
        'get users by ids',
        supabase.from('viole_users').select(USER_FIELDS).in('id', batch)
      ))
    );
  }
  return result;
}

async function getChat(id) {
  if (!id) return null;
  const chatRow = await maybeOne('get chat', supabase.from('viole_chats').select('*').eq('id', id));
  if (!chatRow) return null;
  const memberships = await rows(
    'get chat members',
    supabase
      .from('viole_chat_members')
      .select('user_id,joined_at')
      .eq('chat_id', id)
      .order('joined_at')
  );
  return chatFromRow(chatRow, memberships);
}

async function getChatMembership(chatId, userId) {
  if (!chatId || !userId) return null;
  return maybeOne(
    'get chat membership',
    supabase
      .from('viole_chat_members')
      .select('chat_id,user_id,joined_at,read_at')
      .eq('chat_id', chatId)
      .eq('user_id', userId)
  );
}

async function listChatIdsForUser(userId) {
  const memberships = await rows(
    'list chat ids',
    supabase.from('viole_chat_members').select('chat_id').eq('user_id', userId)
  );
  return memberships.map((item) => item.chat_id);
}

async function listRelatedUserIds(userId) {
  const chatIds = await listChatIdsForUser(userId);
  if (!chatIds.length) return [];
  const related = new Set();
  for (const batch of chunks(chatIds)) {
    const memberships = await rows(
      'list related users',
      supabase
        .from('viole_chat_members')
        .select('user_id')
        .in('chat_id', batch)
        .neq('user_id', userId)
        .limit(2000)
    );
    for (const item of memberships) related.add(item.user_id);
    if (related.size >= 2000) break;
  }
  return [...related].slice(0, 2000);
}

async function filterVisibleUserIds(userId, candidateIds) {
  const candidates = [...new Set((candidateIds || []).filter(Boolean))].slice(0, 100);
  if (!candidates.length) return [];
  const chatIds = await listChatIdsForUser(userId);
  if (!chatIds.length) return [];
  const visible = new Set();
  for (const batch of chunks(chatIds)) {
    const memberships = await rows(
      'filter visible users',
      supabase
        .from('viole_chat_members')
        .select('user_id')
        .in('chat_id', batch)
        .in('user_id', candidates)
        .limit(1000)
    );
    for (const item of memberships) visible.add(item.user_id);
    if (visible.size === candidates.length) break;
  }
  return [...visible];
}

async function listChatsForUser(userId) {
  const result = await rows('list user chats', supabase.rpc('viole_list_chats', { p_user_id: userId }));
  const memberIds = result.flatMap((chat) => chat.member_ids || []);
  const users = await getUsersByIds(memberIds);
  const usersById = new Map(users.map((user) => [user.id, user]));

  return result.map((row) => {
    const chat = {
      id: row.id,
      type: row.type,
      name: row.name || undefined,
      avatar_color: row.avatar_color || undefined,
      owner_id: row.owner_id || undefined,
      member_ids: row.member_ids || [],
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_message: row.last_message || null,
      unread_count: Number(row.unread_count || 0),
    };

    if (chat.type === 'group') {
      chat.members = chat.member_ids.map((id) => usersById.get(id)).filter(Boolean);
    } else {
      chat.other = usersById.get(chat.member_ids.find((id) => id !== userId)) || null;
    }

    return chat;
  });
}

async function createGroupChat(chat, memberIds) {
  const { error } = await supabase.rpc('viole_create_group_chat', {
    p_chat_id: chat.id,
    p_owner_id: chat.owner_id,
    p_name: chat.name,
    p_avatar_color: chat.avatar_color,
    p_member_ids: memberIds,
    p_created_at: chat.created_at,
  });
  if (error) fail('create group chat', error);
  return getChat(chat.id);
}

async function createDirectChat(chatId, userA, userB, createdAt) {
  const { data, error } = await supabase.rpc('viole_create_direct_chat', {
    p_chat_id: chatId,
    p_user_a: userA,
    p_user_b: userB,
    p_created_at: createdAt,
  });
  if (error) fail('create direct chat', error);
  return getChat(data);
}

async function addChatMember(chatId, userId, joinedAt = new Date().toISOString()) {
  const { error } = await supabase.from('viole_chat_members').upsert(
    { chat_id: chatId, user_id: userId, joined_at: joinedAt },
    { onConflict: 'chat_id,user_id', ignoreDuplicates: true }
  );
  if (error) fail('add chat member', error);
  const { error: touchError } = await supabase
    .from('viole_chats')
    .update({ updated_at: joinedAt })
    .eq('id', chatId);
  if (touchError) fail('touch chat after adding member', touchError);
  return getChat(chatId);
}

async function markChatRead(chatId, userId, readAt) {
  const { error } = await supabase
    .from('viole_chat_members')
    .update({ read_at: readAt })
    .eq('chat_id', chatId)
    .eq('user_id', userId);
  if (error) fail('mark chat read', error);
}

async function listMessages(chatId, limit = 300, since = null) {
  let query = supabase
    .from('viole_messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 1, 1), 300));
  if (since) query = query.gte('created_at', since);
  const result = await rows('list messages', query);
  return result.reverse();
}

async function getMessage(id) {
  if (!id) return null;
  return maybeOne('get message', supabase.from('viole_messages').select('*').eq('id', id));
}

async function createMessage(message) {
  const created = await rows(
    'create message',
    supabase.from('viole_messages').insert(message).select('*')
  );
  const { error } = await supabase
    .from('viole_chats')
    .update({ updated_at: message.created_at })
    .eq('id', message.chat_id);
  if (error) fail('touch chat after message', error);
  return created[0];
}

async function updateMessageReactions(messageId, reactions) {
  const updated = await rows(
    'update message reactions',
    supabase.from('viole_messages').update({ reactions }).eq('id', messageId).select('*')
  );
  return updated[0];
}

async function getLastMessage(chatId, since = null) {
  let query = supabase
    .from('viole_messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (since) query = query.gte('created_at', since);
  const result = await rows('get last message', query);
  return result[0] || null;
}

async function createCall(call) {
  const created = await rows('create call', supabase.from('viole_calls').insert(call).select('*'));
  return created[0];
}

async function getCall(id) {
  if (!id) return null;
  return maybeOne('get call', supabase.from('viole_calls').select('*').eq('id', id));
}

async function updateCall(id, patch) {
  const updated = await rows(
    'update call',
    supabase.from('viole_calls').update(patch).eq('id', id).select('*')
  );
  return updated[0];
}

async function createSession(session) {
  const created = await rows(
    'create session',
    supabase.from('viole_sessions').insert(session).select('*')
  );
  return created[0];
}

async function getSessionByTokenHash(tokenHash) {
  if (!tokenHash) return null;
  return maybeOne(
    'get session',
    supabase
      .from('viole_sessions')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
  );
}

async function touchSession(sessionId, lastSeenAt) {
  const { error } = await supabase
    .from('viole_sessions')
    .update({ last_seen_at: lastSeenAt })
    .eq('id', sessionId)
    .is('revoked_at', null);
  if (error) fail('touch session', error);
}

async function revokeSessionByTokenHash(tokenHash, revokedAt = new Date().toISOString()) {
  if (!tokenHash) return null;
  const updated = await rows(
    'revoke session',
    supabase
      .from('viole_sessions')
      .update({ revoked_at: revokedAt })
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .select('id,user_id')
  );
  return updated[0] || null;
}

async function cleanupExpiredSessions() {
  const cutoff = new Date().toISOString();
  const { error } = await supabase.from('viole_sessions').delete().lt('expires_at', cutoff);
  if (error) fail('cleanup expired sessions', error);
}

async function queueStorageCleanup(objectPath, lastError = '') {
  if (!objectPath) return;
  const { error } = await supabase.from('viole_storage_cleanup').upsert(
    {
      object_path: objectPath,
      last_error: String(lastError || '').slice(0, 500),
      next_attempt_at: new Date().toISOString(),
    },
    { onConflict: 'object_path' }
  );
  if (error) fail('queue storage cleanup', error);
}

async function listDueStorageCleanup(limit = 20) {
  return rows(
    'list storage cleanup',
    supabase
      .from('viole_storage_cleanup')
      .select('*')
      .lte('next_attempt_at', new Date().toISOString())
      .order('created_at')
      .limit(Math.min(Math.max(Number(limit) || 1, 1), 100))
  );
}

async function markStorageCleanupFailure(id, attempts, lastError, nextAttemptAt) {
  const { error } = await supabase
    .from('viole_storage_cleanup')
    .update({
      attempts,
      last_error: String(lastError || '').slice(0, 500),
      next_attempt_at: nextAttemptAt,
    })
    .eq('id', id);
  if (error) fail('mark storage cleanup failure', error);
}

async function deleteStorageCleanup(id) {
  const { error } = await supabase.from('viole_storage_cleanup').delete().eq('id', id);
  if (error) fail('delete storage cleanup', error);
}

module.exports = {
  addChatMember,
  cleanupExpiredSessions,
  countUsers,
  createCall,
  createDirectChat,
  createGroupChat,
  createMessage,
  createSession,
  createUser,
  deleteStorageCleanup,
  directKey,
  filterVisibleUserIds,
  getAuthUserByUsername,
  getCall,
  getChat,
  getChatMembership,
  getLastMessage,
  getMessage,
  getSessionByTokenHash,
  getUserById,
  getUserByUsername,
  getUsersByIds,
  healthCheck,
  listChatIdsForUser,
  listChatsForUser,
  listDueStorageCleanup,
  listMessages,
  listRelatedUserIds,
  markChatRead,
  markStorageCleanupFailure,
  queueStorageCleanup,
  revokeSessionByTokenHash,
  searchUsers,
  touchSession,
  updateCall,
  updateMessageReactions,
  updateUser,
};
