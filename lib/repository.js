const { supabase } = require('./supabase');

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

function directKey(a, b) {
  return [a, b].sort().join(':');
}

function chatFromRow(row, memberships = []) {
  const memberIds = memberships.map((item) => item.user_id);
  const readAt = Object.fromEntries(
    memberships.filter((item) => item.read_at).map((item) => [item.user_id, item.read_at])
  );

  return {
    id: row.id,
    type: row.type,
    name: row.name || undefined,
    avatar_color: row.avatar_color || undefined,
    owner_id: row.owner_id || undefined,
    member_ids: memberIds,
    read_at: readAt,
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
  return maybeOne('get user by id', supabase.from('viole_users').select('*').eq('id', id));
}

async function getUserByUsername(username) {
  if (!username) return null;
  return maybeOne(
    'get user by username',
    supabase.from('viole_users').select('*').eq('username', username)
  );
}

async function countUsers() {
  const { count, error } = await supabase
    .from('viole_users')
    .select('*', { count: 'exact', head: true });
  if (error) fail('count users', error);
  return count || 0;
}

async function createUser(user) {
  const created = await rows('create user', supabase.from('viole_users').insert(user).select('*'));
  return created[0];
}

async function updateUser(user) {
  const updated = await rows(
    'update user',
    supabase.from('viole_users').update(user).eq('id', user.id).select('*')
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
      .select('*')
      .ilike('username', `%${safe}%`)
      .neq('id', exceptUserId)
      .order('username')
      .limit(20)
  );
}

async function getUsersByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  return rows('get users by ids', supabase.from('viole_users').select('*').in('id', unique));
}

async function getChat(id) {
  const chatRow = await maybeOne('get chat', supabase.from('viole_chats').select('*').eq('id', id));
  if (!chatRow) return null;
  const memberships = await rows(
    'get chat members',
    supabase.from('viole_chat_members').select('user_id,read_at').eq('chat_id', id)
  );
  return chatFromRow(chatRow, memberships);
}

async function listChatIdsForUser(userId) {
  const memberships = await rows(
    'list chat ids',
    supabase.from('viole_chat_members').select('chat_id').eq('user_id', userId)
  );
  return memberships.map((item) => item.chat_id);
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
      read_at: row.read_at || {},
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

async function addChatMember(chatId, userId) {
  const { error } = await supabase
    .from('viole_chat_members')
    .upsert({ chat_id: chatId, user_id: userId }, { onConflict: 'chat_id,user_id' });
  if (error) fail('add chat member', error);
  const { error: touchError } = await supabase
    .from('viole_chats')
    .update({ updated_at: new Date().toISOString() })
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

async function listMessages(chatId, limit = 300) {
  const result = await rows(
    'list messages',
    supabase
      .from('viole_messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
  return result.reverse();
}

async function getMessage(id) {
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

async function getLastMessage(chatId) {
  const result = await rows(
    'get last message',
    supabase
      .from('viole_messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(1)
  );
  return result[0] || null;
}

async function createCall(call) {
  const created = await rows('create call', supabase.from('viole_calls').insert(call).select('*'));
  return created[0];
}

async function getCall(id) {
  return maybeOne('get call', supabase.from('viole_calls').select('*').eq('id', id));
}

async function updateCall(id, patch) {
  const updated = await rows(
    'update call',
    supabase.from('viole_calls').update(patch).eq('id', id).select('*')
  );
  return updated[0];
}

module.exports = {
  addChatMember,
  countUsers,
  createCall,
  createDirectChat,
  createGroupChat,
  createMessage,
  createUser,
  directKey,
  getCall,
  healthCheck,
  getChat,
  getLastMessage,
  getMessage,
  getUserById,
  getUserByUsername,
  getUsersByIds,
  listChatIdsForUser,
  listChatsForUser,
  listMessages,
  markChatRead,
  searchUsers,
  updateCall,
  updateMessageReactions,
  updateUser,
};
