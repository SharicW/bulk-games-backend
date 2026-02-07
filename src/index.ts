import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { PokerGame } from './poker/game.js';
import type { PlayerAction } from './types.js';
import { UnoGame } from './uno/game.js';
import type { UnoPlayerAction } from './uno/types.js';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.FRONTEND_URL || "https://bulk-games-frontend-production.up.railway.app")
    : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
  credentials: true
}
});


// Store socket to player mappings
type GameType = 'poker' | 'uno';
const socketToPlayer = new Map<string, { odotpid: string; lobbyCode: string; gameType: GameType }>();
const playerToSocket = new Map<string, string>(); // key: `${gameType}:${odotpid}`

// Initialize poker game
const pokerGame = new PokerGame((lobbyCode: string) => {
  broadcastGameState(lobbyCode);
});

// Initialize UNO game
const unoGame = new UnoGame(
  (lobbyCode: string) => {
    broadcastUnoState(lobbyCode);
  },
  (code: string) => !!pokerGame.getLobby(code),
);

function broadcastGameState(lobbyCode: string): void {
  const lobby = pokerGame.getLobby(lobbyCode);
  if (!lobby) return;
  
  // Send personalized state to each player
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

  // shapes:
  // - { type: 'play'|'draw'|'pass', ... }
  // - { action: { type: ... } }
  // - { action: 'play'|'draw'|'pass', cardId?, chosenColor? }
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

function registerHandlers(nsp: ReturnType<Server['of']> | Server): void {
  nsp.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id} from ${socket.handshake.address}`);
    socket.emit('test', { message: 'Backend works!', timestamp: Date.now() });

    const handleCreateLobby = (data: { odotpid: string; nickname: string; avatarUrl: string | null; gameType?: string }, callback: any) => {
      const { odotpid, nickname, avatarUrl } = data;
      const gameType = parseGameType(data) || 'poker';

      if (gameType === 'uno') {
        const lobbyCode = unoGame.createLobby(odotpid);
        const joinResult = unoGame.joinLobby(lobbyCode, odotpid, nickname, avatarUrl);
        if (!joinResult.success) return callback({ success: false, error: joinResult.error });

        socket.join(lobbyCode);
        socketToPlayer.set(socket.id, { odotpid, lobbyCode, gameType });
        playerToSocket.set(`uno:${odotpid}`, socket.id);

        const state = unoGame.getClientState(lobbyCode, odotpid);
        callback({ success: true, code: lobbyCode, gameState: state });
        broadcastUnoState(lobbyCode);
        return;
      }

      const lobbyCode = pokerGame.createLobby(odotpid);
      const joinResult = pokerGame.joinLobby(lobbyCode, odotpid, nickname, avatarUrl);

      if (!joinResult.success) return callback({ success: false, error: joinResult.error });

      socket.join(lobbyCode);
      socketToPlayer.set(socket.id, { odotpid, lobbyCode, gameType: 'poker' });
      playerToSocket.set(`poker:${odotpid}`, socket.id);

      const state = pokerGame.getClientState(lobbyCode, odotpid);
      callback({ success: true, code: lobbyCode, gameState: state });
    };

    const handleJoinLobby = (
      data: { code: string; odotpid: string; nickname: string; avatarUrl: string | null; gameType?: string },
      callback: any,
    ) => {
      const { code, odotpid, nickname, avatarUrl } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(code) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.joinLobby(code, odotpid, nickname, avatarUrl);
        if (!result.success) return callback({ success: false, error: result.error });

        socket.join(code);
        socketToPlayer.set(socket.id, { odotpid, lobbyCode: code, gameType });
        playerToSocket.set(`uno:${odotpid}`, socket.id);

        const state = unoGame.getClientState(code, odotpid);
        callback({ success: true, gameState: state });
        broadcastUnoState(code);
        return;
      }

      const result = pokerGame.joinLobby(code, odotpid, nickname, avatarUrl);
      if (!result.success) return callback({ success: false, error: result.error });

      socket.join(code);
      socketToPlayer.set(socket.id, { odotpid, lobbyCode: code, gameType: 'poker' });
      playerToSocket.set(`poker:${odotpid}`, socket.id);

      const state = pokerGame.getClientState(code, odotpid);
      callback({ success: true, gameState: state });
      broadcastGameState(code);
    };

    const handleLeaveLobby = (data: { lobbyCode: string; odotpid: string; gameType?: string }, callback?: any) => {
      const { lobbyCode, odotpid } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        unoGame.leaveLobby(lobbyCode, odotpid);
        socket.leave(lobbyCode);
        socketToPlayer.delete(socket.id);
        playerToSocket.delete(`uno:${odotpid}`);
        broadcastUnoState(lobbyCode);
        callback?.({ success: true });
        return;
      }

      pokerGame.leaveLobby(lobbyCode, odotpid);
      socket.leave(lobbyCode);
      socketToPlayer.delete(socket.id);
      playerToSocket.delete(`poker:${odotpid}`);
      broadcastGameState(lobbyCode);
      callback?.({ success: true });
    };

    const handleStartGame = (data: { lobbyCode: string; odotpid: string; gameType?: string }, callback: any) => {
      const { lobbyCode, odotpid } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.startGame(lobbyCode, odotpid);
        callback(result);
        if (result.success) broadcastUnoState(lobbyCode);
        return;
      }

      const result = pokerGame.startGame(lobbyCode, odotpid);
      callback(result);
      if (result.success) broadcastGameState(lobbyCode);
    };

    const handlePlayerAction = (
      data: { lobbyCode: string; odotpid: string; gameType?: string; action: any; amount?: number },
      callback: any,
    ) => {
      const { lobbyCode, odotpid } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const action = parseUnoAction(data);
        if (!action) return callback({ success: false, error: 'Invalid UNO action' });
        const result = unoGame.handleAction(lobbyCode, odotpid, action);
        callback(result);
        return;
      }

      const { action, amount } = data as { action: PlayerAction; amount?: number };
      const result = pokerGame.handleAction(lobbyCode, odotpid, action, amount);
      callback(result);
    };

    const handleRequestState = (data: { lobbyCode: string; odotpid: string; gameType?: string }, callback: any) => {
      const { lobbyCode, odotpid } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const state = unoGame.getClientState(lobbyCode, odotpid);
        callback({ success: !!state, gameState: state });
        return;
      }

      const state = pokerGame.getClientState(lobbyCode, odotpid);
      callback({ success: !!state, gameState: state });
    };

    const handleEndLobby = (data: { lobbyCode: string; odotpid: string; gameType?: string }, callback: any) => {
      const { lobbyCode, odotpid } = data;
      const gameType = parseGameType(data) || detectGameTypeByLobbyCode(lobbyCode) || 'poker';

      if (gameType === 'uno') {
        const result = unoGame.endLobby(lobbyCode, odotpid);
        if (result.success) io.to(lobbyCode).emit('lobbyEnded');
        callback(result);
        return;
      }

      const result = pokerGame.endLobby(lobbyCode, odotpid);
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

    // UNO aliases (in case frontend uses prefixed names)
    socket.on('uno:createLobby', (data: any, cb: any) => handleCreateLobby({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:joinLobby', (data: any, cb: any) => handleJoinLobby({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:leaveLobby', (data: any, cb: any) => handleLeaveLobby({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:startGame', (data: any, cb: any) => handleStartGame({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:playerAction', (data: any, cb: any) => handlePlayerAction({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:requestState', (data: any, cb: any) => handleRequestState({ ...data, gameType: 'uno' }, cb));
    socket.on('uno:endLobby', (data: any, cb: any) => handleEndLobby({ ...data, gameType: 'uno' }, cb));

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

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


