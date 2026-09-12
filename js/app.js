/* =========================================================
   HealthyBento — Tiffin Ledger
   Single-file client. Talks to the existing REST API at
   /api/state, /api/orders, /api/customers, /api/kitchen/*.
   ========================================================= */

const API = '/api';

const state = {
  zones: [],
  templates: [],
  addons: [],
  customers: [],
  orders: [],
  kitchenChecklist: [],
  tally: {},
  stats: {},
  // multi-select for bulk actions
  selected: new Set(),
  // form state
  draft: {
    customerName: '',
    phone: '',
    company: '',
    zoneId: '',
    templateId: '',
    addons: [],
    deliverySlot: '12:30 PM',
    customerId: null,
  },
};

const STATUS_ORDER = ['received', 'prep', 'qc', 'transit', 'delivered'];
const STATUS_LABEL = {
  received: 'Received',
  prep: 'In Prep',
  qc: 'QC',
  transit: 'In Transit',
  delivered: 'Delivered',
};
const STATUS_NEXT_ACTION = {
  received: 'Start prep',
  prep: 'Send to QC',
  qc: 'Dispatch',
  transit: 'Mark delivered',
};

// ---------- Fetch helper ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || j.message || msg;
      if (j.details) msg += ': ' + j.details.join('; ');
    } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Toast ----------
function toast(message, kind = 'ok') {
  const shelf = document.getElementById('toast-shelf');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = message;
  shelf.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

// ---------- Utilities ----------
function money(n) {
  if (typeof n !== 'number') n = Number(n) || 0;
  return '₹' + n.toLocaleString('en-IN');
}
function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return n;
}

// ---------- Initial hydration ----------
async function loadState() {
  const data = await api('/state');
  state.zones = data.zones;
  state.templates = data.templates;
  state.addons = data.addons;
  state.customers = data.customers;
  state.orders = data.orders;
  state.kitchenChecklist = data.kitchenChecklist;
  state.tally = data.tally;
  state.stats = data.stats;
  if (state.zones.length && !state.draft.zoneId) state.draft.zoneId = state.zones[0].id;
  if (state.templates.length && !state.draft.templateId) state.draft.templateId = state.templates[0].id;
}

// ---------- View routing ----------
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
  document.querySelectorAll('.nav-tabs .tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('is-active');
  // Leaving Today drops any bulk selection so the bar doesn't persist over the wrong view
  if (name !== 'today' && state.selected.size) {
    state.selected.clear();
    const bar = document.getElementById('bulk-bar');
    if (bar) bar.remove();
  }
  // per-view render
  if (name === 'today') renderToday();
  else if (name === 'new') renderNewOrder();
  else if (name === 'customers') renderCustomers();
  else if (name === 'kitchen') renderKitchen();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------- TODAY view ----------
function renderToday() {
  const view = document.getElementById('view-today');
  const stats = computeLocalStats();

  view.innerHTML = '';
  view.appendChild(el('header', { class: 'section-head' },
    el('div', {},
      el('div', { class: 'eyebrow' }, todayString()),
      el('h1', { html: 'Today’s <em>lunch dispatch</em>' }),
    ),
    el('div', { class: 'meta' },
      'Siripuram Central Kitchen',
      el('strong', {}, 'Vizag Metro • Shift 1'),
    ),
  ));

  // Ledger KPI row
  const ledger = el('div', { class: 'ledger' });
  ledger.appendChild(kpiCell({
    label: 'Bento boxes today',
    value: stats.total,
    unit: 'boxes',
    chips: [
      { text: `${stats.veg} veg`, cls: 'veg' },
      { text: `${stats.nv} non-veg`, cls: 'nv' },
    ],
  }));
  ledger.appendChild(kpiCell({
    label: 'Gross billed',
    value: money(stats.revenue),
    chips: [{ text: `${stats.count} orders`, cls: 'ochre' }],
  }));
  ledger.appendChild(kpiCell({
    label: 'Active subscribers',
    value: stats.active,
    unit: 'passes',
    chips: [
      { text: `${stats.paused} paused`, cls: '' },
    ],
  }));
  ledger.appendChild(kpiCell({
    label: 'In pipeline',
    value: stats.inPipeline,
    unit: 'to dispatch',
    chips: [
      { text: `${stats.done} delivered`, cls: 'veg' },
    ],
  }));
  view.appendChild(ledger);

  // Kanban board
  view.appendChild(el('div', { class: 'board-head' },
    el('h2', {}, 'Order pipeline'),
    el('div', { style: 'display:flex;gap:8px;' },
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => switchView('new'),
      }, '+ New order'),
    ),
  ));

  const board = el('div', { class: 'board' });
  STATUS_ORDER.forEach(status => {
    const col = el('div', { class: 'column', 'data-status': status });
    const orders = state.orders.filter(o => o.status === status);
    const head = el('div', { class: 'column-head' },
      el('div', { class: 'title' }, STATUS_LABEL[status]),
      el('div', { style: 'display:flex;align-items:center;gap:4px;' },
        orders.length ? el('button', {
          class: 'col-select',
          title: `Select all ${STATUS_LABEL[status]} orders`,
          onclick: (e) => { e.stopPropagation(); toggleColumnSelect(status); },
        }, allSelected(status) ? 'Clear' : 'All') : null,
        el('div', { class: 'n' }, String(orders.length)),
      ),
    );
    col.appendChild(head);
    const body = el('div', { class: 'col-body' });
    if (!orders.length) {
      body.appendChild(el('div', { class: 'empty-col' }, `— empty —`));
    } else {
      orders.forEach(o => body.appendChild(renderOrderCard(o)));
    }
    col.appendChild(body);
    board.appendChild(col);
  });
  view.appendChild(board);
  renderBulkBar();
}

