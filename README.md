# Viole / Flovifly 6.0 — Supabase

Mobile-first мессенджер на Node.js, Express, Socket.IO и WebRTC. В этой версии постоянные данные перенесены с локального `data/db.json` в Supabase:

- пользователи и настройки профиля — таблица `viole_users`;
- личные и групповые чаты — `viole_chats` и `viole_chat_members`;
- сообщения, ответы и реакции — `viole_messages`;
- история звонков — `viole_calls`;
- аватарки и баннеры — публичный bucket `profile-media` в Supabase Storage.

Авторизация сайта остаётся серверной: пароль хешируется через `crypto.scrypt`, а сессия хранится в `HttpOnly` cookie. Секретный ключ Supabase используется только в Node.js и не отправляется в браузер.

## 1. Создайте проект Supabase

Создайте новый проект в Supabase. Затем откройте **SQL Editor**, вставьте содержимое файла [`supabase/schema.sql`](supabase/schema.sql) и запустите скрипт один раз.

Скрипт создаёт таблицы, индексы, серверные SQL-функции и Storage bucket `profile-media`. Для таблиц включён RLS, но доступ `anon` и `authenticated` не выдаётся: данные доступны только вашему Node.js backend через server secret/service-role key.

## 2. Настройте `.env`

```bash
cp .env.example .env
```

Заполните минимум эти значения:

```env
JWT_SECRET=очень-длинная-случайная-строка
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=ваш-серверный-секретный-ключ
SUPABASE_STORAGE_BUCKET=profile-media
```

Ключ берётся в **Supabase Dashboard → Project Settings → API**. Подходит новый secret key вида `sb_secret_...` или legacy `service_role`. Никогда не добавляйте этот ключ в `public/app.js`, HTML или клиентские переменные окружения.

Владелец создаётся только когда задан пароль:

```env
OWNER_USERNAME=flovifly
OWNER_PASSWORD=придумайте-сильный-пароль
```

Хардкоженного пароля в исходниках больше нет. Если `OWNER_PASSWORD` пустой, автоматическое создание владельца пропускается.

## 3. Запустите проект

```bash
npm install
npm run check
npm run dev
```

Откройте `http://localhost:3000`. Эндпоинт `GET /api/health` дополнительно проверяет подключение к Supabase.

## Перенос старого `data/db.json`

Если у вас уже есть пользователи, сообщения и локальные изображения из предыдущей версии, сначала сохраните резервную копию папки `data`, затем выполните:

```bash
npm run migrate:supabase
```

Скрипт переносит записи в новые таблицы и загружает файлы из `data/uploads` в Supabase Storage. Он использует upsert, поэтому его можно повторить после исправления ошибки. После миграции проверьте вход, список чатов, сообщения и изображения, прежде чем удалять локальную резервную копию.

## Деплой на Render

`render.yaml` уже содержит названия нужных переменных. В Render добавьте значения `SUPABASE_URL`, `SUPABASE_SECRET_KEY` и при необходимости `OWNER_PASSWORD`. Постоянный диск больше не нужен, потому что данные и изображения находятся в Supabase.

Для звонков в production по-прежнему нужны HTTPS и TURN-сервер:

```env
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=
```

## Важные ограничения архитектуры

- Realtime сообщений по-прежнему работает через Socket.IO на вашем Node.js сервере; Supabase используется как постоянное хранилище.
- При нескольких Node.js-инстансах понадобится общий Socket.IO adapter, например Redis, чтобы события между инстансами синхронизировались.
- Bucket `profile-media` публичный: любой, у кого есть URL изображения, сможет его открыть. Загружать и удалять файлы может только backend с секретным ключом.

Официальная документация:

- https://supabase.com/docs/reference/javascript/initializing
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/storage/uploads/standard-uploads
- https://supabase.com/docs/reference/javascript/file-buckets-getpublicurl
