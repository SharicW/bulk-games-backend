import type {
  UnoCard,
  UnoCardFace,
  UnoClientPlayer,
  UnoClientState,
  UnoColor,
  UnoGameState,
  UnoLogEntry,
  UnoPlayer,
  UnoPlayerAction,
  UnoPrompt,
} from './types.js';

const COLORS: UnoColor[] = ['red', 'green', 'blue', 'yellow'];

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextIndex(from: number, direction: 1 | -1, count: number, steps = 1): number {
  if (count <= 0) return 0;
  let idx = from;
  for (let i = 0; i < steps; i++) idx = (idx + direction + count) % count;
  return idx;
}

function faceId(face: UnoCardFace): string {
  if (face.kind === 'wild' || face.kind === 'wild4') return face.kind;
  if (face.kind === 'number') return `${face.color}_${face.value}`;
  return `${face.color}_${face.kind}`;
}

function makeDeckFaces(): UnoCardFace[] {
  const deck: UnoCardFace[] = [];
  for (const color of COLORS) {
    deck.push({ kind: 'number', color, value: 0 });
    const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
    for (const n of nums) {
      deck.push({ kind: 'number', color, value: n }, { kind: 'number', color, value: n });
    }
    deck.push({ kind: 'skip', color }, { kind: 'skip', color });
    deck.push({ kind: 'reverse', color }, { kind: 'reverse', color });
    deck.push({ kind: 'draw2', color }, { kind: 'draw2', color });
  }
  for (let i = 0; i < 4; i++) deck.push({ kind: 'wild' });
  for (let i = 0; i < 4; i++) deck.push({ kind: 'wild4' });
  return deck;
}

function instantiateDeck(faces: UnoCardFace[], seedPrefix = 'uno'): UnoCard[] {
  let n = 0;
  return faces.map((face) => {
    n++;
    return {
      id: `${seedPrefix}_${n}_${faceId(face)}_${Math.random().toString(36).slice(2, 8)}`,
      face,
    };
  });
}

function isWild(face: UnoCardFace): boolean {
  return face.kind === 'wild' || face.kind === 'wild4';
}

function isPlayableCard(card: UnoCardFace, top: UnoCardFace | null, currentColor: UnoColor | null): boolean {
  if (isWild(card)) return true;
  if (!top) return true;
  if (!currentColor) return true;
  if ('color' in card && card.color === currentColor) return true;
  if (top.kind === 'number') {
    return card.kind === 'number' && card.value === top.value;
  }
  if (top.kind === 'skip' || top.kind === 'reverse' || top.kind === 'draw2') {
    return card.kind === top.kind;
  }
  return false;
}

function hasColor(hand: UnoCard[], color: UnoColor): boolean {
  return hand.some((c) => c.face.kind !== 'wild' && c.face.kind !== 'wild4' && 'color' in c.face && c.face.color === color);
}

function cardLabel(face: UnoCardFace): string {
  if (face.kind === 'wild') return 'Wild';
  if (face.kind === 'wild4') return 'Wild Draw Four';
  const c = face.color[0].toUpperCase() + face.color.slice(1);
  if (face.kind === 'number') return `${c} ${face.value}`;
  if (face.kind === 'draw2') return `${c} Draw Two`;
  if (face.kind === 'reverse') return `${c} Reverse`;
  return `${c} Skip`;
}

function addLog(state: UnoGameState, entry: Omit<UnoLogEntry, 'id' | 'ts'>): UnoGameState {
  const e: UnoLogEntry = { id: nowId('uno_log'), ts: Date.now(), ...entry };
  const actionLog = [...state.actionLog, e].slice(-200);
  return { ...state, actionLog };
}

function drawCards(state: UnoGameState, count: number): { state: UnoGameState; cards: UnoCard[] } {
  let drawPile = state.drawPile;
  let discardPile = state.discardPile;

  const refillIfNeeded = (): void => {
    if (drawPile.length > 0) return;
    if (discardPile.length <= 1) return;
    const top = discardPile[discardPile.length - 1];
    const rest = discardPile.slice(0, -1);
    discardPile = [top];
    drawPile = shuffle(rest);
  };

  const out: UnoCard[] = [];
  for (let i = 0; i < count; i++) {
    refillIfNeeded();
    if (drawPile.length === 0) break;
    const c = drawPile[0];
    drawPile = drawPile.slice(1);
    if (c) out.push(c);
  }

  return { state: { ...state, drawPile, discardPile }, cards: out };
}

function generateLobbyCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

export class UnoGame {
  private lobbies: Map<string, UnoGameState> = new Map();
  private onStateUpdate: (lobbyCode: string) => void;
  private isCodeTaken?: (code: string) => boolean;

  constructor(onStateUpdate: (lobbyCode: string) => void, isCodeTaken?: (code: string) => boolean) {
    this.onStateUpdate = onStateUpdate;
    this.isCodeTaken = isCodeTaken;
  }

  createLobby(
    hostIdArg: string,
    nickname: string,
    avatarUrl: string | null,
    equippedBorder?: string | null,
    equippedEffect?: string | null,
  ): string {
    let code = generateLobbyCode();
    let tries = 0;
    while ((this.isCodeTaken?.(code) || this.lobbies.has(code)) && tries < 50) {
      code = generateLobbyCode();
      tries++;
    }

    const now = Date.now();

    const hostPlayer: UnoPlayer = {
      playerId: hostIdArg,
      seatIndex: 0,
      nickname: nickname || 'Host',
      avatarUrl: avatarUrl || null,
      isConnected: true,
      lastSeenAt: now,
      equippedBorder: equippedBorder ?? null,
      equippedEffect: equippedEffect ?? null,
    };

    const state: UnoGameState = {
      lobbyCode: code,
      hostId: hostIdArg,
      players: [hostPlayer],
      isPublic: false,
      maxPlayers: 10,

      phase: 'lobby',
      gameStarted: false,

      dealerIndex: 0,
      direction: 1,
      currentPlayerIndex: 0,

      hands: { [hostIdArg]: [] },
      drawPile: [],
      discardPile: [],

      currentColor: null,
      pendingDraw: 0,
      drawnPlayable: null,
      mustCallUno: null,
      unoPrompt: null,

      winnerId: null,
      celebration: null,
      rewardIssued: false,

      actionLog: [],

      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    this.lobbies.set(code, state);
    return code;
  }

  /** Create a persistent public lobby with a fixed code. */
  createPublicLobby(code: string): string {
    const now = Date.now();
    const state: UnoGameState = {
      lobbyCode: code,
      hostId: 'public',
      players: [],
      isPublic: true,
      maxPlayers: 10,

      phase: 'lobby',
      gameStarted: false,

      dealerIndex: 0,
      direction: 1,
      currentPlayerIndex: 0,

      hands: {},
      drawPile: [],
      discardPile: [],

      currentColor: null,
      pendingDraw: 0,
      drawnPlayable: null,
      mustCallUno: null,
      unoPrompt: null,

      winnerId: null,
      celebration: null,
      rewardIssued: false,

      actionLog: [],

      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    this.lobbies.set(code, state);
    return code;
  }

  getLobby(code: string): UnoGameState | undefined {
    return this.lobbies.get(code);
  }

  joinLobby(
    code: string,
    odotpid: string,
    nickname: string,
    avatarUrl: string | null,
    equippedBorder?: string | null,
    equippedEffect?: string | null,
  ): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { success: false, error: 'Lobby not found' };

    const now = Date.now();
    const existing = lobby.players.find((p) => p.playerId === odotpid);

    if (existing) {
      existing.isConnected = true;
      existing.lastSeenAt = now;
      existing.nickname = nickname || existing.nickname;
      existing.avatarUrl = avatarUrl ?? existing.avatarUrl;
      existing.equippedBorder = equippedBorder ?? existing.equippedBorder;
      existing.equippedEffect = equippedEffect ?? existing.equippedEffect;
      this.bump(code);
      this.lobbies.set(code, lobby);
      return { success: true };
    }

    // Disallow mid-game joins, except reconnect
    if (lobby.phase !== 'lobby' || lobby.gameStarted) {
      return { success: false, error: 'Game already in progress' };
    }

    const maxPlayers = lobby.maxPlayers ?? 10;
    if (lobby.players.length >= maxPlayers) return { success: false, error: 'Lobby is full' };

    const seatIndex = lobby.players.length;
    const player: UnoPlayer = {
      playerId: odotpid,
      seatIndex,
      nickname: nickname || 'Player',
      avatarUrl: avatarUrl || null,
      isConnected: true,
      lastSeenAt: now,
      equippedBorder: equippedBorder ?? null,
      equippedEffect: equippedEffect ?? null,
    };

    lobby.players.push(player);
    lobby.hands[odotpid] = lobby.hands[odotpid] || [];
    const joined = addLog(lobby, { type: 'joined', playerId: odotpid, text: `${player.nickname} joined the lobby` });
    this.lobbies.set(code, this.bumpState(joined));
    return { success: true };
  }

  leaveLobby(code: string, odotpid: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;

    const idx = lobby.players.findIndex((p) => p.playerId === odotpid);
    if (idx === -1) return;

    const p = lobby.players[idx];
    if (!lobby.gameStarted) {
      lobby.players.splice(idx, 1);
      delete lobby.hands[odotpid];
      lobby.players.forEach((pl, i) => (pl.seatIndex = i));

      const nextHost = lobby.hostId === odotpid ? lobby.players[0]?.playerId || lobby.hostId : lobby.hostId;
      const s1 = { ...lobby, hostId: nextHost };
      const s2 = addLog(s1, { type: 'left', playerId: odotpid, text: `${p.nickname} left the lobby` });
      this.lobbies.set(code, this.bumpState(s2));
    } else {
      lobby.players[idx] = { ...p, isConnected: false, lastSeenAt: Date.now() };
      const s2 = addLog(lobby, { type: 'left', playerId: odotpid, text: `${p.nickname} disconnected` });
      this.lobbies.set(code, this.bumpState(s2));
    }

    const l2 = this.lobbies.get(code);
    if (!l2) return;
    if (l2.players.length === 0 || l2.players.every((pl) => !pl.isConnected)) {
      if (l2.isPublic) {
        // Public rooms never die; reset to lobby state
        const now = Date.now();
        const reset: UnoGameState = {
          ...l2,
          hostId: 'public',
          players: [],
          phase: 'lobby',
          gameStarted: false,
          hands: {},
          drawPile: [],
          discardPile: [],
          currentColor: null,
          pendingDraw: 0,
          drawnPlayable: null,
          mustCallUno: null,
          unoPrompt: null,
          winnerId: null,
          celebration: null,
          rewardIssued: false,
          actionLog: [],
          updatedAt: now,
          version: (l2.version || 0) + 1,
        };
        this.lobbies.set(code, reset);
      } else {
        this.lobbies.delete(code);
      }
    }
  }

  endLobby(code: string, requesterId: string): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { success: false, error: 'Lobby not found' };
    if (lobby.isPublic) return { success: false, error: 'Public rooms cannot be ended' };
    if (lobby.hostId !== requesterId) return { success: false, error: 'Only host can end the lobby' };
    this.lobbies.delete(code);
    return { success: true };
  }

