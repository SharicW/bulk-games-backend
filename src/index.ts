import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { PokerGame } from './poker/game.js';
import type { PlayerAction } from './types.js';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
  origin: process.env.NODE_ENV === 'production' 
    ? "https://bulk-games-frontend-production.up.railway.app"
    : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
  credentials: true
}
});


// Store socket to player mappings
const socketToPlayer = new Map<string, { odotpid: string; lobbyCode: string }>();
const playerToSocket = new Map<string, string>();

// Initialize poker game
const pokerGame = new PokerGame((lobbyCode: string) => {
  broadcastGameState(lobbyCode);
});

function broadcastGameState(lobbyCode: string): void {
  const lobby = pokerGame.getLobby(lobbyCode);
  if (!lobby) return;
  
  // Send personalized state to each player
  for (const player of lobby.players) {
    const socketId = playerToSocket.get(player.playerId);
    if (socketId) {
      const clientState = pokerGame.getClientState(lobbyCode, player.playerId);
      io.to(socketId).emit('gameState', clientState);
    }
  }
}

io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id} from ${socket.handshake.address}`);
   socket.emit('test', { message: 'Backend works!', timestamp: Date.now() });
  socket.on('createLobby', (data: { odotpid: string; nickname: string; avatarUrl: string | null }, callback) => {
    const { odotpid, nickname, avatarUrl } = data;
    
    const lobbyCode = pokerGame.createLobby(odotpid);
    const joinResult = pokerGame.joinLobby(lobbyCode, odotpid, nickname, avatarUrl);
    
    if (joinResult.success) {
      socket.join(lobbyCode);
      socketToPlayer.set(socket.id, { odotpid, lobbyCode });
      playerToSocket.set(odotpid, socket.id);
      
      const state = pokerGame.getClientState(lobbyCode, odotpid);
      callback({ success: true, code: lobbyCode, gameState: state });
    } else {
      callback({ success: false, error: joinResult.error });
    }
  });
  
  socket.on('joinLobby', (data: { code: string; odotpid: string; nickname: string; avatarUrl: string | null }, callback) => {
    const { code, odotpid, nickname, avatarUrl } = data;
    
    const result = pokerGame.joinLobby(code, odotpid, nickname, avatarUrl);
    
    if (result.success) {
      socket.join(code);
      socketToPlayer.set(socket.id, { odotpid, lobbyCode: code });
      playerToSocket.set(odotpid, socket.id);
      
      const state = pokerGame.getClientState(code, odotpid);
      callback({ success: true, gameState: state });
      
      // Broadcast updated state to all players
      broadcastGameState(code);
    } else {
      callback({ success: false, error: result.error });
    }
  });
  
  socket.on('startGame', (data: { lobbyCode: string; odotpid: string }, callback) => {
    const { lobbyCode, odotpid } = data;
    
    const result = pokerGame.startGame(lobbyCode, odotpid);
    callback(result);
    
    if (result.success) {
      broadcastGameState(lobbyCode);
    }
  });
  
  socket.on('playerAction', (data: { lobbyCode: string; odotpid: string; action: PlayerAction; amount?: number }, callback) => {
    const { lobbyCode, odotpid, action, amount } = data;
    
    const result = pokerGame.handleAction(lobbyCode, odotpid, action, amount);
    callback(result);
  });
  
  socket.on('endLobby', (data: { lobbyCode: string; odotpid: string }, callback) => {
    const { lobbyCode, odotpid } = data;
    
    const result = pokerGame.endLobby(lobbyCode, odotpid);
    
    if (result.success) {
      io.to(lobbyCode).emit('lobbyEnded');
    }
    
    callback(result);
  });
  
  socket.on('requestState', (data: { lobbyCode: string; odotpid: string }, callback) => {
    const { lobbyCode, odotpid } = data;
    const state = pokerGame.getClientState(lobbyCode, odotpid);
    callback({ success: !!state, gameState: state });
  });
  
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    const playerInfo = socketToPlayer.get(socket.id);
    if (playerInfo) {
      const { odotpid, lobbyCode } = playerInfo;
      pokerGame.leaveLobby(lobbyCode, odotpid);
      socketToPlayer.delete(socket.id);
      playerToSocket.delete(odotpid);
      
      broadcastGameState(lobbyCode);
    }
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


