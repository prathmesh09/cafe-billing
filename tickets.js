// Kitchen tickets: what each kitchen still has to make.
//
// `sent` remembers how many of each item a kitchen has already been told about for one
// order, so when a table orders more, only the extra items are sent. Items from a
// kitchen in NO_KITCHEN (cigarettes, water, cold drinks) go to nobody.

import { lineKey } from './bill.js';

const NO_KITCHEN = ['Counter'];

export function newTickets(lines, sent, { label, time, idPrefix }) {
  const byKitchen = new Map();
  const nextSent = { ...sent };
  for (const line of lines) {
    if (NO_KITCHEN.includes(line.kitchen)) continue;
    const key = lineKey(line);
    const already = sent[key] ?? 0;
    const extra = line.qty - already;
    nextSent[key] = Math.max(already, line.qty);
    if (extra <= 0) continue;
    if (!byKitchen.has(line.kitchen)) byKitchen.set(line.kitchen, []);
    byKitchen.get(line.kitchen).push({ item: line.item, qty: extra });
  }
  const tickets = [...byKitchen].map(([kitchen, items]) => ({ id: `${idPrefix}-${kitchen}`, kitchen, label, time, items }));
  return { tickets, sent: nextSent };
}
