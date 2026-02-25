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
import leaderboardRouter from './leaderboard.js';
import pool from './db.js';

const IS_DEV = process.env.NODE_ENV !== 'production';
const logInfo = (...args: any[]) => console.log(...args);
const logWarn = (...args: any[]) => console.warn(...args);

const app = express();
const httpServer = createServer(app);

/** Fetch equipped cosmetics for a user from DB.
 *  Includes a hard timeout so a slow/hung DB query never blocks joinLobby. */
const COSMETICS_TIMEOUT_MS = 2500;
async function fetchUserCosmetics(userId: string | number): Promise<{ equippedBorder: string | null; equippedEffect: string | null }> {
  try {
    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('cosmetics query timeout')), COSMETICS_TIMEOUT_MS),
    );
    const res = await Promise.race([
      pool.query('SELECT equipped_border, equipped_effect FROM users WHERE id = $1', [userId]),
      timeoutPromise,
    ]);
    if (res && res.rows.length > 0) {
      return { equippedBorder: res.rows[0].equipped_border ?? null, equippedEffect: res.rows[0].equipped_effect ?? null };
    }
  } catch (e) {
    console.error('[fetchUserCosmetics] DB error/timeout', e);
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

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));

// preflight — use the SAME config so mobile browsers see consistent
// Access-Control-Allow-Origin between preflight and actual responses.
app.options('*', cors(corsOptions));

/* ───────────────────── Middleware ───────────────────── */

app.use(express.json({ limit: '5mb' }));

/* ───────────────────── Routes ───────────────────────── */

app.use('/auth', authRouter);
app.use('/shop', shopRouter);
app.use('/leaderboard', leaderboardRouter);

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
  // pingInterval: how often the server sends a ping (kept < 30 s so Railway's
  //   30 s proxy idle-timeout never fires — the ping resets the idle timer).
  // pingTimeout: how long the server waits for a pong before disconnecting.
  //   Must be generous enough to survive Railway's added latency (10-15 ms in
  //   good conditions, but can spike to several seconds under load).
  //   30 s gives a comfortable buffer while still detecting dead sockets.
  //   Dead-socket window = pingInterval(20s) + pingTimeout(30s) = 50 s.
  //
  // ⚠️  DO NOT lower pingTimeout below 25 s on Railway.
  //   A previous change set it to 20 s which caused false "ping timeout"
  //   disconnects → auto-reconnect → joinLobby timeout loops on both
  //   mobile AND desktop.  This reverts it to the original correct value.
  pingInterval: 20000,
  pingTimeout: 30000,
  // Allow both transports; websocket is preferred, polling is the fallback.
  // Railway supports websockets natively; polling adds latency.
  transports: ['websocket', 'polling'],
});

/* Namespace references — used for broadcasting on the correct namespace */
const pokerNsp = io.of('/poker');
const unoNsp = io.of('/uno');

/* ───────────────── Socket auth ───────────────── */

