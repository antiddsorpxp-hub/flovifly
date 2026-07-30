# Viole / Flovifly 6.1 — Render + Supabase

Сайт и Node.js-сервер разворачиваются на **Render**. Supabase используется только как внешняя PostgreSQL-база данных и Storage для аватарок/баннеров.

```text
Браузер → Render (Express + Socket.IO + WebRTC) → Supabase (Postgres + Storage)
```

## Что хранится в Supabase

- `viole_users` — пользователи и настройки профиля;
- `viole_chats`, `viole_chat_members` — личные и групповые чаты;
- `viole_messages` — сообщения, ответы и реакции;
- `viole_calls` — история звонков;
- `viole_sessions` — отзываемые серверные сессии;
- `viole_storage_cleanup` — очередь повторного удаления старых файлов;
- bucket `profile-media` — аватарки и баннеры.

## Обязательное обновление Supabase

Откройте **Supabase Dashboard → SQL Editor → New query**. Откройте локальный файл `supabase/schema.sql`, скопируйте **всё его содержимое**, вставьте в редактор и нажмите **Run**.

Не вставляйте в SQL Editor строку `supabase/schema.sql`: это путь к файлу, а не SQL-команда.

Скрипт можно выполнить повторно поверх предыдущей версии. Он добавит таблицы сессий и очереди очистки, обновит SQL-функции и сохранит существующие данные.

## Переменные Render

В **Render Dashboard → ваш Web Service → Environment** задайте:

```env
SESSION_SECRET=случайная_строка_минимум_32_байта
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_STORAGE_BUCKET=profile-media

OWNER_USERNAME=flovifly
OWNER_PASSWORD=сильный_пароль
PREMIUM_BETA_ENABLED=true
```

Секрет можно создать командой:

```bash
openssl rand -hex 32
```

Старое имя `JWT_SECRET` поддерживается для совместимости, но для новой установки используйте `SESSION_SECRET`. После перехода на серверные сессии старые cookies перестанут действовать, поэтому пользователям потребуется войти заново.

Render автоматически предоставляет `RENDER_EXTERNAL_URL`. Для жёсткой фиксации домена можно дополнительно задать:

```env
APP_ORIGIN=https://ваш-сервис.onrender.com
```

Для собственного домена укажите его вместо адреса Render.

## TURN для WebRTC

`/api/config` теперь доступен только после входа и выдаёт краткоживущие TURN-реквизиты. Нужен coturn с REST API/shared-secret режимом:

```env
TURN_URL=turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=общий_секрет_coturn
TURN_TTL_SECONDS=3600
```

Постоянные `TURN_USERNAME` и `TURN_CREDENTIAL` больше не отправляются клиенту. Если `TURN_SHARED_SECRET` не задан, сервер вернёт только STUN.

## Деплой на Render

1. Загрузите файлы проекта в GitHub.
2. Выполните обновлённый `supabase/schema.sql` в Supabase.
3. Добавьте переменные окружения Render.
4. Выберите **Manual Deploy → Clear build cache & deploy**.
5. Проверьте `https://ваш-домен/api/health`.

Docker использует Node.js 22, устанавливает production-зависимости и запускает процесс от пользователя `node`, а не от root.

## Локальный запуск

```bash
cp .env.example .env
npm install
npm run check
npm run dev
```

Откройте `http://localhost:3000`.

## Перенос старого `data/db.json`

После настройки Supabase:

```bash
npm run migrate:supabase
```

Миграция повторно декодирует и нормализует локальные изображения перед загрузкой. Сохраните резервную копию `data` до проверки результата.

## Изменения безопасности в 6.1

- приложение не запускается в production без длинного `SESSION_SECRET`;
- вместо 30-дневного самоподписанного токена используются отзываемые сессии в Supabase;
- logout отзывает сессию и закрывает связанные Socket.IO-подключения;
- `/api/config` требует авторизацию и использует временные TURN credentials;
- добавлены origin checks, CSP, HSTS, защита от clickjacking и `no-store` для API;
- `presence:query` валидируется и показывает статус только участникам общих чатов;
- realtime-события имеют схемы, ограничения размера и rate limits;
- реакции ограничены фиксированным набором emoji;
- приглашать в группу может только владелец; новый участник не видит сообщения до `joined_at`;
- изображения реально декодируются, ограничиваются по пикселям/кадрам, перекодируются и очищаются от метаданных;
- парольные хеши читаются только в login-пути;
- `.dockerignore` исключает `.env`, локальные данные, Git и логи из Docker context.

## Важные ограничения

- Сообщения хранятся на сервере в открытом для backend виде. Это **не end-to-end encryption**. Render backend и обладатель Supabase secret/service-role key технически могут читать переписку.
- Bucket профилей публичный: любой обладатель URL изображения может его открыть. Для приватных вложений нужен отдельный private bucket и signed URLs.
- Rate limits и карта Socket.IO находятся в памяти одного Render-инстанса. Перед горизонтальным масштабированием нужен Redis/общий adapter и общий limiter store.
- В архиве зависимости закреплены точными верхнеуровневыми версиями, но `package-lock.json` не сгенерирован. Перед долгосрочным production-релизом выполните `npm install` в нормальном npm-окружении и закоммитьте созданный lockfile; после этого замените Docker-команду на `npm ci --omit=dev`.
