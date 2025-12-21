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

// --- API: INIT GAME (Pre-fetch Target & Token) ---
fastify.post('/init-game', async (request, reply) => {
  const { userId } = request.body;
  if (!userId) return reply.code(400).send({ error: "UserId required" });

  const targetTime = Math.floor(Math.random() * 9000) + 1000; 
  const sessionToken = `sess_${userId}_${Date.now()}_${Math.random().toString(36).substr(2)}`;
  
  // Create session but don't start time yet
  await redis.set(`session:${sessionToken}`, JSON.stringify({ 
    userId, 
    startTime: 0, // Will be set later
    targetTime,
    status: 'ready'
  }), { ex: 300 }); // 5 mins expiry

  return { sessionToken, targetTime };
});

// --- API: START TIMER (Background Sync) ---
fastify.post('/start-timer', async (request, reply) => {
  const { sessionToken } = request.body;
  
  const sessionData = await redis.get(`session:${sessionToken}`);
  if (!sessionData) return reply.code(403).send({ error: "Invalid Session" });
  
  let session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
  
  // Set Server Start Time NOW
  session.startTime = Date.now();
  session.status = 'running';
  
  await redis.set(`session:${sessionToken}`, JSON.stringify(session), { ex: 120 });
  
  return { success: true, serverStartTime: session.startTime };
});

// --- API: STOP GAME (SECURE SERVER VERIFICATION) ---
fastify.post('/stop', async (request, reply) => {
  const { sessionToken, clientTime } = request.body; 
  const endTime = Date.now();
  
  // GET SESSION
  const sessionData = await redis.get(`session:${sessionToken}`);
  if (!sessionData) return reply.code(403).send({ error: "Invalid Session" });
  
  let session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
  const target = session.targetTime;
  
  // --- SERVER SIDE SECURITY CHECK ---
  // Server calculates how much time actually passed
  const serverDuration = endTime - session.startTime;
  
  // Lag Calculation: Server Time hamesha Client Time se thoda zyada hoga (Network Delay)
  // Example: Client ne 5s pe roka, Server tak pahunchte pahunchte 5.2s ho gaya.
  // Diff = 200ms (Valid).
  // Agar Client bole 5s, par Server pe 10s ho gaya -> CHEAT!
  
  const lag = serverDuration - clientTime;
  
  // ALLOWED LAG LIMIT: 2000ms (2 Seconds for bad internet)
  // Agar 2 second se zyada ka jhoot bola -> CHEAT DETECTED
  if (Math.abs(lag) > 2000) {
      console.log(`CHEAT DETECTED: User:${session.userId} Client:${clientTime} Server:${serverDuration}`);
      return reply.code(400).send({ error: "Cheat Detected! Time mismatch." });
  }

  // --- APPROVED! DO CALCULATION ON SERVER ---
  // Ab hum ClientTime use karenge Calculation ke liye kyuki Server ne Verify kar liya hai ki ye time sahi range me hai.
  const diff = Math.abs(clientTime - target); 
  const win = diff === 0; // EXACT MATCH

  // Cleanup ONLY IF WIN
  if (win) {
      await redis.del(`session:${sessionToken}`);
      await redis.del(`playing:${session.userId}`);
  }

  // Update Leaderboard
  if (win || diff < 100) {
      await redis.zadd('global_tournament_v1', { score: diff, member: session.userId });
  }
  
  const rank = await redis.zrank('global_tournament_v1', session.userId);
  const totalPlayers = await redis.zcard('global_tournament_v1');
  
  return {
    success: true,
    diff,
    win,
    rank: rank + 1,
    totalPlayers,
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
