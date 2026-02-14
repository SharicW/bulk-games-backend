import express, { type Request, type Response } from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';

import { PokerGame } from './poker/game.js';
import type { PlayerAction } from './types.js';
import { UnoGame } from './uno/game.js';
import type { UnoPlayerAction } from './uno/types.js';
import { runMigrations } from './migrate.js';
import authRouter, { verifyToken, type AuthUser } from './auth.js';
import shopRouter from './shop.js';
import pool from './db.js';

const IS_DEV = process.env.NODE_ENV !== 'production';

const app = express();
const httpServer = createServer(app);

/** Fetch equipped cosmetics for a user from DB */
async function fetchUserCosmetics(userId: string | number): Promise<{ equippedBorder: string | null; equippedEffect: string | null }> {
  try {
    const res = await pool.query('SELECT equipped_border, equipped_effect FROM users WHERE id = $1', [userId]);
    if (res.rows.length > 0) {
      return { equippedBorder: res.rows[0].equipped_border ?? null, equippedEffect: res.rows[0].equipped_effect ?? null };
    }
  } catch (e) {
    console.error('[fetchUserCosmetics] DB error', e);
  }
  return { equippedBorder: null, equippedEffect: null };
}

/* ───────────────────────── CORS ───────────────────────── */

const normalizeOrigin = (o: string) => o.trim().replace(/\/$/, '').toLowerCase();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://bulk-games-frontend-production.up.railway.app',
  'http://localhost:5173',
  'http://localhost:3000',
].map(normalizeOrigin);

const RAILWAY_FRONTEND_REGEX =
  /^https:\/\/bulk-games-frontend[a-z0-9-]*\.up\.railway\.app$/;

const ENV_ALLOWED_ORIGINS = (
  process.env.CORS_ORIGIN ||
  process.env.FRONTEND_URL ||
  ''
)
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...ENV_ALLOWED_ORIGINS]);

function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin) return true;
  const o = normalizeOrigin(origin);
  return ALLOWED_ORIGINS.has(o) || RAILWAY_FRONTEND_REGEX.test(o);
}

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.warn('[CORS] Blocked origin:', origin);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// preflight
app.options('*', cors());

/* ───────────────────── Middleware ───────────────────── */

app.use(express.json({ limit: '5mb' }));

/* ───────────────────── Routes ───────────────────────── */

app.use('/auth', authRouter);
app.use('/shop', shopRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/* ───────────────────── Socket.IO ────────────────────── */

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
    methods: ['GET', 'POST'],
  },
});

/* Namespace references — used for broadcasting on the correct namespace */
const pokerNsp = io.of('/poker');
const unoNsp = io.of('/uno');

/* ───────────────── Socket auth ───────────────── */

async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token: string | undefined = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  const user = await verifyToken(token);
  if (!user) return next(new Error('Invalid token'));

  socket.data.user = user;
  next();
}

/* apply auth to all namespaces */
io.use(socketAuth);
unoNsp.use(socketAuth);
pokerNsp.use(socketAuth);

/* ───────────────────── Games ───────────────────────── */

type GameType = 'poker' | 'uno';

const socketToPlayer = new Map<string, { userId: string; lobbyCode: string; gameType: GameType }>();
const playerToSocket = new Map<string, string>();

/** Pending disconnect timers — key is `${gameType}:${userId}` */
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Grace period before treating a disconnect as "left" (handles F5/reconnect) */
const DISCONNECT_GRACE_MS = 15_000;

const pokerGame = new PokerGame((code) => broadcastPokerState(code));
const unoGame = new UnoGame(
  (code) => broadcastUnoState(code),
  (code) => !!pokerGame.getLobby(code),
);

// ── Persistent public rooms (always available) ─────────────────────────
const POKER_PUBLIC_CODES = ['POKER_PUBLIC_1', 'POKER_PUBLIC_2', 'POKER_PUBLIC_3'] as const;
const UNO_PUBLIC_CODES = ['UNO_PUBLIC_1', 'UNO_PUBLIC_2', 'UNO_PUBLIC_3'] as const;

for (const code of POKER_PUBLIC_CODES) {
  if (!pokerGame.getLobby(code)) pokerGame.createPublicLobby(code);
}
for (const code of UNO_PUBLIC_CODES) {
  if (!unoGame.getLobby(code)) unoGame.createPublicLobby(code);
}

