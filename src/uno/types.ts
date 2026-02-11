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

export interface UnoGameState {
  lobbyCode: string;
  hostId: string;
  players: UnoPlayer[];

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

  winnerId: string | null;

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
}

export interface UnoClientState {
  gameType: 'uno';
  lobbyCode: string;
  hostId: string;
  players: UnoClientPlayer[];

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

