import pool from './db.js';

const UP = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('host', 'player')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
`;

/* ── V2: coins + cosmetics ─────────────────────────────────────── */
const V2 = `
-- Add coins column to users (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'coins'
  ) THEN
    ALTER TABLE users ADD COLUMN coins INT NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Add equipped_border column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'equipped_border'
  ) THEN
    ALTER TABLE users ADD COLUMN equipped_border TEXT;
  END IF;
END $$;

-- Add equipped_effect column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'equipped_effect'
  ) THEN
    ALTER TABLE users ADD COLUMN equipped_effect TEXT;
  END IF;
END $$;

-- Cosmetics inventory table
CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
`;

/* ── V3: wins tracking ─────────────────────────────────────────── */
const V3 = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'wins_poker'
  ) THEN
    ALTER TABLE users ADD COLUMN wins_poker INT NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'wins_uno'
  ) THEN
    ALTER TABLE users ADD COLUMN wins_uno INT NOT NULL DEFAULT 0;
  END IF;
END $$;
`;

export async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  await pool.query(UP);
  console.log('V1 migrations complete.');
  await pool.query(V2);
  console.log('V2 migrations (coins + cosmetics) complete.');
  await pool.query(V3);
  console.log('V3 migrations (wins) complete.');
}