function allSelected(status) {
  const inCol = state.orders.filter(o => o.status === status);
  return inCol.length > 0 && inCol.every(o => state.selected.has(o.id));
}

function toggleColumnSelect(status) {
  const inCol = state.orders.filter(o => o.status === status);
  const allOn = allSelected(status);
  inCol.forEach(o => {
    if (allOn) state.selected.delete(o.id);
    else state.selected.add(o.id);
  });
  renderToday();
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  // targeted re-render: just the card and bulk bar (avoids full board redraw)
  const card = document.querySelector(`.order[data-id="${id}"]`);
  if (card) card.classList.toggle('selected', state.selected.has(id));
  // also refresh column-head "All/Clear" label
  const order = state.orders.find(o => o.id === id);
  if (order) {
    const col = document.querySelector(`.column[data-status="${order.status}"] .col-select`);
    if (col) col.textContent = allSelected(order.status) ? 'Clear' : 'All';
  }
  renderBulkBar();
}

function clearSelection() {
  const wasSelected = [...state.selected];
  state.selected.clear();
  wasSelected.forEach(id => {
    const card = document.querySelector(`.order[data-id="${id}"]`);
    if (card) card.classList.remove('selected');
  });
  document.querySelectorAll('.col-select').forEach(b => b.textContent = 'All');
  renderBulkBar();
}

function renderBulkBar() {
  const existing = document.getElementById('bulk-bar');
  if (state.selected.size === 0) {
    if (existing) {
      existing.classList.add('leaving');
      setTimeout(() => existing.remove(), 200);
    }
    return;
  }

  // Compute which selected orders are still advanceable (not yet delivered)
  const selectedOrders = state.orders.filter(o => state.selected.has(o.id));
  const canDeliver = selectedOrders.filter(o => o.status !== 'delivered').length;
  const canAdvance = selectedOrders.filter(o => STATUS_ORDER.indexOf(o.status) < STATUS_ORDER.length - 1).length;

  if (existing) existing.remove();
  const bar = el('div', { class: 'bulk-bar', id: 'bulk-bar' });
  bar.appendChild(el('div', { class: 'count' },
    String(state.selected.size),
    el('span', { class: 'lbl' }, state.selected.size === 1 ? 'order selected' : 'orders selected'),
  ));
  bar.appendChild(el('div', { class: 'divider' }));

  if (canAdvance > 0) {
    bar.appendChild(el('button', {
      class: 'btn btn-advance',
      onclick: () => bulkAdvance(),
      title: 'Advance each selected order to its next status',
    }, `Advance one step (${canAdvance})`));
  }

  bar.appendChild(el('button', {
    class: 'btn btn-deliver',
    onclick: () => bulkMarkDelivered(),
    disabled: canDeliver === 0,
  }, canDeliver === selectedOrders.length
    ? `Mark all delivered  →`
    : `Mark ${canDeliver} delivered  →`));

  bar.appendChild(el('button', {
    class: 'btn btn-cancel',
    onclick: () => clearSelection(),
    title: 'Clear selection (Esc)',
  }, 'Cancel'));

  document.body.appendChild(bar);
}

async function bulkMarkDelivered() {
  const ids = [...state.selected].filter(id => {
    const o = state.orders.find(x => x.id === id);
    return o && o.status !== 'delivered';
  });
  if (!ids.length) return;
  if (ids.length >= 5 && !confirm(`Mark ${ids.length} orders as delivered? This cannot be undone.`)) return;

  await bulkPatch(ids, 'delivered', `${ids.length} order${ids.length === 1 ? '' : 's'} marked <strong>delivered</strong>`);
}

async function bulkAdvance() {
  // Each selected order advances by one step
  const ids = [...state.selected];
  const updates = ids.map(id => {
    const o = state.orders.find(x => x.id === id);
    if (!o) return null;
    const next = STATUS_ORDER[STATUS_ORDER.indexOf(o.status) + 1];
    return next ? { id, status: next } : null;
  }).filter(Boolean);

  if (!updates.length) return;

  const results = await Promise.allSettled(updates.map(u =>
    api(`/orders/${u.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: u.status }),
    })
  ));

  let ok = 0, err = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const idx = state.orders.findIndex(o => o.id === updates[i].id);
      if (idx >= 0) state.orders[idx] = r.value;
      ok++;
    } else err++;
  });

  state.selected.clear();
  renderToday();
  if (err === 0) toast(`Advanced <strong>${ok}</strong> order${ok === 1 ? '' : 's'} by one step`);
  else toast(`Advanced ${ok}, ${err} failed`, err > 0 ? 'err' : 'ok');
}

async function bulkPatch(ids, targetStatus, successMsg) {
  const results = await Promise.allSettled(ids.map(id =>
    api(`/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: targetStatus }),
    })
  ));

  let ok = 0, err = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const idx = state.orders.findIndex(o => o.id === ids[i]);
      if (idx >= 0) state.orders[idx] = r.value;
      ok++;
    } else err++;
  });

  state.selected.clear();
  renderToday();
  if (err === 0) toast(successMsg);
  else toast(`Marked ${ok} delivered, ${err} failed`, 'err');
}

function kpiCell({ label, value, unit, chips = [] }) {
  const cell = el('div', { class: 'cell' });
  cell.appendChild(el('div', { class: 'label' }, label));
  const vrow = el('div', { class: 'value' }, String(value));
  if (unit) vrow.appendChild(el('span', { class: 'unit' }, ' ' + unit));
  cell.appendChild(vrow);
  if (chips.length) {
    const foot = el('div', { class: 'foot' });
    chips.forEach(c => foot.appendChild(el('span', { class: `chip ${c.cls || ''}` }, c.text)));
    cell.appendChild(foot);
  }
  return cell;
}

