import express from 'express';
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

const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? (process.env.FRONTEND_URL || 'https://bulk-games-frontend-production.up.railway.app')
  : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

/* ── Express middleware ────────────────────────────────────────── */
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
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
    if (!socketId) continue;
    const clientState = unoGame.getClientState(lobbyCode, player.playerId);
    io.to(socketId).emit('unoState', clientState);
    io.to(socketId).emit('gameState', clientState);
  }
}

/* ── Utility parsers ───────────────────────────────────────────── */
function parseGameType(raw: any): GameType | null {
  const v = raw?.gameType ?? raw?.game ?? raw?.type;
  if (v === 'poker' || v === 'uno') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'poker' || s === 'uno') return s as GameType;
  }
  return null;
}

function detectGameTypeByLobbyCode(code: string): GameType | null {
  if (pokerGame.getLobby(code)) return 'poker';
  if (unoGame.getLobby(code)) return 'uno';
  return null;
}

function parseUnoAction(raw: any): UnoPlayerAction | null {
  if (!raw) return null;
  const a = raw.action && typeof raw.action === 'object' ? raw.action : raw;
  const t = a.type ?? a.action;
  if (t === 'draw') return { type: 'draw' };
  if (t === 'pass') return { type: 'pass' };
  if (t === 'play') {
    const cardId = a.cardId ?? raw.cardId;
    const chosenColor = a.chosenColor ?? raw.chosenColor;
    if (typeof cardId !== 'string' || cardId.length === 0) return null;
    if (chosenColor && !['red', 'green', 'blue', 'yellow'].includes(String(chosenColor))) return null;
    return { type: 'play', cardId, chosenColor };
  }
  return null;
}

