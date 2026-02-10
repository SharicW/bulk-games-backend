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

const app = express();
const httpServer = createServer(app);

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
io.of('/uno').use(socketAuth);
io.of('/poker').use(socketAuth);

/* ───────────────────── Games ───────────────────────── */

type GameType = 'poker' | 'uno';

const socketToPlayer = new Map<string, { userId: string; lobbyCode: string; gameType: GameType }>();
const playerToSocket = new Map<string, string>();

const pokerGame = new PokerGame((code) => broadcastGameState(code));
const unoGame = new UnoGame(
  (code) => broadcastUnoState(code),
  (code) => !!pokerGame.getLobby(code),
);

function roomName(gameType: GameType, code: string) {
  return `${gameType}:${code}`;
}

/* ───────────────── Broadcast helpers ───────────────── */

function broadcastGameState(code: string) {
  const lobby = pokerGame.getLobby(code);
  if (!lobby) return;

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`poker:${p.playerId}`);
    if (!socketId) continue;
    io.to(socketId).emit('gameState', pokerGame.getClientState(code, p.playerId));
  }
}

function broadcastUnoState(code: string) {
  const lobby = unoGame.getLobby(code);
  if (!lobby) return;

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`uno:${p.playerId}`);
    if (!socketId) continue;
    io.to(socketId).emit('gameState', unoGame.getClientState(code, p.playerId));
  }
}

/* ───────────────── Socket handlers ─────────────────── */

function inferGameType(nspName: string, payload?: any): GameType {
  if (nspName === '/uno') return 'uno';
  if (nspName === '/poker') return 'poker';
  // root namespace: rely on payload.gameType if sent
  if (payload?.gameType === 'uno') return 'uno';
  return 'poker';
}

function attachHandlers(nsp: ReturnType<Server['of']>) {
  nsp.on('connection', (socket) => {
    const user: AuthUser = socket.data.user;

    socket.emit('test', { message: 'Backend works', userId: user.id });

    socket.on('createLobby', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);

      if (user.role !== 'host') {
        ack?.({ success: false, error: 'Only host can create lobby' });
        return;
      }

      if (gameType === 'uno') {
        const code = unoGame.createLobby(user.id, user.nickname, user.avatarUrl);
        socket.join(roomName('uno', code));
        socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'uno' });
        playerToSocket.set(`uno:${user.id}`, socket.id);

        ack?.({ success: true, code });
        broadcastUnoState(code);
        return;
      }

      const code = pokerGame.createLobby(user.id, user.nickname, user.avatarUrl);
      socket.join(roomName('poker', code));
      socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);

      ack?.({ success: true, code });
      broadcastGameState(code);
    });

    socket.on('joinLobby', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const code: string | undefined = payload?.code;

      if (!code) {
        ack?.({ success: false, error: 'Lobby code is required' });
        return;
      }

      if (gameType === 'uno') {
        const res = unoGame.joinLobby(code, user.id, user.nickname, user.avatarUrl);
        if (!res.success) {
          ack?.(res);
          return;
        }

        socket.join(roomName('uno', code));
        socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'uno' });
        playerToSocket.set(`uno:${user.id}`, socket.id);

        ack?.({ success: true, gameState: unoGame.getClientState(code, user.id) });
        broadcastUnoState(code);
        return;
      }

      const ok = pokerGame.joinLobby(code, user.id, user.nickname, user.avatarUrl);
      if (!ok) {
        ack?.({ success: false, error: 'Lobby not found or full' });
        return;
      }

      socket.join(roomName('poker', code));
      socketToPlayer.set(socket.id, { userId: user.id, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);

      ack?.({ success: true, gameState: pokerGame.getClientState(code, user.id) });
      broadcastGameState(code);
    });

    socket.on('startGame', (payload: any, ack?: (r: any) => void) => {
      const gameType = inferGameType(nsp.name, payload);
      const lobbyCode: string | undefined = payload?.lobbyCode;

      if (!lobbyCode) {
        ack?.({ success: false, error: 'lobbyCode is required' });
        return;
      }

      if (gameType === 'uno') {
        const res = unoGame.startGame(lobbyCode, user.id);
        if (!res.success) {
          ack?.(res);
          return;
        }
        ack?.({ success: true });
        broadcastUnoState(lobbyCode);
        return;
      }

      const ok = pokerGame.startGame(lobbyCode, user.id);
      if (!ok) {
        ack?.({ success: false, error: 'Only host can start / not enough players / already started' });
        return;
      }
      ack?.({ success: true });
      broadcastGameState(lobbyCode);
    });

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
          ack?.({ success: false, error: 'action is required' });
          return;
        }
        const res = unoGame.handleAction(lobbyCode, user.id, action);
        if (!res.success) {
          ack?.(res);
          return;
        }
        ack?.({ success: true });
        broadcastUnoState(lobbyCode);
        return;
      }

      const action: PlayerAction | undefined = payload?.action;
      const amount: number | undefined = payload?.amount;

      if (!action) {
        ack?.({ success: false, error: 'action is required' });
        return;
      }

      const ok = pokerGame.handleAction(lobbyCode, user.id, action, amount);
      if (!ok) {
        ack?.({ success: false, error: 'Invalid action / not your turn / lobby not found' });
        return;
      }

      ack?.({ success: true });
      broadcastGameState(lobbyCode);
    });

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
        io.in(roomName('uno', lobbyCode)).emit('lobbyEnded');
        ack?.({ success: true });
        return;
      }

      const ok = pokerGame.endLobby(lobbyCode, user.id);
      if (!ok) {
        ack?.({ success: false, error: 'Only host can end the lobby / lobby not found' });
        return;
      }
      io.in(roomName('poker', lobbyCode)).emit('lobbyEnded');
      ack?.({ success: true });
    });

    socket.on('disconnect', () => {
      const info = socketToPlayer.get(socket.id);
      if (!info) return;

      const { userId, lobbyCode, gameType } = info;

      socketToPlayer.delete(socket.id);
      playerToSocket.delete(`${gameType}:${userId}`);

      if (gameType === 'uno') {
        unoGame.leaveLobby(lobbyCode, userId);
        broadcastUnoState(lobbyCode);
      } else {
        pokerGame.leaveLobby(lobbyCode, userId);
        broadcastGameState(lobbyCode);
      }
    });
  });
}

/* attach to all */
attachHandlers(io);
attachHandlers(io.of('/uno'));
attachHandlers(io.of('/poker'));

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
