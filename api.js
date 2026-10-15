// Talks to the sheet script. Every request is a POST with the passcode in the body.
//
// Content-Type is text/plain on purpose: it keeps the browser from sending a preflight
// request, which Apps Script cannot answer.
//
// Errors thrown by send():
//   not_configured  no script address saved
//   bad_address     the address is not a full web address, so nothing was sent
//   offline         the request failed and the phone says it has no connection
//   unreachable     the request failed although the phone is online. Google's sign-in
//                   and error pages cannot be read from a web page, so a wrong address
//                   or a deployment that is not shared with "Anyone" ends up here too.
//   bad_response    something answered, but not the sheet script

const WEB_ADDRESS = /^https?:\/\//i;

const usableItem = (i) => Boolean(i)
  && typeof i.item === 'string' && i.item !== ''
  && typeof i.kitchen === 'string'
  && typeof i.category === 'string'
  && Number.isFinite(i.price) && i.price > 0;

export function createApi({ fetch, getSettings, timeoutMs = 15000, isOnline = () => true }) {
  async function send(message) {
    const { scriptUrl, passcode } = getSettings();
    const url = scriptUrl.trim();
    if (!url) throw new Error('not_configured');
    // Without this, "script.google.com/..." would be read as a path on the app's own
    // site and the passcode would be posted there.
    if (!WEB_ADDRESS.test(url)) throw new Error('bad_address');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow',
        body: JSON.stringify({ key: passcode, ...message }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      throw new Error(isOnline() ? 'unreachable' : 'offline');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new Error('bad_response');
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      throw new Error('bad_response');
    }
    if (reply === null || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
      throw new Error('bad_response');
    }
    return reply;
  }

  // Only ever returns a non-empty list of well-formed items, so a damaged or half-edited
  // Menu tab can never replace the menu saved on the phone.
  async function getMenu() {
    const reply = await send({ action: 'getMenu' });
    if (!reply.ok) throw new Error(reply.error || 'bad_response');
    if (!Array.isArray(reply.items) || !reply.items.every(usableItem)) throw new Error('bad_response');
    if (reply.items.length === 0) throw new Error('empty_menu');
    return reply.items;
  }

  // Today's bills for one outlet, from every phone, as the sheet has them.
  async function getToday(date, outlet) {
    const reply = await send({ action: 'getToday', date, outlet });
    if (!reply.ok) throw new Error(reply.error || 'bad_response');
    if (!Array.isArray(reply.bills)) throw new Error('bad_response');
    return reply.bills;
  }

  // The tables still waiting to pay, shared by every phone.
  async function getOpen() {
    const reply = await send({ action: 'getOpen' });
    if (!reply.ok) throw new Error(reply.error || 'bad_response');
    if (!Array.isArray(reply.orders)) throw new Error('bad_response');
    return reply.orders;
  }

  // The tickets one kitchen still has to make.
  async function getTickets(kitchen) {
    const reply = await send({ action: 'getTickets', kitchen });
    if (!reply.ok) throw new Error(reply.error || 'bad_response');
    if (!Array.isArray(reply.tickets)) throw new Error('bad_response');
    return reply.tickets;
  }

  return { send, getMenu, getToday, getOpen, getTickets };
}
