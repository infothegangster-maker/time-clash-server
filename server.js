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
        
        // Save Session in Redis
        await redis.set(`session:${socket.id}`, JSON.stringify({
            userId,
            targetTime,
            startTime: 0,
            status: 'ready'
        }), { ex: 300 });

        // Send Target to Client (Visual Only)
        socket.emit('game_ready', { 
            targetTimeStr: formatTime(targetTime),
            targetTime: targetTime
        });
    });

    // 2. START CLOUD TIMER
    socket.on('start_timer', async () => {
        // Fetch session
        const sessionData = await redis.get(`session:${socket.id}`);
        if (!sessionData) return;
        
        // Update Start Time
        const startTime = Date.now();
        
        // Start Interval (Stream Time to Client)
        if (gameIntervals.has(socket.id)) clearInterval(gameIntervals.get(socket.id));
        
        const intervalId = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            const timeStr = formatTime(elapsed);
            
            // STREAM TIME TO CLIENT
            socket.emit('timer_update', { timeStr, elapsed });
            
        }, 50); // Update every 50ms (20 FPS)
        
        gameIntervals.set(socket.id, intervalId);
        
        // Update Redis
        const session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
        session.startTime = startTime;
        session.status = 'running';
        await redis.set(`session:${socket.id}`, JSON.stringify(session), { ex: 120 });
    });

    // 3. STOP CLOUD TIMER
    socket.on('stop_timer', async () => {
        const stopTime = Date.now();
        
        // KILL INTERVAL IMMEDIATELY (Stop Streaming)
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }

        const sessionData = await redis.get(`session:${socket.id}`);
        if (!sessionData) {
            socket.emit('game_over', { error: "Invalid Session" });
            return;
        }

        const session = (typeof sessionData === 'string') ? JSON.parse(sessionData) : sessionData;
        const serverDuration = stopTime - session.startTime;
        const target = session.targetTime;
        
        // FINAL CALCULATION (Server Authority)
        const diff = Math.abs(serverDuration - target);
        const win = diff === 0;

        // Send Final Result
        socket.emit('game_result', {
            win,
            diff,
            finalTimeStr: formatTime(serverDuration),
            targetTimeStr: formatTime(target)
        });

        // Update Leaderboard
        if (win || diff < 100) {
            await redis.zadd('global_tournament_v1', { score: diff, member: session.userId });
        }
        
        // Send Leaderboard
        const top3 = await redis.zrange('global_tournament_v1', 0, 2, { withScores: true });
        const formattedTop3 = [];
        if (Array.isArray(top3)) {
            for(let item of top3) {
               if(item.member) formattedTop3.push({ user: item.member, score: item.score });
               else formattedTop3.push({ user: 'Player', score: item });
            }
        }
        socket.emit('leaderboard_update', formattedTop3);
    });

    socket.on('disconnect', () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        console.log('User Disconnected:', socket.id);
    });
});
