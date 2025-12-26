require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const socketIo = require('socket.io');
const { Redis } = require('@upstash/redis');

// --- REDIS SETUP ---
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

// --- FASTIFY SETUP ---
fastify.register(require('@fastify/cors'), { origin: "*" });

fastify.get('/', async () => {
  return { status: 'Time Clash Socket Server Online' };
});

// --- START SERVER FIRST ---
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Server Running on Port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();

// --- SOCKET.IO SETUP (THE CLOUD TIMER ENGINE) ---
const io = socketIo(fastify.server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Helper: Format Time (SS:MMM)
function formatTime(ms) {
    if (ms < 0) ms = 0;
    const seconds = Math.floor(ms / 1000); 
    const milliseconds = Math.floor(ms % 1000);
    return `${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
}

// Store active game intervals
const gameIntervals = new Map();

io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

            // 1. INIT GAME
    socket.on('init_game', async (data) => {
        const userId = data.userId || socket.id;
        const targetTime = Math.floor(Math.random() * 9000) + 1000; 
        
        // Fetch User's Best Score & Rank from Tournament Leaderboard
        const bestScoreStr = await redis.zscore('tournament_v1', userId);
        const currentRank = await redis.zrank('tournament_v1', userId);
        
        const bestScore = bestScoreStr ? parseFloat(bestScoreStr) : null;

        // Save Session in Redis
        await redis.set(`session:${socket.id}`, JSON.stringify({
            userId,
            targetTime,
            startTime: 0,
            status: 'ready',
            bestScore: bestScore // Cache best score in session
        }), { ex: 300 });

        // Send Target + Current Rank/Best to Client
        socket.emit('game_ready', { 
            targetTimeStr: formatTime(targetTime),
            targetTime: targetTime,
            bestScore: bestScore !== null ? bestScore : "NA",
            rank: currentRank !== null ? currentRank + 1 : "UNRANKED"
        });
    });

    // 2. START CLOUD TIMER
    socket.on('start_timer', async () => {
        // ... (Same logic, simple start update)
        const sessionData = await redis.get(`session:${socket.id}`);
        if (!sessionData) return;
        
        const startTime = Date.now();
        
        // Start Interval (Stream Time)
        if (gameIntervals.has(socket.id)) clearInterval(gameIntervals.get(socket.id));
        
        const intervalId = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            const timeStr = formatTime(elapsed);
            socket.emit('timer_update', { timeStr, elapsed });
        }, 50);
        
        gameIntervals.set(socket.id, intervalId);
        
        // Update Redis Session
        const session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
        session.startTime = startTime;
        session.status = 'running';
        await redis.set(`session:${socket.id}`, JSON.stringify(session), { ex: 120 });
    });

    // 3. STOP CLOUD TIMER (Tournament Logic)
    socket.on('stop_timer', async () => {
        // KILL INTERVAL IMMEDIATELY
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        
        const stopTime = Date.now();

        const sessionData = await redis.get(`session:${socket.id}`);
        if (!sessionData) {
            socket.emit('game_over', { error: "Invalid Session" });
            return;
        }

        const session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
        const serverDuration = stopTime - session.startTime;
        const target = session.targetTime;
        
        // FINAL CALCULATION
        const diff = Math.abs(serverDuration - target);
        const win = diff === 0;

        // --- TOURNAMENT LOGIC (COST OPTIMIZATION) ---
        let newRecord = false;
        let rank = null;
        let bestScore = session.bestScore;

        // Only update DB if:
        // 1. No previous best score (First time playing)
        // 2. New diff is BETTER (lower) than previous best
        if (bestScore === null || diff < bestScore) {
            newRecord = true;
            bestScore = diff;
            
            // UPDATE REDIS (Only on High Score)
            await redis.zadd('tournament_v1', { score: diff, member: session.userId });
            
            // Get Updated Rank
            const rankIndex = await redis.zrank('tournament_v1', session.userId);
            rank = rankIndex !== null ? rankIndex + 1 : null;
        } else {
            // Bad score - Just get previous rank (No DB Write)
            // Ideally we cache rank too, but for accuracy we can read rank (Read is cheap)
            const rankIndex = await redis.zrank('tournament_v1', session.userId);
            rank = rankIndex !== null ? rankIndex + 1 : null;
        }

        // Get Top 3 for Leaderboard Display
        const top3 = await redis.zrange('tournament_v1', 0, 2, { withScores: true });
        const formattedTop3 = [];
        if (Array.isArray(top3)) {
            for(let item of top3) {
               if(item.member) formattedTop3.push({ user: item.member, score: item.score });
               else formattedTop3.push({ user: 'Player', score: item });
            }
        }

        socket.emit('game_result', {
            win,
            diff,
            finalTimeStr: formatTime(serverDuration),
            targetTimeStr: formatTime(target),
            rank,
            bestScore,
            newRecord, // Tell client if this was a high score
            topLeaders: formattedTop3
        });
    });

    socket.on('disconnect', () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        console.log('User Disconnected:', socket.id);
    });
});
