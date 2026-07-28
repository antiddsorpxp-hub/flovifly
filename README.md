# Team Viole

Mobile-first messenger with username-only registration, persistent JSON storage, realtime messages, presence and 1:1 WebRTC audio/video calls.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000` in two browser profiles, register two users, find each other and start a chat or call.

## Included

- Username/password registration and login, no email or phone
- Password hashing with Node `scrypt`, signed HTTP-only session token
- Atomic JSON persistence for users, chats, messages and call history
- Realtime presence, typing and messages with Socket.IO
- 1:1 WebRTC audio/video, incoming calls, accept/reject/end, ICE signaling
- Browser noise suppression, echo cancellation, auto gain and audio device settings
- Responsive landing, auth and messenger UI
- Dockerfile and Render deployment blueprint

## Production setup

1. Set a long random `JWT_SECRET`.
2. Configure a TURN service in `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. STUN alone will not connect users behind every NAT or corporate firewall.
3. Deploy with persistent disk mounted at `/app/data`. Render is preconfigured in `render.yaml`.
4. Put HTTPS in front of the app. Browsers require a secure context for camera and microphone outside localhost.

JSON persistence is intentionally implemented because it is part of the product brief. It is safe for an MVP on one server with a persistent disk, but not for horizontal scaling. Move the storage adapter to PostgreSQL before running multiple instances.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/me`, `GET /api/users?q=`, `GET /api/chats`
- `POST /api/chats/direct`, `GET /api/chats/:id/messages`
- `GET /api/config`, `GET /api/health`

## WebRTC flow

Socket events: `call:start`, `call:incoming`, `call:accept`, `call:accepted`, `call:signal`, `call:reject`, `call:end`. Media is peer-to-peer; the server only transports signaling and stores call history.
