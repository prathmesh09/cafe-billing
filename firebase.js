// Realtime operational sync via Cloud Firestore.
//
// When FIREBASE_CONFIG.projectId is set, kitchen tickets and open tables sync in
// real time (<500ms) with multi-tab offline support. When empty, the app uses
// the Google Sheet Apps Script backend.

import { FIREBASE_CONFIG } from './firebase-config.js';

export const firebaseAvailable = (cfg = FIREBASE_CONFIG) => Boolean(cfg && typeof cfg.projectId === 'string' && cfg.projectId.trim() !== '');

async function defaultGetModules() {
  const [appModule, firestoreModule, authModule] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'),
    import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js'),
  ]);
  return { appModule, firestoreModule, authModule };
}

// The database only lets signed-in phones in. A phone signs in with a pass from the sheet
// script (which checks the passcode), naming its kitchen, or none for a counter phone.
// Firebase keeps the phone signed in; a new pass is asked for only when the phone has
// none yet or has been switched between counter and a kitchen.
async function signIn(app, authModule, getPass, kitchen) {
  const auth = authModule.getAuth(app);
  await auth.authStateReady();
  if (auth.currentUser) {
    const { claims } = await auth.currentUser.getIdTokenResult();
    if ((claims.kitchen || '') === kitchen) return;
  }
  const token = await getPass(kitchen);
  await authModule.signInWithCustomToken(auth, token);
}

let sharedClient = null;
const KITCHEN_SHOW_MS = 12 * 60 * 60 * 1000;

// getPass(kitchen) resolves to a sign-in token from the sheet script; getKitchen() is this
// phone's kitchen ('' for a counter phone).
export function createFirebaseClient({ config = FIREBASE_CONFIG, outlet = 'bhukum', getModules = defaultGetModules,
  getPass = async () => { throw new Error('no_pass'); }, getKitchen = () => '' } = {}) {
  let dbPromise = null;

  async function getDb() {
    if (!firebaseAvailable(config)) return null;
    if (!dbPromise) {
      dbPromise = (async () => {
        const { appModule, firestoreModule, authModule } = await getModules();
        const app = appModule.getApps().length > 0
          ? appModule.getApps()[0]
          : appModule.initializeApp(config);
        await signIn(app, authModule, getPass, getKitchen());

        let db;
        try {
          db = firestoreModule.initializeFirestore(app, {
            localCache: firestoreModule.persistentLocalCache({
              tabManager: firestoreModule.persistentMultipleTabManager(),
            }),
          });
        } catch {
          db = firestoreModule.getFirestore(app);
        }
        return { db, f: firestoreModule };
      })();
      // Offline, or the sheet could not give a pass: try again next time, not never.
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  return {
    async pushTickets(tickets) {
      if (!Array.isArray(tickets) || tickets.length === 0) return;
      const client = await getDb();
      if (!client) return;
      const { db, f } = client;
      const batch = f.writeBatch(db);
      for (const t of tickets) {
        const docRef = f.doc(db, 'outlets', outlet, 'kitchen_tickets', t.id);
        batch.set(docRef, {
          id: t.id,
          kitchen: t.kitchen,
          label: t.label,
          time: t.time,
          items: t.items,
          status: 'waiting',
          createdAt: new Date().toISOString(),
        }, { merge: true });
      }
      await batch.commit();
    },

    async markTicketReady(ticketId) {
      if (!ticketId) return;
      const client = await getDb();
      if (!client) return;
      const { db, f } = client;
      const docRef = f.doc(db, 'outlets', outlet, 'kitchen_tickets', ticketId);
      await f.updateDoc(docRef, {
        status: 'ready',
        readyAt: new Date().toISOString(),
      });
    },

    async listenTickets(kitchen, onUpdate, onError) {
      const client = await getDb();
      if (!client) return () => {};
      const { db, f } = client;
      const coll = f.collection(db, 'outlets', outlet, 'kitchen_tickets');
      const q = f.query(coll, f.where('kitchen', '==', kitchen), f.where('status', '==', 'waiting'));
      return f.onSnapshot(q, (snapshot) => {
        // Like the sheet, a kitchen sees only the last 12 hours, made or not.
        const since = Date.now() - KITCHEN_SHOW_MS;
        const tickets = snapshot.docs.map((docSnap) => docSnap.data())
          .filter((t) => !t.createdAt || Date.parse(t.createdAt) >= since);
        onUpdate(tickets);
      }, (err) => {
        if (onError) onError(err);
      });
    },

    async saveOpenOrder(order) {
      if (!order || !order.id) return;
      const client = await getDb();
      if (!client) return;
      const { db, f } = client;
      const docRef = f.doc(db, 'outlets', outlet, 'open_orders', order.id);
      await f.setDoc(docRef, {
        id: order.id,
        label: order.label || '',
        table: order.table || null,
        lines: order.lines || [],
        sent: order.sent || {},
        status: 'open',
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    },

    async closeOpenOrder(orderId) {
      if (!orderId) return;
      const client = await getDb();
      if (!client) return;
      const { db, f } = client;
      const docRef = f.doc(db, 'outlets', outlet, 'open_orders', orderId);
      await f.updateDoc(docRef, {
        status: 'closed',
        closedAt: new Date().toISOString(),
      });
    },

    async listenOpenOrders(onUpdate, onError) {
      const client = await getDb();
      if (!client) return () => {};
      const { db, f } = client;
      const coll = f.collection(db, 'outlets', outlet, 'open_orders');
      const q = f.query(coll, f.where('status', '==', 'open'));
      return f.onSnapshot(q, (snapshot) => {
        const orders = snapshot.docs.map((docSnap) => docSnap.data());
        onUpdate(orders);
      }, (err) => {
        if (onError) onError(err);
      });
    },
  };
}

export function getFirebaseClient(options = {}) {
  if (!sharedClient) sharedClient = createFirebaseClient(options);
  return sharedClient;
}
