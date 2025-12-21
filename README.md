# Time Clash Game Server

Production-grade Node.js backend for Time Clash precision timing game.

## Features
- ⚡ Ultra-fast API using Fastify
- 🔒 Server-side game logic (Anti-cheat)
- 📊 Real-time leaderboard with Redis
- 🚀 Scalable to 1M+ users

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
REDIS_URL=redis://localhost:6379
PORT=3000
```

3. Run server:
```bash
npm start
```

## Deployment

Recommended: Render.com with Redis addon

1. Connect GitHub repo to Render
2. Add Redis database
3. Set `REDIS_URL` environment variable
4. Deploy!

## API Endpoints

- `POST /start` - Start game session
- `POST /stop` - Verify and rank
- `GET /leaderboard` - Get top players

