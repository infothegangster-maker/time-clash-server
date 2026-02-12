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

// --- ADMIN ENDPOINTS ---
// Admin: Get Active Firebase Users (Real-time active users)
fastify.get('/api/admin/firebase-active-users', async (req, reply) => {
    try {
        // Get active user IDs from socket connections
        const activeUserIds = Array.from(activeUsers.values()).map(u => u.userId);
        
        console.log(`📊 Admin Request: Active Users Count = ${activeUsers.size}, User IDs = ${activeUserIds.length}`);
        
        if (activeUserIds.length === 0) {
            return { count: 0, users: [], message: "No active users currently" };
        }

        // If Firebase Admin is available, fetch full user details
        if (isSecureMode && admin && admin.auth) {
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
                        lastSignInTime: user.metadata.lastSignInTime || null,
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
                        creationTime: null,
                        lastSignInTime: null,
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
        } else {
            // Fallback: Return active users from socket connections without Firebase details
            const users = activeUserIds.map(uid => {
                const activeUser = Array.from(activeUsers.values()).find(u => u.userId === uid);
                return {
                    uid: uid,
                    email: activeUser?.email || 'N/A',
                    displayName: activeUser?.username || 'Guest',
                    photoURL: null,
                    emailVerified: false,
                    creationTime: null,
                    lastSignInTime: null,
                    connectedAt: activeUser?.connectedAt || Date.now(),
                    lastActivity: activeUser?.lastActivity || Date.now(),
                    isActive: true,
                    isGuest: !activeUser?.email
                };
            });
            
            return { 
                count: users.length,
                users: users.sort((a, b) => b.lastActivity - a.lastActivity),
                message: "Firebase Admin not available - showing socket connection data"
            };
        }
    } catch (e) {
        console.error("❌ Error fetching active Firebase users:", e);
        return { 
            error: e.message,
            count: 0,
            users: []
        };
    }
});