function roomName(gameType: GameType, code: string) {
  return `${gameType}:${code}`;
}

/* ───────────────── Broadcast helpers ───────────────── */
/*
 * CRITICAL FIX: emit on the correct namespace, not on `io` (root namespace).
 * Clients connect to /poker or /uno — their socket IDs only exist there.
 */

async function broadcastPokerState(code: string) {
  const lobby = pokerGame.getLobby(code);
  if (!lobby) return;

  // ── Award +5 coins to poker winner(s) (exactly once per hand) ──
  if (lobby.street === 'showdown' && !lobby.rewardIssued) {
    const results = pokerGame.getShowdownResults(code);
    if (results) {
      pokerGame.markRewardIssued(code);
      const winnerIds = results.filter((r: any) => r.winnings > 0).map((r: any) => r.playerId);
      for (const wid of winnerIds) {
        try {
          await pool.query(
            'UPDATE users SET coins = coins + 5, updated_at = now() WHERE id = $1',
            [wid],
          );
          console.log(`[reward:poker] +5 coins to winner ${wid} in ${code}`);
        } catch (err) {
          console.error('[reward:poker] Failed to award coins:', err);
        }
      }
    }
  }

  if (IS_DEV) console.log(`[broadcast:poker] ${code} → ${lobby.players.length} players v${lobby.version ?? 0}`);

  // ── Emit celebration ONCE per celebration.id (visible to everyone) ──
  maybeEmitCelebration('poker', code, lobby.celebration ?? null);

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`poker:${p.playerId}`);
    if (!socketId) continue;
    const clientState = pokerGame.getClientState(code, p.playerId);
    if (clientState) {
      pokerNsp.to(socketId).emit('gameState', clientState);
    }
  }
}

async function broadcastUnoState(code: string) {
  const lobby = unoGame.getLobby(code);
  if (!lobby) return;

  // ── Award +5 coins to winner (exactly once) ──
  if (lobby.winnerId && !lobby.rewardIssued) {
    unoGame.markRewardIssued(code);
    try {
      await pool.query(
        'UPDATE users SET coins = coins + 5, updated_at = now() WHERE id = $1',
        [lobby.winnerId],
      );
      console.log(`[reward:uno] +5 coins to winner ${lobby.winnerId} in ${code}`);
    } catch (err) {
      console.error('[reward:uno] Failed to award coins:', err);
    }
  }

  if (IS_DEV) console.log(`[broadcast:uno] ${code} → ${lobby.players.length} players v${lobby.version ?? 0}`);

  // ── Emit celebration ONCE per celebration.id (visible to everyone) ──
  maybeEmitCelebration('uno', code, lobby.celebration ?? null);

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`uno:${p.playerId}`);
    if (!socketId) continue;
    const clientState = unoGame.getClientState(code, p.playerId);
    if (clientState) {
      unoNsp.to(socketId).emit('gameState', clientState);
    }
  }
}

// ── Celebration dedupe emitter ─────────────────────────────────────────
const lastCelebrationEmitted = new Map<string, string>(); // key: `${gameType}:${code}` → celebrationId
function maybeEmitCelebration(
  gameType: GameType,
  code: string,
  celebration: null | { id: string; winnerId: string; effectId: string; createdAt: number },
) {
  if (!celebration?.id) return;
  const key = `${gameType}:${code}`;
  if (lastCelebrationEmitted.get(key) === celebration.id) return;
  lastCelebrationEmitted.set(key, celebration.id);

  const payload = { winnerId: celebration.winnerId, effectId: celebration.effectId, id: celebration.id };
  if (IS_DEV) console.log(`[celebration:${gameType}] code=${code} winner=${payload.winnerId} effect=${payload.effectId} id=${payload.id}`);

  if (gameType === 'poker') pokerNsp.in(roomName('poker', code)).emit('game:celebration', payload);
  else unoNsp.in(roomName('uno', code)).emit('game:celebration', payload);
}

