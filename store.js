// Everything the phone remembers. `storage` is localStorage or anything shaped like it.
//
// Bills, the upload queue and set-aside messages live under ONE key, so a bill and its
// queue entry are written together or not at all. Nothing is cached in memory: every
// call reads storage, so a failed write leaves the store's answers unchanged.

import { newTickets } from './tickets.js';

const KEYS = { settings: 'cb.settings', menu: 'cb.menu', sync: 'cb.sync', data: 'cb.data', sheetToday: 'cb.sheetToday' };
const DEFAULT_SETTINGS = { outlet: 'Bhukum', scriptUrl: '', passcode: '' };
const DEFAULT_SYNC = { lastError: null, lastSuccessAt: null };
const KEEP_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');

function daysBefore(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const then = new Date(y, m - 1, d - days);
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
}

const billIdOf = (message) => (message.action === 'addBill' ? message.bill.id : message.billId);

// Two queue entries are the same message when they do the same thing to the same bill.
// Table messages carry their own id (mid), because one table is updated many times.
const sameMessage = (a, b) => {
  if (!a || !b || a.action !== b.action) return false;
  if (a.mid || b.mid) return a.mid === b.mid;
  return billIdOf(a) === billIdOf(b);
};

let messageCount = 0;
const newMid = () => `m-${Date.now()}-${(messageCount += 1)}-${Math.random().toString(36).slice(2, 7)}`;
const tableMessage = (order) => ({ action: 'putOpen', mid: newMid(), order: { ...order } });
const closeMessage = (orderId) => ({ action: 'closeOpen', mid: newMid(), orderId });
const ticketMessages = (tickets) => tickets.map((ticket) => ({ action: 'addTicket', mid: newMid(), ticket }));
const orderLabel = (o) => (o.table ? `Table ${o.table}` : `Order ${o.tag}`);

// Works out which items the kitchens have not been told about yet, remembers them on the
// order, and returns the messages that tell them.
function sendToKitchens(order, time) {
  const { tickets, sent } = newTickets(order.lines, order.sent ?? {}, { label: orderLabel(order), time, idPrefix: newMid() });
  order.sent = sent;
  return ticketMessages(tickets);
}

const orderIdOf = (m) => (m.action === 'putOpen' ? m.order.id : m.action === 'closeOpen' ? m.orderId : null);