/* ── Socket handlers ───────────────────────────────────────────── */
function registerHandlers(nsp: ReturnType<Server['of']> | Server): void {
  nsp.on('connection', (socket) => {
    const user: AuthUser = socket.data.user;
    console.log(`✅ Client connected: ${socket.id} user=${user.id} (${user.nickname})`);
    socket.emit('test', { message: 'Backend works!', timestamp: Date.now() });

    const handleCreateLobby = (data: any, callback: any) => {
      // Only hosts can create lobbies
      if (user.role !== 'host') {
        return callback({ success: false, error: 'Only hosts can create lobbies' });
      }

      const gameType = parseGameType(data) || 'poker';

      if (gameType === 'uno') {
        const lobbyCode = unoGame.createLobby(user.id);
        const joinResult = unoGame.joinLobby(lobbyCode, user.id, user.nickname, user.avatarUrl);
        if (!joinResult.success) return callback({ success: false, error: joinResult.error });

        socket.join(lobbyCode);
        socketToPlayer.set(socket.id, { odotpid: user.id, lobbyCode, gameType });
        playerToSocket.set(`uno:${user.id}`, socket.id);

        const state = unoGame.getClientState(lobbyCode, user.id);
        callback({ success: true, code: lobbyCode, gameState: state });
        broadcastUnoState(lobbyCode);
        return;
      }

      const lobbyCode = pokerGame.createLobby(user.id);
      const joinResult = pokerGame.joinLobby(lobbyCode, user.id, user.nickname, user.avatarUrl);

      if (!joinResult.success) return callback({ success: false, error: joinResult.error });

      socket.join(lobbyCode);
      socketToPlayer.set(socket.id, { odotpid: user.id, lobbyCode, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);

      const state = pokerGame.getClientState(lobbyCode, user.id);
      callback({ success: true, code: lobbyCode, gameState: state });
    };

    const handleJoinLobby = (data: any, callback: any) => {
      const code: string = data?.code ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(code) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.joinLobby(code, user.id, user.nickname, user.avatarUrl);
        if (!result.success) return callback({ success: false, error: result.error });

        socket.join(code);
        socketToPlayer.set(socket.id, { odotpid: user.id, lobbyCode: code, gameType });
        playerToSocket.set(`uno:${user.id}`, socket.id);

        const state = unoGame.getClientState(code, user.id);
        callback({ success: true, gameState: state });
        broadcastUnoState(code);
        return;
      }

      const result = pokerGame.joinLobby(code, user.id, user.nickname, user.avatarUrl);
      if (!result.success) return callback({ success: false, error: result.error });

      socket.join(code);
      socketToPlayer.set(socket.id, { odotpid: user.id, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${user.id}`, socket.id);

      const state = pokerGame.getClientState(code, user.id);
      callback({ success: true, gameState: state });
      broadcastGameState(code);
    };

    const handleLeaveLobby = (data: any, callback?: any) => {
      const lobbyCode: string = data?.lobbyCode ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        unoGame.leaveLobby(lobbyCode, user.id);
        socket.leave(lobbyCode);
        socketToPlayer.delete(socket.id);
        playerToSocket.delete(`uno:${user.id}`);
        broadcastUnoState(lobbyCode);
        callback?.({ success: true });
        return;
      }

      pokerGame.leaveLobby(lobbyCode, user.id);
      socket.leave(lobbyCode);
      socketToPlayer.delete(socket.id);
      playerToSocket.delete(`poker:${user.id}`);
      broadcastGameState(lobbyCode);
      callback?.({ success: true });
    };

    const handleStartGame = (data: any, callback: any) => {
      const lobbyCode: string = data?.lobbyCode ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.startGame(lobbyCode, user.id);
        callback(result);
        if (result.success) broadcastUnoState(lobbyCode);
        return;
      }

      const result = pokerGame.startGame(lobbyCode, user.id);
      callback(result);
      if (result.success) broadcastGameState(lobbyCode);
    };

    const handlePlayerAction = (data: any, callback: any) => {
      const lobbyCode: string = data?.lobbyCode ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const action = parseUnoAction(data);
        if (!action) return callback({ success: false, error: 'Invalid UNO action' });
        const result = unoGame.handleAction(lobbyCode, user.id, action);
        callback(result);
        return;
      }

      const { action, amount } = data as { action: PlayerAction; amount?: number };
      const result = pokerGame.handleAction(lobbyCode, user.id, action, amount);
      callback(result);
    };

    const handleRequestState = (data: any, callback: any) => {
      const lobbyCode: string = data?.lobbyCode ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const state = unoGame.getClientState(lobbyCode, user.id);
        callback({ success: !!state, gameState: state });
        return;
      }

      const state = pokerGame.getClientState(lobbyCode, user.id);
      callback({ success: !!state, gameState: state });
    };

    const handleEndLobby = (data: any, callback: any) => {
      const lobbyCode: string = data?.lobbyCode ?? '';
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.endLobby(lobbyCode, user.id);
        if (result.success) io.to(lobbyCode).emit('lobbyEnded');
        callback(result);
        return;
      }

      const result = pokerGame.endLobby(lobbyCode, user.id);
      if (result.success) io.to(lobbyCode).emit('lobbyEnded');
      callback(result);
    };

    socket.on('createLobby', handleCreateLobby);
    socket.on('joinLobby', handleJoinLobby);
    socket.on('leaveLobby', handleLeaveLobby);
    socket.on('startGame', handleStartGame);
    socket.on('playerAction', handlePlayerAction);
    socket.on('requestState', handleRequestState);
    socket.on('endLobby', handleEndLobby);

    // UNO aliases
    socket.on('uno:createLobby', (d: any, cb: any) => handleCreateLobby({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:joinLobby', (d: any, cb: any) => handleJoinLobby({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:leaveLobby', (d: any, cb: any) => handleLeaveLobby({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:startGame', (d: any, cb: any) => handleStartGame({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:playerAction', (d: any, cb: any) => handlePlayerAction({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:requestState', (d: any, cb: any) => handleRequestState({ ...d, gameType: 'uno' }, cb));
    socket.on('uno:endLobby', (d: any, cb: any) => handleEndLobby({ ...d, gameType: 'uno' }, cb));

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      const playerInfo = socketToPlayer.get(socket.id);
      if (playerInfo) {
        const { odotpid, lobbyCode, gameType } = playerInfo;
        if (gameType === 'uno') {
          unoGame.leaveLobby(lobbyCode, odotpid);
          socketToPlayer.delete(socket.id);
          playerToSocket.delete(`uno:${odotpid}`);
          broadcastUnoState(lobbyCode);
          return;
        }
        pokerGame.leaveLobby(lobbyCode, odotpid);
        socketToPlayer.delete(socket.id);
        playerToSocket.delete(`poker:${odotpid}`);
        broadcastGameState(lobbyCode);
      }
    });
  });
}

registerHandlers(io);
registerHandlers(io.of('/uno'));
registerHandlers(io.of('/poker'));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/* ── Start server ──────────────────────────────────────────────── */
const PORT = process.env.PORT || 3001;

async function boot(): Promise<void> {
  try {
    await runMigrations();
    console.log('Database ready.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

boot();