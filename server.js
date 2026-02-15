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

// --- ADMIN AUTH MIDDLEWARE ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
if (!ADMIN_SECRET) {
    console.log("⚠️ WARNING: ADMIN_SECRET not set! Admin endpoints will be BLOCKED. Set ADMIN_SECRET env var.");
}

fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/admin')) {
        if (!ADMIN_SECRET) {
            reply.code(403).send({ error: 'Admin access not configured' });
            return;
        }
        const key = req.headers['x-admin-key'];
        if (key !== ADMIN_SECRET) {
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }
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
            if (!email || !username || username === 'Guest') {
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

// Admin: Add Daily Tournament Schedule
fastify.post('/api/admin/tournament/daily-schedule', async (req, reply) => {
    try {
        const { time, playTime, leaderboardTime, rewards } = req.body;

        if (!time) {
            return { error: 'time is required (HH:MM format)' };
        }

        // Validate time format
        const timeMatch = time.match(/^(\d{2}):(\d{2})$/);
        if (!timeMatch) {
            return { error: 'Invalid time format. Use HH:MM (e.g., 14:30)' };
        }

        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            return { error: 'Invalid time. Hours: 0-23, Minutes: 0-59' };
        }

        const playTimeMs = (playTime || 12) * 60 * 1000;
        const leaderboardTimeMs = (leaderboardTime || 3) * 60 * 1000;
        const duration = playTimeMs + leaderboardTimeMs;

        // Check if this time already exists
        const existing = await redis.lrange('tournament:daily-schedules', 0, 99);
        for (const item of existing) {
            try {
                const s = JSON.parse(item);
                if (s.time === time) {
                    return { error: `Daily schedule already exists for ${time}` };
                }
            } catch (e) {
                continue;
            }
        }

        const schedule = {
            id: `daily_${Date.now()}`,
            time: time,
            playTime: playTime || 12,
            leaderboardTime: leaderboardTime || 3,
            rewards: rewards || [],
            duration: duration,
            createdAt: Date.now()
        };

        // Add to daily schedules list
        await redis.lpush('tournament:daily-schedules', JSON.stringify(schedule));
        await redis.ltrim('tournament:daily-schedules', 0, 99); // Keep last 100

        console.log(`📆 Daily Tournament Schedule Added: ${time} (Play: ${playTime}min, Leaderboard: ${leaderboardTime}min)`);

        // Also persist reward configs to Supabase if rewards present
        if (supabase && rewards && rewards.length > 0) {
            try {
                const inserts = rewards.map((r, idx) => ({
                    schedule_id: schedule.id,
                    name: r.name,
                    image_url: r.img || null,
                    reward_type: r.reward_type || 'default',
                    link_url: r.link_url || null,
                    min_rank: parseInt(r.min),
                    max_rank: parseInt(r.max),
                    sort_order: idx
                }));
                await supabase.from('tournament_reward_configs').delete().eq('schedule_id', schedule.id);
                await supabase.from('tournament_reward_configs').insert(inserts);
                console.log(`🎁 [DAILY] Saved ${inserts.length} reward configs to Supabase for ${schedule.id}`);
            } catch (e) { console.error("⚠️ Error saving daily reward configs to Supabase:", e.message); }
        }

        return {
            success: true,
            scheduleId: schedule.id,
            schedule: schedule
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Get All Daily Schedules
fastify.get('/api/admin/tournament/daily-schedules', async (req, reply) => {
    try {
        const schedulesRaw = await redis.lrange('tournament:daily-schedules', 0, 99);
        const schedules = schedulesRaw.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                return null;
            }
        }).filter(x => x !== null);

        return {
            success: true,
            schedules: schedules
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Update Daily Schedule Rewards
fastify.put('/api/admin/tournament/daily-schedule/:scheduleId', async (req, reply) => {
    try {
        const { scheduleId } = req.params;
        const { rewards, playTime, leaderboardTime } = req.body;
        const schedules = await redis.lrange('tournament:daily-schedules', 0, 99);

        let found = false;
        const updated = schedules.map(x => {
            try {
                const s = JSON.parse(x);
                if (s.id === scheduleId) {
                    found = true;
                    if (rewards !== undefined) s.rewards = rewards;
                    if (playTime !== undefined) {
                        s.playTime = playTime;
                        s.duration = (playTime + (s.leaderboardTime || 3)) * 60 * 1000;
                    }
                    if (leaderboardTime !== undefined) {
                        s.leaderboardTime = leaderboardTime;
                        s.duration = ((s.playTime || 12) + leaderboardTime) * 60 * 1000;
                    }
                    return JSON.stringify(s);
                }
                return x;
            } catch (e) {
                return x;
            }
        });

        if (!found) {
            return { error: 'Schedule not found' };
        }

        // Replace the list
        await redis.del('tournament:daily-schedules');
        if (updated.length > 0) {
            await redis.rpush('tournament:daily-schedules', ...updated);
        }

        console.log(`✏️ Daily Schedule Updated: ${scheduleId}`);
        return { success: true, message: 'Daily schedule updated' };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Delete Daily Schedule
fastify.delete('/api/admin/tournament/daily-schedule/:scheduleId', async (req, reply) => {
    try {
        const { scheduleId } = req.params;
        const schedules = await redis.lrange('tournament:daily-schedules', 0, 99);

        const filtered = schedules.filter(x => {
            try {
                const s = JSON.parse(x);
                return s.id !== scheduleId;
            } catch (e) {
                return true;
            }
        });

        // Replace the list
        await redis.del('tournament:daily-schedules');
        if (filtered.length > 0) {
            await redis.rpush('tournament:daily-schedules', ...filtered);
        }

        return { success: true, message: 'Daily schedule deleted' };
    } catch (e) {
        return { error: e.message };
    }
});

// --- REWARD API ENDPOINTS ---

// Admin: Save reward configs for a schedule (persists to Supabase)
fastify.post('/api/admin/reward-configs', async (req, reply) => {
    try {
        const { schedule_id, rewards } = req.body;
        if (!schedule_id || !rewards || !Array.isArray(rewards)) {
            return { error: 'schedule_id and rewards array are required' };
        }

        // Validate reward tiers
        for (const r of rewards) {
            if (!r.name || r.min === undefined || r.max === undefined) {
                return { error: 'Each reward needs: name, min, max. Optional: img' };
            }
            if (parseInt(r.min) > parseInt(r.max)) {
                return { error: `Invalid rank range: min(${r.min}) > max(${r.max})` };
            }
        }

        // 1. Save to Redis (for active tournament use)
        const schedules = await redis.lrange('tournament:daily-schedules', 0, 99);
        let found = false;
        const updated = schedules.map(x => {
            try {
                const s = JSON.parse(x);
                if (s.id === schedule_id) {
                    found = true;
                    s.rewards = rewards;
                    return JSON.stringify(s);
                }
                return x;
            } catch (e) { return x; }
        });

        if (found) {
            await redis.del('tournament:daily-schedules');
            if (updated.length > 0) await redis.rpush('tournament:daily-schedules', ...updated);
        }

        // 2. Save to Supabase (persistent storage)
        if (supabase) {
            // Delete existing configs for this schedule (cascades to redeem codes)
            await supabase.from('tournament_reward_configs').delete().eq('schedule_id', schedule_id);

            // Insert new configs with reward_type support
            const inserts = rewards.map((r, idx) => ({
                schedule_id: schedule_id,
                name: r.name,
                image_url: r.img || null,
                reward_type: r.reward_type || 'default',
                link_url: r.link_url || null,
                min_rank: parseInt(r.min),
                max_rank: parseInt(r.max),
                sort_order: idx
            }));

            const { error } = await supabase.from('tournament_reward_configs').insert(inserts);
            if (error) {
                console.error("❌ Supabase reward config save error:", error);
                // If table doesn't exist, still return success since Redis has the data
                if (error.code === '42P01') {
                    console.log("⚠️ tournament_reward_configs table doesn't exist in Supabase. Using Redis only.");
                    return { success: true, message: 'Saved to Redis (Supabase table missing)', rewards };
                }
            } else {
                console.log(`✅ [REWARD CONFIGS] Saved ${rewards.length} tiers to Supabase for ${schedule_id}`);
            }
        }

        return { success: true, rewards };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Get reward configs for a schedule (from Supabase, fallback Redis)
fastify.get('/api/admin/reward-configs/:scheduleId', async (req, reply) => {
    try {
        const { scheduleId } = req.params;

        // Try Supabase first
        if (supabase) {
            const { data, error } = await supabase
                .from('tournament_reward_configs')
                .select('*')
                .eq('schedule_id', scheduleId)
                .order('sort_order', { ascending: true });

            if (!error && data && data.length > 0) {
                const rewards = data.map(r => ({
                    name: r.name,
                    img: r.image_url,
                    min: r.min_rank,
                    max: r.max_rank
                }));
                return { success: true, rewards, source: 'supabase' };
            }
        }

        // Fallback: Redis daily schedule
        const schedules = await redis.lrange('tournament:daily-schedules', 0, 99);
        for (const item of schedules) {
            try {
                const s = JSON.parse(item);
                if (s.id === scheduleId && s.rewards) {
                    return { success: true, rewards: s.rewards, source: 'redis' };
                }
            } catch (e) { continue; }
        }

        return { success: true, rewards: [] };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Get ALL reward configs (from Supabase)
fastify.get('/api/admin/reward-configs', async (req, reply) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('tournament_reward_configs')
                .select('*')
                .order('schedule_id', { ascending: true })
                .order('sort_order', { ascending: true });

            if (!error && data) {
                // Group by schedule_id
                const grouped = {};
                data.forEach(r => {
                    if (!grouped[r.schedule_id]) grouped[r.schedule_id] = [];
                    grouped[r.schedule_id].push({
                        name: r.name,
                        img: r.image_url,
                        min: r.min_rank,
                        max: r.max_rank
                    });
                });
                return { success: true, configs: grouped };
            }
        }
        return { success: true, configs: {} };
    } catch (e) {
        return { error: e.message };
    }
});

// Admin: Delete reward configs for a schedule
fastify.delete('/api/admin/reward-configs/:scheduleId', async (req, reply) => {
    try {
        const { scheduleId } = req.params;

        // Remove from Redis
        const schedules = await redis.lrange('tournament:daily-schedules', 0, 99);
        const updated = schedules.map(x => {
            try {
                const s = JSON.parse(x);
                if (s.id === scheduleId) { s.rewards = []; return JSON.stringify(s); }
                return x;
            } catch (e) { return x; }
        });
        await redis.del('tournament:daily-schedules');
        if (updated.length > 0) await redis.rpush('tournament:daily-schedules', ...updated);

        // Remove from Supabase
        if (supabase) {
            await supabase.from('tournament_reward_configs').delete().eq('schedule_id', scheduleId);
        }

        return { success: true, message: 'Reward configs deleted' };
    } catch (e) {
        return { error: e.message };
    }
});

// Helper: Create/Fix Supabase tables for rewards (run once)
fastify.post('/api/admin/setup-reward-tables', async (req, reply) => {
    if (!supabase) return { error: 'Supabase not configured' };

    try {
        // Test if user_rewards table exists
        const { error: testError1 } = await supabase.from('user_rewards').select('id').limit(1);
        const { error: testError2 } = await supabase.from('tournament_reward_configs').select('id').limit(1);

        const missing = [];
        if (testError1 && testError1.code === '42P01') missing.push('user_rewards');
        if (testError2 && testError2.code === '42P01') missing.push('tournament_reward_configs');

        // Check if user_id column type needs fixing (UUID → TEXT)
        let needsColumnFix = false;
        if (testError1 && testError1.code === '22P02') needsColumnFix = true;

        return {
            success: missing.length === 0 && !needsColumnFix,
            message: missing.length === 0 && !needsColumnFix
                ? 'All reward tables exist and are correctly configured!'
                : `Run this SQL in Supabase SQL Editor to create/fix tables:`,
            tables: ['user_rewards', 'tournament_reward_configs'],
            needsColumnFix,
            sql: `
-- STEP 0: Drop dependent tables first (foreign key order matters)
DROP TABLE IF EXISTS physical_reward_orders;
DROP TABLE IF EXISTS reward_redeem_codes;

-- STEP 1: Drop and recreate user_rewards with reward types support
DROP TABLE IF EXISTS user_rewards;
CREATE TABLE user_rewards (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    tournament_id TEXT NOT NULL,
    reward_name TEXT NOT NULL,
    reward_image TEXT,
    reward_type TEXT DEFAULT 'default',
    redeem_code TEXT,
    link_url TEXT,
    rank_achieved INTEGER NOT NULL,
    is_claimed BOOLEAN DEFAULT FALSE,
    claim_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_rewards_user ON user_rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_user_rewards_tournament ON user_rewards(tournament_id);

-- STEP 2: Create reward configs table with reward type support
DROP TABLE IF EXISTS tournament_reward_configs;
CREATE TABLE tournament_reward_configs (
    id BIGSERIAL PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    reward_type TEXT DEFAULT 'default',
    link_url TEXT,
    min_rank INTEGER NOT NULL,
    max_rank INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reward_configs_schedule ON tournament_reward_configs(schedule_id);

-- STEP 3: Redeem codes pool (pre-assigned codes per reward config)
CREATE TABLE reward_redeem_codes (
    id BIGSERIAL PRIMARY KEY,
    config_id BIGINT REFERENCES tournament_reward_configs(id) ON DELETE CASCADE,
    schedule_id TEXT NOT NULL,
    rank_position INTEGER NOT NULL,
    code TEXT NOT NULL,
    assigned_to TEXT,
    assigned_tournament TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_config ON reward_redeem_codes(config_id);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_schedule ON reward_redeem_codes(schedule_id);

-- STEP 4: Physical reward orders
CREATE TABLE physical_reward_orders (
    id BIGSERIAL PRIMARY KEY,
    user_reward_id BIGINT REFERENCES user_rewards(id),
    user_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    pincode TEXT NOT NULL,
    order_status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    tracking_link TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_physical_orders_user ON physical_reward_orders(user_id);
            `
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Get Current Tournament Top Scores (Live leaderboard for game page)
fastify.get('/api/tournament-top-scores', async (req, reply) => {
    try {
        if (!currentTournamentKey) {
            return { scores: [], tournament: null };
        }

        const count = Math.min(parseInt(req.query.count) || 10, 50);
        const topScores = await redis.zrange(currentTournamentKey, 0, count - 1, 'WITHSCORES');
        const players = [];

        if (Array.isArray(topScores)) {
            const entries = [];
            if (topScores.length > 0 && typeof topScores[0] === 'object') {
                topScores.forEach(x => entries.push({ u: x.member, s: parseFloat(x.score) }));
            } else {
                for (let i = 0; i < topScores.length; i += 2) {
                    entries.push({ u: topScores[i], s: parseFloat(topScores[i + 1]) });
                }
            }

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                let name = entry.u.substring(0, 8);
                try {
                    const meta = await redis.hgetall(`user_meta:${entry.u}`);
                    if (meta && meta.username) name = meta.username;
                } catch (e) { /* ignore */ }
                if (name === entry.u.substring(0, 8)) {
                    const activeUser = Array.from(activeUsers.values()).find(u => u.userId === entry.u);
                    if (activeUser) name = activeUser.username;
                }
                players.push({
                    rank: i + 1,
                    name: name.length > 14 ? name.substring(0, 12) + '...' : name,
                    score: entry.s,
                    isYou: entry.u === req.query.userId
                });
            }
        }

        return { scores: players, tournament: currentTournamentKey };
    } catch (e) {
        console.error("❌ Error fetching top scores:", e);
        return { scores: [], tournament: null };
    }
});

// Get Current Tournament Rewards (Prize Pool display)
fastify.get('/api/tournament-rewards', async (req, reply) => {
    try {
        if (!currentTournamentKey) {
            return { rewards: [] };
        }

        // Get rewards config from Redis
        const rewardsConfigRaw = await redis.hget(`tournament:info:${currentTournamentKey}`, 'rewards');
        let rewards = rewardsConfigRaw ? JSON.parse(rewardsConfigRaw) : [];

        // Fallback: if Redis empty, try Supabase using stored schedule_id
        if (rewards.length === 0 && supabase) {
            try {
                const scheduleId = await redis.hget(`tournament:info:${currentTournamentKey}`, 'schedule_id');
                if (scheduleId) {
                    const { data } = await supabase
                        .from('tournament_reward_configs')
                        .select('*')
                        .eq('schedule_id', scheduleId)
                        .order('sort_order');

                    if (data && data.length > 0) {
                        rewards = data.map(r => ({ name: r.name, img: r.image_url, min: r.min_rank, max: r.max_rank, reward_type: r.reward_type || 'default', link_url: r.link_url || null }));
                        // Cache back to Redis
                        await redis.hset(`tournament:info:${currentTournamentKey}`, { rewards: JSON.stringify(rewards) });
                        console.log(`🎁 [REWARDS] Loaded ${rewards.length} from Supabase for schedule ${scheduleId}`);
                    }
                }
            } catch (e) { /* ignore fallback errors */ }
        }

        return { rewards };
    } catch (e) {
        console.error("❌ Error fetching tournament rewards:", e);
        return { rewards: [] };
    }
});

// Get User Rewards (My Wins)
fastify.get('/api/user-rewards', async (req, reply) => {
    try {
        const userId = req.query.userId;
        if (!userId) {
            return { error: 'userId is required', rewards: [] };
        }

        if (!supabase) {
            return { error: 'Database not configured', rewards: [] };
        }

        const { data, error } = await supabase
            .from('user_rewards')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error("❌ Error fetching user rewards:", error);
            return { error: error.message, rewards: [] };
        }

        return { rewards: data || [] };
    } catch (e) {
        console.error("❌ Error in user-rewards:", e);
        return { error: e.message, rewards: [] };
    }
});

// Claim a Reward (handles all reward types)
fastify.post('/api/claim-reward', async (req, reply) => {
    try {
        const { rewardId, shippingData } = req.body;
        if (!rewardId) {
            return { error: 'rewardId is required' };
        }

        if (!supabase) {
            return { error: 'Database not configured' };
        }

        // First fetch the reward to check its type
        const { data: existing, error: fetchErr } = await supabase
            .from('user_rewards')
            .select('*')
            .eq('id', rewardId)
            .single();

        if (fetchErr || !existing) {
            return { error: 'Reward not found' };
        }

        if (existing.is_claimed) {
            return { success: true, reward: existing, message: 'Already claimed' };
        }

        const rewardType = existing.reward_type || 'default';

        // For physical_reward, require shipping data
        if (rewardType === 'physical_reward' && shippingData) {
            // Save physical reward order
            const { error: orderErr } = await supabase
                .from('physical_reward_orders')
                .insert({
                    user_reward_id: existing.id,
                    user_id: existing.user_id,
                    full_name: shippingData.fullName,
                    phone: shippingData.phone,
                    address: shippingData.address,
                    city: shippingData.city,
                    state: shippingData.state,
                    pincode: shippingData.pincode
                });
            if (orderErr) {
                console.error("❌ Error saving physical reward order:", orderErr);
                // Don't block claim if order table missing
            }
        }

        // Mark as claimed, store claim_data if provided
        const updateData = { is_claimed: true };
        if (shippingData) updateData.claim_data = shippingData;

        const { data, error } = await supabase
            .from('user_rewards')
            .update(updateData)
            .eq('id', rewardId)
            .select();

        if (error) {
            console.error("❌ Error claiming reward:", error);
            return { error: error.message };
        }

        if (!data || data.length === 0) {
            return { error: 'Reward not found' };
        }

        console.log(`✅ [REWARD CLAIMED] Reward ${rewardId} (type: ${rewardType}) claimed`);
        return { success: true, reward: data[0] };
    } catch (e) {
        console.error("❌ Error in claim-reward:", e);
        return { error: e.message };
    }
});

// =============================================
// SERVER-SIDE HEALTH SYSTEM (Anti-Cheat)
// Health stored in Redis — client syncs from server
// =============================================
const HEALTH_MAX = 20;
const HEALTH_REFILL_MS = 5 * 60 * 1000; // 5 minutes

// GET current health + regen info
fastify.get('/api/health', async (req, reply) => {
    try {
        const { userId } = req.query;
        if (!userId) return { error: 'userId required' };

        const health = parseInt(await redis.get(`health:${userId}`)) || 0;
        const regenStart = await redis.get(`health_regen:${userId}`);
        let regenRemaining = null;

        if (health <= 0 && regenStart) {
            const elapsed = Date.now() - parseInt(regenStart);
            if (elapsed >= HEALTH_REFILL_MS) {
                // Refill ready — grant health
                await redis.set(`health:${userId}`, HEALTH_MAX);
                await redis.del(`health_regen:${userId}`);
                return { health: HEALTH_MAX, regenRemaining: null };
            } else {
                regenRemaining = HEALTH_REFILL_MS - elapsed;
            }
        } else if (health <= 0 && !regenStart) {
            // Start regen timer
            await redis.set(`health_regen:${userId}`, Date.now());
            regenRemaining = HEALTH_REFILL_MS;
        }

        return { health: Math.max(0, health), regenRemaining };
    } catch (e) {
        return { error: e.message };
    }
});

// POST: Tournament entry — reset health to 20 (only ONCE per tournament)
fastify.post('/api/health/tournament-entry', async (req, reply) => {
    try {
        const { userId } = req.body;
        if (!userId) return { error: 'userId required' };

        // Check if user already got health for this tournament
        const activeTid = currentTournamentKey || 'none';
        const lastHealthTid = await redis.get(`health_tid:${userId}`);

        if (lastHealthTid === activeTid) {
            // Same tournament — return current health, don't reset
            const currentHealth = parseInt(await redis.get(`health:${userId}`)) || 0;
            console.log(`❤️ [HEALTH] Re-entry same tournament: ${userId} → ${currentHealth} HP (no reset)`);
            return { success: true, health: currentHealth, sameTourn: true };
        }

        // Different tournament — reset to 20
        await redis.set(`health:${userId}`, HEALTH_MAX);
        await redis.del(`health_regen:${userId}`);
        await redis.set(`health_tid:${userId}`, activeTid);
        console.log(`❤️ [HEALTH] Tournament entry: ${userId} → ${HEALTH_MAX} HP (tid: ${activeTid})`);
        return { success: true, health: HEALTH_MAX, sameTourn: false };
    } catch (e) {
        return { error: e.message };
    }
});

// POST: Ad reward — +20 health (rate-limited: max 15 per 10 minutes per user)
fastify.post('/api/health/ad-reward', async (req, reply) => {
    try {
        const { userId } = req.body;
        if (!userId) return { error: 'userId required' };

        // Rate limit: max 15 ad rewards per 10 minutes
        const adKey = `health_ad_count:${userId}`;
        const adCount = parseInt(await redis.get(adKey)) || 0;
        if (adCount >= 15) {
            return { error: 'Too many ad rewards. Try again later.', success: false };
        }
        await redis.set(adKey, adCount + 1);
        await redis.expire(adKey, 600); // 10 minutes TTL

        await redis.set(`health:${userId}`, HEALTH_MAX);
        await redis.del(`health_regen:${userId}`);
        console.log(`❤️ [HEALTH] Ad reward: ${userId} → ${HEALTH_MAX} HP`);
        return { success: true, health: HEALTH_MAX };
    } catch (e) {
        return { error: e.message };
    }
});

// POST: Refill (5-min timer validated on server)
fastify.post('/api/health/refill', async (req, reply) => {
    try {
        const { userId } = req.body;
        if (!userId) return { error: 'userId required' };

        const currentHealth = parseInt(await redis.get(`health:${userId}`)) || 0;
        if (currentHealth > 0) return { success: false, health: currentHealth, message: 'Health not empty' };

        const regenStart = await redis.get(`health_regen:${userId}`);
        if (!regenStart) return { success: false, health: 0, message: 'No refill timer active' };

        const elapsed = Date.now() - parseInt(regenStart);
        if (elapsed < HEALTH_REFILL_MS) {
            return { success: false, health: 0, remaining: HEALTH_REFILL_MS - elapsed, message: 'Refill not ready' };
        }

        // Refill!
        await redis.set(`health:${userId}`, HEALTH_MAX);
        await redis.del(`health_regen:${userId}`);
        console.log(`❤️ [HEALTH] Refill complete: ${userId} → ${HEALTH_MAX} HP`);
        return { success: true, health: HEALTH_MAX };
    } catch (e) {
        return { error: e.message };
    }
});

// POST: Consume 1 health (called by game on each round start)
fastify.post('/api/health/consume', async (req, reply) => {
    try {
        const { userId } = req.body;
        if (!userId) return { error: 'userId required' };

        const current = parseInt(await redis.get(`health:${userId}`)) || 0;
        if (current <= 0) {
            // Start regen if not already
            const existing = await redis.get(`health_regen:${userId}`);
            if (!existing) await redis.set(`health_regen:${userId}`, Date.now());
            return { success: false, health: 0, message: 'No health remaining' };
        }

        const newHealth = current - 1;
        await redis.set(`health:${userId}`, newHealth);

        // If health just hit 0, start regen timer
        if (newHealth <= 0) {
            await redis.set(`health_regen:${userId}`, Date.now());
        }

        return { success: true, health: newHealth };
    } catch (e) {
        return { error: e.message };
    }
});

// Save redeem codes for a reward config (admin)
fastify.post('/api/admin/redeem-codes', async (req, reply) => {
    try {
        const { schedule_id, config_id, codes } = req.body;
        if (!schedule_id || !codes || !Array.isArray(codes)) {
            return { error: 'schedule_id and codes array required' };
        }
        if (!supabase) return { error: 'Database not configured' };

        // Delete existing codes for this config/schedule
        if (config_id) {
            await supabase.from('reward_redeem_codes').delete().eq('config_id', config_id);
        } else {
            await supabase.from('reward_redeem_codes').delete().eq('schedule_id', schedule_id);
        }

        // Insert new codes: codes = [{ rank_position: 1, code: "ABC123" }, ...]
        const inserts = codes.map(c => ({
            config_id: config_id || null,
            schedule_id,
            rank_position: c.rank_position,
            code: c.code
        }));

        const { error } = await supabase.from('reward_redeem_codes').insert(inserts);
        if (error) {
            console.error("❌ Error saving redeem codes:", error);
            return { error: error.message };
        }

        return { success: true, count: inserts.length };
    } catch (e) {
        return { error: e.message };
    }
});

// Get redeem codes for a schedule (admin)
fastify.get('/api/admin/redeem-codes/:scheduleId', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Database not configured', codes: [] };
        const { data, error } = await supabase
            .from('reward_redeem_codes')
            .select('*')
            .eq('schedule_id', req.params.scheduleId)
            .order('rank_position');
        if (error) return { error: error.message, codes: [] };
        return { codes: data || [] };
    } catch (e) {
        return { error: e.message, codes: [] };
    }
});

// Get physical reward orders (admin)
fastify.get('/api/admin/physical-orders', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Database not configured', orders: [] };
        const { data, error } = await supabase
            .from('physical_reward_orders')
            .select('*, user_rewards(reward_name, reward_image, tournament_id)')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) return { error: error.message, orders: [] };
        return { orders: data || [] };
    } catch (e) {
        return { error: e.message, orders: [] };
    }
});

// Update physical reward order status (admin) — also accepts tracking_link
fastify.post('/api/admin/physical-orders/:orderId/status', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Database not configured' };
        const { status, admin_notes, tracking_link } = req.body;
        const updateData = {};
        if (status) updateData.order_status = status;
        if (admin_notes !== undefined) updateData.admin_notes = admin_notes;
        if (tracking_link !== undefined) updateData.tracking_link = tracking_link;
        const { data, error } = await supabase
            .from('physical_reward_orders')
            .update(updateData)
            .eq('id', req.params.orderId)
            .select();
        if (error) return { error: error.message };
        return { success: true, order: data?.[0] };
    } catch (e) {
        return { error: e.message };
    }
});

// Get/Set WhatsApp contact number (admin config in Redis)
fastify.get('/api/admin/whatsapp-config', async (req, reply) => {
    try {
        const number = await redis.get('admin:whatsapp_number') || '';
        return { number };
    } catch (e) { return { number: '', error: e.message }; }
});
fastify.post('/api/admin/whatsapp-config', async (req, reply) => {
    try {
        const { number } = req.body;
        if (!number) return { error: 'number required' };
        await redis.set('admin:whatsapp_number', number);
        return { success: true };
    } catch (e) { return { error: e.message }; }
});

// Get WhatsApp number (public — for user contact button)
fastify.get('/api/whatsapp-number', async (req, reply) => {
    try {
        const number = await redis.get('admin:whatsapp_number') || '';
        return { number };
    } catch (e) { return { number: '' }; }
});

// Get physical order status for a specific user_reward (for user My Wins OPEN)
fastify.get('/api/physical-order-status', async (req, reply) => {
    try {
        const { rewardId } = req.query;
        if (!rewardId || !supabase) return { order: null };
        const { data, error } = await supabase
            .from('physical_reward_orders')
            .select('id, order_status, tracking_link, full_name, phone, address, city, state, pincode, created_at')
            .eq('user_reward_id', rewardId)
            .single();
        if (error) return { order: null };
        return { order: data };
    } catch (e) { return { order: null }; }
});

// Get user's tournament history (best score per tournament)
fastify.get('/api/user-game-history', async (req, reply) => {
    try {
        const userId = req.query.userId;
        if (!userId) return { error: 'userId required', games: [] };

        // Read from hash: each field = tournamentId, value = best game JSON
        const historyKey = `user:best_games:${userId}`;
        const allEntries = await redis.hgetall(historyKey);

        if (!allEntries || Object.keys(allEntries).length === 0) {
            return { games: [] };
        }

        const games = Object.values(allEntries).map(x => {
            try { return JSON.parse(x); } catch { return null; }
        }).filter(Boolean);

        // Sort by timestamp (most recent first), return last 10
        games.sort((a, b) => (b.ts || 0) - (a.ts || 0));

        return { games: games.slice(0, 10) };
    } catch (e) {
        return { error: e.message, games: [] };
    }
});

// Helper function to create tournament from schedule
async function createTournamentFromSchedule(schedule, scheduleType, scheduleId) {
    // End current tournament
    console.log(`   🏁 Ending current tournament: ${currentTournamentKey}`);
    await endTournament(currentTournamentKey);

    // Create new tournament
    const tournamentStartTime = Date.now();
    const newTournamentId = `tournament_${scheduleType}_${scheduleId}_${tournamentStartTime}`;
    currentTournamentKey = newTournamentId;
    console.log(`   ➕ Creating new tournament: ${newTournamentId}`);

    // Handle different schedule formats:
    // - Scheduled tournaments: playTime and leaderboardTime are in milliseconds
    // - Daily schedules: playTime and leaderboardTime are in minutes
    let playTime, leaderboardTime, duration;

    if (scheduleType === 'daily') {
        // Daily schedules store time in minutes
        playTime = (schedule.playTime || 12) * 60 * 1000;
        leaderboardTime = (schedule.leaderboardTime || 3) * 60 * 1000;
        duration = playTime + leaderboardTime;
    } else {
        // Scheduled tournaments store time in milliseconds
        playTime = schedule.playTime || PLAY_TIME_MS;
        leaderboardTime = schedule.leaderboardTime || LEADERBOARD_TIME_MS;
        duration = schedule.duration || (playTime + leaderboardTime);
    }

    const expirySeconds = Math.ceil(duration / 1000);
    await redis.setex(`tournament:${newTournamentId}:duration`, expirySeconds, duration.toString());
    await redis.setex(`tournament:${newTournamentId}:playTime`, expirySeconds, playTime.toString());
    await redis.setex(`tournament:${newTournamentId}:leaderboardTime`, expirySeconds, leaderboardTime.toString());

    await redis.setex(`tournament:${newTournamentId}:startTime`, expirySeconds, tournamentStartTime.toString());

    // 5. Store Rewards Config if present (try Redis first, then Supabase fallback)
    let rewardsToStore = schedule.rewards && schedule.rewards.length > 0 ? schedule.rewards : [];

    // If no rewards in schedule, try loading from Supabase
    if (rewardsToStore.length === 0 && supabase && scheduleId) {
        try {
            const { data: supaRewards } = await supabase
                .from('tournament_reward_configs')
                .select('*')
                .eq('schedule_id', scheduleId)
                .order('sort_order', { ascending: true });

            if (supaRewards && supaRewards.length > 0) {
                rewardsToStore = supaRewards.map(r => ({
                    name: r.name,
                    img: r.image_url,
                    min: r.min_rank,
                    max: r.max_rank,
                    reward_type: r.reward_type || 'default',
                    link_url: r.link_url || null
                }));
                console.log(`🎁 [REWARDS] Loaded ${rewardsToStore.length} reward tiers from Supabase for ${scheduleId}`);
            }
        } catch (e) {
            console.error("⚠️ Error loading rewards from Supabase:", e.message);
        }
    }

    // Always store schedule_id in tournament info for Supabase reward lookup
    const infoExpiry = expirySeconds + 300;
    const infoData = { schedule_id: scheduleId || '' };
    if (rewardsToStore.length > 0) {
        infoData.rewards = JSON.stringify(rewardsToStore);
        console.log(`🎁 [REWARDS] Saved ${rewardsToStore.length} reward tiers for ${newTournamentId} (TTL: ${infoExpiry}s)`);
    }
    await redis.hset(`tournament:info:${newTournamentId}`, infoData);
    await redis.expire(`tournament:info:${newTournamentId}`, infoExpiry);

    // Broadcast tournament creation
    io.emit('tournament_new', {
        id: newTournamentId,
        duration: duration,
        playTime: playTime,
        leaderboardTime: leaderboardTime
    });

    // Immediately broadcast phase update so clients know tournament is active
    // Retry a few times to ensure Redis data is available
    let retryCount = 0;
    const maxRetries = 5;
    const broadcastPhase = async () => {
        try {
            const phase = await getTournamentPhase(newTournamentId);
            const timeLeft = await getTournamentTimeLeft(newTournamentId);
            const lbTimeLeft = await getLeaderboardTimeLeft(newTournamentId);

            // Only broadcast if phase is valid (not 'n')
            if (phase !== 'n' || retryCount >= maxRetries) {
                io.emit('tu', {
                    ph: phase,
                    tid: newTournamentId,
                    tl: timeLeft,
                    ltl: lbTimeLeft
                });
                console.log(`📡 [BROADCAST] Tournament phase after creation: ${phase} | TID: ${newTournamentId} | TL: ${timeLeft}ms | LTL: ${lbTimeLeft}ms`);
            } else {
                // Retry if phase is 'n' and we haven't exceeded max retries
                retryCount++;
                setTimeout(broadcastPhase, 200);
            }
        } catch (e) {
            console.error(`❌ Error broadcasting tournament phase:`, e);
            if (retryCount < maxRetries) {
                retryCount++;
                setTimeout(broadcastPhase, 200);
            }
        }
    };
    setTimeout(broadcastPhase, 100); // Initial delay to ensure Redis data is available

    console.log(`✅ [SUCCESS] Tournament Created: ${newTournamentId}`);
    console.log(`   Duration: ${duration / 60000}min | Play: ${playTime / 60000}min | Leaderboard: ${leaderboardTime / 60000}min`);
    console.log(`   Current Tournament Key: ${currentTournamentKey}`);
}

// Check scheduled tournaments and daily schedules every 10 seconds
let scheduledCheckCount = 0;
setInterval(async () => {
    try {
        scheduledCheckCount++;
        const now = Date.now();
        const checkWindow = 15000; // 15 seconds window
        const currentDate = new Date(now);

        // Check one-time scheduled tournaments
        const scheduled = await redis.lrange('tournament:scheduled', 0, 99);
        if (scheduled && scheduled.length > 0) {
            console.log(`🔍 [SCHEDULED CHECK #${scheduledCheckCount}] Checking ${scheduled.length} scheduled tournament(s)`);

            for (const item of scheduled) {
                try {
                    const schedule = JSON.parse(item);
                    const timeDiff = now - schedule.scheduledTime;
                    const scheduledDate = new Date(schedule.scheduledTime);
                    const diffMinutes = Math.round(timeDiff / 60000);
                    const diffSeconds = Math.round(timeDiff / 1000);

                    console.log(`   📅 Schedule ID: ${schedule.id}`);
                    console.log(`      Scheduled: ${scheduledDate.toLocaleString()}`);
                    console.log(`      Current: ${currentDate.toLocaleString()}`);
                    console.log(`      Time Diff: ${diffMinutes}min (${diffSeconds}s) ${timeDiff >= -5000 && timeDiff <= checkWindow ? '✅ IN WINDOW' : '❌ OUT OF WINDOW'}`);

                    // Execute if scheduled time is within last 15 seconds or next 5 seconds
                    if (timeDiff >= -5000 && timeDiff <= checkWindow) {
                        console.log(`⏰ [EXECUTING] Scheduled Tournament: ${schedule.id}`);
                        await createTournamentFromSchedule(schedule, 'scheduled', schedule.id);

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
                        return;
                    }
                } catch (e) {
                    console.error(`❌ [ERROR] Processing schedule:`, e);
                }
            }
        }

        // Check daily schedules
        // ALWAYS use Indian Standard Time (IST - UTC+5:30) for daily schedules
        const dailySchedules = await redis.lrange('tournament:daily-schedules', 0, 99);
        if (dailySchedules && dailySchedules.length > 0) {
            const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30 = 19800000 ms

            // Get current time in IST
            const nowIST = new Date(now + IST_OFFSET_MS);
            const istYear = nowIST.getUTCFullYear();
            const istMonth = nowIST.getUTCMonth();
            const istDate = nowIST.getUTCDate();
            const todayStr = `${istYear}-${String(istMonth + 1).padStart(2, '0')}-${String(istDate).padStart(2, '0')}`;

            for (const item of dailySchedules) {
                try {
                    const dailySchedule = JSON.parse(item);
                    const [hours, minutes] = dailySchedule.time.split(':').map(Number);

                    // Create scheduled time in IST (treat as UTC, then subtract IST offset)
                    const scheduledIST = new Date(Date.UTC(istYear, istMonth, istDate, hours, minutes, 0, 0));
                    const scheduledTimestamp = scheduledIST.getTime() - IST_OFFSET_MS;
                    const timeDiff = now - scheduledTimestamp;

                    // Check if we already created a tournament for this daily schedule today
                    const lastExecutedKey = `tournament:daily-executed:${dailySchedule.id}:${todayStr}`;
                    const alreadyExecuted = await redis.get(lastExecutedKey);

                    if (alreadyExecuted) {
                        continue; // Already executed today
                    }

                    // Execute if scheduled time is within last 15 seconds or next 5 seconds
                    if (timeDiff >= -5000 && timeDiff <= checkWindow) {
                        const scheduledTimeToday = new Date(scheduledTimestamp);
                        const currentDate = new Date(now);
                        console.log(`⏰ [EXECUTING] Daily Tournament: ${dailySchedule.time} (ID: ${dailySchedule.id})`);
                        console.log(`   Scheduled Time: ${scheduledTimeToday.toLocaleString()}`);
                        console.log(`   Current Time: ${currentDate.toLocaleString()}`);
                        console.log(`   Time Difference: ${Math.round(timeDiff / 1000)} seconds`);

                        await createTournamentFromSchedule(dailySchedule, 'daily', dailySchedule.id);

                        // Mark as executed today (expires after 24 hours)
                        await redis.setex(lastExecutedKey, 86400, '1');

                        // Break after executing one tournament to avoid conflicts
                        return;
                    }
                } catch (e) {
                    console.error(`❌ [ERROR] Processing daily schedule:`, e);
                }
            }
        }

        if (scheduledCheckCount % 6 === 0) { // Log every 60 seconds
            const scheduledCount = scheduled ? scheduled.length : 0;
            const dailyCount = dailySchedules ? dailySchedules.length : 0;
            if (scheduledCount === 0 && dailyCount === 0) {
                console.log(`🔍 [SCHEDULED CHECK #${scheduledCheckCount}] No scheduled tournaments found`);
            }
        }
    } catch (e) {
        console.error(`❌ [ERROR] Checking scheduled tournaments:`, e);
    }
}, 10000); // Check every 10 seconds for better accuracy

// API: Get Tournament Data (History + Status + Scheduled + Daily)
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

        // Get daily schedules and calculate next tournament time
        const dailySchedulesRaw = await redis.lrange('tournament:daily-schedules', 0, 99);
        const dailySchedules = dailySchedulesRaw.map(x => {
            try {
                return JSON.parse(x);
            } catch (e) {
                return null;
            }
        }).filter(x => x !== null);

        // Calculate next daily tournament time
        // ALWAYS use Indian Standard Time (IST - UTC+5:30) for daily schedules
        let nextDailyTournament = null;
        if (dailySchedules.length > 0) {
            const now = Date.now();
            const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30 = 19800000 ms

            // Get current time in IST
            const nowIST = new Date(now + IST_OFFSET_MS);
            const istYear = nowIST.getUTCFullYear();
            const istMonth = nowIST.getUTCMonth();
            const istDate = nowIST.getUTCDate();

            // Find the next daily tournament time (today or tomorrow in IST)
            const nextTimes = dailySchedules.map(daily => {
                const [hours, minutes] = daily.time.split(':').map(Number);

                // Create date for scheduled time in IST (as UTC, then subtract IST offset to get actual UTC)
                // Example: 8:00 PM IST = 20:00 IST = 14:30 UTC
                const scheduledIST = new Date(Date.UTC(istYear, istMonth, istDate, hours, minutes, 0, 0));
                let scheduledUTC = scheduledIST.getTime() - IST_OFFSET_MS;

                // If today's time has passed, use tomorrow's time
                if (scheduledUTC <= now) {
                    scheduledUTC += 86400000; // Add 24 hours
                }

                return {
                    id: daily.id,
                    scheduledTime: scheduledUTC,
                    playTime: daily.playTime * 60 * 1000,
                    leaderboardTime: daily.leaderboardTime * 60 * 1000,
                    duration: (daily.playTime + daily.leaderboardTime) * 60 * 1000,
                    type: 'daily',
                    time: daily.time,
                    rewards: daily.rewards || []
                };
            });

            // Get the earliest next daily tournament
            nextDailyTournament = nextTimes.sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
        }

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

        // Determine the next tournament (scheduled or daily, whichever is earlier)
        let nextTournament = null;
        if (scheduled.length > 0 && nextDailyTournament) {
            // Compare scheduled vs daily, pick the earlier one
            nextTournament = scheduled[0].scheduledTime < nextDailyTournament.scheduledTime
                ? scheduled[0]
                : nextDailyTournament;
        } else if (scheduled.length > 0) {
            nextTournament = scheduled[0];
        } else if (nextDailyTournament) {
            nextTournament = nextDailyTournament;
        }

        return {
            currentId: currentTournamentKey,
            hasActiveTournament: hasActiveTournament,
            timeLeft: timeLeft,
            history: history,
            scheduled: nextTournament // Next tournament (scheduled or daily)
        };
    } catch (e) {
        console.error("Error in /api/tournament-data:", e);
        return { error: "Failed to fetch data", history: [], scheduled: null, hasActiveTournament: false };
    }
});

// API: Get Current Tournament Results (Winners, Target Time, User Rank)
fastify.get('/api/tournament-results', async (req, reply) => {
    try {
        const userId = req.query.userId || null;

        if (!currentTournamentKey) {
            return { error: "No active tournament", winners: [], targetTime: null, userRank: null };
        }

        // Get target time for this tournament
        // Check both key formats (old and new)
        const targetKey1 = `${currentTournamentKey}_target`;
        const targetKey2 = `tournament:${currentTournamentKey}:target`;
        let targetTime = await redis.get(targetKey1);
        if (!targetTime) {
            targetTime = await redis.get(targetKey2);
        }

        // Get total player count
        const totalPlayers = await redis.zcard(currentTournamentKey) || 0;

        // Get ALL players (up to 50 for leaderboard)
        const top3 = await redis.zrange(currentTournamentKey, 0, 49, 'WITHSCORES');
        const winners = [];

        if (Array.isArray(top3)) {
            if (top3.length > 0 && typeof top3[0] === 'object') {
                top3.forEach(x => winners.push({ userId: x.member, score: x.score }));
            } else {
                for (let i = 0; i < top3.length; i += 2) {
                    if (top3[i] && top3[i + 1] !== undefined) {
                        winners.push({ userId: top3[i], score: parseFloat(top3[i + 1]) });
                    }
                }
            }
        }

        // Get display names and ACTUAL TIMES for winners
        for (let w of winners) {
            try {
                // Fetch User Metadata
                const meta = await redis.hgetall(`user_meta:${w.userId}`);
                if (meta && meta.username) {
                    w.username = meta.username;
                    w.email = meta.email || '';
                }

                // Fetch Actual Time (stored separately)
                const actualTime = await redis.hget(`tournament_times:${currentTournamentKey}`, w.userId);
                if (actualTime) {
                    w.actualTime = parseInt(actualTime);
                } else if (targetTime) {
                    // Fallback: Assume Overshoot if no time stored
                    w.actualTime = parseInt(targetTime) + w.score;
                } else {
                    w.actualTime = w.score; // Worst case fallback
                }

            } catch (e) { /* ignore */ }
            if (!w.username) {
                const activeUser = Array.from(activeUsers.values()).find(u => u.userId === w.userId);
                if (activeUser) {
                    w.username = activeUser.username;
                    w.email = activeUser.email || '';
                }
            }
            if (!w.username) w.username = w.userId.substring(0, 10) + '...';
        }

        // Get user's rank if userId provided
        let userRank = null;
        if (userId) {
            const userScore = await redis.zscore(currentTournamentKey, userId);
            if (userScore !== null) {
                const rank = await redis.zrank(currentTournamentKey, userId);

                // Fetch actual time for user
                let actualTime = await redis.hget(`tournament_times:${currentTournamentKey}`, userId);
                let finalTime = actualTime ? parseInt(actualTime) : (parseInt(targetTime || 0) + parseFloat(userScore));

                userRank = {
                    rank: rank !== null ? rank + 1 : null,
                    score: parseFloat(userScore),
                    actualTime: finalTime
                };
            }
        }

        return {
            tournamentId: currentTournamentKey,
            targetTime: targetTime ? parseInt(targetTime) : null,
            winners: winners,
            userRank: userRank,
            totalPlayers: totalPlayers
        };
    } catch (e) {
        console.error("Error in /api/tournament-results:", e);
        return { error: e.message, winners: [], targetTime: null, userRank: null };
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

// Admin: Search tournaments by date range (from Supabase)
fastify.get('/api/admin/search-tournaments', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Supabase not configured', tournaments: [] };
        const { from, to, limit: lim } = req.query;
        let query = supabase.from('tournaments').select('*').order('started_at', { ascending: false }).limit(parseInt(lim) || 50);
        if (from) query = query.gte('started_at', new Date(from).toISOString());
        if (to) query = query.lte('started_at', new Date(to + 'T23:59:59').toISOString());
        const { data, error } = await query;
        if (error) return { error: error.message, tournaments: [] };
        return { tournaments: data || [] };
    } catch (e) { return { error: e.message, tournaments: [] }; }
});

// Admin: Search player history by email or userId (from Supabase)
fastify.get('/api/admin/search-player', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Supabase not configured', results: [] };
        const { email, userId } = req.query;
        if (!email && !userId) return { error: 'Provide email or userId', results: [] };

        let query = supabase.from('tournament_results').select('*').order('created_at', { ascending: false }).limit(100);
        if (email) query = query.eq('email', email);
        else if (userId) query = query.eq('user_id', userId);
        const { data, error } = await query;
        if (error) return { error: error.message, results: [] };

        // Also get rewards for this player
        let rewards = [];
        if (data && data.length > 0) {
            const uid = data[0].user_id;
            const { data: rData } = await supabase.from('user_rewards').select('*').eq('user_id', uid).order('created_at', { ascending: false });
            if (rData) rewards = rData;
        }

        return { results: data || [], rewards };
    } catch (e) { return { error: e.message, results: [] }; }
});

// Admin: Get tournament details by ID (from Supabase)
fastify.get('/api/admin/tournament-detail/:tournamentId', async (req, reply) => {
    try {
        if (!supabase) return { error: 'Supabase not configured' };
        const tid = req.params.tournamentId;
        const { data: meta } = await supabase.from('tournaments').select('*').eq('id', tid).single();
        const { data: results } = await supabase.from('tournament_results').select('*').eq('tournament_id', tid).order('rank_position');
        const { data: rewards } = await supabase.from('user_rewards').select('*').eq('tournament_id', tid).order('rank_achieved');
        return { tournament: meta || null, results: results || [], rewards: rewards || [] };
    } catch (e) { return { error: e.message }; }
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

        // Check if current tournament is a CUSTOM (scheduled/manual/daily) tournament
        const isCustomTournament = currentTournamentKey &&
            (currentTournamentKey.includes('_scheduled_') || currentTournamentKey.includes('_manual_') || currentTournamentKey.includes('_daily_'));

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
                    // Get rewards config for this tournament (Redis first, Supabase fallback)
                    let rewardsConfig = [];
                    try {
                        const rRaw = await redis.hget(`tournament:info:${currentTournamentKey}`, 'rewards');
                        if (rRaw) rewardsConfig = JSON.parse(rRaw);
                    } catch (e) { /* ignore */ }

                    // Supabase fallback if Redis rewards empty
                    if (rewardsConfig.length === 0 && supabase) {
                        try {
                            const sId = await redis.hget(`tournament:info:${currentTournamentKey}`, 'schedule_id');
                            if (sId) {
                                const { data: sRewards } = await supabase
                                    .from('tournament_reward_configs')
                                    .select('*')
                                    .eq('schedule_id', sId)
                                    .order('sort_order');
                                if (sRewards && sRewards.length > 0) {
                                    rewardsConfig = sRewards.map(r => ({ name: r.name, img: r.image_url, min: r.min_rank, max: r.max_rank }));
                                    // Cache back to Redis
                                    await redis.hset(`tournament:info:${currentTournamentKey}`, { rewards: JSON.stringify(rewardsConfig) });
                                    console.log(`🎁 [P→L] Loaded ${rewardsConfig.length} rewards from Supabase for schedule ${sId}`);
                                }
                            }
                        } catch (e) { console.error('⚠️ Supabase reward fallback error:', e.message); }
                    }

                    // Find max rank needed (at least top 3, or max reward rank)
                    const maxRewardRank = rewardsConfig.length > 0
                        ? Math.max(3, ...rewardsConfig.map(r => parseInt(r.max) || 0))
                        : 3;

                    // Get all qualifying players (up to max reward rank)
                    const topAll = await redis.zrange(currentTournamentKey, 0, maxRewardRank - 1, 'WITHSCORES');
                    const allWinners = [];
                    if (Array.isArray(topAll)) {
                        if (topAll.length > 0 && typeof topAll[0] === 'object') {
                            topAll.forEach(x => allWinners.push({ u: x.member, s: x.score }));
                        } else {
                            for (let i = 0; i < topAll.length; i += 2) {
                                allWinners.push({ u: topAll[i], s: topAll[i + 1] });
                            }
                        }
                    }

                    // Resolve display names
                    for (let w of allWinners) {
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

                    // Attach matching reward to each winner
                    const winnersWithRewards = allWinners.map((w, idx) => {
                        const rank = idx + 1;
                        const matchedReward = rewardsConfig.find(r => rank >= parseInt(r.min) && rank <= parseInt(r.max));
                        return {
                            ...w,
                            rank: rank,
                            reward: matchedReward ? { name: matchedReward.name, img: matchedReward.img, reward_type: matchedReward.reward_type || 'default' } : null
                        };
                    });

                    // 🎉 EMIT tournament_winners to ALL clients with full details
                    io.emit('tournament_winners', {
                        tid: currentTournamentKey,
                        winners: winnersWithRewards,
                        rewards: rewardsConfig,
                        ltl: ltl
                    });
                    console.log(`🏆 [BROADCAST] tournament_winners emitted: ${winnersWithRewards.length} winners, ${rewardsConfig.length} rewards`);

                    // 🎁 DISTRIBUTE REWARDS TO SUPABASE NOW (Redis data is fresh during p→l)
                    if (rewardsConfig.length > 0 && supabase) {
                        try {
                            // Pre-fetch redeem codes for this tournament's schedule
                            let redeemCodesMap = {};
                            const scheduleId = await redis.hget(`tournament:info:${currentTournamentKey}`, 'schedule_id');
                            if (scheduleId) {
                                try {
                                    const { data: codes } = await supabase
                                        .from('reward_redeem_codes')
                                        .select('*')
                                        .eq('schedule_id', scheduleId)
                                        .is('assigned_to', null)
                                        .order('rank_position');
                                    if (codes) {
                                        codes.forEach(c => {
                                            if (!redeemCodesMap[c.rank_position]) redeemCodesMap[c.rank_position] = [];
                                            redeemCodesMap[c.rank_position].push(c);
                                        });
                                    }
                                } catch (e) { /* redeem codes table may not exist */ }
                            }

                            const rewardInserts = [];
                            const codeAssignments = []; // track code assignments
                            for (let i = 0; i < allWinners.length; i++) {
                                const rank = i + 1;
                                const player = allWinners[i];
                                const matchingReward = rewardsConfig.find(r => rank >= parseInt(r.min) && rank <= parseInt(r.max));
                                if (matchingReward) {
                                    const rewardType = matchingReward.reward_type || 'default';
                                    let redeemCode = null;
                                    let linkUrl = matchingReward.link_url || null;

                                    // Assign redeem code if reward type is redeem_code
                                    if (rewardType === 'redeem_code' && redeemCodesMap[rank] && redeemCodesMap[rank].length > 0) {
                                        const codeEntry = redeemCodesMap[rank].shift();
                                        redeemCode = codeEntry.code;
                                        codeAssignments.push({ id: codeEntry.id, userId: player.u });
                                    }

                                    console.log(`   🎁 Rank ${rank} (${player.n}) → ${matchingReward.name} [${rewardType}]${redeemCode ? ' code:***' : ''}`);
                                    rewardInserts.push({
                                        user_id: player.u,
                                        tournament_id: currentTournamentKey,
                                        reward_name: matchingReward.name,
                                        reward_image: matchingReward.img || null,
                                        reward_type: rewardType,
                                        redeem_code: redeemCode,
                                        link_url: linkUrl,
                                        rank_achieved: rank,
                                        is_claimed: false
                                    });
                                }
                            }

                            if (rewardInserts.length > 0) {
                                const { data: insertedData, error: rewardError } = await supabase
                                    .from('user_rewards')
                                    .insert(rewardInserts)
                                    .select();

                                if (rewardError) {
                                    console.error("❌ [REWARD INSERT ERROR] user_rewards insert failed:", rewardError);
                                    console.error("   Insert data was:", JSON.stringify(rewardInserts));
                                } else {
                                    console.log(`✅ [REWARDS DISTRIBUTED] ${rewardInserts.length} rewards saved to Supabase user_rewards!`);
                                    if (insertedData) console.log(`   IDs: ${insertedData.map(r => r.id).join(', ')}`);
                                }

                                // Mark assigned redeem codes
                                for (const ca of codeAssignments) {
                                    try {
                                        await supabase.from('reward_redeem_codes')
                                            .update({ assigned_to: ca.userId, assigned_tournament: currentTournamentKey })
                                            .eq('id', ca.id);
                                    } catch (e) { /* ignore */ }
                                }
                            } else {
                                console.log(`ℹ️ [REWARDS] No matching rewards for any winners`);
                            }
                        } catch (rewardErr) {
                            console.error("❌ [REWARD DISTRIBUTION ERROR]:", rewardErr);
                        }
                    } else {
                        if (rewardsConfig.length === 0) console.log(`ℹ️ [REWARDS] No reward config for this tournament`);
                        if (!supabase) console.log(`⚠️ [REWARDS] Supabase not configured - cannot save rewards`);
                    }

                    // Save ALL results to Supabase tournament_results table
                    if (supabase && allWinners.length > 0) {
                        try {
                            const tgtTime = await redis.get(`${currentTournamentKey}_target`) || await redis.get(`tournament:${currentTournamentKey}:target`);
                            const resultInserts = allWinners.map((w, idx) => ({
                                tournament_id: currentTournamentKey,
                                user_id: w.u,
                                username: w.n || null,
                                email: w.e || null,
                                score: parseFloat(w.s) || 0,
                                rank_position: idx + 1,
                                target_time: tgtTime ? parseFloat(tgtTime) : null,
                                actual_time: tgtTime ? parseFloat(tgtTime) + (parseFloat(w.s) || 0) : null,
                                diff: parseFloat(w.s) || 0
                            }));
                            await supabase.from('tournament_results').insert(resultInserts);
                            console.log(`📊 [P→L] Saved ${resultInserts.length} player results to Supabase`);
                        } catch (e) { console.error('❌ tournament_results insert error:', e.message); }

                        // Save tournament metadata
                        try {
                            const info = await redis.hgetall(`tournament:info:${currentTournamentKey}`);
                            await supabase.from('tournaments').upsert({
                                id: currentTournamentKey,
                                schedule_id: info?.schedule_id || null,
                                started_at: info?.startTime ? new Date(parseInt(info.startTime)).toISOString() : new Date().toISOString(),
                                player_count: allWinners.length,
                                tournament_status: 'leaderboard',
                                play_time_ms: info?.playTime ? parseInt(info.playTime) : null,
                                leaderboard_time_ms: info?.leaderboardTime ? parseInt(info.leaderboardTime) : null
                            });
                            console.log(`📊 [P→L] Tournament metadata saved to Supabase`);
                        } catch (e) { console.error('❌ tournaments upsert error:', e.message); }
                    }

                    // Use top 3 for archive
                    const winners = allWinners.slice(0, 3);

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

        // --- DISTRIBUTE REWARDS (FALLBACK) ---
        // Primary distribution happens during p→l transition. This is a safety net.
        try {
            if (supabase) {
                // Check if rewards were already distributed during p→l transition
                const { data: existingRewards } = await supabase
                    .from('user_rewards')
                    .select('id')
                    .eq('tournament_id', oldKey)
                    .limit(1);

                if (existingRewards && existingRewards.length > 0) {
                    console.log(`ℹ️ [REWARDS] Already distributed for ${oldKey} (found ${existingRewards.length} in Supabase)`);
                } else {
                    // Fallback: try distributing now
                    const rewardsConfigRaw = await redis.hget(`tournament:info:${oldKey}`, 'rewards');
                    const rewardsConfig = rewardsConfigRaw ? JSON.parse(rewardsConfigRaw) : [];

                    if (rewardsConfig.length > 0) {
                        console.log(`🎁 [REWARDS FALLBACK] Distributing rewards for ${oldKey}...`);
                        const maxRewardRank = Math.max(...rewardsConfig.map(r => parseInt(r.max) || 0));
                        const allQualifying = await redis.zrange(oldKey, 0, maxRewardRank - 1, 'WITHSCORES');
                        const qualifiedPlayers = [];
                        if (Array.isArray(allQualifying)) {
                            if (allQualifying.length > 0 && typeof allQualifying[0] === 'object') {
                                allQualifying.forEach(x => qualifiedPlayers.push({ u: x.member, s: x.score }));
                            } else {
                                for (let i = 0; i < allQualifying.length; i += 2) {
                                    qualifiedPlayers.push({ u: allQualifying[i], s: allQualifying[i + 1] });
                                }
                            }
                        }

                        const rewardInserts = [];
                        for (let i = 0; i < qualifiedPlayers.length; i++) {
                            const rank = i + 1;
                            const matchingReward = rewardsConfig.find(r => rank >= parseInt(r.min) && rank <= parseInt(r.max));
                            if (matchingReward) {
                                rewardInserts.push({
                                    user_id: qualifiedPlayers[i].u,
                                    tournament_id: oldKey,
                                    reward_name: matchingReward.name,
                                    reward_image: matchingReward.img || null,
                                    reward_type: matchingReward.reward_type || 'default',
                                    link_url: matchingReward.link_url || null,
                                    rank_achieved: rank,
                                    is_claimed: false
                                });
                            }
                        }

                        if (rewardInserts.length > 0) {
                            const { error: rewardError } = await supabase
                                .from('user_rewards')
                                .insert(rewardInserts);
                            if (rewardError) console.error("❌ [REWARDS FALLBACK] Insert Error:", rewardError);
                            else console.log(`✅ [REWARDS FALLBACK] ${rewardInserts.length} rewards distributed!`);
                        }
                    } else {
                        console.log(`ℹ️ [REWARDS] No reward config found in Redis for ${oldKey}`);
                    }
                }
            }
        } catch (e) {
            console.error("❌ Error in reward distribution fallback:", e);
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

        // 5. Mark tournament as 'ended' in Supabase
        if (supabase) {
            try {
                await supabase.from('tournaments')
                    .update({ tournament_status: 'ended', ended_at: new Date().toISOString() })
                    .eq('id', oldKey);
            } catch (e) { /* ignore if table doesn't exist yet */ }
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
            if (!p.username) p.username = p.userId;
            if (!p.email) p.email = '';
        }

        // 3. Get tournament timing info
        const custom = await getCustomTournamentTiming(tournamentId);
        const tournamentType = tournamentId.includes('_scheduled_') ? 'scheduled' :
            tournamentId.includes('_daily_') ? 'daily' :
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
            // All users are authenticated - no guest users

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
                    // Auto tournaments disabled - but scheduled/daily tournaments can still run
                    // Check if there's a scheduled/daily tournament that should be active
                    // If not, return no tournament
                    return socket.emit('grd', {
                        t: 0,
                        b: -1,
                        r: -1,
                        tl: 0,
                        tid: null,
                        ph: 'n',
                        noTournament: true
                    });
                }
            } else {
                // Active tournament exists (could be auto, scheduled, manual, or daily)
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
            // Check both key formats for compatibility
            const targetKey1 = `${currentTournamentId}_target`;
            const targetKey2 = `tournament:${currentTournamentId}:target`;
            try {
                let existingTarget = await redis.get(targetKey1);
                if (!existingTarget) {
                    existingTarget = await redis.get(targetKey2);
                }

                if (existingTarget) {
                    // Target already exists for this tournament - use it
                    targetTime = parseInt(existingTarget);
                    console.log(`🎯 Using existing target for tournament ${currentTournamentId}: ${targetTime}ms`);
                } else {
                    // Generate new target for this tournament and store it
                    // Tournament target time: 2 seconds (2000ms) to 3.5 seconds (3500ms)
                    targetTime = Math.floor(Math.random() * 1500) + 2000;
                    // Store it with tournament duration expiry (use longer expiry for custom tournaments)
                    const expirySeconds = Math.ceil(TOURNAMENT_DURATION_MS / 1000) + 60; // Add 60s buffer
                    await redis.setex(targetKey1, expirySeconds, targetTime.toString());
                    await redis.setex(targetKey2, expirySeconds, targetTime.toString()); // Store in both formats
                    console.log(`🎯 Generated NEW target for tournament ${currentTournamentId}: ${targetTime}ms`);
                }
            } catch (e) {
                console.error("❌ Error getting/setting tournament target:", e);
                // Fallback to random if Redis fails (2-3.5 seconds)
                targetTime = Math.floor(Math.random() * 1500) + 2000;
            }
        } else {
            // Practice mode: random target per user (2-3.5 seconds)
            targetTime = Math.floor(Math.random() * 1500) + 2000;
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
            if (userId) {
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

        // Fetch Rewards for active tournament
        let activeRewards = [];
        try {
            const rRaw = await redis.hget(`tournament:info:${currentTournamentId}`, 'rewards');
            if (rRaw) {
                activeRewards = JSON.parse(rRaw);
            } else if (currentTournamentId && currentTournamentId.includes('_daily_')) {
                // FALLBACK: Try to retrieve from daily schedule list if missing (for active tournaments created before fix)
                const dailySchedules = await redis.lrange('tournament:daily-schedules', 0, 99);
                for (const item of dailySchedules) {
                    try {
                        const s = JSON.parse(item);
                        if (s.id && currentTournamentId.includes(s.id) && s.rewards && s.rewards.length > 0) {
                            activeRewards = s.rewards;
                            // Cache it to avoid repeated scanning
                            await redis.hset(`tournament:info:${currentTournamentId}`, {
                                rewards: JSON.stringify(activeRewards)
                            });
                            console.log(`🔧 [FALLBACK] Recovered rewards for ${currentTournamentId} from schedule ${s.id}`);
                            break;
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { /* ignore */ }

        socket.emit('grd', {
            t: targetTime,
            b: bestScore !== null ? bestScore : -1,
            r: currentRank !== null ? currentRank + 1 : -1,
            tl: timeLeft,
            tid: currentTournamentId,
            ph: phase,
            ltl: lbTimeLeft,
            rw: activeRewards // Send Rewards
        });
    });

    // 2. START CLOUD TIMER -> 'st'
    socket.on('st', async () => {
        if (!checkRateLimit(socket, 'st')) return;
        const session = sessionStore.get(socket.id);
        if (!session) return;

        // SERVER-SIDE HEALTH CHECK (anti-cheat) — tournament mode only
        if (session.mode === 't' && session.userId) {
            try {
                const currentHealth = parseInt(await redis.get(`health:${session.userId}`)) || 0;
                if (currentHealth <= 0) {
                    socket.emit('no_health', { health: 0 });
                    return; // Block round start
                }
                // Deduct 1 health
                const newHealth = currentHealth - 1;
                await redis.set(`health:${session.userId}`, newHealth);
                if (newHealth <= 0) {
                    await redis.set(`health_regen:${session.userId}`, Date.now());
                }
                socket.emit('health_update', { health: newHealth });
            } catch (e) {
                console.error('❌ Health check error:', e.message);
            }
        }

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
        // Use session's locked tournament ID (set at connect time) — NOT getTournamentKey()
        // getTournamentKey() generates auto-keys which break custom/daily/scheduled tournaments
        const currentTournamentId = session.tournamentId || currentTournamentKey || getTournamentKey(session.startTime);

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

                    // STORE ACTUAL TIME SEPARATELY (for display)
                    // We need the actual time because zadd only stores difference
                    await redis.hset(`tournament_times:${currentTournamentId}`, session.userId, serverDuration);

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

        // Save BEST score per tournament (not every try)
        if (session.userId && session.mode === 't' && newRecord) {
            try {
                const gameEntry = JSON.stringify({
                    ts: Date.now(),
                    diff: diff,
                    time: serverDuration,
                    target: target,
                    rank: rank,
                    win: win ? 1 : 0,
                    tid: currentTournamentId
                });
                const historyKey = `user:best_games:${session.userId}`;
                await redis.hset(historyKey, currentTournamentId, gameEntry);
                await redis.expire(historyKey, 86400 * 7); // 7 days TTL
                // Trim to last 10 tournaments (cleanup old entries)
                const allFields = await redis.hkeys(historyKey);
                if (allFields.length > 10) {
                    // Parse all entries, sort by timestamp, remove oldest
                    const entries = [];
                    for (const f of allFields) {
                        try { entries.push({ field: f, data: JSON.parse(await redis.hget(historyKey, f)) }); } catch {}
                    }
                    entries.sort((a, b) => (b.data.ts || 0) - (a.data.ts || 0));
                    const toRemove = entries.slice(10).map(e => e.field);
                    if (toRemove.length > 0) await redis.hdel(historyKey, ...toRemove);
                }
            } catch (e) { /* ignore history save errors */ }
        }

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
            rem: await getTournamentTimeLeft(session.tournamentId || currentTournamentKey),
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
