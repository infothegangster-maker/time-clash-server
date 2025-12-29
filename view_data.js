require('dotenv').config();

async function viewData() {
    let redis;
    const REDIS_URL = process.env.REDIS_URL;

    console.log("🔍 Checking Redis Connection...");

    if (!REDIS_URL) {
        console.error("❌ Error: REDIS_URL is missing in .env file");
        return;
    }

    // 1. Connect
    if (REDIS_URL.includes('upstash')) {
        console.log("☁️ Connecting to Upstash (HTTP Mode)...");
        const { Redis } = require('@upstash/redis');
        redis = new Redis({
            url: process.env.REDIS_URL,
            token: process.env.REDIS_TOKEN
        });
    } else {
        console.log("🏢 Connecting to Standard/Render Redis (TCP Mode)...");
        const IORedis = require('ioredis');
        redis = new IORedis(REDIS_URL);
    }

    try {
        // 2. Fetch Keys
        // Note: 'keys' command is blocking in production but fine for this admin tool
        // Upstash HTTP client uses 'keys', ioredis uses 'keys'
        const keys = await redis.keys('*');
        console.log(`\n📦 Found ${keys.length} Keys:\n`);

        for (const key of keys) {
            const type = await redis.type(key);
            let value;

            if (type === 'string') {
                value = await redis.get(key);
            } else if (type === 'zset') {
                // Fetch top 100 with scores
                value = await redis.zrange(key, 0, -1, 'WITHSCORES');
            } else if (type === 'hash') {
                value = await redis.hgetall(key);
            } else if (type === 'list') {
                value = await redis.lrange(key, 0, -1);
            } else if (type === 'set') {
                value = await redis.smembers(key);
            } else {
                value = `[Complex Type: ${type}]`;
            }

            console.log(`🔑 Key: ${key} [${type}]`);
            console.log(value);
            console.log('--------------------------------------------------');
        }

        console.log("\n✅ Data Dump Complete.");
        process.exit(0);

    } catch (e) {
        if (e.message && e.message.includes('ENOTFOUND')) {
            console.error("\n❌ CONNECTION FAILED: Host Not Found.");
            console.error("💡 HINT: Are you using a Render 'Internal Connection String' locally?");
            console.error("   - Internal URLs (starting with 'red-') only work INSIDE Render servers.");
            console.error("   - For Local/PC usage, use the 'External Connection String' from Render Dashboard.");
            console.error("   - It usually looks like: rediss://user:pass@oregon-redis.render.com:6379\n");
        } else {
            console.error("❌ Error fetching data:", e);
        }
        process.exit(1);
    }
}

viewData();
