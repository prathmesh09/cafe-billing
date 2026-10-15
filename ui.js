// Draws the screens and handles taps. All the rules live in bill.js, menu.js, store.js
// and sync.js; this file only shows what they say and passes taps on to them.

import { emptyDraft, lineKey, addItem, changeQty, draftTotal, localDate, randomSuffix,
         localTime, finalizeBill, summarize } from './bill.js';
import { kitchens, groupByCategory, searchItems } from './menu.js';
import { pushAvailable, alertsOn, startPush, askForAlerts } from './push.js';

const ERROR_TEXT = {
  bad_passcode: 'Passcode not accepted',
  not_configured: 'Sheet not connected yet',
  bad_response: 'Sheet did not answer correctly. Check the script address.',
  offline: 'No connection. Will retry.',
  unreachable: 'Could not reach the sheet. If the phone has internet, check the script address and that access is set to Anyone.',
  bad_address: 'The script address must start with https:// and end with /exec.',
  server_error: 'The sheet reported a problem. Check the Menu, Bills and Bill Items tabs are still there, then press Upload now.',
  empty_menu: 'The Menu tab has no readable items, so the saved menu was kept. Check its columns: Item, Kitchen, Category, Price, Available.',
};
const STORAGE_FAILED = 'Could not save. Phone storage is full or blocked.';
const BILL_NOT_SAVED = 'Bill NOT saved. Phone storage is full or blocked.';
const NO_MENU = 'No menu yet. Connect to the internet, open Settings and press Refresh menu.';

const NAV = [['billing', 'Billing'], ['today', 'Today'], ['settings', 'Settings']];

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

const errorText = (code) => ERROR_TEXT[code] ?? `Something went wrong (${code})`;

export const waitingText = (n) => (n === 1 ? '1 bill waiting to upload' : `${n} bills waiting to upload`);

