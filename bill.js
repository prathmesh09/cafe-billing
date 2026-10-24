// Bill maths. Pure functions: nothing here touches storage, the network or the page.

const PAYMENTS = ['Cash', 'Online'];
const SUFFIX_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const pad = (n) => String(n).padStart(2, '0');

export function emptyDraft() {
  return { lines: [] };
}

export function lineKey({ kitchen, item }) {
  return `${kitchen}|${item}`;
}

export function addItem(draft, menuItem) {
  const key = lineKey(menuItem);
  if (draft.lines.some((l) => lineKey(l) === key)) return changeQty(draft, key, 1);
  const { item, kitchen, category, price } = menuItem;
  return { lines: [...draft.lines, { item, kitchen, category, price, qty: 1 }] };
}

export function changeQty(draft, key, delta) {
  const lines = draft.lines
    .map((l) => (lineKey(l) === key ? { ...l, qty: l.qty + delta } : l))
    .filter((l) => l.qty > 0);
  return { lines };
}

export function draftTotal(draft) {
  return draft.lines.reduce((sum, l) => sum + l.qty * l.price, 0);
}

export function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function randomSuffix(random = Math.random) {
  let out = '';
  for (let i = 0; i < 4; i++) out += SUFFIX_CHARS[Math.floor(random() * SUFFIX_CHARS.length)];
  return out;
}

export function makeBillId(outlet, d, suffix) {
  const code = outlet.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const day = localDate(d).replaceAll('-', '');
  const clock = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${code}-${day}-${clock}-${suffix}`;
}

export function finalizeBill(draft, { outlet, payment, now, billNo, suffix }) {
  if (draft.lines.length === 0) throw new Error('empty_bill');
  if (!PAYMENTS.includes(payment)) throw new Error('bad_payment');
  return {
    id: makeBillId(outlet, now, suffix),
    billNo,
    date: localDate(now),
    time: localTime(now),
    outlet,
    total: draftTotal(draft),
    payment,
    status: 'Paid',
    lines: draft.lines.map(({ item, kitchen, category, qty, price }) => (
      { item, kitchen, category, qty, price, amount: qty * price })),
  };
}

// Top items are ranked by rupees earned, not by how many were sold: tea and cigarettes
// would win on quantity every single day and say nothing. Counter items (made or sold at
// the counter, no kitchen) are added up on their own line, and parcel charges are left out.
export function summarize(bills) {
  const paid = bills.filter((b) => b.status !== 'Cancelled');
  const sum = (list) => list.reduce((total, b) => total + b.total, 0);
  const byItem = new Map();
  let counterTotal = 0;
  for (const b of paid) {
    for (const l of b.lines) {
      const amount = l.amount ?? l.qty * l.price;
      if (l.kitchen === 'Counter') { counterTotal += amount; continue; }
      if (l.item.startsWith('Parcel')) continue;
      const known = byItem.get(l.item) ?? { item: l.item, qty: 0, amount: 0 };
      known.qty += l.qty;
      known.amount += amount;
      byItem.set(l.item, known);
    }
  }
  const topItems = [...byItem.values()]
    .sort((a, b) => b.amount - a.amount || a.item.localeCompare(b.item))
    .slice(0, 5);
  return {
    total: sum(paid),
    cash: sum(paid.filter((b) => b.payment === 'Cash')),
    online: sum(paid.filter((b) => b.payment === 'Online')),
    count: paid.length,
    topItems,
    counterTotal,
  };
}
