# Security notes

## Reporting

Не публикуйте найденные уязвимости в открытом issue вместе с рабочим exploit или секретами. Передайте владельцу проекта описание, затронутый маршрут/событие и безопасные шаги воспроизведения.

## Secrets

Никогда не коммитьте `.env`, `SESSION_SECRET`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_PASSWORD` или `TURN_SHARED_SECRET`. При утечке немедленно ротируйте соответствующий секрет в Render/Supabase/coturn и отзовите активные сессии очисткой таблицы `viole_sessions`.

## Architecture

Проект использует server-side encryption boundaries, но не E2EE. Profile media находится в публичном bucket. Для нескольких Render-инстансов необходимы Redis-backed Socket.IO adapter, sessions/rate-limit coordination и sticky-session considerations.