  startGame(code: string, requesterId: string): { success: boolean; error?: string } {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { success: false, error: 'Lobby not found' };
    if (!lobby.isPublic && lobby.hostId !== requesterId) return { success: false, error: 'Only host can start the game' };

    const activePlayers = lobby.players.filter((p) => p.isConnected);
    if (activePlayers.length < 2) return { success: false, error: 'Need at least 2 players' };
    if (lobby.phase !== 'lobby') return { success: false, error: 'Game already started' };

    const faces = makeDeckFaces();
    const deck = shuffle(instantiateDeck(faces, `uno_${code}`));

    let temp: UnoGameState = {
      ...lobby,
      phase: 'playing',
      gameStarted: true,
      drawPile: deck,
      discardPile: [],
      currentColor: null,
      direction: 1,
      winnerId: null,
      celebration: null,
      pendingDraw: 0,
      drawnPlayable: null,
      mustCallUno: null,
      unoPrompt: null,
      rewardIssued: false,
    };

    const hands: Record<string, UnoCard[]> = { ...temp.hands };
    for (const p of temp.players) {
      const drawn = drawCards(temp, 7);
      temp = drawn.state;
      hands[p.playerId] = drawn.cards;
    }

    // choose starting card (avoid wilds if possible)
    let start: UnoCard | null = null;
    for (let k = 0; k < 30; k++) {
      const drawn = drawCards(temp, 1);
      temp = drawn.state;
      const c = drawn.cards[0];
      if (!c) break;
      if (c.face.kind === 'wild' || c.face.kind === 'wild4') {
        temp = { ...temp, drawPile: shuffle([...temp.drawPile, c]) };
        continue;
      }
      start = c;
      break;
    }
    if (!start) {
      const drawn = drawCards(temp, 1);
      temp = drawn.state;
      start = drawn.cards[0] || null;
    }

    const dealerIndex = (temp.dealerIndex + 1) % temp.players.length;
    const baseDir: 1 | -1 = 1;
    let direction: 1 | -1 = baseDir;
    let currentPlayerIndex = nextIndex(dealerIndex, baseDir, temp.players.length, 1);
    let currentColor: UnoColor | null = null;
    const discardPile = start ? [start] : [];
    if (start && start.face.kind !== 'wild' && start.face.kind !== 'wild4') {
      currentColor = start.face.color;
    }

    let next: UnoGameState = {
      ...temp,
      hands,
      dealerIndex,
      direction,
      currentPlayerIndex,
      currentColor,
      discardPile,
    };

    next = addLog(next, {
      type: 'started',
      text: `Game started — Starting card: ${start ? cardLabel(start.face) : 'None'}`,
    });

    // apply start card effect
    if (start) {
      const n = next.players.length;
      const cur = dealerIndex;
      if (start.face.kind === 'skip') {
        next = addLog(next, { type: 'skipped', text: `Start card effect: Skip` });
        next = { ...next, currentPlayerIndex: nextIndex(cur, direction, n, 2) };
      } else if (start.face.kind === 'draw2') {
        const victimIdx = nextIndex(cur, direction, n, 1);
        const victim = next.players[victimIdx];
        const drawn = drawCards(next, 2);
        const victimHand = [...(hands[victim.playerId] || []), ...drawn.cards];
        next = drawn.state;
        next = {
          ...next,
          hands: { ...next.hands, [victim.playerId]: victimHand },
          currentPlayerIndex: nextIndex(cur, direction, n, 2),
        };
        next = addLog(next, { type: 'drew', text: `Start card effect: ${victim.nickname} draws 2 and is skipped` });
      } else if (start.face.kind === 'reverse') {
        direction = direction === 1 ? -1 : 1;
        if (n === 2) {
          next = addLog(next, { type: 'reversed', text: `Start card effect: Reverse (acts as Skip)` });
          next = { ...next, direction, currentPlayerIndex: dealerIndex };
        } else {
          next = addLog(next, { type: 'reversed', text: `Start card effect: Reverse` });
          next = { ...next, direction, currentPlayerIndex: nextIndex(dealerIndex, direction, n, 1) };
        }
      }
    }

    this.lobbies.set(code, this.bumpState(next));
    this.onStateUpdate(code);
    return { success: true };
  }

