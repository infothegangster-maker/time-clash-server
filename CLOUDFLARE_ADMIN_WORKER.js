/**
 * Cloudflare Worker for Admin Panel
 * Acts as proxy/combiner: Gets Firebase data from backend + active users from backend
 * Combines and sends to admin panel
 * 
 * Environment Variables needed in Cloudflare Dashboard:
 * - BACKEND_SERVER_URL: https://time-clash-server.onrender.com
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response("OK", { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const BACKEND_URL = env.BACKEND_SERVER_URL || "https://time-clash-server.onrender.com";

    // --- API 1: Get All Firebase Users (from backend) ---
    if (url.pathname === "/api/admin/firebase-users") {
      try {
        // Get Firebase users from backend (backend has Firebase Admin SDK)
        const firebaseRes = await fetch(`${BACKEND_URL}/api/admin/firebase-users`);
        const firebaseData = await firebaseRes.json();
        
        // Get active users from backend to mark which Firebase users are active
        const activeUsersRes = await fetch(`${BACKEND_URL}/api/admin/firebase-active-users`);
        const activeUsersData = await activeUsersRes.json().catch(() => ({ users: [] }));
        
        const activeUserIds = new Set(
          (activeUsersData.users || []).map(u => u.uid || u.userId).filter(Boolean)
        );

        // Mark which Firebase users are currently active
        if (firebaseData.users) {
          const usersWithStatus = firebaseData.users.map(user => ({
            ...user,
            isActive: activeUserIds.has(user.uid)
          }));

          return new Response(JSON.stringify({
            count: firebaseData.count || usersWithStatus.length,
            activeCount: usersWithStatus.filter(u => u.isActive).length,
            users: usersWithStatus.sort((a, b) => {
              if (a.isActive !== b.isActive) return b.isActive - a.isActive;
              const aTime = a.lastSignInTime ? new Date(a.lastSignInTime).getTime() : 0;
              const bTime = b.lastSignInTime ? new Date(b.lastSignInTime).getTime() : 0;
              return bTime - aTime;
            })
          }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // If backend returned error, pass it through
        return new Response(JSON.stringify(firebaseData), {
          status: firebaseRes.status,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ 
          error: e.message,
          details: "Worker error fetching Firebase users"
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // --- API 2: Get Active Firebase Users (Real-time from backend) ---
    if (url.pathname === "/api/admin/firebase-active-users") {
      try {
        // Get active users from backend (real-time socket connections)
        const activeUsersRes = await fetch(`${BACKEND_URL}/api/admin/firebase-active-users`);
        const activeUsersData = await activeUsersRes.json();

        // Backend already enriches with Firebase data if available
        return new Response(JSON.stringify(activeUsersData), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ 
          error: e.message,
          count: 0,
          users: [],
          message: "Failed to fetch active users from backend"
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // --- API 3: Get Current Tournament (Proxy to backend) ---
    if (url.pathname === "/api/admin/current-tournament") {
      try {
        const res = await fetch(`${BACKEND_URL}/api/admin/current-tournament`);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // --- API 4: Get Tournament History (Proxy to backend) ---
    if (url.pathname === "/api/admin/tournament-history") {
      try {
        const res = await fetch(`${BACKEND_URL}/api/admin/tournament-history`);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // --- API 5: Get System Stats (Proxy to backend) ---
    if (url.pathname === "/api/admin/system-stats") {
      try {
        const res = await fetch(`${BACKEND_URL}/api/admin/system-stats`);
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // --- API 6: Combined Admin Data (All in one) ---
    if (url.pathname === "/api/admin/all-data") {
      try {
        const [firebaseRes, activeUsersRes, tournamentRes, statsRes] = await Promise.allSettled([
          fetch(`${BACKEND_URL}/api/admin/firebase-users`),
          fetch(`${BACKEND_URL}/api/admin/firebase-active-users`),
          fetch(`${BACKEND_URL}/api/admin/current-tournament`),
          fetch(`${BACKEND_URL}/api/admin/system-stats`)
        ]);

        const firebaseData = firebaseRes.status === 'fulfilled' 
          ? await firebaseRes.value.json().catch(() => ({ users: [], count: 0 }))
          : { users: [], count: 0 };
        
        const activeUsersData = activeUsersRes.status === 'fulfilled'
          ? await activeUsersRes.value.json().catch(() => ({ users: [] }))
          : { users: [] };
        
        const tournamentData = tournamentRes.status === 'fulfilled'
          ? await tournamentRes.value.json().catch(() => ({}))
          : {};
        
        const statsData = statsRes.status === 'fulfilled'
          ? await statsRes.value.json().catch(() => ({}))
          : {};

        // Combine active status
        const activeUserIds = new Set(
          (activeUsersData.users || []).map(u => u.uid || u.userId).filter(Boolean)
        );

        const usersWithStatus = (firebaseData.users || []).map(user => ({
          ...user,
          isActive: activeUserIds.has(user.uid)
        }));

        return new Response(JSON.stringify({
          firebaseUsers: {
            count: usersWithStatus.length,
            activeCount: usersWithStatus.filter(u => u.isActive).length,
            users: usersWithStatus
          },
          activeUsers: activeUsersData,
          currentTournament: tournamentData,
          systemStats: statsData
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response("Time Clash Admin Worker - Use /api/admin/* endpoints", { 
      headers: corsHeaders 
    });
  }
};
