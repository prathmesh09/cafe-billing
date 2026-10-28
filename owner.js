// The owner's phone: only the sales dashboard. No billing, no uploads, no kitchen alerts.
// A phone becomes an owner phone by scanning the code from showOwnerSetup (…&k=Owner).

import { localDate } from './bill.js';
import { dashboardHtml, emptyHtml, shiftDay } from './dashboard.js';

export const OWNER = 'Owner';

// Bills and kitchen tickets this phone has not uploaded yet. An owner phone never
// uploads, so a counter phone with any of these must not be turned into one.
export const unsentCount = (store) => store.queueLength() + store.kitchenLength();

export function startOwner({ store, api, root }) {
  const today = () => localDate(new Date());
  const state = { date: today(), tabs: {}, loading: false, error: null, fresh: null };

  function render() {
    const bundle = state.fresh && state.fresh.date === state.date ? state.fresh : store.getDashboardCache(state.date);
    const isToday = state.date === today();
    const note = state.loading ? 'Loading…'
      : state.error && bundle ? `Couldn’t refresh · showing ${bundle.updated || 'the last copy'}`
        : bundle ? `Updated ${bundle.updated}` : '';
    // A refresh redraws the page; keep the place the owner had scrolled to.
    const scrollTop = root.querySelector('.owner')?.scrollTop ?? 0;
    root.innerHTML = `<div class="view view-owner"><div class="page owner">
      <header class="owner-top">
        <button type="button" class="owner-step" data-action="day" data-step="-1" aria-label="Day before">‹</button>
        <label class="owner-day">${isToday ? 'Today' : new Date(`${state.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
          <input type="date" value="${state.date}" max="${today()}" data-action="pick-day" aria-label="Pick a day"></label>
        <button type="button" class="owner-step" data-action="day" data-step="1" aria-label="Next day"${isToday ? ' disabled' : ''}>›</button>
      </header>
      <div class="owner-note"><span>${note}</span><button type="button" class="owner-refresh" data-action="refresh"${state.loading ? ' disabled' : ''}>Refresh</button></div>
      ${bundle ? dashboardHtml(bundle, state.tabs) : state.loading ? '' : emptyHtml(state.error)}
    </div></div>`;
    root.querySelector('.owner').scrollTop = scrollTop;
  }

  async function load() {
    const date = state.date;
    state.loading = true;
    state.error = null;
    render();
    try {
      const bundle = await api.getDashboard(date);
      state.fresh = bundle;
      try { store.setDashboardCache(date, bundle); } catch { /* full storage: state.fresh still shows it */ }
    } catch (err) {
      if (date === state.date) state.error = err.message;
    }
    if (date === state.date) {
      state.loading = false;
      render();
    }
  }

  function goTo(date) {
    state.date = date > today() ? today() : date;
    const page = root.querySelector('.owner');
    if (page) page.scrollTop = 0; // a new day starts at the top
    load();
  }

  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'day') goTo(shiftDay(state.date, Number(el.dataset.step)));
    if (el.dataset.action === 'refresh') load();
    if (el.dataset.action === 'dash-tab') {
      state.tabs[el.dataset.tab] = el.dataset.on === '1';
      render();
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target.dataset.action === 'pick-day' && event.target.value) goTo(event.target.value);
  });
  // Coming back to the app after a while: show today's latest numbers.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.loading) load();
  });

  load();
}
