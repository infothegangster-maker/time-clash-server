-- ============================================
-- TIME CLASH - SUPABASE DATABASE SCHEMA
-- Run this in Supabase SQL Editor (one time)
-- ============================================

-- 1. TOURNAMENTS TABLE — Every tournament's record
CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,                    -- tournament key (e.g., tournament_2026_02_13_00_00)
    type TEXT DEFAULT 'auto',               -- 'auto', 'scheduled', 'manual'
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ DEFAULT NOW(),
    duration_ms INTEGER DEFAULT 900000,     -- total duration in ms
    play_time_ms INTEGER DEFAULT 720000,    -- play phase duration
    leaderboard_time_ms INTEGER DEFAULT 180000,
    target_time INTEGER,                    -- target time in ms (same for all players)
    total_players INTEGER DEFAULT 0,
    
    -- Winner info (denormalized for fast queries)
    winner_uid TEXT,
    winner_name TEXT,
    winner_score REAL,
    second_uid TEXT,
    second_name TEXT,
    second_score REAL,
    third_uid TEXT,
    third_name TEXT,
    third_score REAL,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. TOURNAMENT SCORES — Every player's score in every tournament
CREATE TABLE IF NOT EXISTS tournament_scores (
    id BIGSERIAL PRIMARY KEY,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    username TEXT DEFAULT 'Guest',
    email TEXT DEFAULT '',
    best_score REAL NOT NULL,               -- difference in ms (lower = better)
    rank INTEGER,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate entries per user per tournament
    UNIQUE(tournament_id, user_id)
);

-- 3. USERS TABLE — Lifetime stats per user
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                    -- Firebase UID
    username TEXT DEFAULT 'Guest',
    email TEXT DEFAULT '',
    photo_url TEXT,
    
    -- Lifetime stats
    total_games INTEGER DEFAULT 0,
    total_tournaments INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,           -- 1st place count
    total_top3 INTEGER DEFAULT 0,           -- top 3 count
    best_ever_score REAL,                   -- best score across ALL tournaments
    total_score REAL DEFAULT 0,             -- sum of all scores (for avg calculation)
    
    first_played TIMESTAMPTZ DEFAULT NOW(),
    last_played TIMESTAMPTZ DEFAULT NOW(),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES for fast queries
-- ============================================

-- Fast lookup: all scores for a tournament (sorted by rank)
CREATE INDEX IF NOT EXISTS idx_scores_tournament ON tournament_scores(tournament_id, best_score ASC);

-- Fast lookup: all tournaments a user played
CREATE INDEX IF NOT EXISTS idx_scores_user ON tournament_scores(user_id);

-- Fast lookup: tournaments by date
CREATE INDEX IF NOT EXISTS idx_tournaments_date ON tournaments(started_at DESC);

-- Fast lookup: top users by wins
CREATE INDEX IF NOT EXISTS idx_users_wins ON users(total_wins DESC);

-- Fast lookup: top users by best score
CREATE INDEX IF NOT EXISTS idx_users_best ON users(best_ever_score ASC);

-- ============================================
-- RLS (Row Level Security) - Optional for now
-- ============================================
-- ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tournament_scores ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
