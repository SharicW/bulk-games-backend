export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type PlayerAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';

export interface Player {
  playerId: string;
  seatIndex: number;
  nickname: string;
  avatarUrl: string | null;
  stack: number;
  currentBet: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  isConnected: boolean;
  lastAction: PlayerAction | null;
  lastBet: number;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface Pot {
  amount: number;
  eligiblePlayerIds: string[];
}

export interface GameState {
  lobbyCode: string;
  hostId: string;
  players: Player[];
  gameStarted: boolean;
  deck: Card[];
  communityCards: Card[];
  pots: Pot[];
  currentBet: number;
  minRaise: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  currentPlayerIndex: number;
  street: Street;
  smallBlind: number;
  bigBlind: number;
  turnStartTime: number | null;
  turnTimeout: number;
  handNumber: number;
  lastRaiseAmount: number;
  actedThisRound: Set<string>;
}

export interface HandRank {
  rank: number;
  name: string;
  tiebreakers: number[];
  cards: Card[];
}

export interface ShowdownResult {
  playerId: string;
  hand: HandRank;
  winnings: number;
}

export interface ClientGameState {
  lobbyCode: string;
  hostId: string;
  players: ClientPlayer[];
  gameStarted: boolean;
  communityCards: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  dealerIndex: number;
  smallBlindIndex: number;
  bigBlindIndex: number;
  currentPlayerIndex: number;
  street: Street;
  smallBlind: number;
  bigBlind: number;
  turnTimeRemaining: number | null;
  handNumber: number;
  myHoleCards: Card[];
  myPlayerId: string;
  showdownResults: ShowdownResult[] | null;
  winners: string[] | null;
  actionLog: ActionLogEntry[];
}

export interface ClientPlayer {
  playerId: string;
  seatIndex: number;
  nickname: string;
  avatarUrl: string | null;
  stack: number;
  currentBet: number;
  folded: boolean;
  allIn: boolean;
  isConnected: boolean;
  lastAction: PlayerAction | null;
  lastBet: number;
  holeCards: Card[] | null;
}

export interface ActionLogEntry {
  playerId: string;
  nickname: string;
  action: PlayerAction;
  amount?: number;
  timestamp: number;
}

export interface CreateLobbyResponse {
  success: boolean;
  code?: string;
  error?: string;
}

export interface JoinLobbyResponse {
  success: boolean;
  error?: string;
  gameState?: ClientGameState;
}

export interface PlayerActionPayload {
  lobbyCode: string;
  action: PlayerAction;
  amount?: number;
}
