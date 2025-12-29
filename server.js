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

// --- TOURNAMENT HELPERS ---
function getTournamentKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    // Format: tournament_YYYY_MM_DD_HH (e.g., tournament_2024_12_29_14)
    // Uses UTC to ensure global sync
    const key = `tournament_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}_${String(date.getUTCDate()).padStart(2, '0')}_${String(date.getUTCHours()).padStart(2, '0')}`;
    return key;
}

function getTournamentTimeLeft() {
    const now = new Date();
    const minutes = now.getUTCMinutes();
    const seconds = now.getUTCSeconds();

    // Total seconds in an hour
    const totalSecondsInHour = 3600;
    const currentSeconds = (minutes * 60) + seconds;

    const remainingSeconds = totalSecondsInHour - currentSeconds;
    return remainingSeconds * 1000; // Return in ms
}

// --- IN-MEMORY STORES (For Extreme Performance) ---
const gameIntervals = new Map();
const sessionStore = new Map(); // Replaces Redis for hot session data
let cachedTop3 = []; // Cache leaderboard
let lastLeaderboardUpdate = 0; // Timestamp
let currentCachedTournamentId = "";

// Helper: Refresh Leaderboard Cache (Only on Demand)
async function refreshLeaderboardCache() {
    const now = Date.now();
    const currentTournamentId = getTournamentKey(now);

    // Cache valid for 10 seconds AND must be for the same tournament ID
    if (now - lastLeaderboardUpdate < 10000 && currentCachedTournamentId === currentTournamentId) return;

    try {
        // Fetch top 3 from the CURRENT hourly tournament
        const top3 = await redis.zrange(currentTournamentId, 0, 2, 'WITHSCORES');

        const formattedTop3 = [];
        // Handle different return formats
        if (Array.isArray(top3)) {
            if (top3.length > 0 && typeof top3[0] === 'object' && top3[0].member) {
                // Upstash Object format
                for (let item of top3) {
                    formattedTop3.push({ user: item.member, score: item.score });
                }
            } else {
                // Flat array format
                for (let i = 0; i < top3.length; i += 2) {
                    formattedTop3.push({ user: top3[i], score: top3[i + 1] });
                }
            }
        }

        cachedTop3 = formattedTop3;
        lastLeaderboardUpdate = now;
        currentCachedTournamentId = currentTournamentId;
        console.log(`Leaderboard Cache Updated for ${currentTournamentId}`);
    } catch (e) {
        console.error("Leaderboard Cache Error:", e);
    }
}

io.on('connection', (socket) => {
    // console.log('User Connected:', socket.id);

    // 1. INIT GAME -> 'ig'
    socket.on('ig', async (data) => {
        // Refresh Leaderboard Cache (On Demand - Lazy Loading)
        await refreshLeaderboardCache();

        const userId = data.u || socket.id;
        const targetTime = Math.floor(Math.random() * 9000) + 1000;
        const currentTournamentId = getTournamentKey();

        // Fetch Best Score & Rank for CURRENT Tournament
        let bestScore = null;
        let currentRank = null;

        try {
            const [score, rank] = await Promise.all([
                redis.zscore(currentTournamentId, userId),
                redis.zrank(currentTournamentId, userId)
            ]);
            bestScore = score;
            currentRank = rank;
        } catch (e) { console.error(e); }

        bestScore = bestScore ? parseFloat(bestScore) : null;

        // STORE IN MEMORY
        const session = {
            userId,
            targetTime,
            startTime: 0,
            status: 'ready',
            bestScore: bestScore,
            tournamentId: currentTournamentId // Lock user to this tournament ID
        };
        sessionStore.set(socket.id, session);

        // Send Game Ready Data (grd)
        // t: target, b: best, r: rank, tl: timeLeft (ms), tid: tournamentId
        socket.emit('grd', {
            t: targetTime,
            b: bestScore !== null ? bestScore : -1,
            r: currentRank !== null ? currentRank + 1 : -1,
            tl: getTournamentTimeLeft(),
            tid: currentTournamentId
        });
    });

    // 2. START CLOUD TIMER -> 'st'
    socket.on('st', async () => {
        const session = sessionStore.get(socket.id);
        if (!session) return;

        const startTime = Date.now();

        if (gameIntervals.has(socket.id)) clearInterval(gameIntervals.get(socket.id));

        const intervalId = setInterval(() => {
            // const now = Date.now();
            // const elapsed = now - startTime;
            // socket.emit('t', elapsed); // DISABLED TO SAVE BANDWIDTH
        }, 100);

        gameIntervals.set(socket.id, intervalId);

        session.startTime = startTime;
        session.status = 'running';
    });

    // 3. STOP CLOUD TIMER -> 'sp'
    socket.on('sp', async () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }

        const stopTime = Date.now();
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

        // --- TOURNAMENT LOGIC ---
        let newRecord = false;
        let rank = null;
        let bestScore = session.bestScore;

        // Submit to the tournament that is CURRENTLY active
        const currentTournamentId = getTournamentKey(session.startTime); // Use START time to handle hour boundary items

        // ONLY Update Redis if High Score (Lower Diff is Better)
        if (bestScore === null || diff < bestScore) {
            newRecord = true;
            bestScore = diff;
            session.bestScore = bestScore;

            try {
                // UPDATE REDIS
                // Uses 'LT' (Less Than) option if available in newer Redis, 
                // but our manual check above covers it. 
                // We overwrite because we already verified it's better.
                await redis.zadd(currentTournamentId, diff, session.userId);

                // Get Updated Rank
                const rankIndex = await redis.zrank(currentTournamentId, session.userId);
                rank = rankIndex !== null ? rankIndex + 1 : null;
            } catch (e) { console.error(e); }
        } else {
            // Fetch current rank anyway (even if score didn't improve)
            try {
                const rankIndex = await redis.zrank(currentTournamentId, session.userId);
                rank = rankIndex !== null ? rankIndex + 1 : null;
            } catch (e) { }
        }

        // Use Cached Leaderboard
        const optimizedLeaders = cachedTop3.map(p => ({ u: p.user, s: p.score }));

        socket.emit('gr', {
            w: win ? 1 : 0,
            d: diff,
            ft: serverDuration,
            tt: target,
            r: rank,
            bs: bestScore,
            nr: newRecord ? 1 : 0,
            tl: optimizedLeaders,
            tid: currentTournamentId,
            rem: getTournamentTimeLeft() // Send remaining time logic
        });
    });

    socket.on('disconnect', () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        sessionStore.delete(socket.id);
    });
});
