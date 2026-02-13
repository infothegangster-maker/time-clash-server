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

// --- SUPABASE SETUP (Persistent Database) ---
let supabase = null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log("🗄️ Supabase Connected (Persistent Database)");
} else {
    console.log("⚠️ Supabase not configured - tournament data will NOT be persisted. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.");
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

        // Get user emails from active users, session store, or Redis
        const participantsWithDetails = await Promise.all(participants.map(async (p) => {
            const activeUser = Array.from(activeUsers.values()).find(u => u.userId === p.userId);
            const session = Array.from(sessionStore.values()).find(s => s.userId === p.userId);

            let email = activeUser?.email || session?.email || null;
            let username = activeUser?.username || session?.username || null;

            // Fallback: Check Redis for persisted metadata
            if ((!email || !username || username === 'Guest') && !p.userId.startsWith('guest_')) {
                try {
                    const meta = await redis.hgetall(`user_meta:${p.userId}`);
                    if (meta) {
                        email = email || meta.email || 'N/A';
                        username = username || meta.username || 'Guest';
                    }
                } catch (e) { /* ignore */ }
            }

            return {
                userId: p.userId,
                score: p.score,
                email: email || 'N/A',
                username: username || 'Guest'
            };
        }));

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
            console.log("✅ [TOGGLE AUTO] Auto Tournaments ENABLED - Will start at next time boundary");
        } else {
            console.log("⏸️ [TOGGLE AUTO] Auto Tournaments DISABLED - Will stop after current tournament");
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
                    console.log(`   Duration: ${schedule.duration / 60000}min | Play: ${schedule.playTime / 60000}min | Leaderboard: ${schedule.leaderboardTime / 60000}min`);

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

// API: Get Tournament Data (History + Status + Scheduled)
// Used by Tournament Page
fastify.get('/api/tournament-data', async (req, reply) => {
    try {
        const historyRaw = await redis.lrange('tournament_history', 0, 9);
        const history = historyRaw.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                return null;
            }
        }).filter(x => x !== null);

        // Get scheduled tournaments (only upcoming ones)
        const scheduledRaw = await redis.lrange('tournament:scheduled', 0, 99);
        const scheduled = scheduledRaw.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                return null;
            }
        }).filter(x => x !== null && x.scheduledTime > Date.now()).sort((a, b) => a.scheduledTime - b.scheduledTime);

        // Get current tournament info
        let timeLeft = 0;
        let hasActiveTournament = false;

        if (currentTournamentKey) {
            // Check if tournament exists in Redis (has participants or custom timing)
            const participants = await redis.zrange(currentTournamentKey, 0, -1);
            const customTiming = await getCustomTournamentTiming(currentTournamentKey);

            if ((participants && participants.length > 0) || customTiming) {
                hasActiveTournament = true;
                timeLeft = await getTournamentTimeLeft(currentTournamentKey);
            }
        }

        return {
            currentId: currentTournamentKey,
            hasActiveTournament: hasActiveTournament,
            timeLeft: timeLeft,
            history: history,
            scheduled: scheduled.length > 0 ? scheduled[0] : null // Next scheduled tournament
        };
    } catch (e) {
        console.error("Error in /api/tournament-data:", e);
        return { error: "Failed to fetch data", history: [], scheduled: null, hasActiveTournament: false };
    }
});

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