async function socketAuth(socket: Socket, next: (err?: Error) => void): Promise<void> {
  const token: string | undefined = socket.handshake.auth?.token;
  if (!token) {
    logWarn(`[socketAuth] missing token nsp=${socket.nsp.name} socketId=${socket.id}`);
    return next(new Error('Authentication required'));
  }

  const user = await verifyToken(token);
  if (!user) {
    logWarn(`[socketAuth] invalid token nsp=${socket.nsp.name} socketId=${socket.id}`);
    return next(new Error('Invalid token'));
  }

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

/**
 * Tracks which lobby each user is currently in (across ALL game types).
 * Key: userId  →  Value: { gameType, lobbyCode }
 * This prevents a single account from joining multiple lobbies simultaneously.
 */
const userActiveLobby = new Map<string, { gameType: GameType; lobbyCode: string }>();

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
  if (!pokerGame.getLobby(code)) {
    pokerGame.createPublicLobby(code);
    logInfo(`[publicRooms] created poker ${code}`);
  }
}
for (const code of UNO_PUBLIC_CODES) {
  if (!unoGame.getLobby(code)) {
    unoGame.createPublicLobby(code);
    logInfo(`[publicRooms] created uno ${code}`);
  }
}
logInfo(`[publicRooms] ready poker=${POKER_PUBLIC_CODES.join(',')} uno=${UNO_PUBLIC_CODES.join(',')}`);

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
            'UPDATE users SET coins = coins + 5, wins_poker = wins_poker + 1, updated_at = now() WHERE id = $1',
            [wid],
          );
          console.log(`[reward:poker] +5 coins to winner ${wid} in ${code}`);
        } catch (err) {
          console.error('[reward:poker] Failed to award coins:', err);
        }
      }
    }
  }

  if (IS_DEV) console.log(`[broadcast:poker] ${code} -> ${lobby.players.length} players v${lobby.version ?? 0}`);

  // ── Emit celebration ONCE per celebration.id (visible to everyone) ──
  maybeEmitCelebration('poker', code, lobby.celebration ?? null);

  const recipients = [...lobby.players, ...((lobby as any).spectators || [])];
  for (const p of recipients) {
    const socketId = playerToSocket.get(`poker:${p.playerId}`);
    if (!socketId) continue;
    const clientState = pokerGame.getClientState(code, p.playerId);
    if (clientState) {
      pokerNsp.to(socketId).emit('gameState', clientState);
    }
  }

  // ── Notify winners to choose show/hide (once at showdown entry) ──
  if (lobby.street === 'showdown' && lobby.rewardIssued) {
    const results = pokerGame.getShowdownResults(code);
    const winnerIds = results ? results.filter((r: any) => r.winnings > 0).map((r: any) => r.playerId) : [];
    for (const wid of winnerIds) {
      const socketId = playerToSocket.get(`poker:${wid}`);
      if (socketId) {
        const player = lobby.players.find(p => p.playerId === wid);
        // Only prompt if not yet decided (cardsRevealed is false = default hidden, undecided)
        if (player && player.cardsRevealed === false) {
          pokerNsp.to(socketId).emit('poker:showdownChoice');
        }
      }
    }
  }
}

async function broadcastUnoState(code: string) {
  const lobby = unoGame.getLobby(code);
  if (!lobby) {
    if (IS_DEV) console.log(`[broadcast:uno] ${code} - lobby not found, skip`);
    return;
  }

  // ── Award +5 coins to winner (exactly once) ──
  if (lobby.winnerId && !lobby.rewardIssued) {
    unoGame.markRewardIssued(code);
    try {
      await pool.query(
        'UPDATE users SET coins = coins + 5, wins_uno = wins_uno + 1, updated_at = now() WHERE id = $1',
        [lobby.winnerId],
      );
      console.log(`[reward:uno] +5 coins to winner ${lobby.winnerId} in ${code}`);
    } catch (err) {
      console.error('[reward:uno] Failed to award coins:', err);
    }
  }

  if (IS_DEV) console.log(`[broadcast:uno] ${code} -> ${lobby.players.length} players v${lobby.version ?? 0}`);

  // ── Emit celebration ONCE per celebration.id (visible to everyone) ──
  maybeEmitCelebration('uno', code, lobby.celebration ?? null);

  const recipients = [...lobby.players, ...((lobby as any).spectators || [])];
  let emittedCount = 0;
  for (const p of recipients) {
    const socketId = playerToSocket.get(`uno:${p.playerId}`);
    if (!socketId) {
      if (IS_DEV) console.log(`[broadcast:uno] ${code} - no socketId for ${p.playerId}, skip`);
      continue;
    }
    const clientState = unoGame.getClientState(code, p.playerId);
    if (clientState) {
      unoNsp.to(socketId).emit('gameState', clientState);
      emittedCount++;
    }
  }
  if (IS_DEV) console.log(`[broadcast:uno] ${code} - emitted gameState to ${emittedCount}/${recipients.length} recipients v${lobby.version ?? 0}`);

  if (lobby.phase === 'lobby') {
    unoNsp.in(roomName('uno', code)).emit('uno:roster', {
      version: lobby.version ?? 0,
      players: lobby.players.map((p) => ({
        playerId: p.playerId,
        seatIndex: p.seatIndex,
        nickname: p.nickname,
        avatarUrl: p.avatarUrl,
        isConnected: p.isConnected,
        lastSeenAt: p.lastSeenAt,
        cardCount: 0,
        equippedBorder: p.equippedBorder ?? null,
        equippedEffect: p.equippedEffect ?? null,
      })),
    });
  }
}

