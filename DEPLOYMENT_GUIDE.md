# Time Clash Server - Production Deployment Guide

## 🚀 Deploy to Railway.app (Recommended for 1M DAU)

### Prerequisites:
1. GitHub account
2. Railway.app account (sign up at https://railway.app)
3. Upstash Redis account (sign up at https://upstash.com)

---

## Step 1: Setup Upstash Redis

1. Go to https://console.upstash.com/
2. Click **Create Database**
3. Choose **Global** (for worldwide low latency)
4. Copy the **Redis URL** (looks like: `rediss://default:xxxxx@xxxxx.upstash.io:6379`)

---

## Step 2: Deploy to Railway.app

### Method 1: Deploy from GitHub (Easiest)

1. Go to https://railway.app/
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose: `infothegangster-maker/time-clash-server`
5. Railway will auto-detect Node.js
6. Set **Root Directory**: `backend` (if backend is in a subfolder)

### Method 2: Railway CLI (Advanced)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
cd backend
railway init

# Deploy
railway up
```

---

## Step 3: Configure Environment Variables

In Railway Dashboard → Your Project → Variables:

```
PORT=3000
NODE_ENV=production
JWT_SECRET=your_super_secret_jwt_key_here_make_it_very_long_and_random
REDIS_URL=rediss://default:YOUR_UPSTASH_PASSWORD@YOUR_UPSTASH_HOST:6379
CORS_ORIGIN=*
GAME_DURATION_MS=10000
WIN_TOLERANCE_MS=50
LATENCY_BUFFER_MS=200
```

**Important:** Replace `REDIS_URL` with your actual Upstash Redis URL!

---

## Step 4: Get Your Backend URL

After deployment, Railway will give you a URL like:
```
https://time-clash-server-production.up.railway.app
```

Copy this URL - you'll need it for your Android app.

---

## Step 5: Update Android App

Open `www/game_secure.js` and update line 2:

```javascript
const API_URL = "https://time-clash-server-production.up.railway.app";
```

---

## Step 6: Test Your Backend

Open in browser or use Postman:
```
GET https://your-railway-url.railway.app/
```

Should return: `"Time Clash API"`

---

## 🔥 Alternative: Fly.io (Lower Latency)

If you want **ultra-low latency** (better for real-time games):

1. Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Login: `flyctl auth login`
3. Deploy:
   ```bash
   cd backend
   flyctl launch
   flyctl deploy
   ```

---

## 💰 Cost Optimization Tips

### For 1M DAU:

1. **Enable Redis Caching:**
   - Cache leaderboard for 5 seconds
   - Reduces Redis calls by 80%
   - New cost: ~$50/month

2. **Use Cloudflare Workers:**
   - Cache static API responses
   - Free tier: 100K requests/day
   - Paid: $5/month for 10M requests

3. **Optimize Leaderboard:**
   - Only update top 100 in real-time
   - Update full leaderboard every 30 seconds
   - Saves 90% Redis writes

4. **Connection Pooling:**
   - Already implemented in `ioredis`
   - Reduces connection overhead

---

## 📊 Monitoring & Scaling

### Railway.app Auto-Scaling:
- Automatically scales based on traffic
- No manual intervention needed
- Handles sudden spikes (tournaments, etc.)

### Monitor Your App:
1. Railway Dashboard → Metrics
2. Upstash Dashboard → Analytics
3. Set up alerts for high usage

---

## 🔒 Security Checklist

✅ JWT tokens for session validation
✅ Redis TTL for session expiry
✅ CORS configured
✅ Rate limiting (add if needed)
✅ Input validation
✅ Server-authoritative game logic

---

## 🚨 When You Hit 1M DAU:

**Upgrade Path:**
1. **Railway Pro Plan**: $20/month (better performance)
2. **Upstash Pro**: Custom pricing (contact sales)
3. **Multiple Redis Instances**: Regional sharding
4. **Load Balancer**: Distribute traffic across multiple servers

**Expected Cost at 1M DAU:** $300-500/month

---

## 📞 Support

- Railway Docs: https://docs.railway.app/
- Upstash Docs: https://docs.upstash.com/
- Time Clash Repo: https://github.com/infothegangster-maker/time-clash-server

---

**Author:** infothegangster-maker
**Last Updated:** Dec 2025

