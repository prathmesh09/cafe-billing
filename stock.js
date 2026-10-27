// Stock counts and deliveries typed on a kitchen phone. The typed numbers are kept on
// the phone until the sheet has them, so a closed app or a lost connection loses nothing.

import { localDate, localTime } from './bill.js';

const DRAFT_KEY = 'cafe-billing-stock-draft';

// A number of at least 0, from what was typed ("2,5" is read as 2.5). Null if none.
export function parseQty(text) {
  const clean = String(text ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  return Number(clean);
}

// The entry the sheet expects, or null when no item has a number yet.
export function stockEntry({ id, kitchen, kind, items, values, now }) {
  const lines = [];
  items.forEach(({ item }) => {
    const qty = parseQty(values[item]);
    if (qty !== null) lines.push({ item, qty });
  });
  if (lines.length === 0) return null;
  return { id, kitchen, kind, date: localDate(now), time: localTime(now), lines };
}

export function loadStockDraft(storage) {
  try {
    const saved = JSON.parse(storage.getItem(DRAFT_KEY));
    return saved && typeof saved === 'object' && saved.drafts && typeof saved.drafts === 'object' ? saved : null;
  } catch {
    return null;
  }
}

// saved: { kind, drafts: { Count: { id, values }, Received: { id, values } } }, one draft per
// kind so switching tabs never wipes a half-typed count.
// Best effort: a full phone still shows the numbers on screen until the app is closed.
export function saveStockDraft(storage, saved) {
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(saved));
  } catch {
    // nothing more can be done
  }
}