// ── Celebration dedupe emitter ─────────────────────────────────────────
const lastCelebrationEmitted = new Map<string, string>(); // key: `${gameType}:${code}` -> celebrationId
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
    // Always log connects (concise — safe for production, helps mobile debugging)
    logInfo(`[connect] ${nsp.name} userId=${user.id} socketId=${socket.id}`);

    socket.emit('test', { message: 'Backend works', userId: user.id });

    socket.on('listPublicRooms', (payload: any, ack?: (r: any) => void) => {
      const gameType = payload?.gameType as GameType | undefined;
      ack?.({ success: true, rooms: listPublicRooms(gameType) });
    });

    /* ── createLobby ─────────────────────────────────────── */

    socket.on('createLobby', async (payload: any, ack?: (r: any) => void) => {
      try {
        const gameType = inferGameType(nsp.name, payload);

        if (user.role !== 'host') {
          ack?.({ success: false, error: 'Only host can create lobby' });
          return;
        }

        // ── Multi-lobby guard ────────────────────────────────────────────
        const existingLobby = userActiveLobby.get(user.id);
        if (existingLobby) {
          ack?.({ success: false, error: `You are already in a ${existingLobby.gameType.toUpperCase()} lobby (${existingLobby.lobbyCode}). Leave it first.` });
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
          userActiveLobby.set(user.id, { gameType: 'uno', lobbyCode: code });

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
        userActiveLobby.set(user.id, { gameType: 'poker', lobbyCode: code });

        ack?.({ success: true, code });
        broadcastPokerState(code);
      } catch (err: any) {
        console.error(`[createLobby] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
    });

    /* ── joinLobby ───────────────────────────────────────── */

    socket.on('joinLobby', async (payload: any, ack?: (r: any) => void) => {
      try {
        const gameType = inferGameType(nsp.name, payload);
        const code: string | undefined = payload?.code;

        if (!code) {
          ack?.({ success: false, error: 'Lobby code is required' });
          return;
        }

        // Minimal prod-safe join logs (helps debug Railway issues)
        logInfo(`[joinLobby:req] nsp=${nsp.name} gameType=${gameType} code=${code} userId=${user.id}`);

        // ── Multi-lobby guard ────────────────────────────────────────────
        // Allow reconnects to the SAME lobby (same gameType + code).
        // Block cross-lobby or cross-game joins.
        const existingLobby = userActiveLobby.get(user.id);
        if (existingLobby && !(existingLobby.gameType === gameType && existingLobby.lobbyCode === code)) {
          const msg = `You are already in a ${existingLobby.gameType.toUpperCase()} lobby (${existingLobby.lobbyCode}). Leave it first.`;
          logWarn(`[joinLobby:multiLobby] userId=${user.id} blocked — already in ${existingLobby.gameType}:${existingLobby.lobbyCode}`);
          ack?.({ success: false, error: msg });
          return;
        }

        const cosmetics = await fetchUserCosmetics(user.id);

        if (gameType === 'uno') {
          const res = unoGame.joinLobby(code, user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
          if (!res.success) {
            logWarn(`[joinLobby:reject] gameType=uno code=${code} userId=${user.id} reason=${res.error || 'unknown'}`);
            ack?.(res);
            return;
          }

          const wasReconnect = cancelDisconnectTimer('uno', user.id);
          if (IS_DEV) console.log(`[joinLobby:uno] code=${code} userId=${user.id} (reconnect=${!!wasReconnect})`);
          socket.join(roomName('uno', code));
          socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'uno' });
          playerToSocket.set(`uno:${user.id}`, socket.id);
          userActiveLobby.set(user.id, { gameType: 'uno', lobbyCode: code });

          ack?.({ success: true, gameState: unoGame.getClientState(code, user.id) });
          broadcastUnoState(code);
          const l = unoGame.getLobby(code);
          logInfo(`[joinLobby:ok] gameType=uno code=${code} userId=${user.id} players=${l?.players.filter(p => p.isConnected).length ?? 0} spectators=${l?.spectators?.length ?? 0}`);
          return;
        }

        /* Poker */
        const res = pokerGame.joinLobby(code, user.id, user.nickname, user.avatarUrl, cosmetics.equippedBorder, cosmetics.equippedEffect);
        if (!res.success) {
          logWarn(`[joinLobby:reject] gameType=poker code=${code} userId=${user.id} reason=${res.error || 'unknown'}`);
          ack?.({ success: false, error: res.error || 'Lobby not found or full' });
          return;
        }

        const wasReconnect = cancelDisconnectTimer('poker', user.id);
        if (IS_DEV) console.log(`[joinLobby:poker] code=${code} userId=${user.id} (reconnect=${!!wasReconnect})`);
        socket.join(roomName('poker', code));
        socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'poker' });
        playerToSocket.set(`poker:${user.id}`, socket.id);
        userActiveLobby.set(user.id, { gameType: 'poker', lobbyCode: code });

        ack?.({ success: true, gameState: pokerGame.getClientState(code, user.id) });
        broadcastPokerState(code);
        const l = pokerGame.getLobby(code);
        logInfo(`[joinLobby:ok] gameType=poker code=${code} userId=${user.id} players=${l?.players.filter(p => p.isConnected).length ?? 0}`);
      } catch (err: any) {
        console.error(`[joinLobby] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
    });

    /* ── startGame ───────────────────────────────────────── */

    socket.on('startGame', (payload: any, ack?: (r: any) => void) => {
      try {
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
      } catch (err: any) {
        console.error(`[startGame] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error', accepted: false });
      }
    });

    /* ── playerAction ────────────────────────────────────── */

    socket.on('playerAction', (payload: any, ack?: (r: any) => void) => {
      // CRITICAL: entire handler is wrapped in try-catch so ack is ALWAYS called,
      // even on unexpected exceptions.  Without this, a thrown error would leave
      // the client waiting 8 000 ms for the timeout.
      try {
        const gameType = inferGameType(nsp.name, payload);
        const lobbyCode: string | undefined = payload?.lobbyCode;

        if (!lobbyCode) {
          ack?.({ success: false, error: 'lobbyCode is required' });
          return;
        }

        if (gameType === 'uno') {
          const lobby = unoGame.getLobby(lobbyCode);
          if (lobby && (lobby as any).spectators?.some((s: any) => s.playerId === user.id)) {
            ack?.({ success: false, accepted: false, reason: 'Spectators cannot act', error: 'Spectators cannot act' });
            return;
          }
          const action: UnoPlayerAction | undefined = payload?.action;
          if (!action) {
            ack?.({ success: false, accepted: false, reason: 'action is required', error: 'action is required' });
            return;
          }

          if (IS_DEV) logInfo(`[playerAction:uno] code=${lobbyCode} userId=${user.id} type=${action.type}`);

          const res = unoGame.handleAction(lobbyCode, user.id, action);

          if (IS_DEV) logInfo(`[playerAction:uno] code=${lobbyCode} userId=${user.id} type=${action.type} ok=${res.success} err=${res.error ?? ''} - ack sent`);

          if (!res.success) {
            ack?.({ ...res, accepted: false, reason: res.error });
            return;
          }
          const gameState = unoGame.getClientState(lobbyCode, user.id);
          // Include drawnCard in ACK for draw actions (drawer only — never leaked to room)
          const drawnCard = (res as any).drawnCard ?? undefined;
          ack?.({ success: true, accepted: true, version: (res as any).version ?? 0, gameState, drawnCard });
          broadcastUnoState(lobbyCode);

          // Notify room of draw for opponent card-back animation.
          // Intentionally contains NO card face — only the drawer sees the real card via ACK.
          if (action.type === 'draw') {
            unoNsp.in(roomName('uno', lobbyCode)).emit('uno:drawFx', { playerId: user.id, count: 1 });
          }
          return;
        }

        /* Poker */
        const lobby = pokerGame.getLobby(lobbyCode);
        if (lobby && (lobby as any).spectators?.some((s: any) => s.playerId === user.id)) {
          ack?.({ success: false, accepted: false, reason: 'Spectators cannot act', error: 'Spectators cannot act' });
          return;
        }
        const action: PlayerAction | undefined = payload?.action;
        const amount: number | undefined = payload?.amount;

        if (!action) {
          ack?.({ success: false, accepted: false, reason: 'action is required', error: 'action is required' });
          return;
        }

        if (IS_DEV) logInfo(`[playerAction:poker] code=${lobbyCode} userId=${user.id} action=${action} amount=${amount ?? ''}`);

        const res = pokerGame.handleAction(lobbyCode, user.id, action, amount);

        if (IS_DEV) logInfo(`[playerAction:poker] code=${lobbyCode} userId=${user.id} action=${action} ok=${res.success} err=${res.error ?? ''} - ack sent`);

        if (!res.success) {
          ack?.({ success: false, accepted: false, reason: res.error || 'Invalid action', error: res.error || 'Invalid action / not your turn / lobby not found' });
          return;
        }

        const gameState = pokerGame.getClientState(lobbyCode, user.id);
        ack?.({ success: true, accepted: true, version: (res as any).version ?? 0, gameState });
        broadcastPokerState(lobbyCode);
      } catch (err: any) {
        console.error(`[playerAction] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error', accepted: false });
      }
    });

    /* ── requestState ────────────────────────────────────── */

    socket.on('requestState', (payload: any, ack?: (r: any) => void) => {
      try {
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
          if (IS_DEV) logInfo(`[requestState:uno] code=${lobbyCode} userId=${user.id} v=${lobby.version}`);
          ack?.({ success: true, gameState: unoGame.getClientState(lobbyCode, user.id) });
          return;
        }

        const lobby = pokerGame.getLobby(lobbyCode);
        if (!lobby) {
          ack?.({ success: false, error: 'Lobby not found' });
          return;
        }
        ack?.({ success: true, gameState: pokerGame.getClientState(lobbyCode, user.id) });
      } catch (err: any) {
        console.error(`[requestState] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
    });

    /* ── poker:revealCards ───────────────────────────────────── */

    socket.on('poker:revealCards', (payload: any, ack?: (r: any) => void) => {
      try {
        const lobbyCode: string | undefined = payload?.lobbyCode;
        const reveal: boolean = !!payload?.reveal;

        if (!lobbyCode) {
          ack?.({ success: false, error: 'lobbyCode is required' });
          return;
        }

        const res = pokerGame.revealCards(lobbyCode, user.id, reveal);
        ack?.(res);
      } catch (err: any) {
        console.error(`[poker:revealCards] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
    });

    /* ── endLobby ────────────────────────────────────────── */

    socket.on('endLobby', (payload: any, ack?: (r: any) => void) => {
      try {
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
      } catch (err: any) {
        console.error(`[endLobby] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
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
        console.log(`[disconnect] ${nsp.name} userId=${userId} socketId=${socket.id} - already replaced by ${currentSocketId}, skip`);
        return;
      }

      logInfo(`[disconnect] ${nsp.name} userId=${userId} socketId=${socket.id} code=${lobbyCode} - grace ${DISCONNECT_GRACE_MS}ms`);

      /* Mark player as disconnected right away so others see the status.
       * We must bump the lobby version here so the broadcast carries a new
       * version number; otherwise clients whose lastVersion == current version
       * would silently drop the update as a "stale duplicate". */
      if (gameType === 'uno') {
        const lobby = unoGame.getLobby(lobbyCode);
        if (lobby) {
          const p = lobby.players.find(pl => pl.playerId === userId);
          if (p) {
            p.isConnected = false;
            p.lastSeenAt = Date.now();
          }
          unoGame.bumpVersion(lobbyCode); // increments version -> broadcast inside
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
          if (IS_DEV) console.log(`[disconnect:grace] ${mapKey} - player reconnected (${nowSocket}), skip leave`);
          return;
        }

        playerToSocket.delete(mapKey);
        // Clear active lobby entry — player fully left after grace period
        const currentActive = userActiveLobby.get(userId);
        if (currentActive && currentActive.gameType === gameType && currentActive.lobbyCode === lobbyCode) {
          userActiveLobby.delete(userId);
        }
        if (IS_DEV) console.log(`[disconnect:grace] ${mapKey} - grace expired, executing leaveLobby`);

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

    socket.on('leaveLobby', (payload: any, ack?: (r: any) => void) => {
      try {
        const gameType = inferGameType(nsp.name, payload);
        const lobbyCode: string | undefined = payload?.lobbyCode;
        if (!lobbyCode) {
          ack?.({ success: false, error: 'lobbyCode is required' });
          return;
        }

        const mapKey = `${gameType}:${user.id}`;
        socketToPlayer.delete(socket.id);
        playerToSocket.delete(mapKey);
        cancelDisconnectTimer(gameType, user.id);
        // Clear active lobby — explicit leave always removes the entry
        userActiveLobby.delete(user.id);

        try { socket.leave(roomName(gameType, lobbyCode)); } catch { }

        if (gameType === 'uno') {
          unoGame.leaveLobby(lobbyCode, user.id);
          broadcastUnoState(lobbyCode);
          ack?.({ success: true });
          return;
        }

        pokerGame.leaveLobby(lobbyCode, user.id);
        broadcastPokerState(lobbyCode);
        ack?.({ success: true });
      } catch (err: any) {
        console.error(`[leaveLobby] uncaught error userId=${user.id}:`, err?.message || err);
        ack?.({ success: false, error: 'Internal server error' });
      }
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
    logInfo(`[reconnect] cancelled grace timer for ${key} (mobile rejoin)`);
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
