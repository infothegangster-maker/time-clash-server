require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { Redis } = require('@upstash/redis');

// --- 1. CONNECT TO REDIS (Upstash REST API - Perfect for Serverless) ---
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

fastify.register(require('@fastify/cors'), { 
  origin: "*" // Production me isse apni app ke domain/package id pe lock karenge
});

// --- 2. SECURE SESSION STORE ---
const activeSessions = new Map();

// --- API: HEALTH CHECK (For Auto-Scaling) ---
fastify.get('/', async () => {
  return { status: 'Time Clash Server Online', players: activeSessions.size };
});

// --- API: START GAME ---
fastify.post('/start', async (request, reply) => {
  const { userId } = request.body;
  if (!userId) return reply.code(400).send({ error: "UserId required" });

  const startTime = Date.now();
  const sessionToken = `sess_${userId}_${startTime}_${Math.random().toString(36).substr(2)}`;
  
  // LOGIC: Random Target between 1s and 10s (Precise)
  const targetTime = Math.floor(Math.random() * 9000) + 1000; 

  // Store in Memory & Redis
  activeSessions.set(sessionToken, { userId, startTime, targetTime });
  await redis.setex(`playing:${userId}`, 60, "true"); 

  return { sessionToken, message: "Game Started", serverTime: startTime, targetTime };
});

// --- API: STOP GAME (VERIFY & RANK) ---
fastify.post('/stop', async (request, reply) => {
  const { sessionToken } = request.body; // Client time nahi chahiye verification ke liye
  const endTime = Date.now();

  if (!activeSessions.has(sessionToken)) {
    return reply.code(403).send({ error: "Invalid or Expired Token" });
  }

  const session = activeSessions.get(sessionToken);
  const serverDuration = endTime - session.startTime;
  const target = session.targetTime;
  
  // Cleanup
  activeSessions.delete(sessionToken);
  await redis.del(`playing:${session.userId}`);

  // --- EXACT CALCULATION ---
  const diff = Math.abs(serverDuration - target); 
  const win = diff === 0; // EXACT MATCH REQUIRED (As per user request) 

  // --- LEADERBOARD UPDATE (Redis Sorted Set) ---
  // ZADD: Add to leaderboard. Score = Difference (Lower is better)
  await redis.zadd('global_tournament_v1', diff, session.userId);

  // Get My Rank
  const rank = await redis.zrank('global_tournament_v1', session.userId); // 0-based
  const totalPlayers = await redis.zcard('global_tournament_v1');

  // Get Top 3 Players
  const top3 = await redis.zrange('global_tournament_v1', 0, 2, 'WITHSCORES');

  const formattedTop3 = [];
  for(let i=0; i<top3.length; i+=2) {
    formattedTop3.push({ user: top3[i], score: top3[i+1] });
  }

  return {
    success: true,
    serverDuration,
    diff,
    rank: rank + 1,
    totalPlayers,
    topLeaders: formattedTop3,
    win: diff < 50 // < 50ms is WIN
  };
});

// --- API: GET LEADERBOARD ---
fastify.get('/leaderboard', async (request, reply) => {
  const top50 = await redis.zrange('global_tournament_v1', 0, 49, 'WITHSCORES');
  
  const leaderboard = [];
  for (let i = 0; i < top50.length; i += 2) {
    leaderboard.push({
      rank: (i/2) + 1,
      user: top50[i],
      score: top50[i+1] + "ms"
    });
  }
  return { leaderboard };
});

// --- START SERVER ---
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Time Clash Server Running on Port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