  handleAction(code: string, odotpid: string, action: UnoPlayerAction): { success: boolean; error?: string; version?: number } {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { success: false, error: 'Lobby not found' };
    if (!lobby.gameStarted || lobby.phase !== 'playing') return { success: false, error: 'Game not in progress' };

    /* ── UNO call / catch — no turn check needed ──────── */
    if (action.type === 'callUno') {
      return this.applyCallUno(lobby, code, odotpid);
    }
    if (action.type === 'catchUno') {
      return this.applyCatchUno(lobby, code, odotpid);
    }

    const idx = lobby.players.findIndex((p) => p.playerId === odotpid);
    if (idx !== lobby.currentPlayerIndex) return { success: false, error: 'Not your turn' };

    /* Auto-expire mustCallUno when the next normal action happens */
    if (lobby.mustCallUno) {
      lobby.mustCallUno = null;
      lobby.unoPrompt = null;
    }

    if (action.type === 'draw') {
      const res = this.applyDraw(lobby, odotpid);
      if (!res.success) return res;
      const ns = this.bumpState(res.state);
      this.lobbies.set(code, ns);
      this.onStateUpdate(code);
      return { success: true, version: ns.version };
    }

    if (action.type === 'pass') {
      const res = this.applyPass(lobby, odotpid);
      if (!res.success) return res;
      const ns = this.bumpState(res.state);
      this.lobbies.set(code, ns);
      this.onStateUpdate(code);
      return { success: true, version: ns.version };
    }

    if (action.type === 'play') {
      const res = this.applyPlay(lobby, odotpid, action.cardId, action.chosenColor);
      if (!res.success) return res;
      const ns = this.bumpState(res.state);
      this.lobbies.set(code, ns);
      this.onStateUpdate(code);
      return { success: true, version: ns.version };
    }

    return { success: false, error: 'Unknown action' };
  }

