import { v4 as uuidv4 } from 'uuid';
import type { 
  Card, Rank, Suit, Player, GameState, Street, 
  PlayerAction, Pot, ClientGameState, ClientPlayer, 
  ActionLogEntry, ShowdownResult, HandRank 
} from '../types.js';
import { evaluateHand, findWinners } from './evaluator.js';

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const TURN_TIMEOUT = 30000; // 30 seconds
export const STARTING_STACK = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;

function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function generateLobbyCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export class PokerGame {
  private lobbies: Map<string, GameState> = new Map();
  private actionLogs: Map<string, ActionLogEntry[]> = new Map();
  private showdownResults: Map<string, ShowdownResult[]> = new Map();
  private turnTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateUpdate: (lobbyCode: string) => void;
  
  constructor(onStateUpdate: (lobbyCode: string) => void) {
    this.onStateUpdate = onStateUpdate;
  }
  
  createLobby(hostIdArg: string): string {
    const code = generateLobbyCode();
    const state: GameState = {
      lobbyCode: code,
      hostId: hostIdArg,
      players: [],
      gameStarted: false,
      deck: [],
      communityCards: [],
      pots: [{ amount: 0, eligiblePlayerIds: [] }],
      currentBet: 0,
      minRaise: BIG_BLIND,
      dealerIndex: 0,
      smallBlindIndex: 0,
      bigBlindIndex: 1,
      currentPlayerIndex: 0,
      street: 'preflop',
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      turnStartTime: null,
      turnTimeout: TURN_TIMEOUT,
      handNumber: 0,
      lastRaiseAmount: BIG_BLIND,
      actedThisRound: new Set()
    };
    this.lobbies.set(code, state);
    this.actionLogs.set(code, []);
    return code;
  }
  
  getLobby(code: string): GameState | undefined {
    return this.lobbies.get(code);
  }
  
  joinLobby(
    code: string, 
    odotpid: string, 
    nickname: string, 
    avatarUrl: string | null
  ): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }
    
    if (lobby.gameStarted) {
      // Allow reconnection
      const existing = lobby.players.find(p => p.playerId === odotpid);
      if (existing) {
        existing.isConnected = true;
        return { success: true };
      }
      return { success: false, error: 'Game already in progress' };
    }
    
    if (lobby.players.length >= 9) {
      return { success: false, error: 'Lobby is full' };
    }
    
    const existing = lobby.players.find(p => p.playerId === odotpid);
    if (existing) {
      existing.isConnected = true;
      existing.nickname = nickname;
      existing.avatarUrl = avatarUrl;
      return { success: true };
    }
    
    const seatIndex = lobby.players.length;
    const player: Player = {
      playerId: odotpid,
      seatIndex,
      nickname,
      avatarUrl,
      stack: STARTING_STACK,
      currentBet: 0,
      holeCards: [],
      folded: false,
      allIn: false,
      isConnected: true,
      lastAction: null,
      lastBet: 0
    };
    
    lobby.players.push(player);
    return { success: true };
  }
  
  leaveLobby(code: string, odotpid: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    const player = lobby.players.find(p => p.playerId === odotpid);
    if (player) {
      player.isConnected = false;
      
      if (!lobby.gameStarted) {
        lobby.players = lobby.players.filter(p => p.playerId !== odotpid);
        // Reassign seat indices
        lobby.players.forEach((p, i) => p.seatIndex = i);
      }
    }
    
    // Remove lobby if empty
    if (lobby.players.length === 0 || 
        lobby.players.every(p => !p.isConnected)) {
      this.clearLobbyTimer(code);
      this.lobbies.delete(code);
      this.actionLogs.delete(code);
      this.showdownResults.delete(code);
    }
  }
  
  startGame(code: string, requesterId: string): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }
    
    if (lobby.hostId !== requesterId) {
      return { success: false, error: 'Only host can start the game' };
    }
    
    const activePlayers = lobby.players.filter(p => p.isConnected);
    if (activePlayers.length < 2) {
      return { success: false, error: 'Need at least 2 players' };
    }
    
    lobby.gameStarted = true;
    this.startNewHand(code);
    
    return { success: true };
  }
  
  private startNewHand(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    // Filter out players with no chips
    const activePlayers = lobby.players.filter(p => p.stack > 0 && p.isConnected);
    
    if (activePlayers.length < 2) {
      // Game over
      lobby.gameStarted = false;
      this.onStateUpdate(code);
      return;
    }
    
    // Reset hand state
    lobby.deck = shuffleDeck(createDeck());
    lobby.communityCards = [];
    lobby.pots = [{ amount: 0, eligiblePlayerIds: activePlayers.map(p => p.playerId) }];
    lobby.currentBet = 0;
    lobby.minRaise = BIG_BLIND;
    lobby.street = 'preflop';
    lobby.handNumber++;
    lobby.lastRaiseAmount = BIG_BLIND;
    lobby.actedThisRound = new Set();
    
    // Clear previous showdown
    this.showdownResults.delete(code);
    
    // Reset player states
    for (const player of lobby.players) {
      player.currentBet = 0;
      player.holeCards = [];
      player.folded = player.stack === 0 || !player.isConnected;
      player.allIn = false;
      player.lastAction = null;
      player.lastBet = 0;
    }
    
    // Move dealer button
    lobby.dealerIndex = (lobby.dealerIndex + 1) % activePlayers.length;
    
    // Set blinds
    if (activePlayers.length === 2) {
      // Heads up: dealer is small blind
      lobby.smallBlindIndex = lobby.dealerIndex;
      lobby.bigBlindIndex = (lobby.dealerIndex + 1) % activePlayers.length;
    } else {
      lobby.smallBlindIndex = (lobby.dealerIndex + 1) % activePlayers.length;
      lobby.bigBlindIndex = (lobby.dealerIndex + 2) % activePlayers.length;
    }
    
    // Get actual player indices from active players
    const dealerPlayer = activePlayers[lobby.dealerIndex];
    const sbPlayer = activePlayers[lobby.smallBlindIndex];
    const bbPlayer = activePlayers[lobby.bigBlindIndex];
    
    // Post blinds
    this.postBlind(lobby, sbPlayer, lobby.smallBlind);
    this.postBlind(lobby, bbPlayer, lobby.bigBlind);
    
    lobby.currentBet = lobby.bigBlind;
    
    // Deal hole cards
    for (const player of activePlayers) {
      player.holeCards = [lobby.deck.pop()!, lobby.deck.pop()!];
    }
    
    // Set first to act (left of big blind for preflop)
    const firstActorIndex = activePlayers.length === 2 
      ? lobby.dealerIndex  // Heads up: dealer acts first preflop
      : (lobby.bigBlindIndex + 1) % activePlayers.length;
    
    const firstActor = activePlayers[firstActorIndex];
    lobby.currentPlayerIndex = lobby.players.indexOf(firstActor);
    
    this.startTurnTimer(code);
    this.onStateUpdate(code);
  }
  
  private postBlind(lobby: GameState, player: Player, amount: number): void {
    const actual = Math.min(amount, player.stack);
    player.stack -= actual;
    player.currentBet = actual;
    lobby.pots[0].amount += actual;
    
    if (player.stack === 0) {
      player.allIn = true;
    }
  }
  
  handleAction(
    code: string, 
    odotpid: string, 
    action: PlayerAction, 
    amount?: number
  ): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby || !lobby.gameStarted) {
      return { success: false, error: 'Game not in progress' };
    }
    
    const currentPlayer = lobby.players[lobby.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.playerId !== odotpid) {
      return { success: false, error: 'Not your turn' };
    }
    
    if (currentPlayer.folded || currentPlayer.allIn) {
      return { success: false, error: 'Cannot act' };
    }
    
    const toCall = lobby.currentBet - currentPlayer.currentBet;
    
    switch (action) {
      case 'fold':
        currentPlayer.folded = true;
        currentPlayer.lastAction = 'fold';
        break;
        
      case 'check':
        if (toCall > 0) {
          return { success: false, error: 'Cannot check, must call or fold' };
        }
        currentPlayer.lastAction = 'check';
        break;
        
      case 'call':
        if (toCall === 0) {
          currentPlayer.lastAction = 'check';
        } else {
          const callAmount = Math.min(toCall, currentPlayer.stack);
          currentPlayer.stack -= callAmount;
          currentPlayer.currentBet += callAmount;
          lobby.pots[0].amount += callAmount;
          currentPlayer.lastAction = 'call';
          currentPlayer.lastBet = callAmount;
          
          if (currentPlayer.stack === 0) {
            currentPlayer.allIn = true;
            currentPlayer.lastAction = 'all-in';
          }
        }
        break;
        
      case 'bet':
      case 'raise':
        if (amount === undefined) {
          return { success: false, error: 'Amount required for bet/raise' };
        }
        
        const minBet = lobby.currentBet === 0 
          ? lobby.bigBlind 
          : lobby.currentBet + lobby.lastRaiseAmount;
        
        if (amount < minBet && amount < currentPlayer.stack) {
          return { success: false, error: `Minimum bet is ${minBet}` };
        }
        
        const totalBet = Math.min(amount, currentPlayer.stack + currentPlayer.currentBet);
        const toAdd = totalBet - currentPlayer.currentBet;
        
        if (totalBet > lobby.currentBet) {
          lobby.lastRaiseAmount = totalBet - lobby.currentBet;
          lobby.currentBet = totalBet;
          // Reset acted set since there's a raise
          lobby.actedThisRound = new Set([odotpid]);
        }
        
        currentPlayer.stack -= toAdd;
        currentPlayer.currentBet = totalBet;
        lobby.pots[0].amount += toAdd;
        currentPlayer.lastAction = lobby.currentBet === totalBet ? 'raise' : 'bet';
        currentPlayer.lastBet = toAdd;
        
        if (currentPlayer.stack === 0) {
          currentPlayer.allIn = true;
          currentPlayer.lastAction = 'all-in';
        }
        break;
        
      case 'all-in':
        const allInAmount = currentPlayer.stack;
        const newTotal = currentPlayer.currentBet + allInAmount;
        
        if (newTotal > lobby.currentBet) {
          lobby.lastRaiseAmount = newTotal - lobby.currentBet;
          lobby.currentBet = newTotal;
          lobby.actedThisRound = new Set([odotpid]);
        }
        
        currentPlayer.stack = 0;
        currentPlayer.currentBet = newTotal;
        lobby.pots[0].amount += allInAmount;
        currentPlayer.allIn = true;
        currentPlayer.lastAction = 'all-in';
        currentPlayer.lastBet = allInAmount;
        break;
    }
    
    // Log action
    const logs = this.actionLogs.get(code) || [];
    logs.push({
      playerId: odotpid,
      nickname: currentPlayer.nickname,
      action,
      amount: currentPlayer.lastBet || undefined,
      timestamp: Date.now()
    });
    if (logs.length > 50) logs.shift();
    this.actionLogs.set(code, logs);
    
    lobby.actedThisRound.add(odotpid);
    
    this.clearLobbyTimer(code);
    this.advanceGame(code);
    
    return { success: true };
  }
  
  private advanceGame(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    const activePlayers = lobby.players.filter(p => !p.folded && p.stack >= 0);
    const playersInHand = activePlayers.filter(p => !p.allIn);
    
    // Check if only one player left
    if (activePlayers.length === 1) {
      this.awardPot(code, [activePlayers[0].playerId]);
      setTimeout(() => this.startNewHand(code), 3000);
      this.onStateUpdate(code);
      return;
    }
    
    // Check if betting round is complete
    const allActed = playersInHand.every(p => 
      lobby.actedThisRound.has(p.playerId) && 
      (p.currentBet === lobby.currentBet || p.allIn)
    );
    
    const allMatched = activePlayers.every(p => 
      p.currentBet === lobby.currentBet || p.allIn
    );
    
    if (allActed && allMatched) {
      // Handle side pots if needed
      this.calculateSidePots(lobby);
      
      // Move to next street
      if (playersInHand.length <= 1) {
        // All but one all-in, run out the board
        this.runOutBoard(code);
        return;
      }
      
      this.advanceStreet(code);
    } else {
      // Move to next player
      this.moveToNextPlayer(code);
      this.startTurnTimer(code);
    }
    
    this.onStateUpdate(code);
  }
  
  private moveToNextPlayer(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    const activePlayers = lobby.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length === 0) return;
    
    let nextIndex = (lobby.currentPlayerIndex + 1) % lobby.players.length;
    let attempts = 0;
    
    while (attempts < lobby.players.length) {
      const player = lobby.players[nextIndex];
      if (!player.folded && !player.allIn) {
        lobby.currentPlayerIndex = nextIndex;
        return;
      }
      nextIndex = (nextIndex + 1) % lobby.players.length;
      attempts++;
    }
  }
  
  private advanceStreet(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    // Reset for new street
    lobby.actedThisRound = new Set();
    lobby.currentBet = 0;
    lobby.lastRaiseAmount = lobby.bigBlind;
    
    for (const player of lobby.players) {
      player.currentBet = 0;
      player.lastAction = null;
      player.lastBet = 0;
    }
    
    switch (lobby.street) {
      case 'preflop':
        lobby.street = 'flop';
        lobby.communityCards = [
          lobby.deck.pop()!,
          lobby.deck.pop()!,
          lobby.deck.pop()!
        ];
        break;
      case 'flop':
        lobby.street = 'turn';
        lobby.communityCards.push(lobby.deck.pop()!);
        break;
      case 'turn':
        lobby.street = 'river';
        lobby.communityCards.push(lobby.deck.pop()!);
        break;
      case 'river':
        this.goToShowdown(code);
        return;
    }
    
    // Find first active player after dealer
    const activePlayers = lobby.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length === 0) {
      this.goToShowdown(code);
      return;
    }
    
    // First to act is first active player after dealer
    const dealerSeat = lobby.players[lobby.dealerIndex]?.seatIndex || 0;
    let firstActor: Player | null = null;
    
    for (let i = 1; i <= lobby.players.length; i++) {
      const idx = (dealerSeat + i) % lobby.players.length;
      const player = lobby.players.find(p => p.seatIndex === idx);
      if (player && !player.folded && !player.allIn) {
        firstActor = player;
        break;
      }
    }
    
    if (firstActor) {
      lobby.currentPlayerIndex = lobby.players.indexOf(firstActor);
    }
    
    this.startTurnTimer(code);
    this.onStateUpdate(code);
  }
  
  private runOutBoard(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    while (lobby.communityCards.length < 5) {
      lobby.communityCards.push(lobby.deck.pop()!);
    }
    
    this.goToShowdown(code);
  }
  
  private goToShowdown(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    lobby.street = 'showdown';
    
    const activePlayers = lobby.players.filter(p => !p.folded);
    
    // Evaluate hands
    const playerHands: Array<{ pid: string; hand: HandRank }> = activePlayers.map(p => ({
      pid: p.playerId,
      hand: evaluateHand(p.holeCards, lobby.communityCards)
    }));
    
    // Find winners
    const winnerIds = findWinners(playerHands);
    
    // Calculate winnings
    const results: ShowdownResult[] = playerHands.map(ph => ({
      playerId: ph.pid,
      hand: ph.hand,
      winnings: 0
    }));
    
    // Distribute pot
    this.awardPot(code, winnerIds, results);
    
    this.showdownResults.set(code, results);
    this.onStateUpdate(code);
    
    // Start new hand after delay
    setTimeout(() => this.startNewHand(code), 5000);
  }
  
  private calculateSidePots(lobby: GameState): void {
    // Simplified side pot calculation
    const activePlayers = lobby.players.filter(p => !p.folded);
    const allInPlayers = activePlayers.filter(p => p.allIn).sort((a, b) => a.currentBet - b.currentBet);
    
    if (allInPlayers.length === 0) return;
    
    // For now, keep it simple with main pot only
    // Full side pot implementation would go here
  }
  
  private awardPot(code: string, winnerIds: string[], results?: ShowdownResult[]): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    const totalPot = lobby.pots.reduce((sum, p) => sum + p.amount, 0);
    const share = Math.floor(totalPot / winnerIds.length);
    const remainder = totalPot % winnerIds.length;
    
    winnerIds.forEach((winnerId, i) => {
      const player = lobby.players.find(p => p.playerId === winnerId);
      if (player) {
        const winAmount = share + (i === 0 ? remainder : 0);
        player.stack += winAmount;
        
        if (results) {
          const result = results.find(r => r.playerId === winnerId);
          if (result) result.winnings = winAmount;
        }
      }
    });
    
    // Reset pots
    lobby.pots = [{ amount: 0, eligiblePlayerIds: [] }];
  }
  
  private startTurnTimer(code: string): void {
    this.clearLobbyTimer(code);
    
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    
    lobby.turnStartTime = Date.now();
    
    const timer = setTimeout(() => {
      this.handleTimeout(code);
    }, TURN_TIMEOUT);
    
    this.turnTimers.set(code, timer);
  }
  
  private clearLobbyTimer(code: string): void {
    const timer = this.turnTimers.get(code);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(code);
    }
    
    const lobby = this.lobbies.get(code);
    if (lobby) {
      lobby.turnStartTime = null;
    }
  }
  
  private handleTimeout(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby || !lobby.gameStarted) return;
    
    const currentPlayer = lobby.players[lobby.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.folded || currentPlayer.allIn) return;
    
    const toCall = lobby.currentBet - currentPlayer.currentBet;
    
    if (toCall === 0) {
      // Auto-check
      this.handleAction(code, currentPlayer.playerId, 'check');
    } else {
      // Auto-fold
      this.handleAction(code, currentPlayer.playerId, 'fold');
    }
  }
  
  getClientState(code: string, requestingPlayerId: string): ClientGameState | null {
    const lobby = this.lobbies.get(code);
    if (!lobby) return null;
    
    const logs = this.actionLogs.get(code) || [];
    const showdown = this.showdownResults.get(code) || null;
    
    const totalPot = lobby.pots.reduce((sum, p) => sum + p.amount, 0);
    
    const myPlayer = lobby.players.find(p => p.playerId === requestingPlayerId);
    
    const isShowdown = lobby.street === 'showdown';
    
    const clientPlayers: ClientPlayer[] = lobby.players.map(p => ({
      playerId: p.playerId,
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      avatarUrl: p.avatarUrl,
      stack: p.stack,
      currentBet: p.currentBet,
      folded: p.folded,
      allIn: p.allIn,
      isConnected: p.isConnected,
      lastAction: p.lastAction,
      lastBet: p.lastBet,
      // Only show hole cards if it's the requesting player or showdown
      holeCards: (p.playerId === requestingPlayerId || (isShowdown && !p.folded)) 
        ? p.holeCards 
        : null
    }));
    
    const turnTimeRemaining = lobby.turnStartTime 
      ? Math.max(0, TURN_TIMEOUT - (Date.now() - lobby.turnStartTime))
      : null;
    
    const winnerIds = showdown 
      ? showdown.filter(r => r.winnings > 0).map(r => r.playerId)
      : null;
    
    return {
      lobbyCode: lobby.lobbyCode,
      hostId: lobby.hostId,
      players: clientPlayers,
      gameStarted: lobby.gameStarted,
      communityCards: lobby.communityCards,
      pot: totalPot,
      currentBet: lobby.currentBet,
      minRaise: lobby.minRaise,
      dealerIndex: lobby.dealerIndex,
      smallBlindIndex: lobby.smallBlindIndex,
      bigBlindIndex: lobby.bigBlindIndex,
      currentPlayerIndex: lobby.currentPlayerIndex,
      street: lobby.street,
      smallBlind: lobby.smallBlind,
      bigBlind: lobby.bigBlind,
      turnTimeRemaining,
      handNumber: lobby.handNumber,
      myHoleCards: myPlayer?.holeCards || [],
      myPlayerId: requestingPlayerId,
      showdownResults: showdown,
      winners: winnerIds,
      actionLog: logs.slice(-20)
    };
  }
  
  endLobby(code: string, requesterId: string): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { success: false, error: 'Lobby not found' };
    }
    
    if (lobby.hostId !== requesterId) {
      return { success: false, error: 'Only host can end the lobby' };
    }
    
    this.clearLobbyTimer(code);
    this.lobbies.delete(code);
    this.actionLogs.delete(code);
    this.showdownResults.delete(code);
    
    return { success: true };
  }
}
