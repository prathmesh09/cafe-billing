// Wires the pieces together and decides when to try uploading.

import { localDate } from './bill.js';
import { createStore } from './store.js';
import { createApi } from './api.js';
import { createSync } from './sync.js';
import { startUi } from './ui.js';
import { parseSetupHash } from './setup-link.js';
import { firebaseAvailable, getFirebaseClient } from './firebase.js';

const RETRY_MS = 60 * 1000;

// Some browsers block storage outright (private windows). Hand the store something
// that refuses every write, so the app says "not saved" instead of failing to open.
function openStorage() {
  try {
    const storage = window.localStorage;
    storage.getItem('cb.settings');
    return storage;
  } catch {
    return {
      getItem: () => null,
      setItem: () => { throw new Error('storage_blocked'); },
      removeItem: () => {},
    };
  }
}

const store = createStore(openStorage());

// One id per phone, so each phone is its own user in the live-orders database.
function deviceId() {
  try {
    let id = window.localStorage.getItem('cb.device');
    if (!id) {
      id = Math.random().toString(36).slice(2, 12);
      window.localStorage.setItem('cb.device', id);
    }
    return id;
  } catch {
    return '';
  }
}

let api = null;
const fb = firebaseAvailable() ? getFirebaseClient({
  getPass: (kitchen) => api.getFirebasePass(kitchen, deviceId()),
  getKitchen: () => store.getSettings().kitchen || '',
}) : null;
api = createApi({
  fetch: (...args) => window.fetch(...args),
  getSettings: store.getSettings,
  isOnline: () => navigator.onLine !== false,
  fb,
});

// The app can be open twice on one phone: the home-screen app and a browser tab. Only one
// copy may upload at a time, or both would send the same bills and trip over each other.
const uploadLock = navigator.locks
  ? (run) => navigator.locks.request('cafe-billing-upload', { ifAvailable: true }, (held) => (held ? run() : null))
  : undefined;
const sync = createSync({ store, send: api.send, lock: uploadLock });

try {
  store.prune(localDate(new Date()));
} catch {
  // Clearing old bills is housekeeping; never let it stop the app from opening.
}

// Offline opening, and a request that the browser never clears this app's storage.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

// A phone that scanned the owner's setup code arrives with everything it needs after
// the # in the address. Save it, then take it out of the address bar straight away.
let arrival = 'none'; // 'none' | 'connected' | 'bad-code'
if (window.location.hash.startsWith('#c=')) {
  const fromCode = parseSetupHash(window.location.hash);
  arrival = 'bad-code';
  if (fromCode) {
    try {
      store.saveSettings(fromCode);
      arrival = 'connected';
    } catch {
      // storage refused; the connect screen will say so
    }
  }
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

const ui = startUi({ store, api, sync, root: document.getElementById('app'), arrival, fb });

// If the app is already open in this tab when a setup code is scanned, the browser only
// changes the part after the #. Reload so the code is read like a fresh visit.
window.addEventListener('hashchange', () => {
  if (window.location.hash.startsWith('#c=')) window.location.reload();
});

// Chrome on Android offers a one-tap install; keep the offer so the app can show a button.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  ui.offerInstall(event);
});

function upload() {
  sync.flush().catch(() => {}).then(() => ui.refresh()).then(() => ui.refreshOpen());
}

if (store.getSettings().scriptUrl && arrival !== 'connected') ui.refreshMenu();
ui.refreshToday();
upload();
window.addEventListener('online', upload);
setInterval(() => {
  if (store.queueLength() > 0 || store.kitchenLength() > 0) upload();
}, RETRY_MS);

// Other phones may open or pay tables; look every 30 seconds while the app is on screen.
setInterval(() => {
  if (!ui.isKitchen() && document.visibilityState === 'visible' && store.queueLength() === 0) ui.refreshOpen();
}, 30 * 1000);

// A kitchen screen looks for new tickets every 8 seconds.
setInterval(() => {
  if (ui.isKitchen() && document.visibilityState === 'visible') ui.refreshTickets();
}, 8 * 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  upload();
  if (ui.isKitchen()) {
    ui.keepScreenOn();
    ui.refreshTickets();
  }
});