// ── Public rooms listing (HTTP + socket) ───────────────────────────────
function listPublicRooms(gameType?: GameType) {
  const out: any[] = [];
  if (!gameType || gameType === 'poker') {
    for (const code of POKER_PUBLIC_CODES) {
      const l = pokerGame.getLobby(code);
      out.push({
        gameType: 'poker',
        code,
        playerCount: l ? l.players.filter(p => p.isConnected).length : 0,
        status: l?.gameStarted ? 'in_game' : 'lobby',
        maxPlayers: l?.maxPlayers ?? 9,
      });
    }
  }
  if (!gameType || gameType === 'uno') {
    for (const code of UNO_PUBLIC_CODES) {
      const l = unoGame.getLobby(code);
      out.push({
        gameType: 'uno',
        code,
        playerCount: l ? l.players.filter(p => p.isConnected).length : 0,
        status: l?.gameStarted ? 'in_game' : 'lobby',
        maxPlayers: l?.maxPlayers ?? 10,
      });
    }
  }
  return out;
}

app.get('/public/rooms', (req: Request, res: Response) => {
  const gt = (req.query.gameType as any) as GameType | undefined;
  if (gt && gt !== 'poker' && gt !== 'uno') {
    res.status(400).json({ error: 'Invalid gameType' });
    return;
  }
  res.json({ rooms: listPublicRooms(gt) });
});

/* ───────────────── Socket handlers ─────────────────── */

function inferGameType(nspName: string, payload?: any): GameType {
  if (nspName === '/uno') return 'uno';
  if (nspName === '/poker') return 'poker';
  if (payload?.gameType === 'uno') return 'uno';
  return 'poker';
}