  getClientState(code: string, requestingPlayerId: string): UnoClientState | null {
    const lobby = this.lobbies.get(code);
    if (!lobby) return null;

    const players: UnoClientPlayer[] = lobby.players.map((p) => ({
      playerId: p.playerId,
      seatIndex: p.seatIndex,
      nickname: p.nickname,
      avatarUrl: p.avatarUrl,
      isConnected: p.isConnected,
      lastSeenAt: p.lastSeenAt,
      cardCount: (lobby.hands[p.playerId] || []).length,
      equippedBorder: p.equippedBorder ?? null,
      equippedEffect: p.equippedEffect ?? null,
    }));

    const hands: Record<string, UnoCard[]> = {};
    for (const p of lobby.players) {
      if (p.playerId === requestingPlayerId) {
        hands[p.playerId] = lobby.hands[p.playerId] || [];
      } else {
        const n = (lobby.hands[p.playerId] || []).length;
        hands[p.playerId] = Array.from({ length: n }).map((_, i) => ({
          id: `hidden_${p.playerId}_${i}`,
          face: { kind: 'wild' } as const,
        }));
      }
    }

    return {
      gameType: 'uno',
      lobbyCode: lobby.lobbyCode,
      hostId: lobby.hostId,
      players,
      isPublic: lobby.isPublic ?? false,
      maxPlayers: lobby.maxPlayers ?? 10,
      celebration: lobby.celebration ?? null,

      phase: lobby.phase,
      gameStarted: lobby.gameStarted,

      dealerIndex: lobby.dealerIndex,
      direction: lobby.direction,
      currentPlayerIndex: lobby.currentPlayerIndex,

      hands,
      drawPileCount: lobby.drawPile.length,
      discardPile: lobby.discardPile,

      currentColor: lobby.currentColor,
      pendingDraw: lobby.pendingDraw,
      drawnPlayable: lobby.drawnPlayable,
      mustCallUno: lobby.mustCallUno,
      unoPrompt: lobby.unoPrompt,
      winnerId: lobby.winnerId,

      myPlayerId: requestingPlayerId,

      actionLog: lobby.actionLog.slice(-50),

      createdAt: lobby.createdAt,
      updatedAt: lobby.updatedAt,
      version: lobby.version,
      serverTime: Date.now(),
    };
  }

  /* ── UNO call / catch ────────────────────────────────────── */

  private applyCallUno(
    lobby: UnoGameState,
    code: string,
    pid: string,
  ): { success: boolean; error?: string } {
    if (lobby.mustCallUno !== pid) {
      return { success: false, error: 'You don\'t need to call UNO' };
    }

    const player = lobby.players.find((p) => p.playerId === pid);
    let next: UnoGameState = { ...lobby, mustCallUno: null, unoPrompt: null };
    next = addLog(next, { type: 'uno_called', playerId: pid, text: `${player?.nickname || 'Player'} says UNO!` });

    this.lobbies.set(code, this.bumpState(next));
    this.onStateUpdate(code);
    return { success: true };
  }

  private applyCatchUno(
    lobby: UnoGameState,
    code: string,
    catcherPid: string,
  ): { success: boolean; error?: string } {
    if (!lobby.mustCallUno) {
      return { success: false, error: 'No one to catch' };
    }
    if (lobby.mustCallUno === catcherPid) {
      return { success: false, error: 'You cannot catch yourself' };
    }

    const violatorPid = lobby.mustCallUno;
    const violator = lobby.players.find((p) => p.playerId === violatorPid);
    const catcher = lobby.players.find((p) => p.playerId === catcherPid);

    let next: UnoGameState = { ...lobby, mustCallUno: null, unoPrompt: null };
    next = addLog(next, {
      type: 'uno_caught',
      playerId: catcherPid,
      text: `${catcher?.nickname || 'Player'} caught ${violator?.nickname || 'Player'}! Penalty: draw 2 cards`,
    });

    /* Penalty: violator draws 2 cards */
    const drawn = drawCards(next, 2);
    next = drawn.state;
    const violatorHand = [...(next.hands[violatorPid] || []), ...drawn.cards];
    next = { ...next, hands: { ...next.hands, [violatorPid]: violatorHand } };

    this.lobbies.set(code, this.bumpState(next));
    this.onStateUpdate(code);
    return { success: true };
  }

