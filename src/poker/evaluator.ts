import type { Card, Rank, Suit, HandRank } from '../types.js';

const RANK_VALUES: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const HAND_RANKINGS = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  ROYAL_FLUSH: 10
};

function getRankValue(rank: Rank): number {
  return RANK_VALUES[rank];
}

function sortByRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => getRankValue(b.rank) - getRankValue(a.rank));
}

function groupByRank(cards: Card[]): Map<Rank, Card[]> {
  const groups = new Map<Rank, Card[]>();
  for (const card of cards) {
    const existing = groups.get(card.rank) || [];
    existing.push(card);
    groups.set(card.rank, existing);
  }
  return groups;
}

function groupBySuit(cards: Card[]): Map<Suit, Card[]> {
  const groups = new Map<Suit, Card[]>();
  for (const card of cards) {
    const existing = groups.get(card.suit) || [];
    existing.push(card);
    groups.set(card.suit, existing);
  }
  return groups;
}

function isFlush(cards: Card[]): Card[] | null {
  const suitGroups = groupBySuit(cards);
  for (const [, suited] of suitGroups) {
    if (suited.length >= 5) {
      return sortByRank(suited).slice(0, 5);
    }
  }
  return null;
}

function isStraight(cards: Card[]): Card[] | null {
  const uniqueRanks = [...new Set(cards.map(c => getRankValue(c.rank)))].sort((a, b) => b - a);
  
  // Check for A-2-3-4-5 (wheel)
  if (uniqueRanks.includes(14) && uniqueRanks.includes(2) && 
      uniqueRanks.includes(3) && uniqueRanks.includes(4) && uniqueRanks.includes(5)) {
    const wheel: Card[] = [];
    for (const val of [5, 4, 3, 2]) {
      const card = cards.find(c => getRankValue(c.rank) === val);
      if (card) wheel.push(card);
    }
    const ace = cards.find(c => c.rank === 'A');
    if (ace) wheel.push(ace);
    return wheel;
  }
  
  // Check regular straights
  for (let i = 0; i <= uniqueRanks.length - 5; i++) {
    const sequence = uniqueRanks.slice(i, i + 5);
    if (sequence[0] - sequence[4] === 4) {
      const straightCards: Card[] = [];
      for (const val of sequence) {
        const card = cards.find(c => getRankValue(c.rank) === val && !straightCards.includes(c));
        if (card) straightCards.push(card);
      }
      if (straightCards.length === 5) return straightCards;
    }
  }
  
  return null;
}

function isStraightFlush(cards: Card[]): Card[] | null {
  const suitGroups = groupBySuit(cards);
  for (const [, suited] of suitGroups) {
    if (suited.length >= 5) {
      const straight = isStraight(suited);
      if (straight) return straight;
    }
  }
  return null;
}

function isRoyalFlush(cards: Card[]): Card[] | null {
  const straightFlush = isStraightFlush(cards);
  if (straightFlush && getRankValue(straightFlush[0].rank) === 14) {
    return straightFlush;
  }
  return null;
}

function getFourOfAKind(cards: Card[]): { quads: Card[], kicker: Card } | null {
  const rankGroups = groupByRank(cards);
  for (const [, group] of rankGroups) {
    if (group.length === 4) {
      const kicker = sortByRank(cards.filter(c => c.rank !== group[0].rank))[0];
      return { quads: group, kicker };
    }
  }
  return null;
}

function getFullHouse(cards: Card[]): { trips: Card[], pair: Card[] } | null {
  const rankGroups = groupByRank(cards);
  const trips: Card[] = [];
  const pairs: Card[][] = [];
  
  for (const [, group] of rankGroups) {
    if (group.length >= 3 && trips.length === 0) {
      trips.push(...group.slice(0, 3));
    } else if (group.length >= 2) {
      pairs.push(group.slice(0, 2));
    }
  }
  
  // Also check if we have multiple trips (use one as pair)
  if (trips.length === 0) {
    const allTrips: Card[][] = [];
    for (const [, group] of rankGroups) {
      if (group.length >= 3) {
        allTrips.push(group);
      }
    }
    if (allTrips.length >= 2) {
      const sorted = allTrips.sort((a, b) => getRankValue(b[0].rank) - getRankValue(a[0].rank));
      return { trips: sorted[0].slice(0, 3), pair: sorted[1].slice(0, 2) };
    }
  }
  
  if (trips.length === 3 && pairs.length > 0) {
    const sortedPairs = pairs.sort((a, b) => getRankValue(b[0].rank) - getRankValue(a[0].rank));
    return { trips, pair: sortedPairs[0] };
  }
  
  return null;
}

function getThreeOfAKind(cards: Card[]): { trips: Card[], kickers: Card[] } | null {
  const rankGroups = groupByRank(cards);
  for (const [, group] of rankGroups) {
    if (group.length === 3) {
      const kickers = sortByRank(cards.filter(c => c.rank !== group[0].rank)).slice(0, 2);
      return { trips: group, kickers };
    }
  }
  return null;
}

function getTwoPair(cards: Card[]): { pairs: Card[][], kicker: Card } | null {
  const rankGroups = groupByRank(cards);
  const pairs: Card[][] = [];
  
  for (const [, group] of rankGroups) {
    if (group.length >= 2) {
      pairs.push(group.slice(0, 2));
    }
  }
  
  if (pairs.length >= 2) {
    const sortedPairs = pairs.sort((a, b) => getRankValue(b[0].rank) - getRankValue(a[0].rank));
    const usedRanks = [sortedPairs[0][0].rank, sortedPairs[1][0].rank];
    const kicker = sortByRank(cards.filter(c => !usedRanks.includes(c.rank)))[0];
    return { pairs: sortedPairs.slice(0, 2), kicker };
  }
  
  return null;
}

