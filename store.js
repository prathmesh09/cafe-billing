// Everything the phone remembers. `storage` is localStorage or anything shaped like it.
//
// Bills, the upload queue and set-aside messages live under ONE key, so a bill and its
// queue entry are written together or not at all. Nothing is cached in memory: every
// call reads storage, so a failed write leaves the store's answers unchanged.

const KEYS = { settings: 'cb.settings', menu: 'cb.menu', sync: 'cb.sync', data: 'cb.data' };
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
const sameMessage = (a, b) => Boolean(a && b) && a.action === b.action && billIdOf(a) === billIdOf(b);

export function createStore(storage) {
  const read = (key, fallback) => {
    const raw = storage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  };
  const write = (key, value) => storage.setItem(key, JSON.stringify(value));

  // `open` holds orders kept for people who pay after eating. They are not bills yet.
  const readData = () => ({ bills: [], queue: [], rejected: [], open: [], ...read(KEYS.data, {}) });
  const writeData = (data) => write(KEYS.data, data);

  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }),
    saveSettings: (partial) => write(KEYS.settings, { ...read(KEYS.settings, {}), ...partial }),

    getMenu() {
      const menu = read(KEYS.menu, null);
      return menu && Array.isArray(menu.items) ? menu : { items: [], fetchedAt: null };
    },
    saveMenu: (items, fetchedAt) => write(KEYS.menu, { items, fetchedAt }),

    nextBillNo(date) {
      const numbers = readData().bills.filter((b) => b.date === date).map((b) => b.billNo);
      return Math.max(0, ...numbers) + 1;
    },

    // Pass openId when the bill settles an open order: the order is closed in the same
    // write, so it can never be left open after it has been paid.
    recordBill(bill, openId) {
      const data = readData();
      if (openId) data.open = data.open.filter((o) => o.id !== openId);
      data.bills.push(bill);
      data.queue.push({ action: 'addBill', bill });
      writeData(data);
    },

    recordCancel(billId) {
      const data = readData();
      const bill = data.bills.find((b) => b.id === billId);
      if (!bill) throw new Error('not_found');
      bill.status = 'Cancelled';
      data.queue.push({ action: 'cancelBill', billId });
      writeData(data);
    },

    // Keeps an order open. A new order gets the next number (1, 2, 3 ... restarting once
    // nothing is open); an order that is already open is updated in place.
    holdOrder({ id, lines }, time) {
      const data = readData();
      const existing = data.open.find((o) => o.id === id);
      if (existing) {
        existing.lines = lines;
        writeData(data);
        return existing.id;
      }
      const tag = Math.max(0, ...data.open.map((o) => o.tag)) + 1;
      const order = { id: `open-${Date.now()}-${tag}`, tag, time, lines };
      data.open.push(order);
      writeData(data);
      return order.id;
    },

    getOpenOrders: () => readData().open,

    dropOrder(id) {
      const data = readData();
      data.open = data.open.filter((o) => o.id !== id);
      writeData(data);
    },

    getBills(date) {
      const bills = readData().bills.reverse();
      return date === undefined ? bills : bills.filter((b) => b.date === date);
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
