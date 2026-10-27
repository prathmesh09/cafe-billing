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

// An existing name that a newly typed one is probably meant to be ("Oinon" → "Onion",
// "Egg" → "Eggs"), or null. Case, spaces and up to two letters' difference are ignored.
export function closeMatch(name, names) {
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = flat(name);
  if (a.length < 3) return null;
  let best = null;
  let bestDistance = 3;
  for (const other of names) {
    const b = flat(other);
    if (!b || b === a) continue;
    const d = b.startsWith(a) || a.startsWith(b) ? Math.min(Math.abs(a.length - b.length), 2) : distance(a, b);
    if (d < bestDistance) {
      best = other;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