// Helper: Get Tournament Phase
// 'p' = Playing (0 - 12 mins)
// 'l' = Leaderboard (12 - 15 mins)
// 'n' = None (No active tournament)
async function getTournamentPhase(tournamentId = null) {
    if (!tournamentId) return 'n';

    const now = Date.now();
    let elapsed = 0;
    let playTime = PLAY_TIME_MS;

    // Check custom timing
    const custom = await getCustomTournamentTiming(tournamentId);
    if (custom) {
        elapsed = now - custom.startTime;
        playTime = custom.playTime;
    } else {
        // Default 15-min interval
        const intervalStart = Math.floor(now / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS;
        elapsed = now - intervalStart;
    }

    if (elapsed < playTime) {
        return 'p';
    } else {
        return 'l';
    }
}

// Helper: Get Leaderboard Time Left (ms until next tournament starts)
async function getLeaderboardTimeLeft(tournamentId = null) {
    if (!tournamentId) return 0;

    const now = Date.now();

    // Check custom timing
    const custom = await getCustomTournamentTiming(tournamentId);
    if (custom) {
        const totalDuration = custom.playTime + (custom.leaderboardTime || LEADERBOARD_TIME_MS);
        const elapsed = now - custom.startTime;
        return Math.max(0, totalDuration - elapsed);
    }

    // Default 15-min interval
    const intervalStart = Math.floor(now / TOURNAMENT_DURATION_MS) * TOURNAMENT_DURATION_MS;
    const elapsed = now - intervalStart;
    return Math.max(0, TOURNAMENT_DURATION_MS - elapsed);
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
let lastBroadcastPhase = null; // Track last broadcast phase for real-time updates
let lastArchivedTournament = null; // Track which tournament we already archived to Supabase

function startTournamentCheck() {
    // Stop any existing interval first
    if (tournamentCheckInterval) {
        console.log(`🛑 [AUTO TOURNAMENT] Stopping previous check interval`);
        clearInterval(tournamentCheckInterval);
        tournamentCheckInterval = null;
    }

    // Always start check interval (even if disabled) to ensure we can END tournaments
    console.log(`▶️ [AUTO TOURNAMENT] Starting permanent check interval`);

    // Clear existing to be safe
    if (tournamentCheckInterval) clearInterval(tournamentCheckInterval);

    tournamentCheckInterval = setInterval(async () => {
        autoCheckCount++;

        // Check if current tournament is a CUSTOM (scheduled/manual) tournament
        const isCustomTournament = currentTournamentKey &&
            (currentTournamentKey.includes('_scheduled_') || currentTournamentKey.includes('_manual_'));

        if (isCustomTournament) {
            // --- CUSTOM TOURNAMENT HANDLING ---
            // Don't compare with auto-generated key; check if custom tournament has expired
            try {
                const custom = await getCustomTournamentTiming(currentTournamentKey);
                if (custom) {
                    const elapsed = Date.now() - custom.startTime;
                    const totalDuration = custom.playTime + (custom.leaderboardTime || (TOURNAMENT_DURATION_MS - custom.playTime));

                    if (elapsed >= totalDuration) {
                        // Custom tournament has EXPIRED (leaderboard time also over)
                        console.log(`🏁 [CUSTOM TOURNAMENT ENDED] ${currentTournamentKey} (elapsed: ${Math.round(elapsed / 1000)}s / total: ${Math.round(totalDuration / 1000)}s)`);
                        await endTournament(currentTournamentKey);
                        currentTournamentKey = null;

                        // If auto is enabled, start auto tournament
                        if (autoTournamentEnabled) {
                            currentTournamentKey = getTournamentKey();
                            console.log(`✅ [AUTO RESUME] Started auto tournament after custom ended: ${currentTournamentKey}`);
                        } else {
                            console.log(`🛑 [CUSTOM ENDED] Auto disabled - no new tournament created`);
                        }
                    } else {
                        // Custom tournament still running
                        if (autoCheckCount % 6 === 0) {
                            const remaining = totalDuration - elapsed;
                            console.log(`✅ [HEARTBEAT #${autoCheckCount}] Custom Tournament: ${currentTournamentKey} | Remaining: ${Math.round(remaining / 1000)}s`);
                        }
                    }
                } else {
                    // Custom timing data missing from Redis (expired TTL) - tournament is over
                    console.log(`⚠️ [CUSTOM TOURNAMENT] Timing data expired for ${currentTournamentKey} - ending tournament`);
                    await endTournament(currentTournamentKey);
                    currentTournamentKey = null;

                    if (autoTournamentEnabled) {
                        currentTournamentKey = getTournamentKey();
                        console.log(`✅ [AUTO RESUME] Started auto tournament: ${currentTournamentKey}`);
                    }
                }
            } catch (e) {
                console.error(`❌ [CUSTOM TOURNAMENT CHECK ERROR]:`, e);
            }
        } else {
            // --- AUTO TOURNAMENT HANDLING (original logic) ---
            // 1. Calculate what the current tournament key SHOULD be based on time
            const newKey = getTournamentKey();

            // 2. Check if we moved to a new time slot
            if (newKey !== currentTournamentKey) {
                console.log(`🔄 [TIME BOUNDARY] 15-min Slot Changed: ${currentTournamentKey || 'None'} -> ${newKey}`);
                console.log(`   Current Time: ${new Date().toISOString()}`);

                // 3. End the old tournament if it existed
                if (currentTournamentKey) {
                    await endTournament(currentTournamentKey);
                    // Important: Clear it immediately after ending
                    currentTournamentKey = null;
                }

                // 4. Start NEW tournament ONLY if Auto is Enabled
                if (autoTournamentEnabled) {
                    currentTournamentKey = newKey;
                    console.log(`✅ [AUTO START] Started new tournament: ${newKey}`);
                } else {
                    console.log(`🛑 [AUTO STOP] Auto disabled - waiting for manual/scheduled or toggle.`);
                    // currentTournamentKey remains null
                }
            } else {
                // Same time slot. 
                if (autoCheckCount % 6 === 0) { // Log every 60 seconds
                    console.log(`✅ [HEARTBEAT #${autoCheckCount}] Current: ${currentTournamentKey || 'None'} | Auto: ${autoTournamentEnabled}`);
                }
            }
        }

        // --- REAL-TIME PHASE BROADCAST ---
        // Calculate current phase and broadcast to ALL clients if it changed
        const currentPhase = await getTournamentPhase(currentTournamentKey);
        if (currentPhase !== lastBroadcastPhase) {
            const previousPhase = lastBroadcastPhase;
            lastBroadcastPhase = currentPhase;
            const tl = await getTournamentTimeLeft(currentTournamentKey);
            const ltl = await getLeaderboardTimeLeft(currentTournamentKey);

            console.log(`📡 [BROADCAST] Phase changed to '${currentPhase}' | TID: ${currentTournamentKey || 'None'} | TL: ${tl} | LTL: ${ltl}`);

            io.emit('tu', {
                ph: currentPhase,
                tl: tl,
                ltl: ltl,
                tid: currentTournamentKey || null
            });

            // --- ARCHIVE TO SUPABASE WHEN PLAY TIME ENDS ---
            // When phase transitions from 'p' (play) to 'l' (leaderboard),
            // that means play time is over → archive the tournament data NOW
            if (previousPhase === 'p' && currentPhase === 'l' && currentTournamentKey && lastArchivedTournament !== currentTournamentKey) {
                lastArchivedTournament = currentTournamentKey;
                console.log(`🗄️ [PLAY TIME ENDED] Archiving tournament to Supabase: ${currentTournamentKey}`);

                // Get winners for the archive
                try {
                    const top3 = await redis.zrange(currentTournamentKey, 0, 2, 'WITHSCORES');
                    const winners = [];
                    if (Array.isArray(top3)) {
                        if (top3.length > 0 && typeof top3[0] === 'object') {
                            top3.forEach(x => winners.push({ u: x.member, s: x.score }));
                        } else {
                            for (let i = 0; i < top3.length; i += 2) {
                                winners.push({ u: top3[i], s: top3[i + 1] });
                            }
                        }
                    }
                    // Resolve display names
                    for (let w of winners) {
                        try {
                            const meta = await redis.hgetall(`user_meta:${w.u}`);
                            if (meta && meta.username) { w.n = meta.username; w.e = meta.email || ''; }
                        } catch (e) { /* ignore */ }
                        if (!w.n) {
                            const activeUser = Array.from(activeUsers.values()).find(u => u.userId === w.u);
                            if (activeUser) { w.n = activeUser.username; w.e = activeUser.email || ''; }
                        }
                        if (!w.n) w.n = w.u;
                    }

                    archiveTournamentToSupabase(currentTournamentKey, winners).catch(e => {
                        console.error("❌ Supabase Archive Error:", e);
                    });
                } catch (e) {
                    console.error("❌ Error preparing archive at play time end:", e);
                }
            }
        }
    }, 10000);
}

// Initialize on startup
console.log(`🚀 [INIT] Loading tournament state and starting check intervals...`);
loadTournamentState().then(() => {
    console.log(`📊 [INIT] Tournament state loaded - Auto enabled: ${autoTournamentEnabled}`);
    // ALWAYS start the check loop
    startTournamentCheck();
    console.log(`✅ [INIT] Tournament management initialized`);
});

// Global Tournament End Function
async function endTournament(oldKey) {
    console.log(`🏁 Ending Tournament: ${oldKey}`);
    try {
        // 1. Get Top 3 Winners
        const top3 = await redis.zrange(oldKey, 0, 2, 'WITHSCORES');

        // Format Winners with display names
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

        // Resolve display names from Redis metadata
        for (let w of winners) {
            try {
                const meta = await redis.hgetall(`user_meta:${w.u}`);
                if (meta && meta.username) {
                    w.n = meta.username; // Add display name
                    w.e = meta.email || '';
                }
            } catch (e) { /* ignore */ }
            // Fallback: check in-memory activeUsers
            if (!w.n) {
                const activeUser = Array.from(activeUsers.values()).find(u => u.userId === w.u);
                if (activeUser) {
                    w.n = activeUser.username;
                    w.e = activeUser.email || '';
                }
            }
            if (!w.n) w.n = w.u; // Last resort: use userId
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

        // 4. PERSIST to Supabase (only if not already archived at play time end)
        if (lastArchivedTournament !== oldKey) {
            archiveTournamentToSupabase(oldKey, winners).catch(e => {
                console.error("❌ Supabase Archive Error:", e);
            });
        } else {
            console.log(`🗄️ [SUPABASE] Already archived at play time end, skipping: ${oldKey}`);
        }

    } catch (e) {
        console.error("❌ Error Ending Tournament:", e);
    }
}

// --- SUPABASE ARCHIVE FUNCTION ---
// Saves COMPLETE tournament data to PostgreSQL (runs in background)
async function archiveTournamentToSupabase(tournamentId, winners) {
    if (!supabase) return; // Skip if Supabase not configured

    console.log(`🗄️ [SUPABASE] Archiving tournament: ${tournamentId}`);

    try {
        // 1. Get ALL participants from Redis (not just top 3)
        const allParticipants = await redis.zrange(tournamentId, 0, -1, 'WITHSCORES');

        const participants = [];
        if (Array.isArray(allParticipants)) {
            if (allParticipants.length > 0 && typeof allParticipants[0] === 'object') {
                // Upstash format
                allParticipants.forEach((x, idx) => participants.push({
                    userId: x.member, score: x.score, rank: idx + 1
                }));
            } else {
                // Flat array format
                for (let i = 0; i < allParticipants.length; i += 2) {
                    participants.push({
                        userId: allParticipants[i], score: parseFloat(allParticipants[i + 1]), rank: (i / 2) + 1
                    });
                }
            }
        }

        // 2. Resolve display names for ALL participants
        for (let p of participants) {
            try {
                const meta = await redis.hgetall(`user_meta:${p.userId}`);
                if (meta && meta.username) {
                    p.username = meta.username;
                    p.email = meta.email || '';
                }
            } catch (e) { /* ignore */ }
            if (!p.username) {
                const activeUser = Array.from(activeUsers.values()).find(u => u.userId === p.userId);
                if (activeUser) {
                    p.username = activeUser.username;
                    p.email = activeUser.email || '';
                }
            }
            if (!p.username) p.username = p.userId.startsWith('guest_') ? 'Guest' : p.userId;
            if (!p.email) p.email = '';
        }

        // 3. Get tournament timing info
        const custom = await getCustomTournamentTiming(tournamentId);
        const tournamentType = tournamentId.includes('_scheduled_') ? 'scheduled' :
            tournamentId.includes('_manual_') ? 'manual' : 'auto';

        // 4. Get target time for this tournament
        let targetTime = null;
        try {
            const targetKey = `${tournamentId}_target`;
            const target = await redis.get(targetKey);
            if (target) targetTime = parseInt(target);
        } catch (e) { /* ignore */ }

        // 5. INSERT tournament record
        const tournamentRecord = {
            id: tournamentId,
            type: tournamentType,
            started_at: custom ? new Date(custom.startTime).toISOString() : new Date().toISOString(),
            ended_at: new Date().toISOString(),
            duration_ms: custom ? custom.duration || (custom.playTime + custom.leaderboardTime) : TOURNAMENT_DURATION_MS,
            play_time_ms: custom ? custom.playTime : PLAY_TIME_MS,
            leaderboard_time_ms: custom ? custom.leaderboardTime : LEADERBOARD_TIME_MS,
            target_time: targetTime,
            total_players: participants.length,
            winner_uid: winners[0]?.u || null,
            winner_name: winners[0]?.n || null,
            winner_score: winners[0]?.s != null ? parseFloat(winners[0].s) : null,
            second_uid: winners[1]?.u || null,
            second_name: winners[1]?.n || null,
            second_score: winners[1]?.s != null ? parseFloat(winners[1].s) : null,
            third_uid: winners[2]?.u || null,
            third_name: winners[2]?.n || null,
            third_score: winners[2]?.s != null ? parseFloat(winners[2].s) : null
        };

        const { error: tournamentError } = await supabase
            .from('tournaments')
            .upsert(tournamentRecord, { onConflict: 'id' });

        if (tournamentError) {
            console.error("❌ [SUPABASE] Tournament insert error:", tournamentError);
            return;
        }

        console.log(`🗄️ [SUPABASE] Tournament record saved: ${tournamentId} (${participants.length} players)`);

        // 6. INSERT all participant scores (batch insert in chunks of 500)
        if (participants.length > 0) {
            const scoreRows = participants.map(p => ({
                tournament_id: tournamentId,
                user_id: p.userId,
                username: p.username,
                email: p.email,
                best_score: p.score,
                rank: p.rank
            }));

            // Batch insert in chunks (Supabase has row limits)
            const CHUNK_SIZE = 500;
            for (let i = 0; i < scoreRows.length; i += CHUNK_SIZE) {
                const chunk = scoreRows.slice(i, i + CHUNK_SIZE);
                const { error: scoresError } = await supabase
                    .from('tournament_scores')
                    .upsert(chunk, { onConflict: 'tournament_id,user_id' });

                if (scoresError) {
                    console.error(`❌ [SUPABASE] Scores batch ${Math.floor(i / CHUNK_SIZE) + 1} error:`, scoresError);
                }
            }

            console.log(`🗄️ [SUPABASE] ${participants.length} participant scores saved`);
        }

        // 7. UPDATE user lifetime stats
        for (const p of participants) {
            if (p.userId.startsWith('guest_')) continue; // Skip guest users

            try {
                // Check if user exists
                const { data: existingUser } = await supabase
                    .from('users')
                    .select('id, total_games, total_tournaments, total_wins, total_top3, best_ever_score, total_score')
                    .eq('id', p.userId)
                    .single();

                if (existingUser) {
                    // UPDATE existing user
                    const updates = {
                        username: p.username,
                        email: p.email,
                        total_tournaments: existingUser.total_tournaments + 1,
                        total_score: (existingUser.total_score || 0) + p.score,
                        last_played: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };

                    if (p.rank === 1) updates.total_wins = existingUser.total_wins + 1;
                    if (p.rank <= 3) updates.total_top3 = (existingUser.total_top3 || 0) + 1;
                    if (!existingUser.best_ever_score || p.score < existingUser.best_ever_score) {
                        updates.best_ever_score = p.score;
                    }

                    await supabase.from('users').update(updates).eq('id', p.userId);
                } else {
                    // INSERT new user
                    await supabase.from('users').insert({
                        id: p.userId,
                        username: p.username,
                        email: p.email,
                        total_tournaments: 1,
                        total_wins: p.rank === 1 ? 1 : 0,
                        total_top3: p.rank <= 3 ? 1 : 0,
                        best_ever_score: p.score,
                        total_score: p.score,
                        last_played: new Date().toISOString()
                    });
                }
            } catch (e) {
                // Ignore individual user update errors
            }
        }

        console.log(`🗄️ [SUPABASE] ✅ Tournament fully archived: ${tournamentId} | ${participants.length} players | Winner: ${winners[0]?.n || 'None'}`);

    } catch (e) {
        console.error("❌ [SUPABASE] Archive failed:", e);
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

        // PERSIST user metadata in Redis (survives disconnect + server restart)
        try {
            if (userId && !userId.startsWith('guest_')) {
                await redis.hset(`user_meta:${userId}`, {
                    email: userEmail || '',
                    username: username || '',
                    lastSeen: Date.now().toString()
                });
            }
        } catch (e) {
            console.error('❌ Error saving user metadata:', e);
        }

        // Send Game Ready Data (grd)
        // t: target, b: best, r: rank, tl: timeLeft (ms), tid: tournamentId, ph: phase, ltl: leaderboardTimeLeft
        const timeLeft = await getTournamentTimeLeft(currentTournamentId);
        const phase = await getTournamentPhase(currentTournamentId);
        const lbTimeLeft = await getLeaderboardTimeLeft(currentTournamentId);

        socket.emit('grd', {
            t: targetTime,
            b: bestScore !== null ? bestScore : -1,
            r: currentRank !== null ? currentRank + 1 : -1,
            tl: timeLeft,
            tid: currentTournamentId,
            ph: phase,
            ltl: lbTimeLeft
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
            tl: optimizedLeaders,
            tid: currentTournamentId,
            rem: await getTournamentTimeLeft(session.tournamentId || currentTournamentKey), // Send remaining time logic
            ph: await getTournamentPhase(session.tournamentId || currentTournamentKey)
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
