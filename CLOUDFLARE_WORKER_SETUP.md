# Cloudflare Worker Setup Guide

## Admin Panel ke liye Cloudflare Worker Setup

### Step 1: Cloudflare Worker Create Karein

1. Cloudflare Dashboard mein jao: https://dash.cloudflare.com
2. Workers & Pages section mein jao
3. "Create application" click karein
4. "Create Worker" select karein
5. Worker ka naam dein (e.g., `time-clash-admin`)

### Step 2: Code Deploy Karein

1. `CLOUDFLARE_ADMIN_WORKER.js` file ka code copy karein
2. Cloudflare Worker editor mein paste karein
3. "Save and Deploy" click karein

### Step 3: Environment Variables Set Karein

Cloudflare Worker settings mein yeh environment variables add karein:

**Required:**
- `BACKEND_SERVER_URL`: `https://time-clash-server.onrender.com`

**Optional (agar direct Firebase access chahiye):**
- `FIREBASE_PROJECT_ID`: `time-clash-483314`
- `FIREBASE_SERVICE_ACCOUNT`: Service account JSON (stringified)

### Step 4: Worker URL Get Karein

Deploy ke baad aapko worker URL milega:
- Format: `https://your-worker-name.your-subdomain.workers.dev`
- Example: `https://time-clash-admin.abc123.workers.dev`

### Step 5: Admin Panel Update Karein

`www/admin.html` file mein line 400 ke paas:

```javascript
const WORKER_URL = "https://your-worker-name.your-subdomain.workers.dev"; // Yaha apna worker URL daalo
```

### Step 6: Test Karein

1. Admin panel kholo
2. Browser console (F12) mein check karein
3. Network tab mein requests check karein
4. Sab data properly aana chahiye

## Worker Endpoints

Worker yeh endpoints provide karta hai:

1. `/api/admin/firebase-users` - Sab Firebase users
2. `/api/admin/firebase-active-users` - Real-time active users
3. `/api/admin/current-tournament` - Current tournament details
4. `/api/admin/tournament-history` - Tournament history
5. `/api/admin/system-stats` - System statistics
6. `/api/admin/all-data` - Sab data ek saath

## Benefits

- ✅ Fast CDN delivery (Cloudflare edge network)
- ✅ CORS handling
- ✅ Error handling
- ✅ Data combining (Firebase + Backend)
- ✅ Rate limiting (Cloudflare automatic)
- ✅ Free tier available

## Notes

- Worker backend server se data fetch karta hai (backend mein Firebase Admin SDK hai)
- Worker Firebase data ko backend se lekar combine karta hai
- Admin panel ab worker URL use karega backend ke bajay
