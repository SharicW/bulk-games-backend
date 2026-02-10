import express, { type Request, type Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
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

const normalizeOrigin = (o: string) =>
  o.trim().replace(/\/$/, '').toLowerCase();

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

const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...ENV_ALLOWED_ORIGINS,
]);

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
  })
);

// ОБЯЗАТЕЛЬНО для preflight
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

async function socketAuth(
  socket: import('socket.io').Socket,
  next: (err?: Error) => void,
): Promise<void> {
  const token: string | undefined = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  const user = await verifyToken(token);
  if (!user) return next(new Error('Invalid token'));

  socket.data.user = user;
  next();
}

io.use(socketAuth);
io.of('/uno').use(socketAuth);
io.of('/poker').use(socketAuth);

/* ───────────────────── Games ───────────────────────── */

type GameType = 'poker' | 'uno';

const socketToPlayer = new Map<
  string,
  { userId: string; lobbyCode: string; gameType: GameType }
>();
const playerToSocket = new Map<string, string>();

const pokerGame = new PokerGame((code) => broadcastGameState(code));
const unoGame = new UnoGame(
  (code) => broadcastUnoState(code),
  (code) => !!pokerGame.getLobby(code),
);

/* ───────────────── Broadcast helpers ───────────────── */

function broadcastGameState(code: string) {
  const lobby = pokerGame.getLobby(code);
  if (!lobby) return;

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`poker:${p.playerId}`);
    if (!socketId) continue;
    io.to(socketId).emit(
      'gameState',
      pokerGame.getClientState(code, p.playerId),
    );
  }
}

function broadcastUnoState(code: string) {
  const lobby = unoGame.getLobby(code);
  if (!lobby) return;

  for (const p of lobby.players) {
    const socketId = playerToSocket.get(`uno:${p.playerId}`);
    if (!socketId) continue;
    io.to(socketId).emit(
      'gameState',
      unoGame.getClientState(code, p.playerId),
    );
  }
}

/* ───────────────── Socket handlers ─────────────────── */

function registerHandlers(nsp: Server | ReturnType<Server['of']>) {
  nsp.on('connection', (socket) => {
    const user: AuthUser = socket.data.user;

    socket.emit('test', {
      message: 'Backend works',
      userId: user.id,
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

registerHandlers(io);
registerHandlers(io.of('/uno'));
registerHandlers(io.of('/poker'));

/* ───────────────────── Start ───────────────────────── */

const PORT = process.env.PORT || 3001;

async function boot() {
  try {
    await runMigrations();
    console.log('Database ready');
    httpServer.listen(PORT, () =>
      console.log(`🚀 Server running on ${PORT}`),
    );
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  }
}

boot();