// Admin: Get Current Tournament Details
fastify.get('/api/admin/current-tournament', async (req, reply) => {
    try {
        // Use currentTournamentKey if set, otherwise return null (no active tournament)
        const currentTournamentId = currentTournamentKey || null;
        
        if (!currentTournamentId) {
            return {
                tournamentId: null,
                participantCount: 0,
                participants: [],
                timeLeft: 0,
                playTimeLeft: 0,
                hasActiveTournament: false
            };
        }
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

        // Get time left with custom timing support
        const timeLeft = await getTournamentTimeLeft(currentTournamentId);
        
        // Get custom timing if available
        const custom = await getCustomTournamentTiming(currentTournamentId);
        let playTimeLeft = 0;
        if (custom) {
            const elapsed = Date.now() - custom.startTime;
            playTimeLeft = Math.max(0, custom.playTime - elapsed);
        } else {
            playTimeLeft = Math.max(0, PLAY_TIME_MS - (Date.now() - Math.floor(Date.now() / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS));
        }
        
        return {
            tournamentId: currentTournamentId,
            participantCount: participants.length,
            participants: participantsWithDetails.sort((a, b) => a.score - b.score),
            timeLeft: timeLeft,
            playTimeLeft: playTimeLeft
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Get Tournament Status (Auto mode, current state)
fastify.get('/api/admin/tournament-status', async (req, reply) => {
    try {
        const scheduled = await redis.lrange('tournament:scheduled', 0, 99);
        const scheduledList = scheduled.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                return null;
            }
        }).filter(x => x !== null);
        
        return {
            autoEnabled: autoTournamentEnabled,
            currentTournamentId: currentTournamentKey,
            scheduledCount: scheduledList.length,
            scheduled: scheduledList
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Toggle Auto Tournament (Pause/Resume)
fastify.post('/api/admin/tournament/toggle-auto', async (req, reply) => {
    try {
        const oldState = autoTournamentEnabled;
        autoTournamentEnabled = !autoTournamentEnabled;
        
        console.log(`🔄 [TOGGLE AUTO] Changing from ${oldState ? 'ENABLED' : 'DISABLED'} to ${autoTournamentEnabled ? 'ENABLED' : 'DISABLED'}`);
        
        await redis.set('tournament:auto_enabled', autoTournamentEnabled.toString());
        console.log(`💾 [TOGGLE AUTO] State saved to Redis: ${autoTournamentEnabled}`);
        
        if (autoTournamentEnabled) {
            startTournamentCheck();
            console.log("✅ [TOGGLE AUTO] Auto Tournaments ENABLED - Check interval started");
        } else {
            if (tournamentCheckInterval) {
                console.log("🛑 [TOGGLE AUTO] Stopping tournament check interval");
                clearInterval(tournamentCheckInterval);
                tournamentCheckInterval = null;
            }
            console.log("⏸️ [TOGGLE AUTO] Auto Tournaments DISABLED - Check interval stopped");
        }
        
        return { 
            success: true, 
            autoEnabled: autoTournamentEnabled,
            message: autoTournamentEnabled ? 'Auto tournaments enabled' : 'Auto tournaments disabled'
        };
    } catch (e) {
        console.error(`❌ [TOGGLE AUTO ERROR]:`, e);
        return { error: e.message };
    }
});

// Admin: Create Manual Tournament
fastify.post('/api/admin/tournament/create', async (req, reply) => {
    try {
        const { duration, playTime, leaderboardTime } = req.body;
        
        // End current tournament first
        await endTournament(currentTournamentKey);
        
        // Create new tournament with custom or default timing
        const customDuration = duration || TOURNAMENT_DURATION_MS;
        const customPlayTime = playTime || PLAY_TIME_MS;
        const customLeaderboardTime = leaderboardTime || LEADERBOARD_TIME_MS;
        
        // Generate new tournament ID
        const now = Date.now();
        const newTournamentId = `tournament_manual_${now}`;
        
        // Set custom timing for this tournament (store in Redis)
        await redis.setex(`tournament:${newTournamentId}:duration`, Math.ceil(customDuration / 1000), customDuration.toString());
        await redis.setex(`tournament:${newTournamentId}:playTime`, Math.ceil(customDuration / 1000), customPlayTime.toString());
        await redis.setex(`tournament:${newTournamentId}:leaderboardTime`, Math.ceil(customDuration / 1000), customLeaderboardTime.toString());
        
        currentTournamentKey = newTournamentId;
        
        // Broadcast new tournament
        io.emit('tournament_new', {
            id: newTournamentId,
            duration: customDuration,
            playTime: customPlayTime,
            leaderboardTime: customLeaderboardTime
        });
        
        console.log(`✅ Manual Tournament Created: ${newTournamentId}`);
        
        return {
            success: true,
            tournamentId: newTournamentId,
            duration: customDuration,
            playTime: customPlayTime,
            leaderboardTime: customLeaderboardTime
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Schedule Tournament
fastify.post('/api/admin/tournament/schedule', async (req, reply) => {
    try {
        const { scheduledTime, duration, playTime, leaderboardTime } = req.body;
        
        if (!scheduledTime) {
            return { error: 'scheduledTime is required (Unix timestamp in ms)' };
        }
        
        const schedule = {
            id: `schedule_${Date.now()}`,
            scheduledTime: parseInt(scheduledTime),
            duration: duration || TOURNAMENT_DURATION_MS,
            playTime: playTime || PLAY_TIME_MS,
            leaderboardTime: leaderboardTime || LEADERBOARD_TIME_MS,
            createdAt: Date.now()
        };
        
        // Add to scheduled list
        await redis.lpush('tournament:scheduled', JSON.stringify(schedule));
        await redis.ltrim('tournament:scheduled', 0, 99); // Keep last 100
        
        console.log(`📅 Tournament Scheduled: ${new Date(parseInt(scheduledTime)).toISOString()}`);
        
        return {
            success: true,
            schedule: schedule
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Delete Scheduled Tournament
fastify.delete('/api/admin/tournament/schedule/:scheduleId', async (req, reply) => {
    try {
        const { scheduleId } = req.params;
        const scheduled = await redis.lrange('tournament:scheduled', 0, 99);
        
        const filtered = scheduled.filter(x => {
            try {
                const s = JSON.parse(x);
                return s.id !== scheduleId;
            } catch (e) {
                return true;
            }
        });
        
        // Replace the list
        await redis.del('tournament:scheduled');
        if (filtered.length > 0) {
            await redis.rpush('tournament:scheduled', ...filtered);
        }
        
        return { success: true, message: 'Schedule deleted' };
    } catch (e) {
        return { error: e.message };
    }
});

// Check scheduled tournaments every 10 seconds (more frequent for better accuracy)
let scheduledCheckCount = 0;
setInterval(async () => {
    try {
        scheduledCheckCount++;
        const scheduled = await redis.lrange('tournament:scheduled', 0, 99);
        
        if (!scheduled || scheduled.length === 0) {
            if (scheduledCheckCount % 6 === 0) { // Log every 60 seconds
                console.log(`🔍 [SCHEDULED CHECK #${scheduledCheckCount}] No scheduled tournaments found`);
            }
            return; // No scheduled tournaments
        }
        
        const now = Date.now();
        const checkWindow = 15000; // 15 seconds window (check if scheduled time is within last 15 seconds or next 5 seconds)
        
        console.log(`🔍 [SCHEDULED CHECK #${scheduledCheckCount}] Checking ${scheduled.length} scheduled tournament(s) at ${new Date(now).toISOString()}`);
        
        for (const item of scheduled) {
            try {
                const schedule = JSON.parse(item);
                const timeDiff = now - schedule.scheduledTime;
                const scheduledDate = new Date(schedule.scheduledTime);
                const currentDate = new Date(now);
                const diffMinutes = Math.round(timeDiff / 60000);
                const diffSeconds = Math.round(timeDiff / 1000);
                
                console.log(`   📅 Schedule ID: ${schedule.id}`);
                console.log(`      Scheduled: ${scheduledDate.toLocaleString()} (UTC: ${scheduledDate.toISOString()})`);
                console.log(`      Current: ${currentDate.toLocaleString()} (UTC: ${currentDate.toISOString()})`);
                console.log(`      Time Diff: ${diffMinutes} minutes (${diffSeconds} seconds) ${timeDiff >= -5000 && timeDiff <= checkWindow ? '✅ IN WINDOW' : '❌ OUT OF WINDOW'}`);
                
                // Execute if scheduled time is within last 15 seconds or next 5 seconds
                // This ensures we catch tournaments even if check runs slightly before or after scheduled time
                if (timeDiff >= -5000 && timeDiff <= checkWindow) {
                    console.log(`⏰ [EXECUTING] Scheduled Tournament: ${schedule.id}`);
                    console.log(`   Scheduled Time: ${scheduledDate.toISOString()}`);
                    console.log(`   Current Time: ${currentDate.toISOString()}`);
                    console.log(`   Time Difference: ${Math.round(timeDiff / 1000)} seconds`);
                    
                    // End current tournament
                    console.log(`   🏁 Ending current tournament: ${currentTournamentKey}`);
                    await endTournament(currentTournamentKey);
                    
                    // Create new tournament
                    const tournamentStartTime = Date.now();
                    const newTournamentId = `tournament_scheduled_${schedule.id}_${tournamentStartTime}`;
                    currentTournamentKey = newTournamentId;
                    console.log(`   ➕ Creating new tournament: ${newTournamentId}`);
                    
                    // Store custom timing with start time
                    const expirySeconds = Math.ceil(schedule.duration / 1000);
                    await redis.setex(`tournament:${newTournamentId}:duration`, expirySeconds, schedule.duration.toString());
                    await redis.setex(`tournament:${newTournamentId}:playTime`, expirySeconds, schedule.playTime.toString());
                    await redis.setex(`tournament:${newTournamentId}:leaderboardTime`, expirySeconds, schedule.leaderboardTime.toString());
                    await redis.setex(`tournament:${newTournamentId}:startTime`, expirySeconds, tournamentStartTime.toString());
                    
                    // Broadcast
                    io.emit('tournament_new', {
                        id: newTournamentId,
                        duration: schedule.duration,
                        playTime: schedule.playTime,
                        leaderboardTime: schedule.leaderboardTime
                    });
                    
                    console.log(`✅ [SUCCESS] Scheduled Tournament Created: ${newTournamentId}`);
                    console.log(`   Duration: ${schedule.duration/60000}min | Play: ${schedule.playTime/60000}min | Leaderboard: ${schedule.leaderboardTime/60000}min`);
                    
                    // Remove from scheduled list
                    const filtered = scheduled.filter(x => {
                        try {
                            const s = JSON.parse(x);
                            return s.id !== schedule.id;
                        } catch (e) {
                            return true;
                        }
                    });
                    await redis.del('tournament:scheduled');
                    if (filtered.length > 0) {
                        await redis.rpush('tournament:scheduled', ...filtered);
                    }
                    
                    // Break after executing one tournament to avoid conflicts
                    break;
                }
            } catch (e) {
                console.error(`❌ [ERROR] Processing schedule:`, e);
            }
        }
    } catch (e) {
        console.error(`❌ [ERROR] Checking scheduled tournaments:`, e);
    }
}, 10000); // Check every 10 seconds for better accuracy

// Admin: Get Tournament History with Full Details
fastify.get('/api/admin/tournament-history', async (req, reply) => {
    try {
        const historyRaw = await redis.lrange('tournament_history', 0, 49);
        
        if (!historyRaw || historyRaw.length === 0) {
            return { history: [] };
        }
        
        const history = historyRaw.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                console.error("Error parsing tournament history:", e);
                return null;
            }
        }).filter(x => x !== null);
        
        // Get full participant list for each tournament
        const historyWithDetails = await Promise.all(history.map(async (tournament) => {
            try {
                if (!tournament.id) {
                    return { ...tournament, participantCount: 0, allParticipants: [] };
                }
                
                const allParticipants = await redis.zrange(tournament.id, 0, -1, 'WITHSCORES');
                const participants = [];
                if (Array.isArray(allParticipants)) {
                    if (allParticipants.length > 0 && typeof allParticipants[0] === 'object') {
                        allParticipants.forEach(p => {
                            participants.push({ userId: p.member, score: p.score });
                        });
                    } else {
                        for (let i = 0; i < allParticipants.length; i += 2) {
                            if (allParticipants[i] && allParticipants[i + 1] !== undefined) {
                                participants.push({ userId: allParticipants[i], score: allParticipants[i + 1] });
                            }
                        }
                    }
                }
                return {
                    ...tournament,
                    participantCount: participants.length,
                    allParticipants: participants.sort((a, b) => a.score - b.score)
                };
            } catch (e) {
                console.error(`Error getting participants for tournament ${tournament.id}:`, e);
                return { ...tournament, participantCount: 0, allParticipants: [] };
            }
        }));

        console.log(`📜 Returning ${historyWithDetails.length} tournaments in history`);
        return { history: historyWithDetails };
    } catch (e) {
        console.error("❌ Error fetching tournament history:", e);
        return { error: e.message, history: [] };
    }
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

// Helper to get custom tournament timing from Redis
async function getCustomTournamentTiming(tournamentId) {
    try {
        const duration = await redis.get(`tournament:${tournamentId}:duration`);
        const playTime = await redis.get(`tournament:${tournamentId}:playTime`);
        const leaderboardTime = await redis.get(`tournament:${tournamentId}:leaderboardTime`);
        const startTime = await redis.get(`tournament:${tournamentId}:startTime`);
        
        if (duration && playTime && leaderboardTime && startTime) {
            return {
                duration: parseInt(duration),
                playTime: parseInt(playTime),
                leaderboardTime: parseInt(leaderboardTime),
                startTime: parseInt(startTime)
            };
        }
    } catch (e) {
        console.error("Error getting custom tournament timing:", e);
    }
    return null;
}

async function getTournamentTimeLeft(tournamentId = null) {
    const now = Date.now();
    
    // If tournamentId provided, check for custom timing
    if (tournamentId) {
        const custom = await getCustomTournamentTiming(tournamentId);
        if (custom) {
            const elapsed = now - custom.startTime;
            
            // If we're in leaderboard time (after play time), return 0
            if (elapsed >= custom.playTime) {
                return 0; // Tournament ended, leaderboard time
            }
            
            // Return remaining play time
            const remaining = custom.playTime - elapsed;
            return Math.max(0, remaining); // Return in ms
        }
    }
    
    // Default: Find the start of current 15-minute interval
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
        // Fetch top 3 from the CURRENT 15-minute tournament
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

// --- GLOBAL TOURNAMENT MANAGEMENT (Outside socket handler) ---
let currentTournamentKey = null; // Will be set only when auto tournaments are enabled or manual/scheduled tournament is created
let autoTournamentEnabled = true; // Auto tournament enabled by default
let tournamentCheckInterval = null;

// Initialize tournament state from Redis
async function loadTournamentState() {
    try {
        const state = await redis.get('tournament:auto_enabled');
        if (state !== null) {
            autoTournamentEnabled = state === 'true';
            console.log(`📊 Tournament Auto Mode: ${autoTournamentEnabled ? 'ENABLED' : 'DISABLED'}`);
        }
    } catch (e) {
        console.error("Error loading tournament state:", e);
    }
}

// Start tournament check interval
let autoCheckCount = 0;
function startTournamentCheck() {
    // Stop any existing interval first
    if (tournamentCheckInterval) {
        console.log(`🛑 [AUTO TOURNAMENT] Stopping previous check interval`);
        clearInterval(tournamentCheckInterval);
        tournamentCheckInterval = null;
    }
    
    // Don't start interval if auto tournaments are disabled
    if (!autoTournamentEnabled) {
        console.log(`⏸️ [AUTO TOURNAMENT] Auto tournaments are DISABLED - NOT starting check interval`);
        return;
    }
    
    console.log(`▶️ [AUTO TOURNAMENT] Starting check interval (enabled: ${autoTournamentEnabled})`);
    
    tournamentCheckInterval = setInterval(async () => {
        autoCheckCount++;
        
        // Double check (safety)
        if (!autoTournamentEnabled) {
            if (autoCheckCount % 6 === 0) { // Log every 60 seconds
                console.log(`⏸️ [AUTO TOURNAMENT CHECK #${autoCheckCount}] Auto tournaments are DISABLED - stopping interval`);
            }
            // Stop the interval if disabled
            if (tournamentCheckInterval) {
                clearInterval(tournamentCheckInterval);
                tournamentCheckInterval = null;
            }
            return;
        }
        
        const newKey = getTournamentKey();
        if (newKey !== currentTournamentKey) {
            console.log(`🔄 [AUTO TOURNAMENT] Tournament Changed: ${currentTournamentKey} -> ${newKey}`);
            console.log(`   Current Time: ${new Date().toISOString()}`);
            await endTournament(currentTournamentKey);
            currentTournamentKey = newKey;
            console.log(`✅ [AUTO TOURNAMENT] New tournament started: ${newKey}`);
        } else {
            if (autoCheckCount % 6 === 0) { // Log every 60 seconds
                console.log(`✅ [AUTO TOURNAMENT CHECK #${autoCheckCount}] Current tournament: ${currentTournamentKey} (no change)`);
            }
        }
    }, 10000);
}

// Initialize on startup
console.log(`🚀 [INIT] Loading tournament state and starting check intervals...`);
loadTournamentState().then(() => {
    console.log(`📊 [INIT] Tournament state loaded - Auto enabled: ${autoTournamentEnabled}`);
    if (autoTournamentEnabled) {
        startTournamentCheck();
        console.log(`✅ [INIT] Auto tournament check interval started`);
    } else {
        console.log(`⏸️ [INIT] Auto tournaments disabled - NOT starting check interval`);
    }
    console.log(`✅ [INIT] Tournament management initialized`);
});

// Global Tournament End Function
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

        // Push to History List (Keep last 50 for admin panel)
        await redis.lpush('tournament_history', JSON.stringify(archive));
        await redis.ltrim('tournament_history', 0, 49); // Keep last 50 tournaments

        // 3. Broadcast End Event
        io.emit('tou_end', {
            id: oldKey,
            winners: winners
        });

        console.log(`✅ Tournament Archived: ${oldKey} with ${winners.length} winners`);

    } catch (e) {
        console.error("❌ Error Ending Tournament:", e);
    }
}

io.on('connection', (socket) => {
    // console.log('User Connected:', socket.id);

    // 1. INIT GAME -> 'ig'
    socket.on('ig', async (data) => {
        if (!checkRateLimit(socket, 'ig')) {
            return socket.emit('to', 'Too many requests. Please wait.'); // 'to' = toast/error
        }

        // Refresh Leaderboard Cache ...
        await refreshLeaderboardCache();

        let userId = data.u || socket.id;
        let userEmail = data.e || null; // Email from client
        let username = data.n || 'Guest'; // Username from client
        let isVerified = false;

        // --- SECURITY CHECK ---
        if (isSecureMode && data.t) {
            try {
                const decodedToken = await admin.auth().verifyIdToken(data.t);
                userId = decodedToken.uid; // USE REAL UID from Google
                userEmail = decodedToken.email || userEmail;
                username = decodedToken.name || username;
                isVerified = true;
                // console.log(`✅ Verified User: ${userId}`);
            } catch (err) {
                console.error("❌ Token Verification Failed:", err.message);
                // For now, valid tokens are preferred, but we verify anyway
            }
        }

        // Mode: 'p' = Practice, 't' = Tournament (Default)
        const mode = data.m === 'p' ? 'p' : 't';

        // Get current tournament ID - use currentTournamentKey if set, otherwise return error for tournament mode
        let currentTournamentId;
        if (mode === 't') {
            // Tournament mode - check if there's an active tournament
            if (!currentTournamentKey) {
                // No active tournament - check if auto tournaments are enabled
                if (autoTournamentEnabled) {
                    // Auto tournaments enabled - create tournament key
                    currentTournamentKey = getTournamentKey();
                    currentTournamentId = currentTournamentKey;
                } else {
                    // Auto tournaments disabled and no manual/scheduled tournament
                    return socket.emit('grd', {
                        t: 0,
                        b: -1,
                        r: -1,
                        tl: 0,
                        tid: null,
                        noTournament: true
                    });
                }
            } else {
                currentTournamentId = currentTournamentKey;
            }
        } else {
            // Practice mode - use any tournament key for practice
            currentTournamentId = getTournamentKey();
        }
        
        // Get target time for tournament - SAME NUMBER FOR ALL USERS IN ONE TOURNAMENT
        let targetTime;
        if (mode === 't') {
            // Tournament mode: Get or create same target for all users
            const targetKey = `${currentTournamentId}_target`;
            try {
                const existingTarget = await redis.get(targetKey);
                if (existingTarget) {
                    // Target already exists for this tournament - use it
                    targetTime = parseInt(existingTarget);
                    console.log(`🎯 Using existing target for tournament ${currentTournamentId}: ${targetTime}ms`);
                } else {
                    // Generate new target for this tournament and store it
                    targetTime = Math.floor(Math.random() * 9000) + 1000;
                    // Store it with tournament duration expiry (15 minutes = 900 seconds)
                    await redis.setex(targetKey, Math.ceil(TOURNAMENT_DURATION_MS / 1000), targetTime.toString());
                    console.log(`🎯 Generated NEW target for tournament ${currentTournamentId}: ${targetTime}ms`);
                }
            } catch (e) {
                console.error("❌ Error getting/setting tournament target:", e);
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
            targetTime,
            startTime: 0,
            status: 'ready',
            bestScore: bestScore,
            tournamentId: currentTournamentId, // Lock user to this tournament ID
            isVerified: isVerified, // Mark session as verified
            mode: mode // STORE MODE
        };
        sessionStore.set(socket.id, session);

        // Track active user
        activeUsers.set(socket.id, {
            userId: userId,
            email: userEmail,
            username: username,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            socketId: socket.id
        });
        
        console.log(`✅ Active User Tracked: ${userId} (${username}) - Total Active: ${activeUsers.size}`);

        // Send Game Ready Data (grd)
        // t: target, b: best, r: rank, tl: timeLeft (ms), tid: tournamentId
        const timeLeft = await getTournamentTimeLeft(currentTournamentId);
        socket.emit('grd', {
            t: targetTime,
            b: bestScore !== null ? bestScore : -1,
            r: currentRank !== null ? currentRank + 1 : -1,
            tl: timeLeft,
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

        // Update active user last activity
        if (activeUsers.has(socket.id)) {
            activeUsers.get(socket.id).lastActivity = Date.now();
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
            rem: await getTournamentTimeLeft(session.tournamentId || currentTournamentKey) // Send remaining time logic
        });
    });

    socket.on('disconnect', () => {
        if (gameIntervals.has(socket.id)) {
            clearInterval(gameIntervals.get(socket.id));
            gameIntervals.delete(socket.id);
        }
        sessionStore.delete(socket.id);
        const removed = activeUsers.delete(socket.id); // Remove from active users
        if (removed) {
            console.log(`❌ Active User Removed: ${socket.id} - Total Active: ${activeUsers.size}`);
        }
    });
});
