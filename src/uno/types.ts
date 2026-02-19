export type UnoColor = 'red' | 'green' | 'blue' | 'yellow';
export type UnoKind = 'number' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';

export type UnoCardFace =
  | { kind: 'number'; color: UnoColor; value: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }
  | { kind: 'skip'; color: UnoColor }
  | { kind: 'reverse'; color: UnoColor }
  | { kind: 'draw2'; color: UnoColor }
  | { kind: 'wild' }
  | { kind: 'wild4' };

export interface UnoCard {
  id: string;
  face: UnoCardFace;
}

export type UnoPhase = 'lobby' | 'playing' | 'finished';

export interface UnoPlayer {
  playerId: string;
  seatIndex: number;
  nickname: string;
  avatarUrl: string | null;
  isConnected: boolean;
  lastSeenAt: number;
  equippedBorder: string | null;
  equippedEffect: string | null;
}

export interface UnoLogEntry {
  id: string;
  ts: number;
  type:
    | 'joined'
    | 'left'
    | 'reconnected'
    | 'started'
    | 'played'
    | 'drew'
    | 'passed'
    | 'skipped'
    | 'reversed'
    | 'winner'
    | 'uno_called'
    | 'uno_caught'
    | 'system';
  playerId?: string;
  text: string;
}

/** Server-generated UNO prompt with button position for fairness */
export interface UnoPrompt {
  active: true;
  targetPlayerId: string;
  buttonPos: { x: number; y: number };
  createdAt: number;
}

export interface UnoGameState {
  lobbyCode: string;
  hostId: string;
  players: UnoPlayer[];
  spectators?: UnoPlayer[];
  /** Public rooms are persistent and can be joined by anyone */
  isPublic?: boolean;
  /** Max players (used for public room listing / join guards) */
  maxPlayers?: number;

  phase: UnoPhase;
  gameStarted: boolean;

  dealerIndex: number;
  direction: 1 | -1;
  currentPlayerIndex: number;

  hands: Record<string, UnoCard[]>;
  drawPile: UnoCard[];
  discardPile: UnoCard[];

  currentColor: UnoColor | null;
  pendingDraw: number;
  drawnPlayable: null | { playerId: string; cardId: string };

  /** Player who must press UNO (has 1 card left after playing), or null */
  mustCallUno: string | null;

  /** Server-generated UNO prompt with random button position (same for all clients) */
  unoPrompt: UnoPrompt | null;

  winnerId: string | null;
  /** Server-driven win celebration (emitted once, also included in state for resync) */
  celebration?: null | { id: string; winnerId: string; effectId: 'stars' | 'red_hearts' | 'black_hearts' | 'fire_burst' | 'sakura_petals' | 'gold_stars' | 'rainbow_burst'; createdAt: number };

  /** Whether reward has been issued for this game (prevent duplicate +5 coins) */
  rewardIssued: boolean;

  actionLog: UnoLogEntry[];

  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface UnoClientPlayer {
  playerId: string;
  seatIndex: number;
  nickname: string;
  avatarUrl: string | null;
  isConnected: boolean;
  lastSeenAt: number;
  cardCount: number;
  equippedBorder: string | null;
  equippedEffect: string | null;
}

/** A spectator present in the UNO lobby but not holding cards. */
export interface UnoClientSpectator {
  playerId: string;
  nickname: string;
  avatarUrl: string | null;
  isConnected: boolean;
  equippedBorder: string | null;
  equippedEffect: string | null;
}

export interface UnoClientState {
  gameType: 'uno';
  lobbyCode: string;
  hostId: string;
  players: UnoClientPlayer[];
  /** Spectators watching the game (not in the player list). */
  spectators: UnoClientSpectator[];
  /** True when the requesting player is spectating rather than playing. */
  isSpectator: boolean;
  isPublic?: boolean;
  maxPlayers?: number;
  celebration?: null | { id: string; winnerId: string; effectId: 'stars' | 'red_hearts' | 'black_hearts' | 'fire_burst' | 'sakura_petals' | 'gold_stars' | 'rainbow_burst'; createdAt: number };

  phase: UnoPhase;
  gameStarted: boolean;

  dealerIndex: number;
  direction: 1 | -1;
  currentPlayerIndex: number;

  hands: Record<string, UnoCard[]>;
  drawPileCount: number;
  discardPile: UnoCard[];

  currentColor: UnoColor | null;
  pendingDraw: number;
  drawnPlayable: null | { playerId: string; cardId: string };
  mustCallUno: string | null;
  unoPrompt: UnoPrompt | null;
  winnerId: string | null;

  myPlayerId: string;

  actionLog: UnoLogEntry[];

  createdAt: number;
  updatedAt: number;
  version: number;
  serverTime: number;
}

export type UnoPlayerAction =
  | { type: 'play'; cardId: string; chosenColor?: UnoColor }
  | { type: 'draw' }
  | { type: 'pass' }
  | { type: 'callUno' }
  | { type: 'catchUno' };

