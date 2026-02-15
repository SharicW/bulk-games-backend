import { Router, type Request, type Response } from 'express';
import pool from './db.js';
import { authMiddleware } from './auth.js';

type By = 'coins' | 'wins';

function parseBy(v: unknown): By | null {
  if (v === 'coins' || v === 'wins') return v;
  return null;
}

function limitInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const by = parseBy(req.query.by);
    if (!by) {
      res.status(400).json({ error: 'Invalid by' });
      return;
    }
    const limit = limitInt(req.query.limit, 10, 1, 50);

    const metricExpr = by === 'coins' ? 'u.coins' : '(u.wins_poker + u.wins_uno)';

    const q = `
      SELECT
        ranked.rank::int AS rank,
        ranked.id,
        ranked.nickname,
        ranked.avatar_url,
        ranked.coins::int AS coins,
        ranked.wins::int AS wins
      FROM (
        SELECT
          RANK() OVER (ORDER BY ${metricExpr} DESC, u.id ASC) AS rank,
          u.id,
          u.nickname,
          u.avatar_url,
          u.coins,
          (u.wins_poker + u.wins_uno) AS wins
        FROM users u
      ) ranked
      ORDER BY ranked.rank ASC
      LIMIT $1
    `;

    const r = await pool.query(q, [limit]);
    res.json({ by, limit, rows: r.rows.map((x: any) => ({
      rank: x.rank,
      userId: x.id,
      nickname: x.nickname,
      avatarUrl: x.avatar_url ?? null,
      coins: x.coins ?? 0,
      wins: x.wins ?? 0,
    })) });
  } catch (err) {
    console.error('GET /leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const by = parseBy(req.query.by);
    if (!by) {
      res.status(400).json({ error: 'Invalid by' });
      return;
    }
    const userId = req.user!.id;
    const metricExpr = by === 'coins' ? 'u.coins' : '(u.wins_poker + u.wins_uno)';

    const q = `
      SELECT rank::int AS rank, id, nickname, avatar_url, coins::int AS coins, wins::int AS wins
      FROM (
        SELECT
          RANK() OVER (ORDER BY ${metricExpr} DESC, u.id ASC) AS rank,
          u.id,
          u.nickname,
          u.avatar_url,
          u.coins,
          (u.wins_poker + u.wins_uno) AS wins
        FROM users u
      ) ranked
      WHERE id = $1
      LIMIT 1
    `;
    const r = await pool.query(q, [userId]);
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      by,
      me: {
        rank: row.rank,
        userId: row.id,
        nickname: row.nickname,
        avatarUrl: row.avatar_url ?? null,
        coins: row.coins ?? 0,
        wins: row.wins ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /leaderboard/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;


