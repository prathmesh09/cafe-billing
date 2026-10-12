// Wires the pieces together and decides when to try uploading.

import { localDate } from './bill.js';
import { createStore } from './store.js';
import { createApi } from './api.js';
import { createSync } from './sync.js';
import { startUi } from './ui.js';

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
const api = createApi({
  fetch: (...args) => window.fetch(...args),
  getSettings: store.getSettings,
  isOnline: () => navigator.onLine !== false,
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

const ui = startUi({ store, api, sync, root: document.getElementById('app') });

function upload() {
  sync.flush().catch(() => {}).then(() => ui.refresh());
}

if (store.getSettings().scriptUrl) ui.refreshMenu();
upload();
window.addEventListener('online', upload);
setInterval(() => {
  if (store.queueLength() > 0) upload();
}, RETRY_MS);
