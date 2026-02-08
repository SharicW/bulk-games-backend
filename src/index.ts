import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { PokerGame } from './poker/game.js';
import type { PlayerAction } from './types.js';
import { UnoGame } from './uno/game.js';
import type { UnoPlayerAction } from './uno/types.js';
import { runMigrations } from './migrate.js';
import authRouter, { verifyToken, type AuthUser } from './auth.js';

const app = express();
const httpServer = createServer(app);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://bulk-games-frontend-production.up.railway.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

// You can override in Railway with: CORS_ORIGIN=https://your-frontend-domain,https://another-domain
const ALLOWED_ORIGINS: string[] = (process.env.CORS_ORIGIN || process.env.FRONTEND_URL)
  ? (process.env.CORS_ORIGIN || process.env.FRONTEND_URL)!.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

const corsOptions: CorsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / curl requests (no Origin header)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

/* ── Express middleware ────────────────────────────────────────── */
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

/* ── Auth / profile routes ─────────────────────────────────────── */
app.use(authRouter);

/* ── Socket.IO ─────────────────────────────────────────────────── */
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

/* ── Socket auth middleware ────────────────────────────────────── */
async function socketAuth(
  socket: import('socket.io').Socket,
  next: (err?: Error) => void,
): Promise<void> {
  const token: string | undefined = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  const user = await verifyToken(token);
  if (!user) {
    return next(new Error('Invalid or expired token'));
  }
  socket.data.user = user;
  next();
}

io.use(socketAuth);
io.of('/uno').use(socketAuth);
io.of('/poker').use(socketAuth);

/* ── Game instances ────────────────────────────────────────────── */
type GameType = 'poker' | 'uno';

const socketToPlayer = new Map<string, { odotpid: string; lobbyCode: string; gameType: GameType }>();
const playerToSocket = new Map<string, string>();

const pokerGame = new PokerGame((lobbyCode: string) => {
  broadcastGameState(lobbyCode);
});

const unoGame = new UnoGame(
  (lobbyCode: string) => {
    broadcastUnoState(lobbyCode);
  },
  (code: string) => !!pokerGame.getLobby(code),
);

/* ── Broadcast helpers ─────────────────────────────────────────── */
function broadcastGameState(lobbyCode: string): void {
  const lobby = pokerGame.getLobby(lobbyCode);
  if (!lobby) return;
  for (const player of lobby.players) {
    const socketId = playerToSocket.get(`poker:${player.playerId}`);
    if (socketId) {
      const clientState = pokerGame.getClientState(lobbyCode, player.playerId);
      io.to(socketId).emit('gameState', clientState);
    }
  }
}

function broadcastUnoState(lobbyCode: string): void {
  const lobby = unoGame.getLobby(lobbyCode);
  if (!lobby) return;
  for (const player of lobby.players) {
    const socketId = playerToSocket.get(`uno:${player.playerId}`);
    if (socketId) {
      const clientState = unoGame.getClientState(lobbyCode, player.playerId);
      io.of('/uno').to(socketId).emit('gameState', clientState);
    }
  }
}

/* ── REST endpoints (examples) ─────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ── Socket events: Poker ──────────────────────────────────────── */
io.on('connection', (socket) => {
  const user = socket.data.user as AuthUser;

  socket.on('joinLobby', ({ lobbyCode }: { lobbyCode: string }) => {
    const lobby = pokerGame.joinLobby(lobbyCode, user.odotpid, user.nickname);
    socket.join(lobbyCode);

    socketToPlayer.set(socket.id, { odotpid: user.odotpid, lobbyCode, gameType: 'poker' });
    playerToSocket.set(`poker:${user.odotpid}`, socket.id);

    broadcastGameState(lobbyCode);
    io.to(lobbyCode).emit('lobbyUpdate', lobby);
  });

  socket.on('leaveLobby', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    pokerGame.leaveLobby(info.lobbyCode, info.odotpid);

    socket.leave(info.lobbyCode);
    socketToPlayer.delete(socket.id);
    playerToSocket.delete(`poker:${info.odotpid}`);

    broadcastGameState(info.lobbyCode);
  });

  socket.on('startGame', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    pokerGame.startGame(info.lobbyCode);
    broadcastGameState(info.lobbyCode);
  });

  socket.on('playerAction', (action: PlayerAction) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    pokerGame.handleAction(info.lobbyCode, info.odotpid, action);
    broadcastGameState(info.lobbyCode);
  });

  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    if (info.gameType === 'poker') {
      pokerGame.leaveLobby(info.lobbyCode, info.odotpid);
      playerToSocket.delete(`poker:${info.odotpid}`);
      broadcastGameState(info.lobbyCode);
    }

    socketToPlayer.delete(socket.id);
  });
});

/* ── Socket events: UNO namespace ───────────────────────────────── */
io.of('/uno').on('connection', (socket) => {
  const user = socket.data.user as AuthUser;

  socket.on('joinLobby', ({ lobbyCode }: { lobbyCode: string }) => {
    const lobby = unoGame.joinLobby(lobbyCode, user.odotpid, user.nickname);
    socket.join(lobbyCode);

    socketToPlayer.set(socket.id, { odotpid: user.odotpid, lobbyCode, gameType: 'uno' });
    playerToSocket.set(`uno:${user.odotpid}`, socket.id);

    broadcastUnoState(lobbyCode);
    io.of('/uno').to(lobbyCode).emit('lobbyUpdate', lobby);
  });

  socket.on('leaveLobby', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    unoGame.leaveLobby(info.lobbyCode, info.odotpid);

    socket.leave(info.lobbyCode);
    socketToPlayer.delete(socket.id);
    playerToSocket.delete(`uno:${info.odotpid}`);

    broadcastUnoState(info.lobbyCode);
  });

  socket.on('startGame', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    unoGame.startGame(info.lobbyCode);
    broadcastUnoState(info.lobbyCode);
  });

  socket.on('playerAction', (action: UnoPlayerAction) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    unoGame.handleAction(info.lobbyCode, info.odotpid, action);
    broadcastUnoState(info.lobbyCode);
  });

  socket.on('disconnect', () => {
    const info = socketToPlayer.get(socket.id);
    if (!info) return;

    if (info.gameType === 'uno') {
      unoGame.leaveLobby(info.lobbyCode, info.odotpid);
      playerToSocket.delete(`uno:${info.odotpid}`);
      broadcastUnoState(info.lobbyCode);
    }

    socketToPlayer.delete(socket.id);
  });
});

/* ── Start server ──────────────────────────────────────────────── */
const PORT = Number(process.env.PORT ?? 3000);

(async () => {
  await runMigrations();
  httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
})();