  /** Mark that the reward for this game has been issued (prevents duplicates) */
  markRewardIssued(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    lobby.rewardIssued = true;
  }

  private bump(code: string): void {
    const lobby = this.lobbies.get(code);
    if (!lobby) return;
    this.lobbies.set(code, this.bumpState(lobby));
    this.onStateUpdate(code);
  }

  private bumpState(s: UnoGameState): UnoGameState {
    return { ...s, updatedAt: Date.now(), version: (s.version || 0) + 1 };
  }

  private applyDraw(
    lobby: UnoGameState,
    pid: string,
  ): { success: true; state: UnoGameState } | { success: false; error: string } {
    if (lobby.drawnPlayable?.playerId === pid) return { success: false, error: 'Already drew a playable card' };

    const hand = lobby.hands[pid] || [];
    const top = lobby.discardPile.length ? lobby.discardPile[lobby.discardPile.length - 1].face : null;
    const playableNow = hand.some((c) => {
      if (!isPlayableCard(c.face, top, lobby.currentColor)) return false;
      if (c.face.kind === 'wild4' && lobby.currentColor && hasColor(hand, lobby.currentColor)) return false;
      return true;
    });
    if (playableNow) return { success: false, error: 'You have a playable card' };

    const drawn = drawCards(lobby, 1);
    const card = drawn.cards[0];
    if (!card) return { success: false, error: 'Draw pile is empty' };

    let next = drawn.state;
    const newHand = [...hand, card];
    next = { ...next, hands: { ...next.hands, [pid]: newHand } };

    const p = next.players[next.currentPlayerIndex];
    next = addLog(next, { type: 'drew', playerId: pid, text: `${p.nickname} drew 1 card` });

    const isPlayableDrawn =
      isPlayableCard(card.face, top, next.currentColor) && !(card.face.kind === 'wild4' && next.currentColor && hasColor(newHand, next.currentColor));

    if (isPlayableDrawn) {
      next = addLog(next, { type: 'system', text: `Drawn card is playable` });
      next = { ...next, drawnPlayable: { playerId: pid, cardId: card.id } };
    } else {
      next = addLog(next, { type: 'passed', playerId: pid, text: `${p.nickname} passes` });
      next = { ...next, currentPlayerIndex: nextIndex(next.currentPlayerIndex, next.direction, next.players.length, 1) };
    }

    return { success: true, state: next };
  }

  private applyPass(
    lobby: UnoGameState,
    pid: string,
  ): { success: true; state: UnoGameState } | { success: false; error: string } {
    if (!lobby.drawnPlayable || lobby.drawnPlayable.playerId !== pid) return { success: false, error: 'Cannot pass now' };
    let next: UnoGameState = { ...lobby, drawnPlayable: null };
    const p = next.players[next.currentPlayerIndex];
    next = addLog(next, { type: 'passed', playerId: pid, text: `${p.nickname} passes` });
    next = { ...next, currentPlayerIndex: nextIndex(next.currentPlayerIndex, next.direction, next.players.length, 1) };
    return { success: true, state: next };
  }