const whenText = (iso) => new Date(iso).toLocaleString('en-IN',
  { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function startUi({ store, api, sync, root, arrival = 'none' }) {
  const state = {
    view: 'billing',    // 'billing' | 'done' | 'today' | 'settings' | 'connect'
    connect: 'none',    // connect screen: 'none' | 'bad-code' | 'connecting' | 'connected' | 'failed'
    installOffer: null, // the browser's "install this app" offer, when it makes one
    kitchen: null,      // which kitchen tab is open; null means the first one
    query: '',          // text in the search box
    draft: emptyDraft(),
    openId: null,       // the open (pay later) order now on screen, if any
    lastBill: null,     // the bill shown on the Done screen
    notice: null,       // red line at the top of Billing
    openBillId: null,
    showOrder: false,   // Billing shows the whole order instead of the menu
    picking: false,     // Billing shows the table picker
    tickets: [],        // kitchen screen: tickets still to make
    ticketsLoaded: false,
    kitchenStarted: false,
    kitchenError: null,
    todayError: null,   // why today's sales could not be read from the sheet   // the bill expanded on Today
    todayNotice: null,  // red line at the top of Today
    settingsNote: null, // a short line under the Settings buttons, e.g. "Saved"
    menuError: null,    // error code from the last menu refresh, if it failed
  };

  root.innerHTML = '<main id="view" class="view"></main><nav class="nav"></nav>';
  const viewEl = root.querySelector('#view');
  const navEl = root.querySelector('.nav');

  // ---------- Connect (first run, and after scanning the owner's setup code) ----------

  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches;

  function installHtml() {
    if (isInstalled()) return '';
    if (state.installOffer) {
      return '<button type="button" class="btn btn-dark" data-action="install">Put the app on this phone</button>';
    }
    return '<p class="hint">To put the app on this phone: tap the ⋮ menu, then <b>Add to Home screen</b>.</p>';
  }

  function connectView() {
    const how = `Ask the owner to open the <b>Phone setup</b> tab of the billing sheet, then scan the square with this phone's camera.`;
    const screens = {
      none: `
        <p class="connect-mark">📱</p>
        <h1>This phone is not connected yet</h1>
        <p>${how}</p>
        <button type="button" class="link" data-action="nav" data-view="settings">Enter the details by hand</button>`,
      'bad-code': `
        <p class="connect-mark">⚠️</p>
        <h1>That setup code did not work</h1>
        <p>${how}</p>`,
      connecting: `
        <p class="connect-mark">⏳</p>
        <h1>Connecting…</h1>`,
      connected: `
        <p class="connect-mark">✅</p>
        <h1>This phone is connected</h1>
        <p>${store.getMenu().items.length} items on the menu.</p>
        ${installHtml()}
        ${kitchenName()
    ? `<button type="button" class="btn btn-primary" data-action="nav" data-view="kitchen">Open the ${escapeHtml(kitchenName())} kitchen screen</button>`
    : '<button type="button" class="btn btn-primary" data-action="nav" data-view="billing">Start billing</button>'}`,
      failed: `
        <p class="connect-mark">⚠️</p>
        <h1>Could not connect</h1>
        <p>${escapeHtml(errorText(state.menuError ?? 'offline'))}</p>
        <button type="button" class="btn btn-primary" data-action="connect">Try again</button>`,
    };
    return `<div class="connect">${screens[state.connect]}</div>`;
  }

  async function connect() {
    state.view = 'connect';
    state.connect = 'connecting';
    render();
    await refreshMenu();
    state.connect = state.menuError ? 'failed' : 'connected';
    if (state.view === 'connect') render();
  }

  // ---------- Settings ----------

  function settingsView() {
    const s = store.getSettings();
    return `
      <div class="page">
        <h1>Settings</h1>
        <div class="row">
          <button type="button" class="btn" data-action="refresh-menu">Refresh menu</button>
          <button type="button" class="btn" data-action="upload-now">Upload now</button>
        </div>
        <div id="status" class="status" aria-live="polite">${statusHtml()}</div>
        ${state.installOffer && !isInstalled() ? '<button type="button" class="btn btn-dark wide" data-action="install">Put the app on this phone</button>' : ''}
        <details class="advanced">
          <summary>Advanced (owner only)</summary>
        <form id="settings-form" novalidate>
          <label class="field">Outlet name
            <input name="outlet" value="${escapeHtml(s.outlet)}" autocomplete="off">
          </label>
          <label class="field">Sheet script address
            <input name="scriptUrl" value="${escapeHtml(s.scriptUrl)}" inputmode="url"
              autocapitalize="off" autocomplete="off" spellcheck="false">
          </label>
          <label class="field">Passcode
            <input name="passcode" type="password" value="${escapeHtml(s.passcode)}" autocomplete="off">
          </label>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
        </details>
      </div>`;
  }

  function statusHtml() {
    const menu = store.getMenu();
    const refreshed = menu.fetchedAt
      ? `${whenText(menu.fetchedAt)} · ${menu.items.length} items`
      : 'never';
    const rejected = store.rejectedCount();
    const code = state.menuError ?? store.getSyncState().lastError;
    return [
      `<p>Menu last refreshed: ${escapeHtml(refreshed)}</p>`,
      `<p>${waitingText(store.queueLength())}</p>`,
      rejected > 0 ? `<p class="is-error">${rejected} bills could not be uploaded</p>` : '',
      code ? `<p class="is-error">${escapeHtml(errorText(code))}</p>` : '',
      state.settingsNote ? `<p class="is-note">${escapeHtml(state.settingsNote)}</p>` : '',
    ].join('');
  }

  // Saves what is typed in the form. Returns false if the phone refused to store it.
  function saveSettingsForm() {
    const form = viewEl.querySelector('#settings-form');
    if (!form) return true;
    const data = new FormData(form);
    try {
      store.saveSettings({
        outlet: String(data.get('outlet')).trim() || 'Bhukum',
        scriptUrl: String(data.get('scriptUrl')).trim(),
        passcode: String(data.get('passcode')),
      });
      return true;
    } catch {
      state.settingsNote = STORAGE_FAILED;
      refresh();
      return false;
    }
  }

  async function refreshMenu() {
    state.settingsNote = null;
    let items;
    try {
      items = await api.getMenu();
    } catch (e) {
      state.menuError = e.message; // the saved menu is left exactly as it was
      refresh();
      return;
    }
    state.menuError = null;
    try {
      store.saveMenu(items, new Date().toISOString());
    } catch {
      state.settingsNote = STORAGE_FAILED;
    }
    refresh();
  }

  async function uploadNow() {
    try {
      await sync.flush();
    } catch {
      // flush only throws if the phone's storage fails; the status line still shows the queue.
    }
    state.settingsNote = null;
    refresh();
  }

  // ---------- Billing ----------

  function itemButton(item, qtyByKey, showKitchen) {
    const key = lineKey(item);
    const qty = qtyByKey.get(key);
    return `
      <button type="button" class="item${qty ? ' is-in' : ''}" data-action="add" data-key="${escapeHtml(key)}">
        <span class="item-name">${escapeHtml(item.item)}</span>
        <span class="item-meta">${rupees(item.price)}${showKitchen ? ` · ${escapeHtml(item.kitchen)}` : ''}</span>
        ${qty ? `<span class="badge">${qty}</span>` : ''}
      </button>`;
  }

  function currentKitchen(items) {
    const names = kitchens(items);
    if (!names.includes(state.kitchen)) state.kitchen = names[0] ?? null;
    return state.kitchen;
  }

  function tabsHtml() {
    const items = store.getMenu().items;
    const open = currentKitchen(items);
    return kitchens(items).map((name) => `
      <button type="button" class="tab${name === open && !state.query.trim() ? ' is-active' : ''}"
        data-action="tab" data-kitchen="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('');
  }

  function itemsHtml() {
    const items = store.getMenu().items;
    if (items.length === 0) return `<p class="empty">${NO_MENU}</p>`;
    const qtyByKey = new Map(state.draft.lines.map((l) => [lineKey(l), l.qty]));

    if (state.query.trim()) {
      const found = searchItems(items, state.query);
      if (found.length === 0) return '<p class="empty">No items match.</p>';
      return `<div class="grid">${found.map((i) => itemButton(i, qtyByKey, true)).join('')}</div>`;
    }
    return groupByCategory(items, currentKitchen(items)).map((group) => `
      <h2>${escapeHtml(group.category)}</h2>
      <div class="grid">${group.items.map((i) => itemButton(i, qtyByKey, false)).join('')}</div>`).join('');
  }

  // Your tables: 9 on the ground floor (G1-G9) and 4 on the first floor (F1-F4).
  const FLOORS = [['Ground floor', 'G', 9], ['First floor', 'F', 4]];

  const openOrder = () => store.getOpenOrders().find((o) => o.id === state.openId) ?? null;
  const orderName = (o) => (o.table ? `Table ${o.table}` : `Order ${o.tag}`);

  // The bar under the menu. Tapping it shows the whole order and the pay buttons.
  function orderBarHtml() {
    const count = state.draft.lines.reduce((n, l) => n + l.qty, 0);
    const current = openOrder();
    const label = current ? `${orderName(current)} · ` : '';
    if (count === 0) return `<div class="orderbar is-empty">${label}Tap items to add them</div>`;
    return `
      <button type="button" class="orderbar" data-action="show-order">
        <span>${label}${count} item${count === 1 ? '' : 's'}</span>
        <strong>${rupees(draftTotal(state.draft))} · View order ›</strong>
      </button>`;
  }

  function orderView() {
    const current = openOrder();
    const lines = state.draft.lines.map((l) => {
      const key = escapeHtml(lineKey(l));
      return `
        <div class="line" data-key="${key}">
          <span class="line-name">${escapeHtml(l.item)}</span>
          <span class="stepper">
            <button type="button" class="step" data-action="qty" data-key="${key}" data-delta="-1" aria-label="One less ${escapeHtml(l.item)}">−</button>
            <span class="qty">${l.qty}</span>
            <button type="button" class="step" data-action="qty" data-key="${key}" data-delta="1" aria-label="One more ${escapeHtml(l.item)}">+</button>
          </span>
          <span class="line-amount">${rupees(l.qty * l.price)}</span>
        </div>`;
    }).join('');
    const empty = state.draft.lines.length === 0;
    return `
      <div class="billing">
        <div id="notice">${noticeHtml()}</div>
        <div class="order-head">
          <button type="button" class="btn" data-action="hide-order">‹ Add more items</button>
          <strong>${current ? orderName(current) : 'New order'}</strong>
        </div>
        <div class="page order-lines">${empty ? '<p class="empty">No items in this order.</p>' : lines}</div>
        <div class="billpanel">
          <div class="total"><span>Total</span> <strong>${rupees(draftTotal(state.draft))}</strong></div>
          <div class="row pay">
            <button type="button" class="btn btn-primary" data-action="pay" data-payment="Cash"${empty ? ' disabled' : ''}>Cash</button>
            <button type="button" class="btn btn-dark" data-action="pay" data-payment="Online"${empty ? ' disabled' : ''}>Online</button>
          </div>
          <div class="later">
            <button type="button" class="btn" data-action="hold"${empty ? ' disabled' : ''}>${current && current.table ? `Pay later (keep Table ${current.table} open)` : 'Pay later (choose table)'}</button>
          </div>
        </div>
      </div>`;
  }

  function tablePickerView() {
    const busy = new Map(store.getOpenOrders().filter((o) => o.table).map((o) => [o.table, o]));
    return `
      <div class="page picker">
        <h1>Which table?</h1>
        ${FLOORS.map(([name, letter, count]) => `
          <h2>${name}</h2>
          <div class="tables">
            ${Array.from({ length: count }, (_, i) => `${letter}${i + 1}`).map((t) => `
              <button type="button" class="table${busy.has(t) ? ' is-busy' : ''}" data-action="pick-table" data-table="${t}">
                <strong>${t}</strong><small>${busy.has(t) ? rupees(draftTotal(busy.get(t))) : 'free'}</small>
              </button>`).join('')}
          </div>`).join('')}
        <p class="hint">A table that already has an order gets these items added to it.</p>
        <button type="button" class="btn wide" data-action="cancel-pick">Back</button>
      </div>`;
  }

  const noticeHtml = () => (state.notice ? `<p class="notice" role="alert">${escapeHtml(state.notice)}</p>` : '');

  // Orders kept open for people who pay after eating, as a row of buttons.
  function openOrdersHtml() {
    return store.getOpenOrders().map((o) => `
      <button type="button" class="chip${o.id === state.openId ? ' is-active' : ''}" data-action="open-order" data-id="${escapeHtml(o.id)}">
        ${escapeHtml(orderName(o))} · ${rupees(draftTotal(o))}<small>${escapeHtml(o.time)}</small>
      </button>`).join('');
  }

  // Puts whatever is on screen into the open orders and sends it to the sheet straight
  // away, so other phones see the table and a reset cannot lose it. Returns false if the
  // phone refused to save it.
  function holdDraft(table) {
    if (state.draft.lines.length === 0) return true;
    try {
      store.holdOrder({ id: state.openId, lines: state.draft.lines, table }, localTime(new Date()));
    } catch {
      state.notice = STORAGE_FAILED;
      return false;
    }
    state.draft = emptyDraft();
    state.openId = null;
    sync.flush().catch(() => {}).then(refresh);
    return true;
  }

  function billingView() {
    if (state.picking) return tablePickerView();
    if (state.showOrder) return orderView();
    return `
      <div class="billing">
        <div id="notice">${noticeHtml()}</div>
        <div id="open" class="open-orders">${openOrdersHtml()}</div>
        <div id="tabs" class="tabs">${tabsHtml()}</div>
        <div class="search">
          <input id="search" type="search" placeholder="Search items" value="${escapeHtml(state.query)}"
            autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search items">
        </div>
        <div id="items" class="items">${itemsHtml()}</div>
        <div id="orderbar">${orderBarHtml()}</div>
      </div>`;
  }

  // On the menu, redraws everything except the search box, so typing is never
  // interrupted. The order and table screens are simply redrawn.
  function renderBilling() {
    if (state.view !== 'billing' || state.showOrder || state.picking || !viewEl.querySelector('#items')) {
      render();
      return;
    }
    viewEl.querySelector('#notice').innerHTML = noticeHtml();
    viewEl.querySelector('#open').innerHTML = openOrdersHtml();
    viewEl.querySelector('#tabs').innerHTML = tabsHtml();
    viewEl.querySelector('#items').innerHTML = itemsHtml();
    viewEl.querySelector('#orderbar').innerHTML = orderBarHtml();
  }

  // Finishing a bill. Nothing here waits: the draft is emptied and the screen changes
  // before the browser can deliver a second tap, so a double tap makes one bill.
  function checkout(payment) {
    const now = new Date();
    let bill;
    try {
      bill = finalizeBill(state.draft, {
        outlet: store.getSettings().outlet,
        payment,
        now,
        billNo: store.nextBillNo(localDate(now)),
        suffix: randomSuffix(),
      });
    } catch {
      return; // an empty bill: nothing to do
    }
    const current = openOrder();
    if (current && current.table) bill.table = current.table;
    try {
      store.recordBill(bill, state.openId);
    } catch {
      state.notice = BILL_NOT_SAVED;
      renderBilling();
      return;
    }
    state.draft = emptyDraft();
    state.openId = null;
    state.showOrder = false;
    state.lastBill = bill;
    state.notice = null;
    state.query = '';
    state.view = 'done';
    render();
    sync.flush().catch(() => {}).then(refresh);
  }

  function doneView() {
    const bill = state.lastBill;
    return `
      <div class="done">
        <p class="done-total">${rupees(bill.total)}</p>
        <p class="done-label">Bill #${bill.billNo} · ${bill.payment}${bill.table ? ` · Table ${escapeHtml(bill.table)}` : ''}</p>
        ${store.queueLength() > 0 ? '<p class="waiting">Waiting to upload</p>' : ''}
        <button type="button" class="btn btn-primary" data-action="new-bill">New bill</button>
      </div>`;
  }

  // ---------- Today ----------

  function billRow(bill) {
    const cancelled = bill.status === 'Cancelled';
    const open = bill.id === state.openBillId;
    const id = escapeHtml(bill.id);
    const head = `#${bill.billNo} · ${bill.time} · ${bill.payment} · ${rupees(bill.total)}${bill.table ? ` · ${bill.table}` : ''}`;
    const body = !open ? '' : `
      <div class="bill-body">
        ${bill.lines.map((l) => `
          <p class="bill-line"><span>${l.qty} × ${escapeHtml(l.item)}</span><span>${rupees(l.amount)}</span></p>`).join('')}
        ${cancelled ? '' : `<button type="button" class="btn btn-danger" data-action="cancel-bill" data-id="${id}">Cancel bill</button>`}
      </div>`;
    return `
      <div class="bill${cancelled ? ' is-cancelled' : ''}">
        <button type="button" class="bill-head" data-action="toggle-bill" data-id="${id}" aria-expanded="${open}">
          <span class="bill-text">${escapeHtml(head)}</span>${cancelled ? '<span class="tag">Cancelled</span>' : ''}
        </button>${body}
      </div>`;
  }

  // Fetches the open tables from the sheet, so every phone shows the same tables and a
  // wiped phone gets them back. Only the menu and table screens are redrawn: an order
  // someone is working on is never swapped out from under them.
  async function refreshOpen() {
    if (!store.getSettings().scriptUrl) return;
    try {
      store.mergeSheetOpen(await api.getOpen());
    } catch {
      return; // offline or not reachable: keep what this phone has
    }
    if (state.view === 'billing' && !state.showOrder) renderBilling();
  }

  // Fetches today's bills from the sheet, so every phone shows the same sales and a
  // wiped phone carries on with the right bill numbers.
  async function refreshToday() {
    if (!store.getSettings().scriptUrl) return;
    const date = localDate(new Date());
    try {
      const bills = await api.getToday(date, store.getSettings().outlet);
      store.saveSheetToday(date, bills, new Date().toISOString());
      state.todayError = null;
    } catch (e) {
      state.todayError = e.message;
    }
    if (state.view === 'today') render();
  }

  function todaySourceHtml(date) {
    const sheet = store.getSheetToday(date);
    if (state.todayError) {
      return `<p class="waiting">Showing this phone only. ${escapeHtml(errorText(state.todayError))}</p>`;
    }
    if (!sheet) return '<p class="hint">Loading sales from the sheet…</p>';
    return `<p class="hint">All phones · updated ${escapeHtml(whenText(sheet.fetchedAt))}</p>`;
  }

  function todayView() {
    const date = localDate(new Date());
    const bills = store.todayBills(date);
    const sum = summarize(bills);
    const waiting = store.queueLength();
    return `
      <div class="page">
        <h1>Today</h1>
        ${todaySourceHtml(date)}
        ${state.todayNotice ? `<p class="notice" role="alert">${escapeHtml(state.todayNotice)}</p>` : ''}
        ${waiting > 0 ? `<p class="waiting">${waitingText(waiting)}</p>` : ''}
        <div class="stats">
          <p class="stat stat-main"><span>Sales</span> <strong>${rupees(sum.total)}</strong></p>
          <p class="stat"><span>Cash</span> <strong>${rupees(sum.cash)}</strong></p>
          <p class="stat"><span>Online</span> <strong>${rupees(sum.online)}</strong></p>
          <p class="stat"><span>Bills</span> <strong>${sum.count}</strong></p>
        </div>
        <h2>Top items</h2>
        ${sum.topItems.length === 0 ? '<p class="empty">No bills yet today.</p>' : `
          <div class="top">${sum.topItems.map((t) => `
            <p class="bill-line"><span>${escapeHtml(t.item)}</span><strong>${t.qty}</strong></p>`).join('')}
          </div>`}
        ${bills.length === 0 ? '' : `<h2>Bills</h2><div class="bills">${bills.map(billRow).join('')}</div>`}
      </div>`;
  }

  function cancelBill(id) {
    const bill = store.todayBills(localDate(new Date())).find((b) => b.id === id);
    if (!bill || bill.status === 'Cancelled') return;
    if (!window.confirm(`Cancel bill #${bill.billNo} for ${rupees(bill.total)}?`)) return;
    try {
      store.recordCancel(id);
      state.todayNotice = null;
    } catch {
      state.todayNotice = STORAGE_FAILED;
    }
    render();
    sync.flush().catch(() => {}).then(refresh);
  }

  // ---------- Kitchen screen ----------
  //
  // A phone set up from a "Kitchen setup" code shows only that kitchen's tickets, oldest
  // first, and beeps when a new one arrives. Nothing to type, nothing to bill.

  const kitchenName = () => store.getSettings().kitchen || '';
  const doneTickets = new Set(); // marked Ready here, perhaps not yet in the sheet
  let audio = null;
  let wakeLock = null;

  function beep() {
    try {
      if (audio) {
        [0, 0.35].forEach((at) => {
          const tone = audio.createOscillator();
          const volume = audio.createGain();
          tone.frequency.value = 880;
          volume.gain.value = 0.4;
          tone.connect(volume).connect(audio.destination);
          tone.start(audio.currentTime + at);
          tone.stop(audio.currentTime + at + 0.22);
        });
      }
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    } catch {
      // a beep is a nice-to-have
    }
  }

  async function keepScreenOn() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch {
      // not every phone allows it; the screen may then turn off as usual
    }
  }

  async function refreshTickets() {
    if (!kitchenName() || !store.getSettings().scriptUrl) return;
    try {
      const tickets = (await api.getTickets(kitchenName())).filter((t) => !doneTickets.has(t.id));
      const known = new Set(state.tickets.map((t) => t.id));
      const fresh = tickets.some((t) => !known.has(t.id));
      state.tickets = tickets;
      state.kitchenError = null;
      if (fresh && state.ticketsLoaded) beep();
      state.ticketsLoaded = true;
    } catch (e) {
      state.kitchenError = e.message;
    }
    if (state.view === 'kitchen') render();
  }

  function kitchenView() {
    const name = escapeHtml(kitchenName());
    if (!state.kitchenStarted) {
      return `
        <div class="connect">
          <p class="connect-mark">👨‍🍳</p>
          <h1>${name} kitchen</h1>
          <p>Orders taken at the counter for ${name} appear here, with a beep.</p>
          <button type="button" class="btn btn-primary" data-action="start-kitchen">Start</button>
        </div>`;
    }
    const cards = state.tickets.map((t) => `
      <div class="ticket">
        <div class="ticket-head"><strong>${escapeHtml(t.label)}</strong><span>${escapeHtml(t.time)}</span></div>
        ${t.items.map((i) => `<p class="ticket-line"><b>${i.qty} ×</b> ${escapeHtml(i.item)}</p>`).join('')}
        <button type="button" class="btn btn-primary" data-action="ticket-ready" data-id="${escapeHtml(t.id)}">Ready ✓</button>
      </div>`).join('');
    let alerts = '';
    if (pushAvailable()) {
      alerts = alertsOn()
        ? '<p class="hint">🔔 Alerts on: this phone buzzes for new orders even in other apps.</p>'
        : '<button type="button" class="btn btn-dark wide" data-action="alerts">🔔 Turn on order alerts</button>';
    }
    return `
      <div class="page kitchen">
        <h1>${name} kitchen <small>${state.tickets.length} waiting</small></h1>
        ${alerts}
        ${state.kitchenError ? `<p class="waiting">Cannot reach the sheet right now. Trying again…</p>` : ''}
        ${cards || '<p class="empty">No orders right now.</p>'}
      </div>`;
  }

  // ---------- Drawing ----------

  const VIEWS = { kitchen: kitchenView, billing: billingView, done: doneView, today: todayView, settings: settingsView, connect: connectView };

  let drawnView = null;

  function render() {
    // A kitchen phone only ever shows its kitchen (or the connect and settings screens).
    if (kitchenName() && !['connect', 'settings'].includes(state.view)) state.view = 'kitchen';
    // Redrawing the same screen (a bill opened, an upload finished) keeps its scroll place.
    const page = viewEl.querySelector('.page');
    const scrollTop = drawnView === state.view && page ? page.scrollTop : 0;
    viewEl.className = `view view-${state.view}`;
    viewEl.innerHTML = VIEWS[state.view]();
    drawnView = state.view;
    const redrawn = viewEl.querySelector('.page');
    if (redrawn) redrawn.scrollTop = scrollTop;
    const active = state.view === 'done' ? 'billing' : state.view;
    navEl.hidden = state.view === 'kitchen';
    navEl.innerHTML = NAV.map(([view, label]) => `
      <button type="button" class="nav-btn${view === active ? ' is-active' : ''}"
        data-action="nav" data-view="${view}">${label}</button>`).join('');
  }

  // Called when something changed in the background (an upload finished, the menu
  // arrived). Never redraws a form the person may be typing in.
  function refresh() {
    if (state.view === 'settings') {
      const status = viewEl.querySelector('#status');
      if (status) status.innerHTML = statusHtml();
      return;
    }
    if (state.view === 'billing') {
      renderBilling();
      return;
    }
    if (state.view === 'connect' && state.connect === 'connecting') return; // connect() redraws when it finishes
    render();
  }

  // ---------- Taps ----------

  const actions = {
    nav(el) {
      state.view = el.dataset.view;
      state.picking = false;
      if (state.view === 'today') refreshToday();
      state.settingsNote = null;
      state.todayNotice = null;
      render();
    },
    tab(el) {
      state.kitchen = el.dataset.kitchen;
      state.query = '';
      viewEl.querySelector('#search').value = '';
      renderBilling();
    },
    add(el) {
      const item = store.getMenu().items.find((i) => lineKey(i) === el.dataset.key);
      if (!item) return;
      state.draft = addItem(state.draft, item);
      state.notice = null;
      renderBilling();
    },
    qty(el) {
      state.draft = changeQty(state.draft, el.dataset.key, Number(el.dataset.delta));
      if (state.draft.lines.length === 0 && state.openId) {
        try {
          store.dropOrder(state.openId);
          sync.flush().catch(() => {}).then(refresh);
        } catch {
          state.notice = STORAGE_FAILED;
        }
        state.openId = null;
      }
      renderBilling();
    },
    'show-order'() {
      state.showOrder = true;
      render();
    },
    'hide-order'() {
      state.showOrder = false;
      render();
    },
    hold() {
      const current = openOrder();
      if (current && current.table) {
        holdDraft(current.table);
        state.showOrder = false;
      } else {
        state.picking = true;
      }
      render();
    },
    'pick-table'(el) {
      if (holdDraft(el.dataset.table)) {
        state.picking = false;
        state.showOrder = false;
      }
      render();
    },
    'cancel-pick'() {
      state.picking = false;
      render();
    },
    'open-order'(el) {
      if (el.dataset.id === state.openId) return;
      if (!holdDraft()) {
        renderBilling();
        return;
      }
      const order = store.getOpenOrders().find((o) => o.id === el.dataset.id);
      if (order) {
        state.draft = { lines: order.lines };
        state.openId = order.id;
        state.showOrder = true;
      }
      state.notice = null;
      render();
    },
    pay(el) {
      checkout(el.dataset.payment);
    },
    'toggle-bill'(el) {
      state.openBillId = state.openBillId === el.dataset.id ? null : el.dataset.id;
      render();
    },
    'cancel-bill'(el) {
      cancelBill(el.dataset.id);
    },
    'new-bill'() {
      state.view = 'billing';
      state.showOrder = false;
      render();
    },
    connect() {
      connect();
    },
    'start-kitchen'() {
      try {
        audio = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        audio = null;
      }
      state.kitchenStarted = true;
      keepScreenOn();
      render();
      refreshTickets();
      startPush(kitchenName()).then((ready) => (ready ? askForAlerts() : false)).then(render);
    },
    alerts() {
      startPush(kitchenName()).then((ready) => (ready ? askForAlerts() : false)).then(render);
    },
    'ticket-ready'(el) {
      doneTickets.add(el.dataset.id);
      state.tickets = state.tickets.filter((t) => t.id !== el.dataset.id);
      try {
        store.markTicketReady(el.dataset.id);
      } catch {
        // the ticket is hidden here anyway; the sheet catches up next time
      }
      render();
      sync.flush().catch(() => {});
    },
    async install() {
      const offer = state.installOffer;
      if (!offer) return;
      state.installOffer = null;
      offer.prompt();
      await offer.userChoice.catch(() => {});
      render();
    },
    'refresh-menu'() {
      if (!saveSettingsForm()) return;
      state.settingsNote = 'Refreshing menu…';
      refresh();
      refreshMenu();
    },
    'upload-now'() {
      if (!saveSettingsForm()) return;
      state.settingsNote = 'Uploading…';
      refresh();
      uploadNow();
    },
  };

  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
  });

  root.addEventListener('input', (event) => {
    if (event.target.id !== 'search') return;
    state.query = event.target.value;
    renderBilling();
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.id !== 'settings-form') return;
    if (!saveSettingsForm()) return;
    state.settingsNote = 'Saved';
    refresh();
  });

  if (arrival === 'connected') {
    connect();
  } else if (arrival === 'bad-code' || !store.getSettings().scriptUrl) {
    state.view = 'connect';
    state.connect = arrival === 'bad-code' ? 'bad-code' : 'none';
    render();
  } else {
    render();
  }

  return {
    refresh,
    refreshMenu,
    refreshToday,
    refreshOpen,
    refreshTickets,
    isKitchen: () => Boolean(kitchenName()),
    keepScreenOn,
    offerInstall(offer) {
      state.installOffer = offer;
      if (state.view === 'connect' || state.view === 'settings') render();
    },
  };
}
