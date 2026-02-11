import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'bulk-games-jwt-secret-dev';
const TOKEN_EXPIRY = '7d';
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/* ─── Types ─────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: 'host' | 'player';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/* ─── Helpers ───────────────────────────────────────────────────── */

function rowToUser(row: any): AuthUser {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    avatarUrl: row.avatar_url ?? null,
    role: row.role,
  };
}

/* ─── Middleware (Express) ──────────────────────────────────────── */

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = header.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const sess = await pool.query(
      'SELECT id FROM sessions WHERE token = $1 AND expires_at > now()',
      [token],
    );
    if (sess.rows.length === 0) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    const usr = await pool.query(
      'SELECT id, email, nickname, avatar_url, role FROM users WHERE id = $1',
      [decoded.userId],
    );
    if (usr.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = rowToUser(usr.rows[0]);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* ─── Token verifier (for Socket.IO) ──────────────────────────── */

export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const sess = await pool.query(
      'SELECT id FROM sessions WHERE token = $1 AND expires_at > now()',
      [token],
    );
    if (sess.rows.length === 0) return null;

    const usr = await pool.query(
      'SELECT id, email, nickname, avatar_url, role FROM users WHERE id = $1',
      [decoded.userId],
    );
    if (usr.rows.length === 0) return null;

    return rowToUser(usr.rows[0]);
  } catch {
    return null;
  }
}

/* ─── Router ────────────────────────────────────────────────────── */

const router = Router();

// ── POST /auth/register ────────────────────────────────────────
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, nickname } = req.body ?? {};

    if (!email || !String(email).includes('@')) {
      res.status(400).json({ error: 'Please enter a valid email' });
      return;
    }
    if (!password || String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }
    if (!nickname || !String(nickname).trim()) {
      res.status(400).json({ error: 'Please enter a nickname' });
      return;
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'User with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, nickname, role)
       VALUES (LOWER($1), $2, $3, 'player')
       RETURNING id, email, nickname, avatar_url, role`,
      [email, passwordHash, String(nickname).trim()],
    );

    const user = ins.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt],
    );

    res.json({ success: true, token, user: rowToUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/login ───────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, nickname, avatar_url, role FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const row = result.rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    const token = jwt.sign({ userId: row.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [row.id, token, expiresAt],
    );

    res.json({ success: true, token, user: rowToUser(row) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/logout ──────────────────────────────────────────
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization!.slice(7);
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me ────────────────────────────────────────────────────
router.get('/me', authMiddleware, (_req: Request, res: Response) => {
  const u = _req.user!;
  res.json({ id: u.id, email: u.email, nickname: u.nickname, avatarUrl: u.avatarUrl, role: u.role });
});

// ── PATCH /me ──────────────────────────────────────────────────
router.patch('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { nickname, avatarUrl, oldPassword, newPassword } = req.body ?? {};
    const userId = req.user!.id;

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (nickname !== undefined) {
      if (!String(nickname).trim()) {
        res.status(400).json({ error: 'Nickname cannot be empty' });
        return;
      }
      updates.push(`nickname = $${idx++}`);
      values.push(String(nickname).trim());
    }

    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${idx++}`);
      values.push(avatarUrl);
    }

    if (newPassword) {
      if (!oldPassword) {
        res.status(400).json({ error: 'Current password required' });
        return;
      }
      if (String(newPassword).length < 6) {
        res.status(400).json({ error: 'New password must be at least 6 characters' });
        return;
      }
      const cur = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
      const valid = await bcrypt.compare(oldPassword, cur.rows[0].password_hash);
      if (!valid) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }
      const hash = await bcrypt.hash(newPassword, 12);
      updates.push(`password_hash = $${idx++}`);
      values.push(hash);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    updates.push('updated_at = now()');
    values.push(userId);

    const q = `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, nickname, avatar_url, role`;
    const result = await pool.query(q, values);
    const user = result.rows[0];

    res.json({ success: true, user: rowToUser(user) });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

