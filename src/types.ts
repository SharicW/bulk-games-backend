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
  equippedBorder: string | null;
  equippedEffect: string | null;
  /** Whether the player has chosen to reveal their cards at showdown */
  cardsRevealed?: boolean;
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
  spectators?: Player[];
  gameStarted: boolean;
  /** Public rooms are persistent and can be joined by anyone */
  isPublic?: boolean;
  /** Max players (used for public room listing / join guards) */
  maxPlayers?: number;
  /** Server-driven win celebration (emitted once, also included in state for resync) */
  celebration?: null | { id: string; winnerId: string; effectId: 'stars' | 'red_hearts' | 'black_hearts' | 'fire_burst' | 'sakura_petals' | 'gold_stars' | 'rainbow_burst'; createdAt: number };
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
  version: number;
  /** Whether reward has been issued for the current hand (prevent duplicate coins) */
  rewardIssued: boolean;
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

/** A spectator present in the lobby but not seated at the table. */
export interface ClientSpectator {
  playerId: string;
  nickname: string;
  avatarUrl: string | null;
  isConnected: boolean;
  equippedBorder: string | null;
  equippedEffect: string | null;
}

export interface ClientGameState {
  lobbyCode: string;
  hostId: string;
  players: ClientPlayer[];
  /** Spectators watching the game (not seated). */
  spectators: ClientSpectator[];
  /** True when the requesting player is spectating rather than playing. */
  isSpectator: boolean;
  gameStarted: boolean;
  isPublic?: boolean;
  maxPlayers?: number;
  celebration?: null | { id: string; winnerId: string; effectId: 'stars' | 'red_hearts' | 'black_hearts' | 'fire_burst' | 'sakura_petals' | 'gold_stars' | 'rainbow_burst'; createdAt: number };
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
  version: number;
  serverTime: number;
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
  equippedBorder: string | null;
  equippedEffect: string | null;
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