  private applyPlay(
    lobby: UnoGameState,
    pid: string,
    cardId: string,
    chosenColor?: UnoColor,
  ): { success: true; state: UnoGameState } | { success: false; error: string } {
    const hand = [...(lobby.hands[pid] || [])];
    const ci = hand.findIndex((c) => c.id === cardId);
    if (ci === -1) return { success: false, error: 'Card not found' };

    if (lobby.drawnPlayable?.playerId === pid && lobby.drawnPlayable.cardId !== cardId) {
      return { success: false, error: 'Must play the drawn card or pass' };
    }

    const card = hand[ci];
    const top = lobby.discardPile.length ? lobby.discardPile[lobby.discardPile.length - 1].face : null;
    const ok = isPlayableCard(card.face, top, lobby.currentColor);
    if (!ok) return { success: false, error: 'Card not playable' };
    if (card.face.kind === 'wild4' && lobby.currentColor && hasColor(hand, lobby.currentColor)) {
      return { success: false, error: 'Cannot play Wild Draw Four when you have the current color' };
    }
    if ((card.face.kind === 'wild' || card.face.kind === 'wild4') && !chosenColor) {
      return { success: false, error: 'chosenColor required' };
    }

    hand.splice(ci, 1);
    let next: UnoGameState = {
      ...lobby,
      hands: { ...lobby.hands, [pid]: hand },
      discardPile: [...lobby.discardPile, card],
      drawnPlayable: null,
      pendingDraw: 0,
    };

    const player = next.players[next.currentPlayerIndex];
    const afterCount = hand.length;

    if (card.face.kind === 'wild' || card.face.kind === 'wild4') {
      next = { ...next, currentColor: chosenColor! };
      next = addLog(next, {
        type: 'played',
        playerId: pid,
        text: `${player.nickname} played ${cardLabel(card.face)} — Color: ${chosenColor!.toUpperCase()}`,
      });
    } else {
      next = { ...next, currentColor: card.face.color };
      next = addLog(next, { type: 'played', playerId: pid, text: `${player.nickname} played ${cardLabel(card.face)}` });
    }

    if (afterCount === 1) {
      /* Player must press UNO — set the flag so others can catch them */
      const prompt: UnoPrompt = {
        active: true,
        targetPlayerId: pid,
        buttonPos: {
          x: Math.round(15 + Math.random() * 70),   // 15..85 %
          y: Math.round(20 + Math.random() * 55),    // 20..75 %
        },
        createdAt: Date.now(),
      };
      next = { ...next, mustCallUno: pid, unoPrompt: prompt };
    }

    if (afterCount === 0) {
      const equipped = next.players[next.currentPlayerIndex]?.equippedEffect ?? null;
      const effectId =
        equipped === 'effect_red_hearts' ? 'red_hearts'
        : equipped === 'effect_black_hearts' ? 'black_hearts'
        : 'stars';
      next = {
        ...next,
        phase: 'finished',
        winnerId: pid,
        celebration: {
          id: `uno_${code}_${Date.now()}`,
          winnerId: pid,
          effectId,
          createdAt: Date.now(),
        },
      };
      next = addLog(next, { type: 'winner', playerId: pid, text: `${player.nickname} wins!` });
      return { success: true, state: next };
    }

    const n = next.players.length;
    const dir = next.direction;
    const cur = next.currentPlayerIndex;

    const drawForNext = (amount: number): UnoGameState => {
      const victimIdx = nextIndex(cur, dir, n, 1);
      const victim = next.players[victimIdx];
      const drawn = drawCards(next, amount);
      const victimHand = [...(next.hands[victim.playerId] || []), ...drawn.cards];
      let t = drawn.state;
      t = { ...t, hands: { ...t.hands, [victim.playerId]: victimHand }, pendingDraw: amount };
      t = addLog(t, { type: 'drew', text: `${victim.nickname} draws ${amount} and is skipped` });
      t = { ...t, currentPlayerIndex: nextIndex(cur, dir, n, 2), pendingDraw: 0 };
      return t;
    };

    if (card.face.kind === 'skip') {
      next = addLog(next, { type: 'skipped', text: `Skip!` });
      next = { ...next, currentPlayerIndex: nextIndex(cur, dir, n, 2) };
    } else if (card.face.kind === 'reverse') {
      const ndir: 1 | -1 = dir === 1 ? -1 : 1;
      next = addLog(next, { type: 'reversed', text: `Reverse!` });
      if (n === 2) {
        next = { ...next, direction: ndir, currentPlayerIndex: cur };
      } else {
        next = { ...next, direction: ndir, currentPlayerIndex: nextIndex(cur, ndir, n, 1) };
      }
    } else if (card.face.kind === 'draw2') {
      next = addLog(next, { type: 'system', text: `Draw Two!` });
      next = drawForNext(2);
    } else if (card.face.kind === 'wild4') {
      next = addLog(next, { type: 'system', text: `Wild Draw Four!` });
      next = drawForNext(4);
    } else {
      next = { ...next, currentPlayerIndex: nextIndex(cur, dir, n, 1) };
    }

    return { success: true, state: next };
  }
}