function getOnePair(cards: Card[]): { pair: Card[], kickers: Card[] } | null {
  const rankGroups = groupByRank(cards);
  for (const [, group] of rankGroups) {
    if (group.length === 2) {
      const kickers = sortByRank(cards.filter(c => c.rank !== group[0].rank)).slice(0, 3);
      return { pair: group, kickers };
    }
  }
  return null;
}

export function evaluateHand(holeCards: Card[], communityCards: Card[]): HandRank {
  const allCards = [...holeCards, ...communityCards];
  
  // Royal Flush
  const royalFlush = isRoyalFlush(allCards);
  if (royalFlush) {
    return {
      rank: HAND_RANKINGS.ROYAL_FLUSH,
      name: 'Royal Flush',
      tiebreakers: [14],
      cards: royalFlush
    };
  }
  
  // Straight Flush
  const straightFlush = isStraightFlush(allCards);
  if (straightFlush) {
    return {
      rank: HAND_RANKINGS.STRAIGHT_FLUSH,
      name: 'Straight Flush',
      tiebreakers: [getRankValue(straightFlush[0].rank)],
      cards: straightFlush
    };
  }
  
  // Four of a Kind
  const fourOfKind = getFourOfAKind(allCards);
  if (fourOfKind) {
    return {
      rank: HAND_RANKINGS.FOUR_OF_A_KIND,
      name: 'Four of a Kind',
      tiebreakers: [getRankValue(fourOfKind.quads[0].rank), getRankValue(fourOfKind.kicker.rank)],
      cards: [...fourOfKind.quads, fourOfKind.kicker]
    };
  }
  
  // Full House
  const fullHouse = getFullHouse(allCards);
  if (fullHouse) {
    return {
      rank: HAND_RANKINGS.FULL_HOUSE,
      name: 'Full House',
      tiebreakers: [getRankValue(fullHouse.trips[0].rank), getRankValue(fullHouse.pair[0].rank)],
      cards: [...fullHouse.trips, ...fullHouse.pair]
    };
  }
  
  // Flush
  const flush = isFlush(allCards);
  if (flush) {
    return {
      rank: HAND_RANKINGS.FLUSH,
      name: 'Flush',
      tiebreakers: flush.map(c => getRankValue(c.rank)),
      cards: flush
    };
  }
  
  // Straight
  const straight = isStraight(allCards);
  if (straight) {
    // For wheel (A-2-3-4-5), the high card is 5
    const highCard = straight[0].rank === 'A' && straight[1].rank === '5' 
      ? 5 : getRankValue(straight[0].rank);
    return {
      rank: HAND_RANKINGS.STRAIGHT,
      name: 'Straight',
      tiebreakers: [highCard],
      cards: straight
    };
  }
  
  // Three of a Kind
  const threeOfKind = getThreeOfAKind(allCards);
  if (threeOfKind) {
    return {
      rank: HAND_RANKINGS.THREE_OF_A_KIND,
      name: 'Three of a Kind',
      tiebreakers: [
        getRankValue(threeOfKind.trips[0].rank),
        ...threeOfKind.kickers.map(c => getRankValue(c.rank))
      ],
      cards: [...threeOfKind.trips, ...threeOfKind.kickers]
    };
  }
  
  // Two Pair
  const twoPair = getTwoPair(allCards);
  if (twoPair) {
    return {
      rank: HAND_RANKINGS.TWO_PAIR,
      name: 'Two Pair',
      tiebreakers: [
        getRankValue(twoPair.pairs[0][0].rank),
        getRankValue(twoPair.pairs[1][0].rank),
        getRankValue(twoPair.kicker.rank)
      ],
      cards: [...twoPair.pairs[0], ...twoPair.pairs[1], twoPair.kicker]
    };
  }
  
  // One Pair
  const onePair = getOnePair(allCards);
  if (onePair) {
    return {
      rank: HAND_RANKINGS.ONE_PAIR,
      name: 'One Pair',
      tiebreakers: [
        getRankValue(onePair.pair[0].rank),
        ...onePair.kickers.map(c => getRankValue(c.rank))
      ],
      cards: [...onePair.pair, ...onePair.kickers]
    };
  }
  
  // High Card
  const highCards = sortByRank(allCards).slice(0, 5);
  return {
    rank: HAND_RANKINGS.HIGH_CARD,
    name: 'High Card',
    tiebreakers: highCards.map(c => getRankValue(c.rank)),
    cards: highCards
  };
}

export function compareHands(hand1: HandRank, hand2: HandRank): number {
  if (hand1.rank !== hand2.rank) {
    return hand1.rank - hand2.rank;
  }
  
  for (let i = 0; i < hand1.tiebreakers.length; i++) {
    if (hand1.tiebreakers[i] !== hand2.tiebreakers[i]) {
      return hand1.tiebreakers[i] - hand2.tiebreakers[i];
    }
  }
  
  return 0;
}

export function findWinners(
  playerHands: Array<{ pid: string; hand: HandRank }>
): string[] {
  if (playerHands.length === 0) return [];
  if (playerHands.length === 1) return [playerHands[0].pid];
  
  const sorted = [...playerHands].sort((a, b) => compareHands(b.hand, a.hand));
  const bestHand = sorted[0].hand;
  
  return sorted
    .filter(p => compareHands(p.hand, bestHand) === 0)
    .map(p => p.pid);
}
