require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { Redis } = require('@upstash/redis');

// --- 1. CONNECT TO REDIS (Upstash REST API) ---
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

fastify.register(require('@fastify/cors'), { 
  origin: "*" 
});

// --- API: HEALTH CHECK ---
fastify.get('/', async () => {
  return { status: 'Time Clash Server Online' };
});

// --- API: START GAME ---
fastify.post('/start', async (request, reply) => {
  const { userId } = request.body;
  if (!userId) return reply.code(400).send({ error: "UserId required" });

  const startTime = Date.now();
  // RANDOM TARGET: 1.000s to 9.999s
  const targetTime = Math.floor(Math.random() * 9000) + 1000; 
  
  const sessionToken = `sess_${userId}_${startTime}_${Math.random().toString(36).substr(2)}`;
  
  // SAVE FULL SESSION IN REDIS (Safe from restarts)
  // Expire in 120 seconds (2 mins)
  // NOTE: Upstash Redis uses { ex: seconds } option
  await redis.set(`session:${sessionToken}`, JSON.stringify({ 
    userId, 
    startTime, 
    targetTime 
  }), { ex: 120 });

  // Also lock user to prevent multiple games
  await redis.set(`playing:${userId}`, "true", { ex: 60 }); 

  return { sessionToken, message: "Game Started", serverTime: startTime, targetTime };
});

// --- API: STOP GAME (VERIFY & RANK) ---
fastify.post('/stop', async (request, reply) => {
  const { sessionToken } = request.body; 
  const endTime = Date.now();

  // GET SESSION FROM REDIS
  const sessionData = await redis.get(`session:${sessionToken}`);

  if (!sessionData) {
    // Session not found means expired or invalid token
    return reply.code(403).send({ error: "Session Expired or Invalid" });
  }

  // Upstash Redis returns object directly if JSON, or we might need to handle it.
  // Usually Upstash auto-parses JSON if stored as JSON. 
  // But we stored stringified JSON, so we might need to parse, or Upstash might have returned it as object already if it detected JSON.
  // Let's assume it returns what we stored. If we stored string, it returns string.
  
  let session;
  try {
      session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
  } catch(e) {
      session = sessionData;
  }

  const serverDuration = endTime - session.startTime;
  const target = session.targetTime;
  
  // Cleanup
  await redis.del(`session:${sessionToken}`);
  await redis.del(`playing:${session.userId}`);

  // --- EXACT CALCULATION ---
  const diff = Math.abs(serverDuration - target); 
  const win = diff === 0; // EXACT MATCH

  // --- LEADERBOARD UPDATE ---
  await redis.zadd('global_tournament_v1', { score: diff, member: session.userId });
  
  const rank = await redis.zrank('global_tournament_v1', session.userId);
  const totalPlayers = await redis.zcard('global_tournament_v1');
  const top3 = await redis.zrange('global_tournament_v1', 0, 2, { withScores: true });
  
  // Format top 3 (Upstash returns [{member: '...', score: ...}, ...])
  const formattedTop3 = [];
  // top3 from Upstash is Array of objects or Array of strings depending on client version.
  // @upstash/redis typically returns: [ { member: '...', score: ... } ] if withScores: true
  
  if (Array.isArray(top3)) {
      for(let item of top3) {
         if(item.member) formattedTop3.push({ user: item.member, score: item.score });
         else formattedTop3.push({ user: 'Player', score: item }); // Fallback
      }
  }

  return {
    success: true,
    serverDuration,
    diff,
    rank: rank + 1,
    totalPlayers,
    topLeaders: formattedTop3,
    win,
    targetTime: target 
  };
});

// --- API: GET LEADERBOARD ---
fastify.get('/leaderboard', async (request, reply) => {
  const top50 = await redis.zrange('global_tournament_v1', 0, 49, { withScores: true });
  
  const leaderboard = [];
  if (Array.isArray(top50)) {
      top50.forEach((item, index) => {
           leaderboard.push({
              rank: index + 1,
              user: item.member,
              score: item.score + "ms"
           });
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