function attachHandlers(nsp: ReturnType<Server['of']>) {
  nsp.on('connection', (socket) => {
    const user: AuthUser = socket.data.user;
    if (IS_DEV) console.log(`[connect] ${nsp.name} userId=${user.id} socketId=${socket.id} role=${user.role}`);

    socket.emit('test', { message: 'Backend works', userId: user.id });

    socket.on('listPublicRooms', (payload: any, ack?: (r: any) => void) => {
      const gameType = payload?.gameType as GameType | undefined;
      ack?.({ success: true, rooms: listPublicRooms(gameType) });
    });

    /* ── createLobby ─────────────────────────────────────── */

    socket.on('createLobby', async (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);

      if (user.role !== 'host') {
        ack?.({ success: false, error: 'Only host can create lobby' });
        return;
      }

      const cosmetics = await fetchUserCosmetics(user.id);

      if (gameType === 'uno') {
        const code = unoGame.createLobby(user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
      if (IS_DEV) console.log(`[createLobby:uno] code=${code} hostId=${user.id}`);
        socket.join(roomName('uno', code));
        socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'uno' });
        playerToSocket.set(`uno:${user.id}`, socket.id);
        cancelDisconnectTimer('uno', user.id);

        ack?.({ success: true, code });
        broadcastUnoState(code);
        return;
      }

      const code = pokerGame.createLobby(user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
      if (IS_DEV) console.log(`[createLobby:poker] code=${code} hostId=${user.id}`);
      socket.join(roomName('poker', code));
      socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);
      cancelDisconnectTimer('poker', user.id);

      ack?.({ success: true, code });
      broadcastPokerState(code);
    });

    /* ── joinLobby ───────────────────────────────────────── */

    socket.on('joinLobby', async (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const code: string | undefined = payload?.code;

      if (!code) {
        ack?.({ success: false, error: 'Lobby code is required' });
        return;
      }

      const cosmetics = await fetchUserCosmetics(user.id);

      if (gameType === 'uno') {
        const res = unoGame.joinLobby(code, user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
        if (!res.success) {
          ack?.(res);
          return;
        }

        if (IS_DEV) console.log(`[joinLobby:uno] code=${code} userId=${user.id} (reconnect=${!!cancelDisconnectTimer('uno', user.id)})`);
        socket.join(roomName('uno', code));
        socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'uno' });
        playerToSocket.set(`uno:${user.id}`, socket.id);

        ack?.({ success: true, gameState: unoGame.getClientState(code, user.id) });
        broadcastUnoState(code);
        return;
      }

      /* Poker */
      const res = pokerGame.joinLobby(code, user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
      if (!res.success) {
        ack?.({ success: false, error: res.error || 'Lobby not found or full' });
        return;
      }

      if (IS_DEV) console.log(`[joinLobby:poker] code=${code} userId=${user.id} (reconnect=${!!cancelDisconnectTimer('poker', user.id)})`);
      socket.join(roomName('poker', code));
      socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);

      ack?.({ success: true, gameState: pokerGame.getClientState(code, user.id) });
      broadcastPokerState(code);
    });

    /* ── startGame ───────────────────────────────────────── */

    socket.on('startGame', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const lobbyCode: string | undefined = payload?.lobbyCode;

      if (!lobbyCode) {
        ack?.({ success: false, error: 'lobbyCode is required' });
        return;
      }

      if (gameType === 'uno') {
        const res = unoGame.startGame(lobbyCode, user.id);
        if (IS_DEV) console.log(`[startGame:uno] code=${lobbyCode} userId=${user.id} success=${res.success} error=${res.error || ''}`);
        if (!res.success) {
          ack?.({ ...res, accepted: false, reason: res.error });
          return;
        }
        const unoLobby = unoGame.getLobby(lobbyCode);
        ack?.({ success: true, accepted: true, version: unoLobby?.version ?? 0 });
        broadcastUnoState(lobbyCode);
        return;
      }

      /* Poker */
      const res = pokerGame.startGame(lobbyCode, user.id);
      if (IS_DEV) console.log(`[startGame:poker] code=${lobbyCode} userId=${user.id} success=${res.success} error=${res.error || ''}`);
      if (!res.success) {
        ack?.({ success: false, accepted: false, reason: res.error || 'Only host can start / not enough players / already started', error: res.error || 'Only host can start / not enough players / already started' });
        return;
      }
      const pokerLobby = pokerGame.getLobby(lobbyCode);
      ack?.({ success: true, accepted: true, version: pokerLobby?.version ?? 0 });
      broadcastPokerState(lobbyCode);
    });

    /* ── playerAction ────────────────────────────────────── */

    socket.on('playerAction', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const lobbyCode: string | undefined = payload?.lobbyCode;

      if (!lobbyCode) {
        ack?.({ success: false, error: 'lobbyCode is required' });
        return;
      }

      if (gameType === 'uno') {
        const action: UnoPlayerAction | undefined = payload?.action;
        if (!action) {
          ack?.({ success: false, accepted: false, reason: 'action is required', error: 'action is required' });
          return;
        }
        const res = unoGame.handleAction(lobbyCode, user.id, action);
        if (!res.success) {
          ack?.({ ...res, accepted: false, reason: res.error });
          return;
        }
        ack?.({ success: true, accepted: true, version: (res as any).version ?? 0 });
        broadcastUnoState(lobbyCode);
        return;
      }

      /* Poker */
      const action: PlayerAction | undefined = payload?.action;
      const amount: number | undefined = payload?.amount;

      if (!action) {
        ack?.({ success: false, accepted: false, reason: 'action is required', error: 'action is required' });
        return;
      }

      const res = pokerGame.handleAction(lobbyCode, user.id, action, amount);
      if (!res.success) {
        ack?.({ success: false, accepted: false, reason: res.error || 'Invalid action', error: res.error || 'Invalid action / not your turn / lobby not found' });
        return;
      }

      ack?.({ success: true, accepted: true, version: (res as any).version ?? 0 });
      broadcastPokerState(lobbyCode);
    });

    /* ── requestState ────────────────────────────────────── */

    socket.on('requestState', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const lobbyCode: string | undefined = payload?.lobbyCode;

      if (!lobbyCode) {
        ack?.({ success: false, error: 'lobbyCode is required' });
        return;
      }

      if (gameType === 'uno') {
        const lobby = unoGame.getLobby(lobbyCode);
        if (!lobby) {
          ack?.({ success: false, error: 'Lobby not found' });
          return;
        }
        ack?.({ success: true, gameState: unoGame.getClientState(lobbyCode, user.id) });
        return;
      }

      const lobby = pokerGame.getLobby(lobbyCode);
      if (!lobby) {
        ack?.({ success: false, error: 'Lobby not found' });
        return;
      }
      ack?.({ success: true, gameState: pokerGame.getClientState(lobbyCode, user.id) });
    });

    /* ── endLobby ────────────────────────────────────────── */

    socket.on('endLobby', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const lobbyCode: string | undefined = payload?.lobbyCode;

      if (!lobbyCode) {
        ack?.({ success: false, error: 'lobbyCode is required' });
        return;
      }

      if (gameType === 'uno') {
        const res = unoGame.endLobby(lobbyCode, user.id);
        if (!res.success) {
          ack?.(res);
          return;
        }
        /* Emit lobbyEnded on the CORRECT namespace */
        unoNsp.in(roomName('uno', lobbyCode)).emit('lobbyEnded');
        ack?.({ success: true });
        return;
      }

      /* Poker */
      const res = pokerGame.endLobby(lobbyCode, user.id);
      if (!res.success) {
        ack?.({ success: false, error: res.error || 'Only host can end the lobby / lobby not found' });
        return;
      }
      pokerNsp.in(roomName('poker', lobbyCode)).emit('lobbyEnded');
      ack?.({ success: true });
    });

    /* ── disconnect ──────────────────────────────────────── */
    /*
     * Grace period: on disconnect we DON'T immediately call leaveLobby.
     * We mark the player as disconnected and start a timer.
     * If the same userId reconnects (join) before the timer expires,
     * the timer is cancelled (see cancelDisconnectTimer in joinLobby).
     * This prevents host-jumping on F5.
     *
     * Race-condition guard: if the playerToSocket mapping already points
     * to a DIFFERENT socket (new connection arrived first), we skip cleanup.
     */

    socket.on('disconnect', () => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return;

      const { userId, lobbyCode, gameType } = info;
      socketToPlayer.delete(socket.id);

      const mapKey = `${gameType}:${userId}`;

      /* If a newer socket already replaced this one, do nothing */
      const currentSocketId = playerToSocket.get(mapKey);
      if (currentSocketId && currentSocketId !== socket.id) {
        console.log(`[disconnect] ${nsp.name} userId=${userId} socketId=${socket.id} — already replaced by ${currentSocketId}, skip`);
        return;
      }

      if (IS_DEV) console.log(`[disconnect] ${nsp.name} userId=${userId} socketId=${socket.id} code=${lobbyCode} — starting ${DISCONNECT_GRACE_MS}ms grace`);

      /* Mark player as disconnected right away so others see the status */
      if (gameType === 'uno') {
        const lobby = unoGame.getLobby(lobbyCode);
        if (lobby) {
          const p = lobby.players.find(pl => pl.playerId === userId);
          if (p) {
            p.isConnected = false;
            p.lastSeenAt = Date.now();
          }
          broadcastUnoState(lobbyCode);
        }
      } else {
        const lobby = pokerGame.getLobby(lobbyCode);
        if (lobby) {
          const p = lobby.players.find(pl => pl.playerId === userId);
          if (p) p.isConnected = false;
          broadcastPokerState(lobbyCode);
        }
      }

      /* Start grace-period timer */
      const timer = setTimeout(() => {
        disconnectTimers.delete(mapKey);

        /* Double-check: if the player reconnected in the meantime, skip */
        const nowSocket = playerToSocket.get(mapKey);
        if (nowSocket && nowSocket !== socket.id) {
          if (IS_DEV) console.log(`[disconnect:grace] ${mapKey} — player reconnected (${nowSocket}), skip leave`);
          return;
        }

        playerToSocket.delete(mapKey);
        if (IS_DEV) console.log(`[disconnect:grace] ${mapKey} — grace expired, executing leaveLobby`);

        if (gameType === 'uno') {
          unoGame.leaveLobby(lobbyCode, userId);
          broadcastUnoState(lobbyCode);
        } else {
          pokerGame.leaveLobby(lobbyCode, userId);
          broadcastPokerState(lobbyCode);
        }
      }, DISCONNECT_GRACE_MS);

      disconnectTimers.set(mapKey, timer);
    });
  });
}

/**
 * Cancel a pending disconnect timer for a player.
 * Returns true if a timer was cancelled (i.e. this was a reconnect).
 */
function cancelDisconnectTimer(gameType: GameType, userId: string): boolean {
  const key = `${gameType}:${userId}`;
  const timer = disconnectTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
    if (IS_DEV) console.log(`[reconnect] cancelled disconnect timer for ${key}`);
    return true;
  }
  return false;
}

/* attach to all namespaces */
attachHandlers(io.of('/'));
attachHandlers(unoNsp);
attachHandlers(pokerNsp);

/* ───────────────────── Start ───────────────────────── */

const PORT = process.env.PORT || 3001;

async function boot() {
  try {
    await runMigrations();
    console.log('Database ready');
    httpServer.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  }
}

boot();
