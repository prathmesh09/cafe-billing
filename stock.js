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

// A measured item (fries, paneer, milk) is counted as full packs plus the open one in g or
// ml; it needs a pack size, or it is asked as a plain number like the rest.
export function measured(it) {
  return it.countAs === 'measure' && Number(it.per) > 0 && Boolean(it.recipeUnit);
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

// A row's quantity in the item's counted unit, or null when nothing is filled in.
// value: the typed text, or { full, open } for a measured item.
export function qtyOf(value, it) {
  // A measured row shows two boxes; a plain number left from before is not shown, so not sent.
  if (measured(it) && typeof value === 'string') return null;
  if (value && typeof value === 'object') {
    const full = parseQty(value.full);
    const open = parseQty(value.open);
    if (full === null && open === null) return null;
    const per = Number(it.per) > 0 ? Number(it.per) : 1;
    return round((full ?? 0) + (open ?? 0) / per, 4);
  }
  return parseQty(value);
}

// What a row's boxes hold for a quantity (for "Same as last").
export function valueFor(it, qty) {
  if (measured(it)) {
    const full = Math.floor(qty + 1e-9);
    return { full: String(full), open: String(Math.round((qty - full) * Number(it.per))) };
  }
  return String(round(qty, 2));
}

// A quantity in the words staff count in: "22 nos", "1 packets + 700 g", "1.25 kg".
export function sayQty(it, qty) {
  if (measured(it)) {
    const full = Math.floor(qty + 1e-9);
    const open = Math.round((qty - full) * Number(it.per));
    // "1 packet", "2 packets" (units are written plural on the sheet; "nos" stays).
    const unit = full === 1 && /[^o]s$/.test(it.unit) ? it.unit.slice(0, -1) : it.unit;
    if (!open) return `${full} ${unit}`;
    return full ? `${full} ${unit} + ${open} ${it.recipeUnit}` : `${open} ${it.recipeUnit}`;
  }
  return `${round(qty, 2)} ${it.unit}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Last count (yesterday 23:40): 22 nos", or "Not counted yet".
export function lastText(it, now) {
  if (!it.last) return 'Not counted yet';
  const today = localDate(now);
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  let day;
  if (it.last.date === today) day = 'today';
  else if (it.last.date === localDate(y)) day = 'yesterday';
  else {
    const [yy, mm, dd] = it.last.date.split('-').map(Number);
    const d = new Date(yy, mm - 1, dd);
    day = `${WEEKDAYS[d.getDay()]} ${dd} ${MONTHS[mm - 1]}`;
  }
  return `Last count (${day} ${it.last.time}): ${sayQty(it, Number(it.last.qty))}`;
}

export function countProgress(items, values) {
  return { done: items.filter((it) => qtyOf(values[it.item], it) !== null).length, total: items.length };
}

// The entry the sheet expects, or null when no item has a number yet.
export function stockEntry({ id, kitchen, kind, items, values, now }) {
  const lines = [];
  items.forEach((it) => {
    const qty = qtyOf(values[it.item], it);
    if (qty !== null) lines.push({ item: it.item, qty });
  });
  if (lines.length === 0) return null;
  return { id, kitchen, kind, date: localDate(now), time: localTime(now), lines };
}

// Drafts older than this are dropped when the app opens: a half-typed count from days ago
// must not slip into tonight's (draft ids are STK-<ms>-…).
export const STOCK_DRAFT_HOURS = 18;
export function freshStockDrafts(saved, now) {
  const drafts = {};
  Object.entries((saved && saved.drafts) || {}).forEach(([kind, d]) => {
    const made = Number(String(d && d.id).split('-')[1]);
    if (made > 0 && now - made < STOCK_DRAFT_HOURS * 3600000) drafts[kind] = d;
  });
  return { ...(saved || {}), drafts };
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
