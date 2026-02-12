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
// Tournament runs every 15 minutes: 12 minutes play + 3 minutes winner/leaderboard
const TOURNAMENT_DURATION_MS = 15 * 60 * 1000; // 15 minutes total
const PLAY_TIME_MS = 12 * 60 * 1000; // 12 minutes play time
const LEADERBOARD_TIME_MS = 3 * 60 * 1000; // 3 minutes winner/leaderboard time

function getTournamentKey(timestamp = Date.now()) {
    // Calculate which 15-minute interval we're in
    const intervalStart = Math.floor(timestamp / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS;
    const date = new Date(intervalStart);
    // Format: tournament_YYYY_MM_DD_HH_MM (includes minute for 15-min intervals)
    const key = `tournament_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, '0')}_${String(date.getUTCDate()).padStart(2, '0')}_${String(date.getUTCHours()).padStart(2, '0')}_${String(date.getUTCMinutes()).padStart(2, '0')}`;
    return key;
}

function getTournamentTimeLeft() {
    const now = Date.now();
    // Find the start of current 15-minute interval
    const intervalStart = Math.floor(now / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS;
    const elapsed = now - intervalStart;
    
    // If we're in winner/leaderboard time (last 3 minutes), return 0
    if (elapsed >= PLAY_TIME_MS) {
        return 0; // Tournament ended, winner/leaderboard time
    }
    
    // Return remaining play time
    const remaining = PLAY_TIME_MS - elapsed;
    return remaining; // Return in ms
}

// --- IN-MEMORY STORES (For Extreme Performance) ---
const gameIntervals = new Map();
const sessionStore = new Map(); // Replaces Redis for hot session data
const activeUsers = new Map(); // Track active users: socketId -> {userId, email, username, connectedAt, lastActivity}
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
        // Fetch top 3 from the CURRENT tournament
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

// --- FIREBASE ADMIN SETUP (SECURITY) ---
// --- FIREBASE ADMIN SETUP (SECURITY) ---
const admin = require('firebase-admin');
let isSecureMode = false;

try {
    let serviceAccount;

    // 1. Try Environment Variable (For Production/Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.log("🔑 reading service account from Environment Variable...");
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    // 2. Try Local File (For Local Dev)
    else {
        serviceAccount = require('./serviceAccountKey.json');
    }

    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        isSecureMode = true;
        console.log("🔒 SECURE MODE: Enabled (Firebase Admin Ready)");
    }
} catch (e) {
    console.log("⚠️ INSECURE MODE: Service Account missing or invalid.");
    console.log("   Detailed Error:", e.message);
    // console.log("   Tip: Add FIREBASE_SERVICE_ACCOUNT env var in Render Dashboard");
}

// --- RATE LIMITING (SECURITY PHASE 3) ---
const RATE_LIMITS = {
    'ig': { max: 10, window: 60 * 1000 },    // 10 Games per minute
    'st': { max: 5, window: 10 * 1000 },     // 5 Starts per 10 seconds (Prevents rapid retries)
    'sp': { max: 10, window: 20 * 1000 },    // 10 Stops per 20 seconds
    'default': { max: 20, window: 1000 }     // 20 Packets per second (General DOS)
};

const requestCounts = new Map(); // Key: socket.id + event

function checkRateLimit(socket, event) {
    const key = `${socket.id}:${event}`;
    const limit = RATE_LIMITS[event] || RATE_LIMITS['default'];
    const now = Date.now();

    if (!requestCounts.has(key)) {
        requestCounts.set(key, []);
    }

    const timestamps = requestCounts.get(key);

    // Remove old timestamps outside the window
    const newTimestamps = timestamps.filter(t => now - t < limit.window);

    if (newTimestamps.length >= limit.max) {
        return false; // Rate limit exceeded
    }

    newTimestamps.push(now);
    requestCounts.set(key, newTimestamps);
    return true;
}

// Cleanup Interval (Every 5 mins clear old memory)
setInterval(() => {
    requestCounts.clear();
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
    // console.log('User Connected:', socket.id);

    // 1. INIT GAME -> 'ig'
    // --- TOURNAMENT MANAGEMENT ---
    let currentTournamentKey = getTournamentKey();

    // Check for Tournament End Every 10 Seconds
    setInterval(() => {
        const newKey = getTournamentKey();
        if (newKey !== currentTournamentKey) {
            endTournament(currentTournamentKey);
            currentTournamentKey = newKey;
        }
    }, 10000);

    async function endTournament(oldKey) {
        console.log(`🏁 Ending Tournament: ${oldKey}`);
        try {
            // 1. Get Top 3 Winners
            const top3 = await redis.zrange(oldKey, 0, 2, 'WITHSCORES');

            // Format Winners
            const winners = [];
            if (Array.isArray(top3)) {
                // Handle Redis Format differences (Array vs Object)
                if (top3.length > 0 && typeof top3[0] === 'object') {
                    // Upstash/Object
                    top3.forEach(x => winners.push({ u: x.member, s: x.score }));
                } else {
                    // Flat Array
                    for (let i = 0; i < top3.length; i += 2) {
                        winners.push({ u: top3[i], s: top3[i + 1] });
                    }
                }
            }

            // 2. Archive to History
            const archive = {
                id: oldKey,
                ts: Date.now(),
                winners: winners
            };

            // Push to History List (Keep last 10)
            await redis.lpush('tournament_history', JSON.stringify(archive));
            await redis.ltrim('tournament_history', 0, 9);

            // 3. Broadcast End Event
            io.emit('tou_end', {
                id: oldKey,
                winners: winners
            });

            console.log(`✅ Tournament Archived & Broadcasted`);

        } catch (e) {
            console.error("Error Ending Tournament:", e);
        }
    }

    // 4. API: Get Tournament Data (History + Status)
    // Used by Tournament Page
    fastify.get('/api/tournament-data', async (req, reply) => {
        try {
            const historyRaw = await redis.lrange('tournament_history', 0, 9);
            const history = historyRaw.map(x => JSON.parse(x));
            const timeLeft = getTournamentTimeLeft();

            return {
                currentId: currentTournamentKey,
                timeLeft: timeLeft,
                history: history
            };
        } catch (e) {
            console.error(e);
            return { error: "Failed to fetch data" };
        }
    });

    // --- ADMIN API ENDPOINTS ---
    // Admin: Get Active Users
    fastify.get('/api/admin/active-users', async (req, reply) => {
        try {
            const users = Array.from(activeUsers.values()).map(u => ({
                userId: u.userId,
                email: u.email || 'N/A',
                username: u.username || 'Guest',
                connectedAt: u.connectedAt,
                lastActivity: u.lastActivity,
                socketId: u.socketId
            }));
            return { count: users.length, users };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get Current Tournament Details
    fastify.get('/api/admin/current-tournament', async (req, reply) => {
        try {
            const currentTournamentId = getTournamentKey();
            const allParticipants = await redis.zrange(currentTournamentId, 0, -1, 'WITHSCORES');
            
            const participants = [];
            if (Array.isArray(allParticipants)) {
                if (allParticipants.length > 0 && typeof allParticipants[0] === 'object') {
                    allParticipants.forEach(p => {
                        participants.push({ userId: p.member, score: p.score });
                    });
                } else {
                    for (let i = 0; i < allParticipants.length; i += 2) {
                        participants.push({ userId: allParticipants[i], score: allParticipants[i + 1] });
                    }
                }
            }

            // Get user emails from active users or session store
            const participantsWithDetails = participants.map(p => {
                const activeUser = Array.from(activeUsers.values()).find(u => u.userId === p.userId);
                const session = Array.from(sessionStore.values()).find(s => s.userId === p.userId);
                return {
                    userId: p.userId,
                    score: p.score,
                    email: activeUser?.email || session?.email || 'N/A',
                    username: activeUser?.username || session?.username || 'Guest'
                };
            });

            return {
                tournamentId: currentTournamentId,
                participantCount: participants.length,
                participants: participantsWithDetails.sort((a, b) => a.score - b.score),
                timeLeft: getTournamentTimeLeft(),
                playTimeLeft: Math.max(0, PLAY_TIME_MS - (Date.now() - Math.floor(Date.now() / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS))
            };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get Tournament History with Full Details
    fastify.get('/api/admin/tournament-history', async (req, reply) => {
        try {
            const historyRaw = await redis.lrange('tournament_history', 0, 49);
            const history = historyRaw.map(x => JSON.parse(x));
            
            // Get full participant list for each tournament
            const historyWithDetails = await Promise.all(history.map(async (tournament) => {
                try {
                    const allParticipants = await redis.zrange(tournament.id, 0, -1, 'WITHSCORES');
                    const participants = [];
                    if (Array.isArray(allParticipants)) {
                        if (allParticipants.length > 0 && typeof allParticipants[0] === 'object') {
                            allParticipants.forEach(p => {
                                participants.push({ userId: p.member, score: p.score });
                            });
                        } else {
                            for (let i = 0; i < allParticipants.length; i += 2) {
                                participants.push({ userId: allParticipants[i], score: allParticipants[i + 1] });
                            }
                        }
                    }
                    return {
                        ...tournament,
                        participantCount: participants.length,
                        allParticipants: participants.sort((a, b) => a.score - b.score)
                    };
                } catch (e) {
                    return { ...tournament, participantCount: 0, allParticipants: [] };
                }
            }));

            return { history: historyWithDetails };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get System Stats
    fastify.get('/api/admin/system-stats', async (req, reply) => {
        try {
            const activeCount = activeUsers.size;
            const sessionCount = sessionStore.size;
            const runningGames = gameIntervals.size;
            const currentTournamentId = getTournamentKey();
            
            // Get Redis stats
            const tournamentKeys = await redis.keys('tournament_*');
            const totalTournaments = tournamentKeys.filter(k => !k.includes('_target') && !k.includes('history')).length;

            return {
                activeUsers: activeCount,
                activeSessions: sessionCount,
                runningGames: runningGames,
                currentTournament: currentTournamentId,
                totalTournaments: totalTournaments,
                serverUptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                timestamp: Date.now()
            };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get All Users (from sessions and active)
    fastify.get('/api/admin/all-users', async (req, reply) => {
        try {
            const activeUsersList = Array.from(activeUsers.values());
            const sessionUsers = Array.from(sessionStore.values());
            
            const allUsers = new Map();
            activeUsersList.forEach(u => {
                allUsers.set(u.userId, {
                    userId: u.userId,
                    email: u.email || 'N/A',
                    username: u.username || 'Guest',
                    isActive: true,
                    connectedAt: u.connectedAt,
                    lastActivity: u.lastActivity
                });
            });
            
            sessionUsers.forEach(s => {
                if (!allUsers.has(s.userId)) {
                    allUsers.set(s.userId, {
                        userId: s.userId,
                        email: s.email || 'N/A',
                        username: s.username || 'Guest',
                        isActive: false,
                        bestScore: s.bestScore
                    });
                }
            });

            return { count: allUsers.size, users: Array.from(allUsers.values()) };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get Firebase Users (All registered users from Firebase Auth)
    fastify.get('/api/admin/firebase-users', async (req, reply) => {
        try {
            if (!isSecureMode || !admin) {
                return { error: "Firebase Admin not initialized" };
            }

            const listUsersResult = await admin.auth().listUsers(1000);
            const firebaseUsers = listUsersResult.users.map(user => ({
                uid: user.uid,
                email: user.email || 'N/A',
                displayName: user.displayName || user.email?.split('@')[0] || 'Guest',
                photoURL: user.photoURL || null,
                emailVerified: user.emailVerified || false,
                creationTime: user.metadata.creationTime,
                lastSignInTime: user.metadata.lastSignInTime || 'Never',
                providerData: user.providerData.map(p => p.providerId)
            }));

            // Get active users from socket connections
            const activeUserIds = new Set(Array.from(activeUsers.values()).map(u => u.userId));
            
            // Mark which Firebase users are currently active
            const usersWithStatus = firebaseUsers.map(user => ({
                ...user,
                isActive: activeUserIds.has(user.uid)
            }));

            return { 
                count: firebaseUsers.length,
                activeCount: usersWithStatus.filter(u => u.isActive).length,
                users: usersWithStatus.sort((a, b) => {
                    // Sort: active first, then by last sign in
                    if (a.isActive !== b.isActive) return b.isActive - a.isActive;
                    return new Date(b.lastSignInTime) - new Date(a.lastSignInTime);
                })
            };
        } catch (e) {
            return { error: e.message };
        }
    });

    // Admin: Get Active Firebase Users (Real-time active users)
    fastify.get('/api/admin/firebase-active-users', async (req, reply) => {
        try {
            if (!isSecureMode || !admin) {
                return { error: "Firebase Admin not initialized" };
            }

            // Get active user IDs from socket connections
            const activeUserIds = Array.from(activeUsers.values()).map(u => u.userId);
            
            if (activeUserIds.length === 0) {
                return { count: 0, users: [] };
            }

            // Fetch Firebase user details for active users
            const firebaseUsersPromises = activeUserIds.map(async (uid) => {
                try {
                    const user = await admin.auth().getUser(uid);
                    const activeUser = Array.from(activeUsers.values()).find(u => u.userId === uid);
                    return {
                        uid: user.uid,
                        email: user.email || 'N/A',
                        displayName: user.displayName || user.email?.split('@')[0] || 'Guest',
                        photoURL: user.photoURL || null,
                        emailVerified: user.emailVerified || false,
                        creationTime: user.metadata.creationTime,
                        lastSignInTime: user.metadata.lastSignInTime || 'Never',
                        connectedAt: activeUser?.connectedAt || Date.now(),
                        lastActivity: activeUser?.lastActivity || Date.now(),
                        isActive: true
                    };
                } catch (e) {
                    // User might not exist in Firebase (guest user)
                    const activeUser = Array.from(activeUsers.values()).find(u => u.userId === uid);
                    return {
                        uid: uid,
                        email: activeUser?.email || 'Guest User',
                        displayName: activeUser?.username || 'Guest',
                        photoURL: null,
                        emailVerified: false,
                        creationTime: 'N/A',
                        lastSignInTime: 'N/A',
                        connectedAt: activeUser?.connectedAt || Date.now(),
                        lastActivity: activeUser?.lastActivity || Date.now(),
                        isActive: true,
                        isGuest: true
                    };
                }
            });

            const users = await Promise.all(firebaseUsersPromises);

            return { 
                count: users.length,
                users: users.sort((a, b) => b.lastActivity - a.lastActivity)
            };
        } catch (e) {
            return { error: e.message };
        }
    });

    socket.on('ig', async (data) => {
        if (!checkRateLimit(socket, 'ig')) {
            return socket.emit('to', 'Too many requests. Please wait.'); // 'to' = toast/error
        }

        // Refresh Leaderboard Cache ...
        await refreshLeaderboardCache();

        let userId = data.u || socket.id;
        let isVerified = false;
        let userEmail = null;
        let username = null;

        // --- SECURITY CHECK ---
        if (isSecureMode && data.t) {
            try {
                const decodedToken = await admin.auth().verifyIdToken(data.t);
                userId = decodedToken.uid; // USE REAL UID from Google
                userEmail = decodedToken.email;
                username = decodedToken.name || decodedToken.email?.split('@')[0];
                isVerified = true;
                // console.log(`✅ Verified User: ${userId}`);
            } catch (err) {
                console.error("❌ Token Verification Failed:", err.message);
                // For now, valid tokens are preferred, but we verify anyway
            }
        }

        // Track active user
        activeUsers.set(socket.id, {
            userId: userId,
            email: userEmail,
            username: username,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            socketId: socket.id
        });

        // Mode: 'p' = Practice, 't' = Tournament (Default)
        const mode = data.m === 'p' ? 'p' : 't';

        const currentTournamentId = getTournamentKey();
        
        // Get or create target time for this tournament (same for all users)
        let targetTime;
        if (mode === 't') {
            // Check if target already exists for this tournament
            const targetKey = `${currentTournamentId}_target`;
            try {
                const existingTarget = await redis.get(targetKey);
                if (existingTarget) {
                    targetTime = parseInt(existingTarget);
                } else {
                    // Generate new target for this tournament
                    targetTime = Math.floor(Math.random() * 9000) + 1000;
                    // Store it with tournament duration expiry (15 minutes)
                    await redis.setex(targetKey, Math.ceil(TOURNAMENT_DURATION_MS / 1000), targetTime.toString());
                }
            } catch (e) {
                console.error("Error getting target:", e);
                // Fallback to random if Redis fails
                targetTime = Math.floor(Math.random() * 9000) + 1000;
            }
        } else {
            // Practice mode: random target per user
            targetTime = Math.floor(Math.random() * 9000) + 1000;
        }

        // Fetch Best Score & Rank for CURRENT Tournament (ONLY IF TOURNAMENT MODE)
        let bestScore = null;
        let currentRank = null;

        if (mode === 't') {
            try {
                const [score, rank] = await Promise.all([
                    redis.zscore(currentTournamentId, userId),
                    redis.zrank(currentTournamentId, userId)
                ]);
                bestScore = score;
                currentRank = rank;
            } catch (e) { console.error(e); }
        }

        bestScore = bestScore ? parseFloat(bestScore) : null;

        // STORE IN MEMORY
        const session = {
            userId,
            email: userEmail,
            username: username,
            targetTime,
            startTime: 0,
            status: 'ready',
            bestScore: bestScore,
            tournamentId: currentTournamentId, // Lock user to this tournament ID
            isVerified: isVerified, // Mark session as verified
            mode: mode // STORE MODE
        };
        sessionStore.set(socket.id, session);
        
        // Update active user last activity
        if (activeUsers.has(socket.id)) {
            activeUsers.get(socket.id).lastActivity = Date.now();
        }

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
        if (!checkRateLimit(socket, 'st')) return;
        const session = sessionStore.get(socket.id);
        if (!session) return;

        const startTime = Date.now();

        if (gameIntervals.has(socket.id)) clearInterval(gameIntervals.get(socket.id));

        const intervalId = setInterval(() => {
            const now = Date.now();
            const elapsed = now - startTime;
            socket.emit('t', elapsed);
        }, 100);

        gameIntervals.set(socket.id, intervalId);

        session.startTime = startTime;
        session.status = 'running';
    });

    // 3. STOP CLOUD TIMER -> 'sp'
    socket.on('sp', async () => {
        if (!checkRateLimit(socket, 'sp')) return;
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

        if (session.status !== 'running') return; // Prevent double submission
        session.status = 'finished';

        const serverDuration = stopTime - session.startTime;
        const target = session.targetTime;

        // FINAL CALCULATION
        const diff = Math.abs(serverDuration - target);
        const win = diff === 0;

        // --- TOURNAMENT LOGIC ---
        let newRecord = false;
        let rank = null;
        let bestScore = session.bestScore;
        const currentTournamentId = getTournamentKey(session.startTime); // Use START time to handle tournament boundary items

        // ONLY UPDATE REDIS IF IN TOURNAMENT MODE
        if (session.mode === 't') {
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
        activeUsers.delete(socket.id); // Remove from active users
    });
});
