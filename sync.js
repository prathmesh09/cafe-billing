// Upload queue. Sends waiting messages to the sheet, oldest first, and stops at the
// first one that cannot be delivered so bills always arrive in order.

// Replies that mean "this message will never be accepted". Only these are set aside.
// Anything else the sheet refuses is treated as temporary: the bill stays queued.
const PERMANENT = new Set(['bad_request', 'unknown_action']);

// `lock(run)` runs `run` while holding a phone-wide upload lock and resolves to its
// result, or resolves to null without running it when another copy of the app (a second
// tab, or the installed app next to a browser tab) is already uploading.
export function createSync({ store, send, now = () => new Date(), lock = (run) => run() }) {
  let running = null;

  async function run() {
    let sent = 0;
    let error = null;
    for (let message = store.peekQueue(); message; message = store.peekQueue()) {
      let reply;
      try {
        reply = await send(message);
      } catch (e) {
        error = e.message;
        break;
      }
      if (reply.ok) {
        store.dequeue(message);
        sent += 1;
      } else if (PERMANENT.has(reply.error)) {
        store.rejectHead(message, reply.error);
      } else {
        error = reply.error || 'bad_response';
        break;
      }
    }
    store.setSyncState(sent > 0
      ? { lastError: error, lastSuccessAt: now().toISOString() }
      : { lastError: error });
    return { sent, remaining: store.queueLength(), error };
  }

  async function runIfFree() {
    const result = await lock(run);
    return result ?? { sent: 0, remaining: store.queueLength(), error: null };
  }

  return {
    flush() {
      if (!running) {
        running = runIfFree().finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
}
