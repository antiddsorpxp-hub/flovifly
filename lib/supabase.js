const { createClient } = require('@supabase/supabase-js');

const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const key = String(
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();
const storageBucket = String(process.env.SUPABASE_STORAGE_BUCKET || 'profile-media').trim();

if (!url || !key) {
  throw new Error(
    'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).'
  );
}
if (process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
  throw new Error('SUPABASE_URL must use HTTPS in production.');
}
if (key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) {
  throw new Error('Use a server-only Supabase secret/service-role key, not a publishable or anon key.');
}
if (!/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(storageBucket)) {
  throw new Error('SUPABASE_STORAGE_BUCKET contains invalid characters.');
}

const supabase = createClient(url, key, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  db: { schema: 'public' },
  global: {
    headers: { 'X-Client-Info': 'viole-render-backend/6.1.0' },
  },
});

module.exports = { supabase, storageBucket };
