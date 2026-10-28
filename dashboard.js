// The owner's dashboard as HTML, from the bundle the sheet's getDashboard sends
// (dashboardFor in apps-script/Code.gs). Plain functions, no page access, so tests can
// check the words. Bars are divs with a width; there is no chart library.

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pct = (part, whole) => (whole > 0 ? Math.max(2, Math.round((part / whole) * 100)) : 0);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayName = (date) => DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;

// A date moved by whole days ('2026-10-31', 1 → '2026-11-01').
export function shiftDay(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function card(title, body, switcher = '') {
  return `<section class="dash-card"><div class="dash-card-head"><h2>${title}</h2>${switcher}</div>${body}</section>`;
}

function switcher(name, on, offLabel, onLabel) {
  return `<div class="dash-switch" role="group">
    <button type="button" data-action="dash-tab" data-tab="${name}" data-on="0" class="${on ? '' : 'is-on'}">${offLabel}</button>
    <button type="button" data-action="dash-tab" data-tab="${name}" data-on="1" class="${on ? 'is-on' : ''}">${onLabel}</button>
  </div>`;
}

const none = '<p class="dash-none">No sales this day.</p>';

function barRows(rows, max) {
  return `<ol class="dash-bars">${rows.map((r) => `
    <li><span class="dash-name">${escapeHtml(r.name)}</span><span class="dash-num">${r.right}</span>
      <span class="dash-bar"><i style="width:${pct(r.value, max)}%"></i></span></li>`).join('')}</ol>`;
}

function topCard(list) {
  if (!list.length) return none;
  const max = list[0].rs;
  return barRows(list.map((x) => ({ name: x.item, value: x.rs, right: `${x.qty} · ${rupees(x.rs)}` })), max);
}

function moversCard(list, falling) {
  if (!list.length) return '<p class="dash-none">Nothing changed much.</p>';
  return `<ol class="dash-list">${list.map((m) => `
    <li><span class="dash-name">${escapeHtml(m.item)}</span>
      <span class="dash-num ${falling ? 'is-down' : 'is-up'}">${m.before} → ${m.now} ${falling ? '▼' : '▲'}</span></li>`).join('')}</ol>`;
}

function kitchensCard(k) {
  const names = ['Fresco', 'Pancham', 'Counter'];
  return `<table class="dash-table"><thead><tr><th></th><th>Day</th><th>7 days</th></tr></thead><tbody>
    ${names.map((n) => `<tr><th>${n}</th><td>${rupees(k.day[n] || 0)}</td><td>${rupees(k.week[n] || 0)}</td></tr>`).join('')}
  </tbody></table>
  <p class="dash-key">Counter = tea, cigarettes, water and cold drinks.</p>`;
}

function hoursCard(hours) {
  const max = Math.max(1, ...hours.map((h) => Math.max(h.day, h.usual)));
  return `<div class="dash-hours">${hours.map((h) => `
    <div class="dash-hour" title="${hourLabel(h.hour)}: ${rupees(h.day)} (usual ${rupees(h.usual)})">
      <span class="dash-hour-bar"><i style="height:${pct(h.day, max)}%"></i><b style="bottom:${pct(h.usual, max)}%"></b></span>
      <small>${hourLabel(h.hour)}</small></div>`).join('')}</div>
    <p class="dash-key"><i></i> this day <b></b> a usual day</p>`;
}

function weekdaysCard(days) {
  const max = Math.max(1, ...days.map((d) => d.avg));
  return barRows(days.map((d) => ({ name: d.day, value: d.avg, right: rupees(d.avg) })), max);
}

function decisionsCard(list) {
  if (!list.length) return '<p class="dash-none">No ideas on the Decisions tab yet.</p>';
  return `<ol class="dash-list">${list.map((d) => `
    <li><span class="dash-name">${escapeHtml(d.title)}</span><span class="dash-num">${rupees(d.rsMonth)}/mo</span></li>`).join('')}</ol>`;
}

// tabs: { top7, falling } pick the right half of the two switches.
export function dashboardHtml(b, tabs = {}) {
  const onTrack = b.sales >= b.target;
  const change = b.sameDayLastWeek > 0 ? Math.round(((b.sales - b.sameDayLastWeek) / b.sameDayLastWeek) * 100) : null;
  const avgChange = b.avgBillPrev7 > 0 ? Math.round(((b.avgBill - b.avgBillPrev7) / b.avgBillPrev7) * 100) : null;
  const empty = b.bills === 0 && b.sales === 0;
  const catMax = b.categories.length ? b.categories[0].rs : 0;

  const hero = `<section class="dash-hero ${onTrack ? 'is-on-track' : 'is-behind'}">
    <p class="dash-label">Sales</p>
    <p class="dash-big">${rupees(b.sales)}</p>
    <div class="dash-progress"><i style="width:${Math.min(100, pct(b.sales, b.target))}%"></i></div>
    <p class="dash-sub">${onTrack ? `Target reached · ${rupees(b.target)}` : `${rupees(b.toGo)} to go · target ${rupees(b.target)}`}</p>
    ${change === null ? '' : `<p class="dash-sub">${change < 0 ? '▼' : '▲'} ${Math.abs(change)}% vs last ${weekdayName(b.date)} (${rupees(b.sameDayLastWeek)})</p>`}
  </section>`;

  const tiles = `<section class="dash-tiles">
    <div><small>Bills</small><b>${b.bills}</b></div>
    <div><small>Average bill</small><b>${rupees(b.avgBill)}</b>${avgChange === null ? '' : `<em>${avgChange < 0 ? '▼' : '▲'} ${Math.abs(avgChange)}% vs 7 days</em>`}</div>
    <div><small>Items sold</small><b>${b.items}</b></div>
  </section>
  <p class="dash-line">Parcels ${b.parcels} · Tables ${b.tables} · Cash ${rupees(b.cash)} · Online ${rupees(b.online)}</p>`;

  return `${hero}${tiles}
    ${card('Top earners', empty && !tabs.top7 ? none : topCard(tabs.top7 ? b.top7 : b.topDay), switcher('top7', tabs.top7, 'Day', '7 days'))}
    ${card('What’s changing', moversCard(tabs.falling ? b.falling : b.rising, tabs.falling), switcher('falling', tabs.falling, 'Selling more', 'Selling less'))}
    ${card('Where the money comes from', `${kitchensCard(b.kitchens)}
      <h3>Top categories, last 7 days</h3>${b.categories.length ? barRows(b.categories.slice(0, 8).map((c) => ({ name: c.category, value: c.rs, right: rupees(c.rs) })), catMax) : none}`)}
    ${card('When it’s busy', hoursCard(b.hours))}
    ${card('Weekday trend', `<p class="dash-key">Average day, last 8 weeks</p>${weekdaysCard(b.weekdays)}`)}
    ${card('Decisions', decisionsCard(b.decisions))}`;
}

const REASONS = {
  offline: 'Can’t reach the sheet. Check the internet, then tap Refresh.',
  unreachable: 'Can’t reach the sheet. Check the internet, then tap Refresh.',
  bad_passcode: 'This link is not the owner link. Scan the code from showOwnerSetup in the sheet.',
};

export function emptyHtml(reason) {
  return `<p class="dash-empty">${escapeHtml(REASONS[reason] || 'Can’t reach the sheet. Tap Refresh to try again.')}</p>`;
}
