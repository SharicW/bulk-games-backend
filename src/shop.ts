import { Router, type Request, type Response } from 'express';
import pool from './db.js';
import { authMiddleware } from './auth.js';

/* ── Shop item catalog (hardcoded) ─────────────────────────────── */

export interface ShopItem {
  id: string;
  name: string;
  type: 'border' | 'effect';
  price: number;
  description: string;
  /** CSS class applied to avatar wrapper */
  cssClass: string;
}

export const SHOP_ITEMS: ShopItem[] = [
  // Borders
  { id: 'border_gold', name: 'Golden Ring', type: 'border', price: 50, description: 'A shiny golden border around your avatar.', cssClass: 'cosmetic-border--gold' },
  { id: 'border_rainbow', name: 'Rainbow Ring', type: 'border', price: 50, description: 'A colorful rainbow gradient border.', cssClass: 'cosmetic-border--rainbow' },
  { id: 'border_neon', name: 'Neon Glow', type: 'border', price: 50, description: 'Electric neon glow around your avatar.', cssClass: 'cosmetic-border--neon' },
  { id: 'border_fire', name: 'Fire Ring', type: 'border', price: 50, description: 'Blazing fire ring around your avatar.', cssClass: 'cosmetic-border--fire' },
  { id: 'border_ice', name: 'Ice Ring', type: 'border', price: 50, description: 'A crisp icy rim with a cool glow.', cssClass: 'cosmetic-border--ice' },
  { id: 'border_starlight', name: 'Starlight Ring', type: 'border', price: 50, description: 'A glowing white starlight border.', cssClass: 'cosmetic-border--starlight' },
  { id: 'border_purple', name: 'Purple Aura', type: 'border', price: 50, description: 'A violet gradient ring with a subtle aura.', cssClass: 'cosmetic-border--purple' },
  { id: 'border_ruby', name: 'Ruby Ring', type: 'border', price: 50, description: 'A deep crimson ruby ring with a soft red glow.', cssClass: 'cosmetic-border--ruby' },
  // Effects
  // NOTE: effect_gold_stars is a built-in default effect (not listed in store catalog)
  { id: 'effect_red_hearts', name: 'Red Hearts', type: 'effect', price: 80, description: 'Celebrate wins with a burst of red hearts.', cssClass: 'cosmetic-effect--hearts-red' },
  { id: 'effect_black_hearts', name: 'Black Hearts', type: 'effect', price: 80, description: 'Celebrate wins with a burst of black hearts.', cssClass: 'cosmetic-effect--hearts-black' },
  { id: 'effect_fire_burst', name: 'Fire Burst', type: 'effect', price: 80, description: 'Celebrate wins with a burst of fiery sparks.', cssClass: 'cosmetic-effect--fire-burst' },
  { id: 'effect_water_burst', name: 'Water Burst', type: 'effect', price: 80, description: 'Celebrate wins with a splash of cool water droplets.', cssClass: 'cosmetic-effect--water-burst' },
  { id: 'effect_sakura_petals', name: 'Sakura Petals', type: 'effect', price: 80, description: 'Celebrate wins with drifting sakura petals.', cssClass: 'cosmetic-effect--sakura-petals' },
  { id: 'effect_rainbow_burst', name: 'Rainbow Burst', type: 'effect', price: 80, description: 'Celebrate wins with a burst of rainbow sparkles.', cssClass: 'cosmetic-effect--rainbow-burst' },
];

const ITEMS_MAP = new Map(SHOP_ITEMS.map(i => [i.id, i]));

/* ── Router ────────────────────────────────────────────────────── */

const router = Router();

// GET /shop/items — return catalog
router.get('/items', (_req: Request, res: Response) => {
  res.json({ items: SHOP_ITEMS });
});

// POST /shop/buy — purchase an item
router.post('/buy', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { itemId } = req.body ?? {};

    if (!itemId || !ITEMS_MAP.has(itemId)) {
      res.status(400).json({ error: 'Invalid item' });
      return;
    }

    const item = ITEMS_MAP.get(itemId)!;

    // Check if already owned
    const owned = await pool.query(
      'SELECT 1 FROM user_cosmetics WHERE user_id = $1 AND item_id = $2',
      [userId, itemId],
    );
    if (owned.rows.length > 0) {
      res.status(400).json({ error: 'You already own this item' });
      return;
    }

    // Check coins
    const userRow = await pool.query(
      'SELECT coins FROM users WHERE id = $1',
      [userId],
    );
    if (userRow.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const coins: number = userRow.rows[0].coins;
    if (coins < item.price) {
      res.status(400).json({ error: `Not enough coins (have ${coins}, need ${item.price})` });
      return;
    }

    // Deduct coins and insert cosmetic (atomic)
    await pool.query('BEGIN');
    await pool.query(
      'UPDATE users SET coins = coins - $1, updated_at = now() WHERE id = $2',
      [item.price, userId],
    );
    await pool.query(
      'INSERT INTO user_cosmetics (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, itemId],
    );
    await pool.query('COMMIT');

    const updated = await pool.query(
      'SELECT coins FROM users WHERE id = $1',
      [userId],
    );

    res.json({ success: true, coins: updated.rows[0].coins });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => { });
    console.error('Shop buy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /shop/equip — equip an owned item
router.post('/equip', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { itemId } = req.body ?? {};

    // Allow null/empty to unequip
    if (itemId) {
      const item = ITEMS_MAP.get(itemId);
      if (!item) {
        res.status(400).json({ error: 'Invalid item' });
        return;
      }

      // Check ownership
      const owned = await pool.query(
        'SELECT 1 FROM user_cosmetics WHERE user_id = $1 AND item_id = $2',
        [userId, itemId],
      );
      if (owned.rows.length === 0) {
        res.status(400).json({ error: 'You do not own this item' });
        return;
      }

      const column = item.type === 'border' ? 'equipped_border' : 'equipped_effect';
      await pool.query(
        `UPDATE users SET ${column} = $1, updated_at = now() WHERE id = $2`,
        [itemId, userId],
      );
    } else {
      // Unequip: figure out what to unequip from the request
      const { slot } = req.body ?? {};
      if (slot === 'border') {
        await pool.query('UPDATE users SET equipped_border = NULL, updated_at = now() WHERE id = $1', [userId]);
      } else if (slot === 'effect') {
        await pool.query('UPDATE users SET equipped_effect = NULL, updated_at = now() WHERE id = $1', [userId]);
      } else {
        res.status(400).json({ error: 'Provide itemId to equip or slot to unequip' });
        return;
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Shop equip error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