export function createStore(storage) {
  const read = (key, fallback) => {
    const raw = storage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  };
  const write = (key, value) => storage.setItem(key, JSON.stringify(value));

  // `open` holds orders kept for people who pay after eating. They are not bills yet.
  // `kitchen` is a separate queue for kitchen tickets, sent before anything else so the
  // kitchens hear about an order as fast as possible.
  const readData = () => ({ bills: [], queue: [], rejected: [], open: [], kitchen: [], ...read(KEYS.data, {}) });
  const writeData = (data) => write(KEYS.data, data);

  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }),
    saveSettings: (partial) => write(KEYS.settings, { ...read(KEYS.settings, {}), ...partial }),

    getMenu() {
      const menu = read(KEYS.menu, null);
      return menu && Array.isArray(menu.items) ? menu : { items: [], fetchedAt: null };
    },
    saveMenu: (items, fetchedAt) => write(KEYS.menu, { items, fetchedAt }),

    // Counts on from the highest number seen today, on this phone or in the sheet, so a
    // phone that was wiped or rescanned does not start again at 1.
    nextBillNo(date) {
      const sheet = read(KEYS.sheetToday, null);
      const fromSheet = sheet && sheet.date === date ? sheet.bills : [];
      const numbers = [...readData().bills, ...fromSheet].filter((b) => b.date === date).map((b) => b.billNo);
      return Math.max(0, ...numbers) + 1;
    },

    // The sheet's copy of today's bills, as last fetched. Only one day is kept.
    saveSheetToday: (date, bills, fetchedAt) => write(KEYS.sheetToday, { date, bills, fetchedAt }),
    getSheetToday(date) {
      const sheet = read(KEYS.sheetToday, null);
      return sheet && sheet.date === date ? sheet : null;
    },

    // Today's bills from every phone: the sheet's copy plus this phone's bills (which may
    // not have reached the sheet yet). A cancel made on this phone wins.
    todayBills(date) {
      const byId = new Map();
      const sheet = read(KEYS.sheetToday, null);
      if (sheet && sheet.date === date) sheet.bills.forEach((b) => byId.set(b.id, b));
      readData().bills.filter((b) => b.date === date).forEach((b) => {
        const known = byId.get(b.id);
        if (!known || b.status === 'Cancelled') byId.set(b.id, b);
      });
      return [...byId.values()].sort((x, y) => y.billNo - x.billNo);
    },

    // Pass openId when the bill settles an open order: the order is closed in the same
    // write, so it can never be left open after it has been paid.
    recordBill(bill, openId) {
      const data = readData();
      const order = openId ? data.open.find((o) => o.id === openId) : null;
      if (openId) data.open = data.open.filter((o) => o.id !== openId);
      data.bills.push(bill);
      data.queue.push({ action: 'addBill', bill });
      if (openId) data.queue.push(closeMessage(openId));
      // Whatever the kitchens have not had yet: everything for a counter bill, only the
      // last additions for a table.
      const label = order ? orderLabel(order) : `Bill #${bill.billNo}`;
      const { tickets } = newTickets(bill.lines, order?.sent ?? {}, { label, time: bill.time, idPrefix: newMid() });
      data.kitchen.push(...ticketMessages(tickets));
      writeData(data);
    },

    recordCancel(billId) {
      const data = readData();
      let bill = data.bills.find((b) => b.id === billId);
      if (!bill) {
        // A bill made on another phone, known from the sheet.
        const sheet = read(KEYS.sheetToday, null);
        const fromSheet = sheet ? sheet.bills.find((b) => b.id === billId) : null;
        if (!fromSheet) throw new Error('not_found');
        bill = { ...fromSheet };
        data.bills.push(bill);
      }
      bill.status = 'Cancelled';
      data.queue.push({ action: 'cancelBill', billId });
      writeData(data);
    },

    // Keeps an order open. A new order gets the next number (1, 2, 3 ... restarting once
    // nothing is open); an order that is already open is updated in place.
    // With a table, a new order for a table that already has one is added to it.
    holdOrder({ id, lines, table = null }, time) {
      const data = readData();
      const existing = data.open.find((o) => o.id === id);
      if (existing) {
        existing.lines = lines;
        if (table) existing.table = table;
        data.kitchen.push(...sendToKitchens(existing, time));
        data.queue.push(tableMessage(existing));
        writeData(data);
        return existing.id;
      }
      const atTable = table ? data.open.find((o) => o.table === table) : null;
      if (atTable) {
        lines.forEach((line) => {
          const same = atTable.lines.find((l) => l.item === line.item && l.kitchen === line.kitchen);
          if (same) same.qty += line.qty;
          else atTable.lines.push({ ...line });
        });
        data.kitchen.push(...sendToKitchens(atTable, time));
        data.queue.push(tableMessage(atTable));
        writeData(data);
        return atTable.id;
      }
      const tag = Math.max(0, ...data.open.map((o) => o.tag)) + 1;
      const order = { id: `open-${Date.now()}-${tag}`, tag, time, lines, table };
      data.open.push(order);
      data.kitchen.push(...sendToKitchens(order, time));
      data.queue.push(tableMessage(order));
      writeData(data);
      return order.id;
    },

    getOpenOrders: () => readData().open,

    // On a kitchen screen: a ticket made is queued as ready for the sheet.
    markTicketReady(ticketId) {
      const data = readData();
      data.kitchen.push({ action: 'markReady', mid: newMid(), ticketId });
      writeData(data);
    },

    dropOrder(id) {
      const data = readData();
      data.open = data.open.filter((o) => o.id !== id);
      data.queue.push(closeMessage(id));
      writeData(data);
    },

    // Takes the sheet's list of open tables (shared by every phone). Tables changed or
    // closed on this phone but not yet uploaded keep this phone's version.
    mergeSheetOpen(sheetOrders) {
      const data = readData();
      const pending = new Set(data.queue.map(orderIdOf).filter(Boolean));
      const mine = data.open.filter((o) => pending.has(o.id));
      const fromSheet = sheetOrders.filter((o) => !pending.has(o.id));
      data.open = [...fromSheet, ...mine];
      writeData(data);
    },

    getBills(date) {
      const bills = readData().bills.reverse();
      return date === undefined ? bills : bills.filter((b) => b.date === date);
    },

    peekKitchen: () => readData().kitchen[0] ?? null,
    kitchenLength: () => readData().kitchen.length,
    dequeueKitchen(sent) {
      const data = readData();
      if (!sameMessage(data.kitchen[0], sent)) return;
      data.kitchen.shift();
      writeData(data);
    },

    peekQueue: () => readData().queue[0] ?? null,
    queueLength: () => readData().queue.length,
    rejectedCount: () => readData().rejected.length,

    // `sent` is the message that was just delivered. It is removed only if it is still
    // at the head: the app can be open twice on one phone (installed app plus a browser
    // tab), and the other copy may have removed it already. Removing "whatever is first"
    // would then throw away a bill that was never uploaded.
    dequeue(sent) {
      const data = readData();
      if (!sameMessage(data.queue[0], sent)) return;
      data.queue.shift();
      writeData(data);
    },

    rejectHead(sent, error) {
      const data = readData();
      if (!sameMessage(data.queue[0], sent)) return;
      data.rejected.push({ message: data.queue.shift(), error });
      writeData(data);
    },

    getSyncState: () => ({ ...DEFAULT_SYNC, ...read(KEYS.sync, {}) }),
    setSyncState: (partial) => write(KEYS.sync, { ...read(KEYS.sync, {}), ...partial }),

    prune(today) {
      const data = readData();
      const cutoff = daysBefore(today, KEEP_DAYS);
      const waiting = new Set(data.queue.map(billIdOf));
      const kept = data.bills.filter((b) => b.date >= cutoff || waiting.has(b.id));
      if (kept.length === data.bills.length) return;
      writeData({ ...data, bills: kept });
    },
  };
}