function computeLocalStats() {
  const orders = state.orders;
  const s = {
    total: orders.length,
    veg: orders.filter(o => o.diet === 'veg').length,
    nv: orders.filter(o => o.diet !== 'veg').length,
    revenue: orders.reduce((a, o) => a + (Number(o.totalPrice) || 0), 0),
    count: orders.length,
    active: state.customers.filter(c => c.status === 'active').length,
    paused: state.customers.filter(c => c.status === 'paused').length,
    inPipeline: orders.filter(o => o.status !== 'delivered').length,
    done: orders.filter(o => o.status === 'delivered').length,
  };
  return s;
}

function todayString() {
  const d = new Date();
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const rest = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${day.toUpperCase()} · ${rest.toUpperCase()}`;
}

function renderOrderCard(o) {
  const isSelected = state.selected.has(o.id);
  const card = el('div', {
    class: `order ${o.status} ${isSelected ? 'selected' : ''}`,
    'data-id': o.id,
    onclick: (e) => {
      // whole-card click also toggles selection, unless clicking an inner button
      if (e.target.closest('button')) return;
      toggleSelect(o.id);
    },
  });
  card.appendChild(el('button', {
    class: 'pick',
    title: 'Select for bulk action',
    'aria-label': `Select order ${o.id}`,
    onclick: (e) => { e.stopPropagation(); toggleSelect(o.id); },
  }, '✓'));
  card.appendChild(el('div', { class: 'row1' },
    el('span', { class: `diet-dot ${o.diet === 'veg' ? '' : 'nv'}` }),
    el('span', { class: 'id' }, o.id),
  ));
  card.appendChild(el('div', { class: 'name' }, o.customerName));
  card.appendChild(el('div', { class: 'company' }, o.company || ''));
  card.appendChild(el('div', { class: 'foot' },
    el('span', { class: 'price' }, money(o.totalPrice)),
    el('span', { class: 'slot' }, o.deliverySlot || ''),
  ));
  const actions = el('div', { class: 'actions' });
  const nextStatus = STATUS_ORDER[STATUS_ORDER.indexOf(o.status) + 1];
  if (nextStatus) {
    actions.appendChild(el('button', {
      class: 'advance',
      onclick: (e) => { e.stopPropagation(); advanceOrder(o.id, nextStatus); },
    }, STATUS_NEXT_ACTION[o.status] + ' →'));
  } else {
    actions.appendChild(el('span', { class: 'advance', style: 'background:var(--herb-soft);color:var(--herb);cursor:default;' }, '✓ Delivered'));
  }
  actions.appendChild(el('button', {
    class: 'del',
    title: 'Cancel order',
    onclick: (e) => { e.stopPropagation(); deleteOrder(o.id); },
  }, '✕'));
  card.appendChild(actions);
  return card;
}

async function advanceOrder(id, status) {
  try {
    const updated = await api(`/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const idx = state.orders.findIndex(o => o.id === id);
    if (idx >= 0) state.orders[idx] = updated;
    renderToday();
    toast(`Order <strong>${id}</strong> → ${STATUS_LABEL[status]}`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteOrder(id) {
  if (!confirm(`Cancel order ${id}? This cannot be undone.`)) return;
  try {
    await api(`/orders/${id}`, { method: 'DELETE' });
    state.orders = state.orders.filter(o => o.id !== id);
    renderToday();
    toast(`Order <strong>${id}</strong> cancelled`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------- NEW ORDER view ----------
function renderNewOrder() {
  const view = document.getElementById('view-new');
  view.innerHTML = '';

  view.appendChild(el('header', { class: 'section-head' },
    el('div', {},
      el('div', { class: 'eyebrow' }, 'STEP 1 · CUSTOMER  →  STEP 2 · MEAL  →  STEP 3 · EXTRAS'),
      el('h1', { html: 'Compose a <em>new</em> bento order' }),
    ),
    el('div', { class: 'meta' },
      'Instant dispatch on save',
      el('strong', {}, 'Kitchen picks it up in Prep column'),
    ),
  ));

  const shell = el('div', { class: 'form-shell' });
  const left = el('div', {});
  const right = renderSummary();

  // 1. Customer card
  const step1 = el('div', { class: 'card' });
  step1.appendChild(el('h3', {}, el('span', { class: 'num' }, '1'), 'Customer & delivery'));

  const grid = el('div', { class: 'field-grid' });
  grid.appendChild(field('Existing customer', selectExisting()));
  grid.appendChild(field('Delivery zone', selectZone()));
  grid.appendChild(field('Full name', input('customerName', 'e.g. Kiranmai Reddy')));
  grid.appendChild(field('Phone', input('phone', '+91 98480 12345')));
  grid.appendChild(field('Office / delivery address', input('company', 'Millennium Tower B, IT SEZ'), true));
  grid.appendChild(field('Delivery slot', selectSlot()));
  step1.appendChild(grid);
  left.appendChild(step1);

  // 2. Meal pick
  const step2 = el('div', { class: 'card', style: 'margin-top:16px;' });
  step2.appendChild(el('h3', {}, el('span', { class: 'num' }, '2'), 'Pick the bento'));
  const tp = el('div', { class: 'template-pick' });
  state.templates.forEach(t => {
    const picked = state.draft.templateId === t.id;
    const card = el('button', {
      class: `tpl ${picked ? 'is-picked' : ''}`,
      type: 'button',
      onclick: () => { state.draft.templateId = t.id; state.draft.diet = t.diet; renderNewOrder(); },
    });
    card.appendChild(el('div', { class: 'tpl-name' }, t.name));
    card.appendChild(el('div', { class: 'tpl-desc' }, `${t.baseGrain} · ${t.proteinMain}`));
    card.appendChild(el('div', { class: 'tpl-foot' },
      el('span', { class: 'tpl-price' }, money(t.price)),
      el('span', { class: `tpl-diet ${t.diet === 'veg' ? 'veg' : 'nv'}` }, t.diet === 'veg' ? 'Veg' : 'Non-veg'),
    ));
    tp.appendChild(card);
  });
  step2.appendChild(tp);
  left.appendChild(step2);

  // 3. Addons
  const step3 = el('div', { class: 'card', style: 'margin-top:16px;' });
  step3.appendChild(el('h3', {}, el('span', { class: 'num' }, '3'), 'Add-ons  ',
    el('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--ink-3);letter-spacing:.1em;' }, '(optional)')));
  const al = el('div', { class: 'addons-list' });
  state.addons.forEach(a => {
    const on = state.draft.addons.includes(a.id);
    const row = el('button', {
      class: `addon ${on ? 'on' : ''}`,
      type: 'button',
      onclick: () => {
        if (on) state.draft.addons = state.draft.addons.filter(x => x !== a.id);
        else state.draft.addons = [...state.draft.addons, a.id];
        renderNewOrder();
      },
    });
    row.appendChild(el('span', { class: 'check' }, on ? '✓' : ''));
    row.appendChild(el('div', { class: 'info' },
      el('div', { class: 'n' }, a.name),
      el('div', { class: 'd' }, `${a.portion} · ${a.protein}g protein`),
    ));
    row.appendChild(el('div', { class: 'p' }, money(a.price)));
    al.appendChild(row);
  });
  step3.appendChild(al);
  left.appendChild(step3);

  shell.appendChild(left);
  shell.appendChild(right);
  view.appendChild(shell);
}

function selectExisting() {
  const sel = el('select', {
    id: 'draft-existing',
    onchange: (e) => {
      const cid = e.target.value;
      if (!cid) return;
      const c = state.customers.find(x => x.id === cid);
      if (c) {
        state.draft.customerId = c.id;
        state.draft.customerName = c.name;
        state.draft.phone = c.phone;
        state.draft.company = c.company;
        state.draft.zoneId = c.zoneId;
        state.draft.addons = [...(c.defaultAddons || [])];
        renderNewOrder();
      }
    },
  });
  sel.appendChild(el('option', { value: '' }, '— New walk-in / one-time —'));
  state.customers.forEach(c => {
    const opt = el('option', { value: c.id }, `${c.name} · ${c.company.slice(0, 30)}`);
    if (state.draft.customerId === c.id) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function selectZone() {
  const sel = el('select', {
    onchange: (e) => { state.draft.zoneId = e.target.value; }
  });
  state.zones.forEach(z => {
    const opt = el('option', { value: z.id }, z.name);
    if (state.draft.zoneId === z.id) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function selectSlot() {
  const sel = el('select', {
    onchange: (e) => { state.draft.deliverySlot = e.target.value; }
  });
  ['12:00 PM', '12:30 PM', '1:00 PM', '1:30 PM'].forEach(s => {
    const opt = el('option', { value: s }, s);
    if (state.draft.deliverySlot === s) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

function input(key, placeholder) {
  return el('input', {
    type: 'text',
    placeholder,
    value: state.draft[key] || '',
    oninput: (e) => { state.draft[key] = e.target.value; updateSummary(); },
  });
}

function field(label, inputEl, full = false) {
  const f = el('div', { class: `field ${full ? 'full' : ''}` });
  f.appendChild(el('label', {}, label));
  f.appendChild(inputEl);
  return f;
}

function computeDraftTotals() {
  const tpl = state.templates.find(t => t.id === state.draft.templateId) || state.templates[0];
  let price = tpl.price;
  let cal = tpl.baseCalories, protein = tpl.baseProtein, carbs = tpl.baseCarbs, fats = tpl.baseFats;
  state.draft.addons.forEach(id => {
    const a = state.addons.find(x => x.id === id);
    if (a) { price += a.price; cal += a.calories; protein += a.protein; carbs += a.carbs; fats += a.fats; }
  });
  return { tpl, price, cal, protein, carbs, fats };
}

function renderSummary() {
  const { tpl, price, cal, protein, carbs, fats } = computeDraftTotals();
  const wrap = el('div', {});
  const sum = el('div', { class: 'summary', id: 'summary' });
  sum.appendChild(el('div', { class: 'subhead' }, 'ORDER PREVIEW'));
  sum.appendChild(el('h3', {}, tpl.name));
  sum.appendChild(el('div', { class: 'line' },
    el('span', { class: 'k' }, 'Base meal'),
    el('span', { class: 'v' }, money(tpl.price)),
  ));
  state.draft.addons.forEach(id => {
    const a = state.addons.find(x => x.id === id);
    if (a) {
      sum.appendChild(el('div', { class: 'line' },
        el('span', { class: 'k' }, '+ ' + a.name),
        el('span', { class: 'v' }, money(a.price)),
      ));
    }
  });

  sum.appendChild(el('div', { class: 'macros' },
    macro(cal, 'kcal'), macro(protein + 'g', 'protein'), macro(carbs + 'g', 'carbs'), macro(fats + 'g', 'fats'),
  ));

  sum.appendChild(el('div', { class: 'total' },
    el('span', { class: 'k' }, 'Total'),
    el('span', { class: 'v' }, money(price)),
  ));

  const cta = el('button', {
    class: 'cta',
    onclick: submitOrder,
  }, 'Dispatch to kitchen  →');
  sum.appendChild(cta);

  const err = el('div', { class: 'err', id: 'summary-err', hidden: true });
  sum.appendChild(err);
  wrap.appendChild(sum);
  return wrap;
}

function macro(n, l) {
  return el('div', { class: 'm' }, el('span', { class: 'n' }, n), el('span', { class: 'l' }, l));
}

function updateSummary() {
  const cur = document.getElementById('summary');
  if (!cur) return;
  const newSum = renderSummary();
  cur.parentElement.replaceChild(newSum.firstElementChild, cur);
}

async function submitOrder() {
  const d = state.draft;
  const errBox = document.getElementById('summary-err');
  if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
  if (!d.customerName || !d.phone || !d.company) {
    if (errBox) { errBox.textContent = 'Fill in name, phone, and delivery address.'; errBox.hidden = false; }
    return;
  }
  const tpl = state.templates.find(t => t.id === d.templateId);
  const { price, cal, protein, carbs, fats } = computeDraftTotals();
  const payload = {
    customerName: d.customerName,
    phone: d.phone,
    company: d.company,
    zoneId: d.zoneId,
    templateId: d.templateId,
    diet: tpl.diet,
    addons: d.addons,
    deliverySlot: d.deliverySlot,
    totalPrice: price,
    macros: { cal, protein, carbs, fats },
    customerId: d.customerId,
  };
  try {
    const order = await api('/orders', { method: 'POST', body: JSON.stringify(payload) });
    state.orders.unshift(order);
    toast(`Order <strong>${order.id}</strong> dispatched to kitchen`);
    // Reset draft to a clean slate but keep zone
    state.draft = {
      customerName: '', phone: '', company: '', zoneId: d.zoneId,
      templateId: state.templates[0].id, addons: [],
      deliverySlot: '12:30 PM', customerId: null,
    };
    switchView('today');
    // Highlight the new card
    requestAnimationFrame(() => {
      const card = document.querySelector(`.order[data-id="${order.id}"]`);
      if (card) card.classList.add('new-in');
    });
  } catch (err) {
    if (errBox) { errBox.textContent = err.message; errBox.hidden = false; }
    toast(err.message, 'err');
  }
}

// ---------- CUSTOMERS view ----------
function renderCustomers() {
  const view = document.getElementById('view-customers');
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'section-head' },
    el('div', {},
      el('div', { class: 'eyebrow' }, `${state.customers.length} SUBSCRIBERS · VIZAG`),
      el('h1', { html: 'Meal-pass <em>subscribers</em>' }),
    ),
    el('div', { class: 'meta' },
      state.customers.filter(c => c.status === 'active').length + ' active',
      el('strong', {}, state.customers.filter(c => c.status === 'paused').length + ' paused'),
    ),
  ));

  const toolbar = el('div', { class: 'cust-toolbar' });
  const search = el('div', { class: 'search-box' },
    el('span', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' }),
    el('input', {
      type: 'text',
      id: 'cust-search',
      placeholder: 'Search by name, company, phone…',
      oninput: (e) => { renderCustomerRows(e.target.value); },
    }),
  );
  toolbar.appendChild(search);
  toolbar.appendChild(el('button', {
    class: 'btn btn-primary',
    onclick: openAddCustomerDialog,
  }, '+ Add subscriber'));
  view.appendChild(toolbar);

  const list = el('div', { class: 'cust-list', id: 'cust-list' });
  view.appendChild(list);
  renderCustomerRows('');
}

function renderCustomerRows(query) {
  const list = document.getElementById('cust-list');
  if (!list) return;
  list.innerHTML = '';
  const q = (query || '').toLowerCase();
  const rows = state.customers.filter(c =>
    !q || (c.name.toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || c.id.toLowerCase().includes(q))
  );
  if (!rows.length) {
    list.appendChild(el('div', { class: 'empty' },
      el('h3', {}, 'No matches'),
      el('p', {}, 'Try a different name or phone. All subscribers stay on file — you can un-pause any time.'),
    ));
    return;
  }
  rows.forEach(c => {
    const zone = state.zones.find(z => z.id === c.zoneId);
    const row = el('div', { class: 'cust-row' });
    row.appendChild(el('div', { class: 'avatar' }, initials(c.name)));
    row.appendChild(el('div', { class: 'who' },
      el('div', { class: 'name' }, c.name),
      el('div', { class: 'id' }, `${c.id}  ·  ${c.phone}`),
    ));
    row.appendChild(el('div', { class: 'place' }, `${c.company} · ${zone ? zone.name : ''}`));
    row.appendChild(el('div', { class: 'plan' }, c.plan || ''));
    row.appendChild(el('div', { class: 'stat' },
      money(c.lifetimeSpend || 0),
      el('span', { class: 'sub' }, (c.totalOrders || 0) + ' orders'),
    ));
    row.appendChild(el('div', { class: 'rowbtns' },
      el('span', { class: `status-pill ${c.status}` }, c.status),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        title: 'Open monthly attendance calendar',
        onclick: () => openAttendanceCalendar(c.id),
      }, 'Calendar'),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => togglePause(c.id),
      }, c.status === 'active' ? 'Pause' : 'Resume'),
    ));
    list.appendChild(row);
  });
}

async function togglePause(id) {
  try {
    const updated = await api(`/customers/${id}/pause`, { method: 'PATCH' });
    const idx = state.customers.findIndex(c => c.id === id);
    if (idx >= 0) state.customers[idx] = updated;
    renderCustomerRows(document.getElementById('cust-search')?.value || '');
    toast(`${updated.name} → <strong>${updated.status}</strong>`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function openAddCustomerDialog() {
  const overlay = el('div', {
    style: 'position:fixed;inset:0;background:rgba(28,23,18,.4);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeUp .18s var(--ease);',
    onclick: (e) => { if (e.target === overlay) overlay.remove(); },
  });
  const dlg = el('div', {
    style: 'background:var(--paper);border-radius:14px;padding:28px;max-width:520px;width:100%;border:1px solid var(--rule);box-shadow:0 20px 60px rgba(0,0,0,.15);',
  });
  dlg.appendChild(el('h3', { style: 'font-family:var(--serif);font-weight:400;font-size:26px;margin:0 0 4px;letter-spacing:-.02em;' }, 'Add subscriber'));
  dlg.appendChild(el('p', { style: 'color:var(--ink-3);font-size:13px;margin:0 0 18px;' }, 'Enroll a new lunch-pass subscriber. They\'ll appear in Customers instantly.'));

  const buf = { name: '', phone: '', email: '', company: '', zoneId: state.zones[0]?.id, plan: '20-Day Monthly Power Bento', diet: 'veg' };
  const grid = el('div', { class: 'field-grid' });
  grid.appendChild(field('Full name', el('input', { oninput: (e) => buf.name = e.target.value, placeholder: 'e.g. Priya Menon' }), true));
  grid.appendChild(field('Phone', el('input', { oninput: (e) => buf.phone = e.target.value, placeholder: '+91 98…' })));
  grid.appendChild(field('Email', el('input', { oninput: (e) => buf.email = e.target.value, placeholder: 'name@office.com' })));
  grid.appendChild(field('Office / address', el('input', { oninput: (e) => buf.company = e.target.value, placeholder: 'Company & floor' }), true));

  const zoneSel = el('select', { onchange: (e) => buf.zoneId = e.target.value });
  state.zones.forEach(z => zoneSel.appendChild(el('option', { value: z.id }, z.name)));
  grid.appendChild(field('Delivery zone', zoneSel));

  const dietSel = el('select', { onchange: (e) => buf.diet = e.target.value });
  ['veg', 'nonveg'].forEach(d => dietSel.appendChild(el('option', { value: d }, d === 'veg' ? 'Vegetarian' : 'Non-veg')));
  grid.appendChild(field('Diet', dietSel));

  const planSel = el('select', { onchange: (e) => buf.plan = e.target.value });
  ['20-Day Monthly Power Bento', '5-Day Weekly Corporate Pass', '3-Day Trial Pass', 'Custom'].forEach(p => planSel.appendChild(el('option', { value: p }, p)));
  grid.appendChild(field('Plan', planSel, true));

  dlg.appendChild(grid);

  const err = el('div', { style: 'color:var(--terracotta);font-size:12px;margin-top:12px;', hidden: true });
  dlg.appendChild(err);

  const actions = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:20px;' },
    el('button', { class: 'btn btn-ghost', onclick: () => overlay.remove() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        try {
          const c = await api('/customers', { method: 'POST', body: JSON.stringify(buf) });
          state.customers.unshift(c);
          overlay.remove();
          renderCustomers();
          toast(`Welcome <strong>${c.name}</strong> — enrolled as ${c.id}`);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      },
    }, 'Enroll subscriber'),
  );
  dlg.appendChild(actions);

  overlay.appendChild(dlg);
  document.body.appendChild(overlay);
}

// ---------- ATTENDANCE CALENDAR ----------
// State cycle on click: (empty) → delivered → skipped → (empty)
// Backend enforces "no future days marked delivered".
const NEXT_STATE = { null: 'delivered', delivered: 'skipped', skipped: null };
const MARK = { delivered: '✓', skipped: '—' };

// Track which month is being viewed per-customer modal invocation.
let calCtx = null; // { customerId, year, month }

function openAttendanceCalendar(customerId) {
  const now = new Date();
  calCtx = { customerId, year: now.getFullYear(), month: now.getMonth() };

  const overlay = el('div', {
    class: 'modal-overlay',
    id: 'attn-overlay',
    onclick: (e) => { if (e.target === overlay) closeAttendance(); },
  });
  const modal = el('div', { class: 'modal wide' });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Keyboard: Esc to close, ←/→ to change month
  document.addEventListener('keydown', attnKeyHandler);

  renderAttendance();
}

function closeAttendance() {
  const overlay = document.getElementById('attn-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', attnKeyHandler);
  calCtx = null;
}

function attnKeyHandler(e) {
  if (!calCtx) return;
  if (e.key === 'Escape') { e.preventDefault(); closeAttendance(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); shiftMonth(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); shiftMonth(1); }
}

function shiftMonth(delta) {
  const d = new Date(calCtx.year, calCtx.month + delta, 1);
  // Don't let people navigate past next month or before customer signup (arbitrary: 12 months back)
  const today = new Date();
  const maxAhead = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const minBehind = new Date(today.getFullYear(), today.getMonth() - 12, 1);
  if (d > maxAhead || d < minBehind) return;
  calCtx.year = d.getFullYear();
  calCtx.month = d.getMonth();
  renderAttendance();
}

function renderAttendance() {
  const overlay = document.getElementById('attn-overlay');
  if (!overlay) return;
  const modal = overlay.querySelector('.modal');
  modal.innerHTML = '';

  const cust = state.customers.find(c => c.id === calCtx.customerId);
  if (!cust) return;
  const deliveries = cust.deliveries || {};

  // Header
  const head = el('div', { class: 'attn-head' });
  head.appendChild(el('div', { class: 'who' },
    el('div', { class: 'avatar' }, initials(cust.name)),
    el('div', {},
      el('h3', { class: 'name' }, cust.name),
      el('div', { class: 'sub' }, `${cust.id} · ${cust.plan || 'no plan'}`),
    ),
  ));
  head.appendChild(el('button', { class: 'attn-close', 'aria-label': 'Close', onclick: closeAttendance }, '✕'));
  modal.appendChild(head);

  // Month navigator
  const monthName = new Date(calCtx.year, calCtx.month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const today = new Date();
  const nextMonth = new Date(calCtx.year, calCtx.month + 1, 1);
  const nextAllowed = nextMonth <= new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const prevMonth = new Date(calCtx.year, calCtx.month - 1, 1);
  const prevAllowed = prevMonth >= new Date(today.getFullYear(), today.getMonth() - 12, 1);

  const bar = el('div', { class: 'attn-month-bar' });
  bar.appendChild(el('button', {
    onclick: () => shiftMonth(-1),
    disabled: !prevAllowed,
    'aria-label': 'Previous month',
  }, el('span', { html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>' })));

  const [monWord, yearWord] = monthName.split(' ');
  bar.appendChild(el('h4', {},
    monWord + ' ',
    el('em', {}, yearWord),
  ));

  bar.appendChild(el('button', {
    onclick: () => shiftMonth(1),
    disabled: !nextAllowed,
    'aria-label': 'Next month',
  }, el('span', { html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>' })));
  modal.appendChild(bar);

  // Compute tally for this month
  const monthKey = `${calCtx.year}-${String(calCtx.month + 1).padStart(2, '0')}`;
  let delivered = 0, skipped = 0, pending = 0;
  const monthDays = new Date(calCtx.year, calCtx.month + 1, 0).getDate();
  const todayStr = today.toISOString().slice(0, 10);
  for (let d = 1; d <= monthDays; d++) {
    const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
    const dow = new Date(calCtx.year, calCtx.month, d).getDay();
    if (dow === 0 || dow === 6) continue; // don't count weekends
    if (iso > todayStr) continue;
    const s = deliveries[iso];
    if (s === 'delivered') delivered++;
    else if (s === 'skipped') skipped++;
    else pending++;
  }

  const tally = el('div', { class: 'attn-tally' });
  tally.appendChild(el('span', { class: 'chip delivered' }, `${delivered} delivered`));
  tally.appendChild(el('span', { class: 'chip skipped' }, `${skipped} skipped`));
  if (pending) tally.appendChild(el('span', { class: 'chip pending' }, `${pending} unmarked`));
  modal.appendChild(tally);

  // Day-of-week header row (Mon-Sun for Indian working week)
  const dowNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const dowRow = el('div', { class: 'dow-row' });
  dowNames.forEach((n, i) => {
    dowRow.appendChild(el('div', { class: `dow ${i >= 5 ? 'wknd' : ''}` }, n));
  });
  modal.appendChild(dowRow);

  // Calendar grid
  const grid = el('div', { class: 'cal-grid' });

  // Figure out leading blank cells (Monday-first: getDay Sun=0, Mon=1, so offset = (dow + 6) % 7)
  const firstDow = new Date(calCtx.year, calCtx.month, 1).getDay();
  const leading = (firstDow + 6) % 7;
  for (let i = 0; i < leading; i++) grid.appendChild(el('div', { class: 'day blank' }));

  for (let d = 1; d <= monthDays; d++) {
    const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
    const dowN = new Date(calCtx.year, calCtx.month, d).getDay();
    const isWknd = dowN === 0 || dowN === 6;
    const isFuture = iso > todayStr;
    const isToday = iso === todayStr;
    const s = deliveries[iso] || null;

    const classes = ['day'];
    if (s) classes.push(s);
    if (isWknd) classes.push('wknd');
    if (isFuture) classes.push('future');
    if (isToday) classes.push('today');

    const cell = el('button', {
      class: classes.join(' '),
      type: 'button',
      title: isFuture ? `${iso} (future — can't mark)` :
             isWknd ? `${iso} (weekend — no delivery)` :
             `${iso} — click to cycle: pending → delivered → skipped`,
      'aria-label': `${iso} ${s || 'unmarked'}`,
      disabled: isFuture,
      onclick: (e) => { e.stopPropagation(); if (!isFuture) cycleDay(iso); },
    });
    cell.appendChild(el('span', { class: 'num' }, String(d)));
    cell.appendChild(el('span', { class: 'mark' }, s ? MARK[s] : ''));
    grid.appendChild(cell);
  }
  modal.appendChild(grid);

  modal.appendChild(el('div', { class: 'attn-hint' },
    'Click a day to cycle ',
    el('kbd', {}, '✓ delivered'), ' → ',
    el('kbd', {}, '— skipped'), ' → ',
    el('kbd', {}, 'clear'),
    '. Use ',
    el('kbd', {}, '←'), ' ', el('kbd', {}, '→'),
    ' to switch months, ',
    el('kbd', {}, 'Esc'), ' to close.',
  ));
}

async function cycleDay(iso) {
  const cust = state.customers.find(c => c.id === calCtx.customerId);
  if (!cust) return;
  if (!cust.deliveries) cust.deliveries = {};
  const current = cust.deliveries[iso] || null;
  const next = NEXT_STATE[current];

  try {
    const updated = await api(`/customers/${cust.id}/deliveries/${iso}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    const idx = state.customers.findIndex(c => c.id === cust.id);
    if (idx >= 0) state.customers[idx] = updated;
    renderAttendance();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------- KITCHEN view ----------
function renderKitchen() {
  const view = document.getElementById('view-kitchen');
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'section-head' },
    el('div', {},
      el('div', { class: 'eyebrow' }, 'CENTRAL PREP KITCHEN · SIRIPURAM'),
      el('h1', { html: 'Kitchen <em>mise-en-place</em>' }),
    ),
    el('div', { class: 'meta' },
      state.kitchenChecklist.filter(x => x.done).length + '/' + state.kitchenChecklist.length + ' complete',
      el('strong', {}, 'Shift 1 · 09:00–13:30'),
    ),
  ));

  const grid = el('div', { class: 'kitchen-grid' });

  // Left: tally card
  const tallyCard = el('div', { class: 'card' });
  tallyCard.appendChild(el('h3', {}, el('span', { class: 'num' }, 'Σ'), 'Portions to prep today'));
  const t = computeKitchenTally();
  const tg = el('div', { class: 'tally-grid' });
  tg.appendChild(tallyCell('Veg bentos', t.vegBentos, 'boxes'));
  tg.appendChild(tallyCell('Non-veg bentos', t.nonVegBentos, 'boxes'));
  tg.appendChild(tallyCell('Boiled eggs', t.eggPortions, 'pieces'));
  tg.appendChild(tallyCell('Pepper chicken', t.chickenPortions, 'portions'));
  tg.appendChild(tallyCell('Malai paneer', t.paneerPortions, 'portions'));
  tg.appendChild(tallyCell('Buttermilk', t.buttermilkPortions, 'bottles'));
  tallyCard.appendChild(tg);
  grid.appendChild(tallyCard);

  // Right: checklist
  const checkCard = el('div', { class: 'card' });
  checkCard.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;' },
    el('h3', { style: 'margin:0;' }, el('span', { class: 'num' }, '✓'), 'Prep checklist'),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: async () => {
        if (!confirm('Reset all checklist items for the next shift?')) return;
        await api('/kitchen/checklist/reset', { method: 'POST' });
        state.kitchenChecklist.forEach(x => x.done = false);
        renderKitchen();
        toast('Checklist reset for next shift');
      },
    }, 'Reset for shift'),
  ));

  const cl = el('div', { class: 'checklist' });
  state.kitchenChecklist.forEach(item => {
    const row = el('div', {
      class: `check-row ${item.done ? 'done' : ''}`,
      onclick: () => toggleCheck(item.id),
    });
    row.appendChild(el('span', { class: 'box' }, item.done ? '✓' : ''));
    row.appendChild(el('div', { class: 'text' }, item.task));
    cl.appendChild(row);
  });
  checkCard.appendChild(cl);
  grid.appendChild(checkCard);

  view.appendChild(grid);
}

function tallyCell(l, n, u) {
  return el('div', { class: 'tally' },
    el('div', { class: 'l' }, l),
    el('div', { class: 'n' }, String(n)),
    el('div', { class: 'u' }, u),
  );
}

function computeKitchenTally() {
  const t = { vegBentos: 0, nonVegBentos: 0, eggPortions: 0, chickenPortions: 0, paneerPortions: 0, buttermilkPortions: 0, rotiPairs: 0 };
  state.orders.forEach(o => {
    if (o.diet === 'veg') t.vegBentos++; else t.nonVegBentos++;
    (o.addons || []).forEach(id => {
      if (id === 'addon_eggs') t.eggPortions += 2;
      if (id === 'addon_chicken') t.chickenPortions++;
      if (id === 'addon_paneer') t.paneerPortions++;
      if (id === 'addon_buttermilk') t.buttermilkPortions++;
      if (id === 'addon_rotis') t.rotiPairs++;
    });
  });
  return t;
}

async function toggleCheck(id) {
  const item = state.kitchenChecklist.find(x => x.id === id);
  if (!item) return;
  const newDone = !item.done;
  try {
    await api('/kitchen/checklist', { method: 'PATCH', body: JSON.stringify({ id, done: newDone }) });
    item.done = newDone;
    renderKitchen();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- Nav counts ----------
function updateNavCounts() {
  const nCust = document.querySelector('[data-view="customers"] .count');
  if (nCust) nCust.textContent = state.customers.length;
  const nOrd = document.querySelector('[data-view="today"] .count');
  if (nOrd) nOrd.textContent = state.orders.filter(o => o.status !== 'delivered').length;
}

// ---------- Boot ----------
async function boot() {
  // Wire up nav
  document.querySelectorAll('.nav-tabs .tab').forEach(t => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });
  // Global keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape' && state.selected.size) {
      clearSelection();
      return;
    }
    const map = { '1': 'today', '2': 'new', '3': 'customers', '4': 'kitchen' };
    if (map[e.key]) {
      e.preventDefault();
      switchView(map[e.key]);
    }
  });
  // Reset db button
  document.getElementById('btn-reset')?.addEventListener('click', async () => {
    if (!confirm('Reset all demo data back to seed state?')) return;
    try {
      await api('/reset', { method: 'POST' });
      await loadState();
      updateNavCounts();
      switchView('today');
      toast('Demo data restored to seed');
    } catch (e) { toast(e.message, 'err'); }
  });
  // Quick add order
  document.getElementById('btn-new')?.addEventListener('click', () => switchView('new'));

  try {
    await loadState();
    updateNavCounts();
    document.getElementById('boot-loading')?.remove();
    switchView('today');
  } catch (err) {
    document.getElementById('boot-loading').innerHTML = `
      <div style="max-width:400px;text-align:center;">
        <div style="font-family:var(--serif);font-size:28px;color:var(--ink);margin-bottom:8px;">Kitchen unreachable</div>
        <div style="color:var(--ink-3);font-size:14px;margin-bottom:20px;">${err.message}</div>
        <button class="btn btn-primary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
