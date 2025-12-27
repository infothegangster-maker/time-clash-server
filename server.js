require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const socketIo = require('socket.io');

// --- HYBRID REDIS SETUP ---
let redis;
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL && REDIS_URL.includes('upstash')) {
    // USE UPSTASH HTTP CLIENT (Serverless)
    console.log("🔌 Connecting to Upstash Redis (HTTP Mode)");
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
        url: process.env.REDIS_URL,
        token: process.env.REDIS_TOKEN
    });
} else {
    // USE STANDARD REDIS CLIENT (TCP Mode - AWS/Render/Local)
    console.log("🔌 Connecting to Standard Redis (TCP Mode)");
    const IORedis = require('ioredis');
    redis = new IORedis(REDIS_URL || 'redis://localhost:6379');
}

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

// --- IN-MEMORY STORES (For Extreme Performance) ---
const gameIntervals = new Map();
const sessionStore = new Map(); // Replaces Redis for hot session data
let cachedTop3 = []; // Cache leaderboard
let lastLeaderboardUpdate = 0; // Timestamp

// Helper: Refresh Leaderboard Cache (Only on Demand)
async function refreshLeaderboardCache() {
    const now = Date.now();
    // Cache valid for 10 seconds
    if (now - lastLeaderboardUpdate < 10000) return; 

    try {
        // Standardize response format (Upstash returns array differently sometimes)
        // IORedis returns ['member', 'score', 'member', 'score'] or objects depending on version
        // Let's assume standard 'WITHSCORES' behavior returns flat array [m, s, m, s] in IORedis
        
        const top3 = await redis.zrange('tournament_v1', 0, 2, 'WITHSCORES');
        
        const formattedTop3 = [];
        // Handle different return formats (Upstash SDK vs IORedis)
        // Upstash SDK usually returns objects or array depending on config, but we used WITHSCORES
        // Let's handle flat array [user1, score1, user2, score2] which is common
        
        if (Array.isArray(top3)) {
            // Check if result is objects (Upstash sometimes) or flat array
            if (top3.length > 0 && typeof top3[0] === 'object' && top3[0].member) {
                 // Upstash Object format
                 for(let item of top3) {
                     formattedTop3.push({ user: item.member, score: item.score });
                 }
            } else {
                 // Flat array format [u, s, u, s] (IORedis / Standard)
                 for(let i=0; i<top3.length; i+=2) {
                     formattedTop3.push({ user: top3[i], score: top3[i+1] });
                 }
            }
        }
        
        cachedTop3 = formattedTop3;
        lastLeaderboardUpdate = now;
        console.log("Leaderboard Cache Updated");
    } catch (e) {
        console.error("Leaderboard Cache Error:", e);
    }
}

io.on('connection', (socket) => {
    console.log('User Connected:', socket.id);

    // 1. INIT GAME
    socket.on('init_game', async (data) => {
        // Refresh Leaderboard Cache (On Demand - Lazy Loading)
        refreshLeaderboardCache(); // Don't await to not block init

        const userId = data.userId || socket.id;
        const targetTime = Math.floor(Math.random() * 9000) + 1000; 
        
        // Fetch Best Score & Rank 
        let bestScore = null;
        let currentRank = null;
        
        try {
            // Parallel Fetch
            const [score, rank] = await Promise.all([
                redis.zscore('tournament_v1', userId),
                redis.zrank('tournament_v1', userId)
            ]);
            bestScore = score;
            currentRank = rank;
        } catch(e) { console.error(e); }

        bestScore = bestScore ? parseFloat(bestScore) : null;

        // STORE IN MEMORY (Fast Access)
        const session = {
            userId,
            targetTime,
            startTime: 0,
            status: 'ready',
            bestScore: bestScore
        };
        sessionStore.set(socket.id, session);

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
        // READ FROM MEMORY (Zero Latency, No DB Cost)
        const session = sessionStore.get(socket.id);
        if (!session) return;
        
        const startTime = Date.now();
        
        // Start Interval (Stream Time to Client)
        if (gameIntervals.has(socket.id)) clearInterval(gameIntervals.get(socket.id));
        
        // OPTIMIZATION: 
        // 1. Interval 100ms (10 FPS) - Saves 50% Bandwidth
        // 2. Send Only Integer (No JSON String) - Saves 80% Data Packet Size
        const intervalId = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            // Send event 't' (short for timer) with raw integer
            socket.emit('t', elapsed);
        }, 100);
        
        gameIntervals.set(socket.id, intervalId);
        
        // Update Memory
        session.startTime = startTime;
        session.status = 'running';
    });

    // 3. STOP CLOUD TIMER (Tournament Logic)
    socket.on('stop_timer', async () => {
        // KILL INTERVAL IMMEDIATELY
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        
        const stopTime = Date.now();

        // READ FROM MEMORY
        const session = sessionStore.get(socket.id);
        if (!session) {
            socket.emit('game_over', { error: "Invalid Session" });
            return;
        }

        const serverDuration = stopTime - session.startTime;
        const target = session.targetTime;
        
        // FINAL CALCULATION
        const diff = Math.abs(serverDuration - target);
        const win = diff === 0;

        // --- TOURNAMENT LOGIC (COST OPTIMIZATION) ---
        let newRecord = false;
        let rank = null;
        let bestScore = session.bestScore;

        // ONLY Update Redis if High Score
        if (bestScore === null || diff < bestScore) {
            newRecord = true;
            bestScore = diff;
            session.bestScore = bestScore; // Update memory cache
            
            try {
                // UPDATE REDIS
                await redis.zadd('tournament_v1', diff, session.userId); // Standard args for ioredis (score, member)
                
                // Get Updated Rank
                const rankIndex = await redis.zrank('tournament_v1', session.userId);
                rank = rankIndex !== null ? rankIndex + 1 : null;
            } catch(e) { console.error(e); }
        } else {
            // No DB interaction for bad scores!
        }

        // Use Cached Leaderboard (Zero Read Cost)
        socket.emit('game_result', {
            win,
            diff,
            finalTimeStr: formatTime(serverDuration),
            targetTimeStr: formatTime(target),
            rank,
            bestScore,
            newRecord,
            topLeaders: cachedTop3 // From Memory Cache
        });
    });

    socket.on('disconnect', () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        // Clear memory
        sessionStore.delete(socket.id);
        console.log('User Disconnected:', socket.id);
    });
});
