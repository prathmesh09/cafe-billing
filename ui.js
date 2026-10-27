// Draws the screens and handles taps. All the rules live in bill.js, menu.js, store.js
// and sync.js; this file only shows what they say and passes taps on to them.

import { emptyDraft, lineKey, addItem, changeQty, draftTotal, localDate, randomSuffix,
         localTime, finalizeBill, summarize } from './bill.js';
import { kitchens, groupByCategory, searchItems } from './menu.js';
import { pushAvailable, alertsOn, startPush, askForAlerts, onAlert } from './push.js';
import { ringTones, ringVibration } from './ring.js';
import { stockEntry, loadStockDraft, saveStockDraft, parseQty, closeMatch } from './stock.js';

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

// Settings is not in the bar: staff rarely need it. It sits behind the gear on the Running and Today screens.
const NAV = [['billing', 'Billing'], ['running', 'Running'], ['today', 'Today'], ['stock', 'Stock']];

const GEAR = '<button type="button" class="gear" data-action="nav" data-view="settings" aria-label="Settings">⚙</button>';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

const errorText = (code) => ERROR_TEXT[code] ?? `Something went wrong (${code})`;

export const waitingText = (n) => (n === 1 ? '1 bill waiting to upload' : `${n} bills waiting to upload`);

const whenText = (iso) => new Date(iso).toLocaleString('en-IN',
  { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function startUi({ store, api, sync, root, arrival = 'none', fb = null }) {
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
    moving: null,       // id of the open order being moved to another table, if any
    tickets: [],        // kitchen screen: tickets still to make
    ticketsLoaded: false,
    kitchenStarted: false,
    kitchenError: null,
    todayError: null,   // why today's sales could not be read from the sheet   // the bill expanded on Today
    todayNotice: null,  // red line at the top of Today
    settingsNote: null, // a short line under the Settings buttons, e.g. "Saved"
    menuError: null,    // error code from the last menu refresh, if it failed
    stockItems: null,   // stock screen: this kitchen's list from the sheet, once loaded
    stockShowAll: false, // count tab: every item, not only those due today
    orders: null,       // open orders (proposed, approved, ordered) this phone deals with
    ordersError: null,
    orderEdits: {},     // order id → item → quantity typed
    stockError: null,   // why the list could not be read or the count not saved
    stockNote: null,    // "Saved" line on the stock screen
    stockSaving: false,
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
    ? `<button type="button" class="btn btn-primary" data-action="nav" data-view="kitchen">${recipeMode() ? 'Start the recipe cards' : `Open the ${escapeHtml(kitchenName())} kitchen screen`}</button>`
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

  // The table grid. For a new order it asks "Which table?"; when moving an order it asks
  // where to, and a table that is busy says it will be joined.
  function tablePickerView() {
    const moving = state.moving ? store.getOpenOrders().find((o) => o.id === state.moving) : null;
    const busy = new Map(store.getOpenOrders().filter((o) => o.table).map((o) => [o.table, o]));
    const action = moving ? 'move-to' : 'pick-table';
    const small = (t) => {
      if (moving && t === moving.table) return 'here now';
      return busy.has(t) ? `${rupees(draftTotal(busy.get(t)))}${moving ? ' · join' : ''}` : 'free';
    };
    return `
      <div class="page picker">
        <h1>${moving ? `Move ${escapeHtml(orderName(moving))} to…` : 'Which table?'}</h1>
        ${FLOORS.map(([name, letter, count]) => `
          <h2>${name}</h2>
          <div class="tables">
            ${Array.from({ length: count }, (_, i) => `${letter}${i + 1}`).map((t) => `
              <button type="button" class="table${busy.has(t) ? ' is-busy' : ''}" data-action="${action}" data-table="${t}"${moving && t === moving.table ? ' disabled' : ''}>
                <strong>${t}</strong><small>${small(t)}</small>
              </button>`).join('')}
          </div>`).join('')}
        <p class="hint">${moving ? 'Moving onto a busy table joins the two orders into one.' : 'A table that already has an order gets these items added to it.'}</p>
        <button type="button" class="btn wide" data-action="${moving ? 'cancel-move' : 'cancel-pick'}">Back</button>
      </div>`;
  }

  // ---------- Running tables ----------

  // Minutes since an order's start time ("20:05"), or null when the time cannot be read.
  function minutesSince(time) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
    if (!m) return null;
    const now = new Date();
    return (now.getHours() * 60 + now.getMinutes() - (Number(m[1]) * 60 + Number(m[2])) + 1440) % 1440;
  }

  const sinceText = (mins) => (mins === null ? '' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`);

  function runningCard(o) {
    const mins = minutesSince(o.time);
    const sent = o.sent ?? {};
    const lines = o.lines.map((l) => {
      const toKitchen = l.kitchen && l.kitchen !== 'Counter';
      const flag = toKitchen ? ((sent[lineKey(l)] ?? 0) >= l.qty ? '<small class="ok">sent</small>' : '<small class="late">not sent</small>') : '';
      return `<p class="bill-line"><span>${l.qty} × ${escapeHtml(l.item)} ${flag}</span><span>${rupees(l.qty * l.price)}</span></p>`;
    }).join('');
    const id = escapeHtml(o.id);
    return `
      <div class="run${mins !== null && mins >= 45 ? ' is-long' : ''}">
        <div class="run-head"><strong>${escapeHtml(orderName(o))}</strong><span>${escapeHtml(o.time || '')}${mins === null ? '' : ` · ${sinceText(mins)}`}</span></div>
        <div class="run-lines">${lines}</div>
        <p class="run-total"><span>Total</span> <strong>${rupees(draftTotal(o))}</strong></p>
        <div class="row">
          <button type="button" class="btn btn-primary" data-action="run-open" data-id="${id}">Open / pay</button>
          <button type="button" class="btn" data-action="run-move" data-id="${id}">Move table</button>
        </div>
      </div>`;
  }

  function runningView() {
    if (state.moving) return tablePickerView();
    const orders = [...store.getOpenOrders()].sort((a, b) => (minutesSince(b.time) ?? 0) - (minutesSince(a.time) ?? 0));
    return `
      <div class="page running">
        <div class="page-head"><h1>Running tables <small>${orders.length}</small></h1>${GEAR}</div>
        ${state.notice ? `<p class="notice" role="alert">${escapeHtml(state.notice)}</p>` : ''}
        ${orders.length === 0 ? '<p class="empty">No table is running right now.</p>' : orders.map(runningCard).join('')}
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
    let orderId;
    try {
      orderId = store.holdOrder({ id: state.openId, lines: state.draft.lines, table }, localTime(new Date()));
    } catch {
      state.notice = STORAGE_FAILED;
      return false;
    }
    if (fb && orderId) {
      const order = store.getOpenOrders().find((o) => o.id === orderId);
      if (order) fb.saveOpenOrder(order).catch(() => {});
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
    const closedId = state.openId;
    if (current && current.table) bill.table = current.table;
    try {
      store.recordBill(bill, state.openId);
    } catch {
      state.notice = BILL_NOT_SAVED;
      renderBilling();
      return;
    }
    if (fb && closedId) {
      fb.closeOpenOrder(closedId).catch(() => {});
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
    else if (state.view === 'running' && !state.moving) render();
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
        <div class="page-head"><h1>Today</h1>${GEAR}</div>
        ${todaySourceHtml(date)}
        ${state.todayNotice ? `<p class="notice" role="alert">${escapeHtml(state.todayNotice)}</p>` : ''}
        ${waiting > 0 ? `<p class="waiting">${waitingText(waiting)}</p>` : ''}
        <div class="stats">
          <p class="stat stat-main"><span>Sales</span> <strong>${rupees(sum.total)}</strong></p>
          <p class="stat"><span>Cash</span> <strong>${rupees(sum.cash)}</strong></p>
          <p class="stat"><span>Online</span> <strong>${rupees(sum.online)}</strong></p>
          <p class="stat"><span>Bills</span> <strong>${sum.count}</strong></p>
        </div>
        <h2>Top earners</h2>
        ${sum.topItems.length === 0 ? '<p class="empty">No bills yet today.</p>' : `
          <div class="top">${sum.topItems.map((t) => `
            <p class="bill-line"><span>${escapeHtml(t.item)} <small>× ${t.qty}</small></span><strong>${rupees(t.amount)}</strong></p>`).join('')}
          </div>
          <p class="hint">Tea, cigarettes and other counter items: ${rupees(sum.counterTotal)}${sum.total > 0 ? ` (${Math.round((sum.counterTotal / sum.total) * 100)}% of sales)` : ''}</p>`}
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
  // first, and rings for five seconds when a new one arrives. Nothing to type, nothing to bill.

  const kitchenName = () => store.getSettings().kitchen || '';
  const doneTickets = new Set(); // marked Ready here, perhaps not yet in the sheet
  let audio = null;
  let wakeLock = null;

  let ringing = [];

  // About five seconds of ringing and buzzing, like a delivery partner app. Any tap on the
  // kitchen screen stops it early.
  function ring() {
    stopRing();
    try {
      if (audio) {
        if (audio.state === 'suspended') audio.resume();
        const start = audio.currentTime + 0.05;
        ringing = ringTones().map(({ at, freq, length }) => {
          const tone = audio.createOscillator();
          const volume = audio.createGain();
          tone.type = 'square';
          tone.frequency.value = freq;
          volume.gain.value = 0.35;
          tone.connect(volume).connect(audio.destination);
          tone.start(start + at);
          tone.stop(start + at + length);
          return tone;
        });
      }
      if (navigator.vibrate) navigator.vibrate(ringVibration());
    } catch {
      // the ring is a nice-to-have; the ticket is on screen either way
    }
  }

  function stopRing() {
    ringing.forEach((tone) => {
      try { tone.stop(); } catch { /* already finished */ }
    });
    ringing = [];
    try {
      if (navigator.vibrate) navigator.vibrate(0);
    } catch {
      // nothing to stop
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

  // Tickets arrive two ways: from the sheet every 8 seconds, and from the live-orders
  // database the moment they are made. The screen shows both lists together, oldest first,
  // so a ticket only one of them has never flickers or rings twice.
  const ticketLists = { sheet: [], live: [] };
  const madeAt = (t) => Number((/^m-(\d+)-/.exec(t.id) || [])[1] || 0);

  function showTickets(source, tickets) {
    ticketLists[source] = tickets;
    const byId = new Map();
    [...ticketLists.sheet, ...ticketLists.live].forEach((t) => {
      if (!doneTickets.has(t.id) && !byId.has(t.id)) byId.set(t.id, t);
    });
    const merged = [...byId.values()].sort((a, b) => madeAt(a) - madeAt(b));
    const known = new Set(state.tickets.map((t) => t.id));
    const fresh = merged.some((t) => !known.has(t.id));
    state.tickets = merged;
    state.kitchenError = null;
    if (fresh && state.ticketsLoaded) ring();
    state.ticketsLoaded = true;
    // On the stock screen a new order shows a banner too: the ring alone is easy to miss.
    if (state.view === 'kitchen' || (state.view === 'stock' && fresh)) render();
  }

  let unsubscribeTickets = null;
  let listening = false;
  async function startRealtimeTickets() {
    if (!fb || !kitchenName() || unsubscribeTickets || listening) return;
    listening = true;
    try {
      unsubscribeTickets = await fb.listenTickets(kitchenName(), (tickets) => showTickets('live', tickets), () => {
        // The listener has stopped (signed out, offline for long). The 8-second check
        // keeps the screen working, and starts listening again.
        unsubscribeTickets = null;
      });
    } catch {
      // not signed in yet: the 8-second check keeps the screen working and tries again
      unsubscribeTickets = null;
    } finally {
      listening = false;
    }
  }

  async function refreshTickets() {
    if (!kitchenName() || recipeMode() || !store.getSettings().scriptUrl) return;
    if (state.kitchenStarted) startRealtimeTickets();
    try {
      showTickets('sheet', await api.getTickets(kitchenName()));
    } catch (e) {
      state.kitchenError = e.message;
      if (state.view === 'kitchen') render();
    }
  }

  function kitchenView() {
    const name = escapeHtml(kitchenName());
    if (!state.kitchenStarted) {
      return `
        <div class="connect">
          <p class="connect-mark">👨‍🍳</p>
          <h1>${name} kitchen</h1>
          <p>Orders taken at the counter for ${name} appear here, with a ring.</p>
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
        ? '<p class="hint">🔔 Alerts on: this phone rings for new orders even in other apps.</p>'
        : '<button type="button" class="btn btn-dark wide" data-action="alerts">🔔 Turn on order alerts</button>';
    }
    return `
      <div class="page kitchen">
        <h1>${name} kitchen <small>${state.tickets.length} waiting</small></h1>
        ${alerts}
        <button type="button" class="btn btn-dark wide" data-action="open-stock">📦 Stock count / delivery</button>
        ${state.kitchenError ? `<p class="waiting">Cannot reach the sheet right now. Trying again…</p>` : ''}
        ${cards || '<p class="empty">No orders right now.</p>'}
      </div>`;
  }

  // ---------- Stock (kitchen phones) ----------
  //
  // Count: what is on the shelf now. Delivery: what just came in. Only items with a
  // number are sent, so a partial count is fine. The typed numbers stay on the phone
  // until the sheet has them; the entry id stays the same, so a retry is never doubled.

  const phoneStorage = () => window.localStorage;
  const newStockDraft = () => ({ id: `STK-${Date.now()}-${randomSuffix()}`, values: {} });
  // One draft per kind, so tapping the other tab never wipes a half-typed count.
  const stock = (() => {
    try {
      return loadStockDraft(phoneStorage()) || { kind: 'Count', drafts: {} };
    } catch {
      return { kind: 'Count', drafts: {} };
    }
  })();
  const stockDraft = () => {
    if (!stock.drafts[stock.kind]) stock.drafts[stock.kind] = newStockDraft();
    return stock.drafts[stock.kind];
  };
  const keepStockDraft = () => {
    try {
      saveStockDraft(phoneStorage(), stock);
    } catch {
      // the numbers are still on screen
    }
  };

  // A kitchen phone counts its kitchen's stock; the counter phone counts the counter's
  // (cigarettes in sticks, cold drinks, water).
  const stockPlace = () => kitchenName() || 'Counter';

  async function loadStockItems() {
    try {
      const reply = await api.send({ action: 'getStockItems', kitchen: stockPlace() });
      if (!reply.ok || !Array.isArray(reply.items)) throw new Error(reply.error || 'bad_response');
      state.stockItems = reply.items;
      state.stockError = null;
    } catch (e) {
      state.stockError = e.message;
    }
    if (state.view === 'stock') render();
    loadOrders();
  }

  // A kitchen sees its own orders; the counter (the manager) sees every kitchen's.
  async function loadOrders() {
    try {
      const reply = await api.send({ action: 'getOrders', kitchen: kitchenName() || undefined });
      if (!reply.ok || !Array.isArray(reply.orders)) throw new Error(reply.error || 'bad_response');
      state.orders = reply.orders;
      state.ordersError = null;
    } catch (e) {
      state.ordersError = e.message;
    }
    if (state.view === 'stock' || state.view === 'orders') render();
  }

  // What this phone has to act on: a kitchen approves its proposals; the manager places
  // approved orders and receives ordered ones (and approves the counter's own).
  const myTurn = (o) => o.status === 'Draft' || (kitchenName()
    ? o.status === 'Proposed'
    : o.status === 'Approved' || o.status === 'Ordered' || (o.status === 'Proposed' && o.kitchen === 'Counter'));

  function ordersView() {
    const list = state.orders || [];
    const step = { Draft: ['Approved', 'Approve order'], Proposed: ['Approved', 'Approve order'], Approved: ['Ordered', 'Mark as ordered'], Ordered: ['Received', 'Received ✓'] };
    const cards = list.map((o) => {
      const editable = myTurn(o) && o.status !== 'Approved';
      const edits = state.orderEdits[o.id] || {};
      const lines = o.lines.map((l) => `
        <div class="order-line">
          <span class="stock-name">${escapeHtml(l.item)}${l.have !== undefined ? `<small> · have ${l.have}</small>` : ''}</span>
          ${editable
    ? `<input type="text" inputmode="decimal" autocomplete="off" data-order-id="${escapeHtml(o.id)}" data-order-item="${escapeHtml(l.item)}"
              value="${escapeHtml(edits[l.item] ?? String(l.qty))}">`
    : `<b>${l.qty}</b>`}
          <span class="stock-unit">${escapeHtml(l.unit || '')}</span>
        </div>`).join('');
      const label = o.status === 'Ordered' && myTurn(o) ? 'Type what actually came, then:' : '';
      // Staff can add anything the count did not catch, from the list or typed in.
      const canAdd = myTurn(o) && (o.status === 'Draft' || o.status === 'Proposed');
      const addRow = canAdd ? `
          <div class="order-add">
            <input type="text" list="order-items" autocomplete="off" placeholder="Add item" id="add-item-${escapeHtml(o.id)}">
            <input type="text" inputmode="decimal" autocomplete="off" placeholder="Qty" id="add-qty-${escapeHtml(o.id)}">
            <button type="button" class="chip" data-action="order-add-line" data-id="${escapeHtml(o.id)}">+ Add</button>
          </div>` : '';
      return `
        <div class="ticket">
          <div class="ticket-head"><strong>${escapeHtml(o.kitchen)}</strong><span>${escapeHtml(o.status)}</span></div>
          ${label ? `<p class="hint">${label}</p>` : ''}
          ${lines || '<p class="hint">Add the items to order below.</p>'}
          ${addRow}
          ${myTurn(o)
    ? `<button type="button" class="btn btn-primary wide" data-action="order-step" data-id="${escapeHtml(o.id)}"
              data-status="${step[o.status][0]}">${step[o.status][1]}</button>`
    : `<p class="hint">${o.status === 'Proposed' ? `Waiting for ${escapeHtml(o.kitchen)} to approve` : `With the manager: ${escapeHtml(o.status.toLowerCase())}`}</p>`}
        </div>`;
    }).join('');
    return `
      <div class="page orders">
        <h1>Orders</h1>
        ${state.ordersError ? `<p class="waiting">${escapeHtml(errorText(state.ordersError))}</p>` : ''}
        ${state.stockNote ? `<p class="hint">${escapeHtml(state.stockNote)}</p>` : ''}
        ${cards || '<p class="empty">No open orders.</p>'}
        <datalist id="order-items">${(state.stockItems || []).map((i) => `<option value="${escapeHtml(i.item)}">`).join('')}</datalist>
        ${list.some((o) => (o.status === 'Draft' || o.status === 'Proposed') && o.kitchen === stockPlace()) ? ''
    : '<button type="button" class="btn btn-dark wide" data-action="order-new">＋ Start an order</button>'}
        <button type="button" class="btn wide" data-action="orders-back">Back to stock</button>
      </div>`;
  }

  // Cigarettes are counted by brand but billed by price. Until a brand's price is set,
  // its row shows one button per cigarette price on the menu; the manager taps once.
  function soldAsPicker(i) {
    if (i.unit !== 'sticks' || i.soldAs) return '';
    const prices = store.getMenu().items.filter((m) => m.category === 'Cigarettes');
    if (prices.length === 0) return '';
    return `<span class="sold-as">Sold at: ${prices.map((m) => `
      <button type="button" class="chip" data-action="stock-sold-as" data-item="${escapeHtml(i.item)}"
        data-sold-as="${escapeHtml(m.item)}">${rupees(m.price)}</button>`).join('')}</span>`;
  }

  function stockView() {
    const counting = stock.kind === 'Count';
    const values = stockDraft().values;
    const kindButton = (kind, label) => `
      <button type="button" class="tab${stock.kind === kind ? ' is-active' : ''}"
        data-action="stock-kind" data-kind="${kind}">${label}</button>`;
    let body;
    if (!state.stockItems) {
      body = state.stockError
        ? `<p class="waiting">${escapeHtml(errorText(state.stockError))}</p>
           <button type="button" class="btn btn-dark wide" data-action="open-stock">Try again</button>`
        : '<p class="empty">Loading the stock list…</p>';
    } else if (state.stockItems.length === 0) {
      body = '<p class="empty">No stock items for this kitchen yet. The owner adds them on the "Stock items" tab.</p>';
    } else {
      // Counting shows only what is due today (daily items, and the rest on their days).
      const due = state.stockItems.filter((i) => i.due !== false);
      const shown = counting && !state.stockShowAll ? due : state.stockItems;
      const more = state.stockItems.length - due.length;
      body = `
        ${counting ? `<p class="hint">${state.stockShowAll ? `All ${state.stockItems.length} items`
    : `Due today: ${due.length} item${due.length === 1 ? '' : 's'}`}
          ${more > 0 ? `<button type="button" class="chip" data-action="stock-show-all">${state.stockShowAll ? 'Only due today' : `Show all (${more} more)`}</button>` : ''}</p>` : ''}
        ${shown.length === 0 ? '<p class="empty">Nothing to count today ✓</p>' : ''}
        <div class="stock-list">
          ${shown.map((i) => `
            <label class="stock-row">
              <span class="stock-name">${escapeHtml(i.item)}${soldAsPicker(i)}</span>
              <input type="text" inputmode="decimal" autocomplete="off" data-stock-item="${escapeHtml(i.item)}"
                value="${escapeHtml(values[i.item] ?? '')}" placeholder="–">
              <span class="stock-unit">${escapeHtml(i.unit || '')}</span>
            </label>`).join('')}
        </div>
        ${state.stockError ? `<p class="waiting">Not saved: ${escapeHtml(errorText(state.stockError))} The numbers are kept; press Save again.</p>` : ''}
        ${state.stockNote ? `<p class="hint">${escapeHtml(state.stockNote)}</p>` : ''}
        <button type="button" class="btn btn-primary wide" data-action="stock-save" ${state.stockSaving ? 'disabled' : ''}>
          ${state.stockSaving ? 'Saving…' : counting ? 'Save count' : 'Save delivery'}</button>`;
    }
    return `
      <div class="page stock">
        <h1>${escapeHtml(stockPlace())} stock</h1>
        <button type="button" class="btn btn-dark wide" data-action="open-orders">${(state.orders || []).some(myTurn)
    ? `📋 Orders to check: ${(state.orders || []).filter(myTurn).length}` : '📋 Orders · ＋ start one'}</button>
        ${kitchenName() && state.tickets.length ? `<button type="button" class="btn btn-primary wide stock-orders" data-action="stock-back">
          🔔 ${state.tickets.length} order${state.tickets.length === 1 ? '' : 's'} waiting: back to orders</button>` : ''}
        <div class="tabs stock-kinds">${kindButton('Count', 'Count what is left')}${kindButton('Received', 'Delivery came in')}</div>
        <p class="hint">${counting
    ? 'Type what is on the shelf now. Leave an item blank if you did not count it.'
    : 'Type only what just arrived.'}</p>
        ${body}
        ${kitchenName() ? '<button type="button" class="btn wide" data-action="stock-back">Back to orders</button>' : ''}
      </div>`;
  }

  // ---------- Recipe cards (a phone set up with the "Recipes" link) ----------
  //
  // One dish per card, best sellers first: tap the stock items one plate uses, tap an
  // amount, Save & next. Each dish is saved to the sheet the moment it is saved here.

  const RECIPES = 'Recipes';
  const recipeMode = () => store.getSettings().kitchen === RECIPES;
  const recipe = { data: null, index: 0, rows: [], error: null, note: null, saving: false, kept: new Set() };
  const RECIPE_UNITS = ['g', 'kg', 'ml', 'litre', 'nos', 'pcs', 'slices', 'packets', 'tbsp', 'tsp', 'scoops'];
  const emptyRow = () => ({ ingredient: '', qty: '', unit: '' });

  const recipeDone = (d) => d.lines.length > 0 || d.saved;
  function recipeCovered() {
    const all = recipe.data.dishes.reduce((n, d) => n + d.sold, 0);
    const done = recipe.data.dishes.filter(recipeDone).reduce((n, d) => n + d.sold, 0);
    return all ? Math.round((done / all) * 100) : 0;
  }
  function openDish(i) {
    recipe.index = i;
    const dish = recipe.data.dishes[i];
    recipe.rows = dish.lines.length
      ? dish.lines.map((l) => ({ ingredient: l.ingredient, qty: String(l.qty), unit: l.unit || '' }))
      : [emptyRow(), emptyRow(), emptyRow()];
  }
  function nextOpenDish(from) {
    const list = recipe.data.dishes;
    for (let k = 1; k <= list.length; k++) {
      const i = (from + k) % list.length;
      if (!recipeDone(list[i])) return i;
    }
    return (from + 1) % list.length;
  }

  async function loadRecipes() {
    try {
      const reply = await api.send({ action: 'getRecipeSetup' });
      if (!reply.ok || !Array.isArray(reply.dishes)) throw new Error(reply.error || 'bad_response');
      recipe.data = reply;
      recipe.error = null;
      const first = reply.dishes.findIndex((d) => !recipeDone(d));
      openDish(first < 0 ? 0 : first);
    } catch (e) {
      recipe.error = e.message;
    }
    if (state.view === 'recipes') render();
  }

  // One row per ingredient: name, quantity, unit. Name and unit are dropdowns that
  // also take anything typed, for items not on the list.
  function recipesView() {
    if (!recipe.data) {
      return `<div class="page recipes"><h1>Recipe cards</h1>${recipe.error
        ? `<p class="waiting">${escapeHtml(errorText(recipe.error))}</p>
           <button type="button" class="btn btn-dark wide" data-action="recipe-load">Try again</button>`
        : '<p class="empty">Loading dishes…</p>'}</div>`;
    }
    const list = recipe.data.dishes;
    const dish = list[recipe.index];
    const doneCount = list.filter(recipeDone).length;
    const covered = recipeCovered();
    const own = recipe.data.stock.filter((x) => x.kitchen === dish.kitchen).map((x) => x.item);
    const others = recipe.data.stock.filter((x) => x.kitchen !== dish.kitchen).map((x) => x.item);
    const names = [...new Set([...own, ...others])];
    const rows = recipe.rows.map((r, i) => `
      <div class="recipe-row">
        <input type="text" list="recipe-items" autocomplete="off" placeholder="Ingredient" data-recipe-row="${i}" data-field="ingredient"
          value="${escapeHtml(r.ingredient)}">
        <input type="text" inputmode="decimal" autocomplete="off" placeholder="Qty" data-recipe-row="${i}" data-field="qty"
          value="${escapeHtml(r.qty)}">
        <input type="text" list="recipe-units" autocomplete="off" placeholder="Unit" data-recipe-row="${i}" data-field="unit"
          value="${escapeHtml(r.unit)}">
        <button type="button" class="recipe-remove" data-action="recipe-remove" data-row="${i}" aria-label="Remove">✕</button>
      </div>`).join('');
    return `
      <div class="page recipes">
        <div class="recipe-progress"><span style="width:${covered}%"></span></div>
        <p class="hint">${doneCount} of ${list.length} dishes · ${covered}% of sales covered</p>
        <h1>${escapeHtml(dish.dish)}</h1>
        <p class="hint">${escapeHtml(dish.kitchen)} · sold ${dish.sold} in 30 days${recipeDone(dish) ? ' · ✓ saved' : ''}</p>
        <p><b>What goes into one plate?</b></p>
        <div class="recipe-head"><span>Ingredient</span><span>Qty</span><span>Unit</span><span></span></div>
        ${rows}
        <datalist id="recipe-items">${names.map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
        <datalist id="recipe-units">${RECIPE_UNITS.map((u) => `<option value="${u}">`).join('')}</datalist>
        <button type="button" class="btn wide" data-action="recipe-add-row">+ Add ingredient</button>
        ${recipe.error ? `<p class="waiting">Not saved: ${escapeHtml(errorText(recipe.error))}</p>` : ''}
        ${recipe.note ? `<p class="hint">${escapeHtml(recipe.note)}</p>` : ''}
        <button type="button" class="btn btn-primary wide" data-action="recipe-save" ${recipe.saving ? 'disabled' : ''}>
          ${recipe.saving ? 'Saving…' : 'Save & next →'}</button>
        <div class="recipe-nav">
          <button type="button" class="btn" data-action="recipe-move" data-step="-1">← Back</button>
          <button type="button" class="btn" data-action="recipe-move" data-step="1">Skip →</button>
        </div>
      </div>`;
  }

  // ---------- Drawing ----------

  const VIEWS = { kitchen: kitchenView, stock: stockView, recipes: recipesView, orders: ordersView, billing: billingView, running: runningView, done: doneView, today: todayView, settings: settingsView, connect: connectView };

  let drawnView = null;

  function render() {
    // A kitchen phone only ever shows its kitchen (or the connect and settings screens).
    if (recipeMode() && !['connect', 'settings'].includes(state.view)) {
    if (state.view !== 'recipes') loadRecipes();
    state.view = 'recipes';
  } else if (kitchenName() && !['connect', 'settings', 'stock', 'orders'].includes(state.view)) state.view = 'kitchen';
    // Redrawing the same screen (a bill opened, an upload finished) keeps its scroll place.
    const page = viewEl.querySelector('.page');
    const scrollTop = drawnView === state.view && page ? page.scrollTop : 0;
    viewEl.className = `view view-${state.view}`;
    viewEl.innerHTML = VIEWS[state.view]();
    drawnView = state.view;
    const redrawn = viewEl.querySelector('.page');
    if (redrawn) redrawn.scrollTop = scrollTop;
    const active = state.view === 'done' ? 'billing' : state.view;
    navEl.hidden = state.view === 'kitchen' || state.view === 'recipes' || ((state.view === 'stock' || state.view === 'orders') && Boolean(kitchenName()));
    navEl.innerHTML = NAV.map(([view, label]) => `
      <button type="button" class="nav-btn${view === active ? ' is-active' : ''}"
        data-action="nav" data-view="${view}">${label}</button>`).join('');
  }

  // Called when something changed in the background (an upload finished, the menu
  // arrived). Never redraws a form the person may be typing in.
  function refresh() {
    if (['stock', 'recipes', 'orders'].includes(state.view)) return; // someone may be typing
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
      state.moving = null;
      if (state.view === 'today') refreshToday();
      if (state.view === 'stock') {
        state.stockError = null;
        state.stockNote = null;
        loadStockItems();
      }
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
    'run-open'(el) {
      state.view = 'billing';
      state.picking = false;
      actions['open-order'](el);
    },
    'run-move'(el) {
      // An order being edited on the Billing screen is saved first, so the move works on
      // what is really on the table and the screen holds no stale copy afterwards.
      if (state.openId === el.dataset.id) {
        if (!holdDraft()) { render(); return; }
        state.openId = null;
        state.draft = emptyDraft();
      }
      state.moving = el.dataset.id;
      state.notice = null;
      render();
    },
    'cancel-move'() {
      state.moving = null;
      render();
    },
    'move-to'(el) {
      const id = state.moving;
      const table = el.dataset.table;
      const target = store.getOpenOrders().find((o) => o.table === table && o.id !== id);
      if (target && !window.confirm(`Table ${table} already has an order. Join them into one?`)) return;
      let result;
      try {
        result = store.moveOrder(id, table, localTime(new Date()));
      } catch (e) {
        state.notice = e.message === 'not_found' ? 'That table was already paid or moved.' : STORAGE_FAILED;
        state.moving = null;
        render();
        return;
      }
      if (fb) {
        const kept = store.getOpenOrders().find((o) => o.id === result.id);
        if (kept) fb.saveOpenOrder(kept).catch(() => {});
        if (result.merged) fb.closeOpenOrder(id).catch(() => {});
      }
      state.moving = null;
      state.notice = null;
      render();
      sync.flush().catch(() => {}).then(refresh);
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
      startRealtimeTickets();
      render();
      refreshTickets();
      startPush(kitchenName()).then((ready) => (ready ? askForAlerts() : false)).then(render);
      onAlert(() => refreshTickets());
    },
    alerts() {
      startPush(kitchenName()).then((ready) => (ready ? askForAlerts() : false)).then(render);
    },
    'open-stock'() {
      state.view = 'stock';
      state.stockError = null;
      state.stockNote = null;
      render();
      loadStockItems();
    },
    'recipe-load'() {
      recipe.error = null;
      render();
      loadRecipes();
    },
    'recipe-add-row'() {
      recipe.rows.push(emptyRow());
      render();
    },
    'recipe-remove'(el) {
      recipe.rows.splice(Number(el.dataset.row), 1);
      if (recipe.rows.length === 0) recipe.rows.push(emptyRow());
      render();
    },
    'recipe-move'(el) {
      const n = recipe.data.dishes.length;
      openDish((recipe.index + Number(el.dataset.step) + n) % n);
      recipe.note = null;
      recipe.error = null;
      render();
    },
    async 'recipe-save'() {
      const dish = recipe.data.dishes[recipe.index];
      const kitchenStock = recipe.data.stock.filter((x) => x.kitchen === dish.kitchen);
      const lines = [];
      for (const r of recipe.rows) {
        const name = r.ingredient.trim().replace(/\s+/g, ' ');
        const unit = r.unit.trim();
        if (!name && !r.qty.trim() && !unit) continue; // an empty row
        const qty = parseQty(r.qty);
        if (!name || !qty || !unit) {
          recipe.note = `Fill all three boxes for ${name || 'each ingredient'} (ingredient, quantity, unit), or remove the row.`;
          render();
          return;
        }
        // A name typed in a different case still matches the stock list.
        const known = kitchenStock.find((x) => x.item.toLowerCase() === name.toLowerCase());
        // A typo of a listed item is asked about once; Save again keeps the typed name.
        const near = known ? null : closeMatch(name, recipe.data.stock.map((x) => x.item));
        if (near && !recipe.kept.has(name)) {
          recipe.kept.add(name);
          recipe.note = `"${name}" looks like "${near}", which is already on the list. Change it to ${near}, or tap Save again to keep "${name}".`;
          render();
          return;
        }
        lines.push(known ? { ingredient: known.item, qty, unit } : { ingredient: name, qty, unit, isNew: true });
      }
      recipe.saving = true;
      render();
      try {
        const reply = await api.send({ action: 'saveRecipe', dish: dish.dish, kitchen: dish.kitchen, lines });
        if (!reply.ok) throw new Error(reply.error || 'bad_response');
        dish.lines = lines.map(({ ingredient, qty, unit }) => ({ ingredient, qty, unit }));
        dish.saved = true;
        lines.filter((l) => l.isNew).forEach((l) => recipe.data.stock.push({ item: l.ingredient, kitchen: dish.kitchen, unit: l.unit }));
        recipe.error = null;
        recipe.note = `✓ ${dish.dish} saved · ${recipeCovered()}% of sales covered`;
        openDish(nextOpenDish(recipe.index));
      } catch (e) {
        recipe.error = e.message;
      }
      recipe.saving = false;
      if (state.view === 'recipes') render();
    },
    async 'stock-sold-as'(el) {
      const item = (state.stockItems || []).find((i) => i.item === el.dataset.item);
      if (!item) return;
      try {
        const reply = await api.send({ action: 'setSoldAs', kitchen: stockPlace(), item: item.item, soldAs: el.dataset.soldAs });
        if (!reply.ok || !reply.found) throw new Error(reply.error || 'bad_response');
        item.soldAs = el.dataset.soldAs;
        state.stockError = null;
        state.stockNote = `${item.item}: sold as ${item.soldAs}`;
      } catch (e) {
        state.stockError = e.message;
      }
      if (state.view === 'stock') render();
    },
    'stock-show-all'() {
      state.stockShowAll = !state.stockShowAll;
      render();
    },
    'open-orders'() {
      state.view = 'orders';
      state.stockNote = null;
      render();
      loadOrders();
    },
    'orders-back'() {
      state.view = 'stock';
      state.stockNote = null;
      render();
    },
    'order-new'() {
      const id = `ORD-HAND-${Date.now()}-${randomSuffix()}`;
      state.orders = [{ id, kitchen: stockPlace(), status: 'Draft', lines: [] }, ...(state.orders || [])];
      state.stockNote = null;
      render();
    },
    'order-add-line'(el) {
      const order = (state.orders || []).find((o) => o.id === el.dataset.id);
      if (!order) return;
      const name = (viewEl.querySelector(`#add-item-${CSS.escape(order.id)}`).value || '').trim().replace(/\s+/g, ' ');
      const qty = parseQty(viewEl.querySelector(`#add-qty-${CSS.escape(order.id)}`).value);
      if (!name || !qty) {
        state.stockNote = 'Pick or type the item, and how many, then tap + Add.';
        render();
        return;
      }
      const known = (state.stockItems || []).find((i) => i.item.toLowerCase() === name.toLowerCase());
      const item = known ? known.item : name;
      const edits = state.orderEdits[order.id] || {};
      const existing = order.lines.find((l) => l.item === item);
      if (existing) {
        edits[item] = String((parseQty(edits[item] ?? String(existing.qty)) || 0) + qty);
      } else {
        order.lines.push({ item, unit: known ? known.unit : '', qty });
      }
      state.orderEdits[order.id] = edits;
      state.stockNote = null;
      render();
    },
    async 'order-step'(el) {
      const order = (state.orders || []).find((o) => o.id === el.dataset.id);
      if (!order) return;
      const status = el.dataset.status;
      const edits = state.orderEdits[order.id] || {};
      const message = { action: 'setOrder', orderId: order.id, status };
      if (status !== 'Ordered') {
        message.lines = order.lines.map((l) => {
          const typed = edits[l.item];
          const qty = typed === undefined ? l.qty : parseQty(typed);
          return { item: l.item, unit: l.unit, qty: qty === null ? l.qty : qty };
        });
      }
      if (status === 'Received') {
        const now = new Date();
        message.date = localDate(now);
        message.time = localTime(now);
      }
      if (order.status === 'Draft' && message.lines.length === 0) {
        state.stockNote = 'Add at least one item first.';
        render();
        return;
      }
      el.disabled = true;
      try {
        // An order started by hand is saved first, then approved like any other.
        if (order.status === 'Draft') {
          const made = await api.send({ action: 'addOrder', id: order.id, kitchen: order.kitchen, lines: message.lines.filter((l) => l.qty > 0) });
          if (!made.ok) throw new Error(made.error || 'bad_response');
          message.lines = message.lines.filter((l) => l.qty > 0);
        }
        const reply = await api.send(message);
        if (!reply.ok) throw new Error(reply.error || 'bad_response');
        delete state.orderEdits[order.id];
        state.stockNote = { Approved: '✓ Approved. The manager sees it on the counter phone.',
          Ordered: '✓ Marked as ordered.', Received: '✓ Received. Stock is updated.' }[status];
        state.ordersError = null;
      } catch (e) {
        state.ordersError = e.message;
      }
      await loadOrders();
    },
    'stock-back'() {
      state.view = 'kitchen';
      render();
    },
    'stock-kind'(el) {
      if (stock.kind === el.dataset.kind) return;
      stock.kind = el.dataset.kind;
      keepStockDraft();
      state.stockNote = null;
      state.stockError = null;
      render();
    },
    async 'stock-save'() {
      const draft = stockDraft();
      const kind = stock.kind;
      const entry = stockEntry({ id: draft.id, kitchen: stockPlace(), kind,
        items: state.stockItems || [], values: draft.values, now: new Date() });
      if (!entry) {
        state.stockError = null;
        state.stockNote = 'Type a number for at least one item first.';
        render();
        return;
      }
      state.stockSaving = true;
      state.stockNote = null;
      render();
      try {
        const reply = await api.send({ action: 'addStock', entry });
        if (!reply.ok) throw new Error(reply.error || 'bad_response');
        if (stock.drafts[kind] === draft) delete stock.drafts[kind];
        keepStockDraft();
        state.stockError = null;
        state.stockNote = `Saved ✓ ${entry.lines.length} item${entry.lines.length === 1 ? '' : 's'} at ${entry.time}`;
        if (reply.order) {
          // The count proposes an order straight away: check it, change any number, approve.
          state.orders = [reply.order, ...(state.orders || []).filter((o) => o.id !== reply.order.id
            && !(o.kitchen === reply.order.kitchen && o.status === 'Proposed'))];
          state.stockNote = `Count saved ✓ Here is what to order. Change any number, then approve.`;
          state.stockSaving = false;
          state.view = 'orders';
          render();
          return;
        }
        if (kind === 'Count') state.stockNote += ' · Nothing needs ordering.';
      } catch (e) {
        state.stockError = e.message;
      }
      state.stockSaving = false;
      if (state.view === 'stock') render();
    },
    'ticket-ready'(el) {
      doneTickets.add(el.dataset.id);
      state.tickets = state.tickets.filter((t) => t.id !== el.dataset.id);
      if (fb) fb.markTicketReady(el.dataset.id).catch(() => {});
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
    if (ringing.length) stopRing();
    const el = event.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
  });

  root.addEventListener('input', (event) => {
    const orderId = event.target.dataset && event.target.dataset.orderId;
    if (orderId) {
      state.orderEdits[orderId] = state.orderEdits[orderId] || {};
      state.orderEdits[orderId][event.target.dataset.orderItem] = event.target.value;
      return;
    }
    const recipeRow = event.target.dataset && event.target.dataset.recipeRow;
    if (recipeRow !== undefined) {
      const row = recipe.rows[Number(recipeRow)];
      if (row) row[event.target.dataset.field] = event.target.value;
      return;
    }
    const stockItem = event.target.dataset && event.target.dataset.stockItem;
    if (stockItem) {
      stockDraft().values[stockItem] = event.target.value;
      keepStockDraft();
      return;
    }
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
