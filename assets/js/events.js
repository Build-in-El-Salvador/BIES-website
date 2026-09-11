/* events.js — the Events page (events.html). Vanilla JS, no libraries.
 *
 * Reads /api/events (built by src/worker.js from pretix, the single source of
 * event data), renders a Luma-style timeline of upcoming and past events, and
 * opens a detail popup per event. Tickets are bought on the ticket site: the
 * popup's button links to the event's page on tickets.buildinelsalvador.com.
 * This page sets no cookies and loads no third-party scripts.
 */
(() => {
  'use strict';

  const API = document.body.dataset.eventsSrc || '/api/events';
  const SAMPLE = '/assets/data/events.sample.json'; // only tried when previewing on localhost
  const HOME_TZ = 'America/El_Salvador';
  const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
  const PAGE_URL = location.origin + location.pathname.replace(/\.html$/, '');
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const VIEWER_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
  })();

  const ICON = {
    pin: '<path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    google: '<path d="M12 5v14M5 12h14"/>',
    share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 13v5.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V13"/>',
  };

  const bySlug = new Map();
  const dialog = document.getElementById('ev-dialog');
  const $ = (id) => document.getElementById(id);
  const baseTitle = document.title;
  let opener = null;
  let closingFromHistory = false;

  // ---------- tiny DOM helpers (all text goes in via textContent) ----------
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  }
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.innerHTML = ICON[name]; // static markup from this file only
    return s;
  }

  // ---------- dates (always shown in the event's own time zone) ----------
  const toDate = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d; };
  const tzOf = (ev) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: ev.timezone }); return ev.timezone; } catch (_) { return HOME_TZ; }
  };
  const fmt = (d, tz, opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)).format(d);
  const TIME = { hour: 'numeric', minute: '2-digit' };
  const dayKey = (d, tz) => fmt(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  function isoDay(d, tz) { const [m, dd, y] = dayKey(d, tz).split('/'); return `${y}-${m}-${dd}`; }
  function offsetLabel(d, tz) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(d).find((x) => x.type === 'timeZoneName');
      return p ? p.value : '';
    } catch (_) { return ''; }
  }
  function timeRange(ev, tz) {
    const s = toDate(ev.start);
    if (!s) return '';
    const e = toDate(ev.end);
    let a = fmt(s, tz, TIME);
    if (!e) return a;
    let b = fmt(e, tz, TIME);
    if (dayKey(s, tz) !== dayKey(e, tz)) b = `${fmt(e, tz, { weekday: 'short', month: 'short', day: 'numeric' })}, ${b}`;
    else if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -3); // "5:00 – 11:00 PM", as Luma writes it
    return `${a} – ${b}`;
  }
  const zoneName = (tz) => (tz === HOME_TZ ? 'El Salvador time' : `${tz.split('/').pop().replace(/_/g, ' ')} time`);
  function isLive(ev) {
    const s = toDate(ev.start), e = toDate(ev.end), now = Date.now();
    return Boolean(s && e && s.getTime() <= now && now < e.getTime());
  }

  // ---------- prices ----------
  function money(value, currency) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: currency || 'USD',
        minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
      }).format(n);
    } catch (_) { return `${n.toFixed(2)} ${currency || ''}`.trim(); }
  }
  const isFree = (ev) => ev.tickets.length > 0 && ev.tickets.every((t) => Number(t.price) === 0 && !t.free_price);
  function priceLabel(ev) {
    if (!ev.tickets.length || ev.price_from == null) return '';
    if (isFree(ev)) return 'Free';
    const lo = money(ev.price_from, ev.currency), hi = money(ev.price_to, ev.currency);
    return lo === hi ? lo : `From ${lo}`;
  }

  // ---------- status chips (card + popup kicker) ----------
  function chips(ev) {
    if (ev.status === 'cancelled') return [['Cancelled', 'out']];
    if (ev.is_past) return [['Past event', 'past']];
    const out = [];
    if (ev.status === 'postponed') out.push(['Postponed', 'out']);
    if (isLive(ev)) out.push(['Happening now', 'live']);
    const price = priceLabel(ev);
    if (price) out.push([price, price === 'Free' ? 'free' : 'price']);
    // The shop data (ev.sales) is fresher than the organizer list's reason, so it decides
    // whenever it has an answer; the list's reason only fills in when it does not.
    const r = ev.availability && ev.availability.reason;
    if (ev.sales === 'sold_out' || ev.sales === 'reserved') {
      if (ev.waiting_list) out.push(['Waiting list open', 'wait']);
      else if (ev.sales === 'reserved') out.push(['Almost sold out', 'low']); // the rest sit in carts
      else out.push(['Sold out', 'out']);
    } else if (ev.sales === 'closed') out.push(r === 'soon' ? ['Tickets soon', 'soon'] : ['Sales closed', 'out']);
    else if (ev.sales === 'open') { if (r === 'low') out.push(['Few left', 'low']); }
    else if (r === 'waitinglist') out.push(['Waiting list open', 'wait']);
    else if (r === 'reserved') out.push(['Almost sold out', 'low']);
    else if (r === 'full') out.push(['Sold out', 'out']);
    else if (r === 'low') out.push(['Few left', 'low']);
    else if (r === 'soon') out.push(['Tickets soon', 'soon']);
    else if (r === 'over') out.push(['Sales closed', 'out']);
    return out;
  }
  const chipEl = ([label, kind]) => h('span', { class: `ev-chip ev-chip-${kind}`, text: label });

  // ---------- sanitising pretix HTML (defence in depth; pretix already cleans it) ----------
  const KEEP = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'A', 'UL', 'OL', 'LI', 'HR', 'BLOCKQUOTE',
    'CODE', 'PRE', 'SPAN', 'SMALL', 'SUB', 'SUP', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'H4', 'H5']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'FORM', 'INPUT',
    'BUTTON', 'TEXTAREA', 'SELECT', 'IMG', 'VIDEO', 'AUDIO', 'SVG', 'MATH', 'LINK', 'META', 'BASE']);
  const HEADING = { H1: 'H4', H2: 'H4', H3: 'H4', H4: 'H5', H5: 'H5', H6: 'H5' }; // stay below the popup's h2/h3
  function cleanTree(node, doc) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) { child.remove(); continue; } // comments
      if (child.nodeType !== 1) continue;
      let tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) { child.remove(); continue; }
      let el = child;
      if (HEADING[tag] && HEADING[tag] !== tag) {
        el = doc.createElement(HEADING[tag]);
        while (child.firstChild) el.appendChild(child.firstChild);
        child.replaceWith(el);
        tag = el.tagName;
      }
      if (!KEEP.has(tag)) { cleanTree(el, doc); el.replaceWith(...Array.from(el.childNodes)); continue; }
      const href = tag === 'A' ? el.getAttribute('href') : null;
      for (const a of Array.from(el.attributes)) {
        if (!((tag === 'TD' || tag === 'TH') && (a.name === 'colspan' || a.name === 'rowspan'))) el.removeAttribute(a.name);
      }
      if (tag === 'A') {
        if (href && /^(https?:|mailto:|tel:)/i.test(href.trim())) {
          el.setAttribute('href', href.trim());
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
        }
      }
      cleanTree(el, doc);
    }
  }
  // pretix turns every newline in its Markdown into <br>, so text pasted with hard wraps
  // breaks mid-sentence. A break in the middle of a long sentence is a wrap and becomes a
  // space. A break after a short line (an address, a schedule) or after a finished
  // sentence (one line per point) is deliberate and stays.
  const WRAP_MIN = 60;
  const SENTENCE_END = /[.!?:;…]["'”’)\]]*$/;
  function unwrapLines(root) {
    const lineText = (n, step) => {
      let s = '';
      for (; n && n.nodeName !== 'BR'; n = n[step]) s = step === 'previousSibling' ? n.textContent + s : s + n.textContent;
      return s.trim();
    };
    const wraps = Array.from(root.querySelectorAll('br')).filter((br) => {
      const before = lineText(br.previousSibling, 'previousSibling');
      return before.length >= WRAP_MIN && !SENTENCE_END.test(before) && lineText(br.nextSibling, 'nextSibling');
    });
    for (const br of wraps) br.replaceWith(' ');
  }
  function richHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const root = doc.body && doc.body.firstElementChild;
    if (!root) return document.createDocumentFragment(); // e.g. a bare <frameset> swallowed the wrapper
    cleanTree(root, doc);
    unwrapLines(root);
    for (const p of Array.from(root.querySelectorAll('p'))) if (!p.textContent.trim() && !p.querySelector('br')) p.remove();
    while (root.firstElementChild && root.firstElementChild.tagName === 'HR') root.firstElementChild.remove();
    let last; // drop a trailing rule or a heading with nothing under it (e.g. an unfinished "Getting there")
    while ((last = root.lastElementChild) && /^(H4|H5|HR)$/.test(last.tagName)) last.remove();
    const frag = document.createDocumentFragment();
    frag.append(...Array.from(root.childNodes));
    return frag;
  }
  const hasText = (html) => Boolean(richHtml(html).textContent.trim());

  // ---------- cover (the event's "Social media image" in pretix, or a branded placeholder) ----------
  function placeholder(ev) {
    const s = toDate(ev.start), tz = tzOf(ev);
    const when = s ? `${fmt(s, tz, { month: 'short' })} ${fmt(s, tz, { day: 'numeric' })}` : 'BIES';
    return h('div', { class: 'ev-ph', 'aria-hidden': 'true' }, h('small', { text: 'BIES' }), h('b', { text: when }));
  }
  function cover(ev, eager) {
    if (!ev.cover) return placeholder(ev);
    const img = h('img', {
      src: ev.cover, alt: '', width: 1200, height: 630, decoding: 'async', loading: eager ? 'eager' : 'lazy',
    });
    img.addEventListener('error', () => img.replaceWith(placeholder(ev)), { once: true });
    return img;
  }

  // ---------- list ----------
  function groupByDay(events) {
    const groups = [];
    for (const ev of events) {
      const s = toDate(ev.start), tz = tzOf(ev);
      const key = s ? `${tz}|${dayKey(s, tz)}` : `tba|${ev.slug}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.events.push(ev);
      else groups.push({ key, date: s, tz, events: [ev] });
    }
    return groups;
  }

  function rail(group) {
    if (!group.date) return h('div', { class: 'ev-rail' }, h('time', null, h('span', { class: 'ev-rail-m', text: 'Date TBA' })));
    const { date, tz } = group;
    const thisYear = fmt(new Date(), tz, { year: 'numeric' }) === fmt(date, tz, { year: 'numeric' });
    const label = fmt(date, tz, thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    return h('div', { class: 'ev-rail' },
      h('time', { datetime: isoDay(date, tz) },
        h('span', { class: 'ev-rail-m', text: label }),
        h('span', { class: 'ev-rail-d', text: fmt(date, tz, { weekday: 'long' }) })));
  }

  function card(ev) {
    const tz = tzOf(ev), s = toDate(ev.start);
    const time = h('p', { class: 'ev-card-time' });
    if (s) time.append(timeRange(ev, tz), ' ', h('span', { class: 'ev-tz', text: offsetLabel(s, tz) }));
    else time.append(ev.date_range || 'Date to be announced');

    const link = h('a', { class: 'ev-card-link', href: `#${ev.slug}`, 'data-slug': ev.slug, 'aria-haspopup': 'dialog' },
      h('div', { class: 'ev-card-body' },
        time,
        h('h3', { class: 'ev-card-title', text: ev.title }),
        ev.location && h('p', { class: 'ev-card-meta' }, icon('pin'), h('span', { text: ev.location })),
        h('p', { class: 'ev-card-meta' },
          h('img', { src: '/favicon-192x192.png', alt: '', width: 18, height: 18 }),
          h('span', { text: `By ${ev.host}` })),
        h('div', { class: 'ev-card-tags' }, chips(ev).map(chipEl))),
      h('div', { class: 'ev-card-cover' }, cover(ev, false)));

    if (typeof dialog.showModal !== 'function') { // very old browsers: go straight to the ticket site
      link.href = ev.tickets_url;
      link.target = '_blank';
      link.rel = 'noopener';
    }
    return h('article', { class: 'ev-card' }, link);
  }

  function renderList(listEl, events, isPast) {
    listEl.replaceChildren(...groupByDay(events).map((g, i) => {
      const li = h('li', { class: `ev-day${isPast ? ' is-past' : ''}`, style: `--i:${i}` },
        rail(g), h('div', { class: 'ev-day-cards' }, g.events.map(card)));
      return li;
    }));
    listEl.removeAttribute('aria-busy');
  }

  // ---------- popup ----------
  function kicker(ev) {
    if (ev.status === 'cancelled') return 'Cancelled';
    if (ev.status === 'postponed') return 'Postponed';
    if (ev.is_past) return 'Past event';
    if (isLive(ev)) return 'Happening now';
    return 'Upcoming event';
  }

  function splitLocation(loc) {
    const i = loc.indexOf(',');
    return i > 0 ? [loc.slice(0, i).trim(), loc.slice(i + 1).trim()] : [loc, ''];
  }

  function gcalUrl(ev) {
    const s = toDate(ev.start);
    if (!s) return null;
    const e = toDate(ev.end) || new Date(s.getTime() + 2 * 3600e3);
    const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return `https://calendar.google.com/calendar/render?${new URLSearchParams({
      action: 'TEMPLATE', text: ev.title, dates: `${stamp(s)}/${stamp(e)}`, ctz: tzOf(ev),
      location: ev.location || '', details: `Details and tickets: ${PAGE_URL}#${ev.slug}`,
    })}`;
  }

  function fillWhen(ev) {
    const tz = tzOf(ev), s = toDate(ev.start);
    const cal = $('ev-d-cal'), date = $('ev-d-date'), time = $('ev-d-time'), yours = $('ev-d-yourtime');
    yours.hidden = true;
    if (!s) {
      cal.replaceChildren(h('small', { text: 'Date' }), h('b', { text: '?' }));
      date.textContent = ev.date_range || 'Date to be announced';
      time.textContent = '';
      return;
    }
    cal.replaceChildren(h('small', { text: fmt(s, tz, { month: 'short' }) }), h('b', { text: fmt(s, tz, { day: 'numeric' }) }));
    date.textContent = fmt(s, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    time.textContent = `${timeRange(ev, tz)} · ${zoneName(tz)} (${offsetLabel(s, tz)})`;
    if (VIEWER_TZ && offsetLabel(s, VIEWER_TZ) !== offsetLabel(s, tz)) {
      yours.textContent = `Your time: ${fmt(s, VIEWER_TZ, { weekday: 'short', month: 'short', day: 'numeric' })}, ${timeRange(ev, VIEWER_TZ)} (${offsetLabel(s, VIEWER_TZ)})`;
      yours.hidden = false;
    }
  }

  function fillWhere(ev) {
    const where = $('ev-d-where');
    where.hidden = !ev.location;
    if (!ev.location) return;
    const [venue, area] = splitLocation(ev.location);
    $('ev-d-venue').textContent = venue;
    $('ev-d-area').textContent = area;
    $('ev-d-area').hidden = !area;
    const map = $('ev-d-map');
    map.hidden = !ev.map_url;
    if (ev.map_url) map.href = ev.map_url;
  }

  function fillActions(ev) {
    const box = $('ev-d-actions');
    box.replaceChildren();
    if (!ev.is_past && ev.status !== 'cancelled' && toDate(ev.start)) {
      box.append(h('a', { class: 'ev-mini', href: ev.ics_url, rel: 'nofollow' }, icon('cal'), 'Add to calendar'));
      const g = gcalUrl(ev);
      if (g) box.append(h('a', { class: 'ev-mini', href: g, target: '_blank', rel: 'noopener' }, icon('google'), 'Google Calendar'));
    }
    const shareBtn = h('button', { class: 'ev-mini', type: 'button' }, icon('share'), h('span', { text: 'Share' }));
    shareBtn.addEventListener('click', () => share(ev, shareBtn));
    box.append(shareBtn);
  }

  function fillTickets(ev) {
    const list = $('ev-d-ticket-list'), note = $('ev-d-sales-note'), get = $('ev-d-get'), foot = $('ev-d-foot');
    list.replaceChildren();
    note.hidden = true;
    get.hidden = false;
    get.className = 'btn btn-orange ev-get';
    get.href = ev.tickets_url;
    foot.hidden = false;
    const say = (msg) => { note.textContent = msg; note.hidden = false; };

    if (ev.status === 'cancelled' || ev.is_past) {
      list.hidden = true;
      get.hidden = true;
      say(ev.status === 'cancelled' ? 'This event has been cancelled.' : 'This event has ended.');
      foot.replaceChildren('Hear about the next one first: ',
        h('a', { href: 'https://buildinelsalvador.substack.com/', target: '_blank', rel: 'noopener', text: 'join our newsletter' }), '.');
      return;
    }

    list.hidden = !ev.tickets.length;
    for (const t of ev.tickets) {
      const price = Number(t.price) === 0 && !t.free_price ? 'Free' : `${t.price_varies || t.free_price ? 'From ' : ''}${money(t.price, ev.currency)}`;
      const row = h('li', { class: `ev-ticket${t.available ? '' : ' is-out'}` },
        h('div', { class: 'ev-ticket-top' }, h('span', { class: 'ev-ticket-name', text: t.name }), h('span', { class: 'ev-ticket-price', text: price })));
      if (hasText(t.description_html)) row.append(h('div', { class: 'ev-ticket-desc' }, richHtml(t.description_html)));
      const state = t.reserved ? 'In carts' : t.not_on_sale === 'soon' ? 'Not on sale yet' : t.not_on_sale ? 'No longer on sale' : 'Sold out';
      if (!t.available) row.append(h('span', { class: 'ev-ticket-state', text: state }));
      else if (Number.isFinite(t.left) && t.left <= 10) row.append(h('span', { class: 'ev-ticket-state', text: `${t.left} left` }));
      list.append(row);
    }

    if (ev.sales === 'closed') {
      say(ev.sales_note || 'Ticket sales for this event are closed.');
      get.textContent = 'View on ticket site';
      get.className = 'btn btn-ghost ev-get';
    } else if (ev.sales === 'reserved') {
      say(ev.waiting_list
        ? 'The last tickets are sitting in carts right now. Join the waiting list and you will be emailed if one frees up.'
        : 'The last tickets are sitting in carts right now. Unpaid carts are released, so check back shortly.');
      get.textContent = ev.waiting_list ? 'Join the waiting list' : 'Check the ticket site';
    } else if (ev.sales === 'sold_out') {
      say(ev.waiting_list ? 'Sold out. Join the waiting list and you will be emailed if a spot opens up.' : 'This event is sold out.');
      get.textContent = ev.waiting_list ? 'Join the waiting list' : 'View on ticket site';
      if (!ev.waiting_list) get.className = 'btn btn-ghost ev-get';
    } else if (ev.sales === 'none') {
      get.textContent = 'View on ticket site';
      get.className = 'btn btn-ghost ev-get';
    } else {
      get.textContent = isFree(ev) ? 'Register' : 'Get tickets';
    }
    foot.replaceChildren('You complete your order on our ticket site, ',
      h('a', { href: ev.tickets_url, target: '_blank', rel: 'noopener', text: 'tickets.buildinelsalvador.com' }), '.');
  }

  function fill(ev) {
    $('ev-d-cover').replaceChildren(cover(ev, true));
    $('ev-d-kicker').textContent = kicker(ev);
    $('ev-d-title').textContent = ev.title;
    $('ev-d-host').textContent = ev.host;
    fillWhen(ev);
    fillWhere(ev);
    fillActions(ev);
    fillTickets(ev);
    const about = $('ev-d-about');
    const frag = richHtml(ev.description_html);
    about.replaceChildren(frag);
    $('ev-d-about-wrap').hidden = !about.textContent.trim();
  }

  function openEvent(slug, push) {
    const ev = bySlug.get(slug);
    if (!ev || typeof dialog.showModal !== 'function') return false;
    fill(ev);
    if (push) history.pushState({ evSlug: slug }, '', `#${slug}`);
    if (!dialog.open) {
      opener = document.activeElement;
      dialog.showModal();
      document.documentElement.classList.add('ev-lock');
    }
    dialog.querySelector('.ev-d-inner').scrollTop = 0;
    $('ev-d-title').focus({ preventScroll: true });
    document.title = `${ev.title} | Events | Build in El Salvador`;
    return true;
  }

  function hashSlug() {
    let raw = '';
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch (_) { return null; }
    return SLUG_RE.test(raw) ? raw : null;
  }

  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('ev-lock');
    document.title = baseTitle;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
    if (closingFromHistory) { closingFromHistory = false; return; }
    if (history.state && history.state.evSlug) history.back();
    else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop click
  window.addEventListener('popstate', () => {
    const slug = hashSlug();
    if (slug && bySlug.has(slug)) openEvent(slug, false);
    else if (dialog.open) { closingFromHistory = true; dialog.close(); }
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('a.ev-card-link[data-slug]');
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (openEvent(link.dataset.slug, true)) e.preventDefault();
  });

  async function share(ev, btn) {
    const url = `${PAGE_URL}#${ev.slug}`;
    if (navigator.share) {
      try { await navigator.share({ title: ev.title, url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const label = btn.querySelector('span');
    try {
      await navigator.clipboard.writeText(url);
      label.textContent = 'Link copied';
      $('ev-status').textContent = 'Link copied to clipboard';
      setTimeout(() => { label.textContent = 'Share'; }, 2200);
    } catch (_) {
      window.prompt('Copy this link:', url);
    }
  }

  // ---------- structured data for search engines (upcoming events only) ----------
  function jsonLd(events) {
    const nodes = events.filter((ev) => toDate(ev.start)).map((ev) => {
      const node = {
        '@type': 'Event',
        name: ev.title,
        startDate: ev.start,
        eventStatus: `https://schema.org/${ev.status === 'cancelled' ? 'EventCancelled' : ev.status === 'postponed' ? 'EventPostponed' : 'EventScheduled'}`,
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        url: `${PAGE_URL}#${ev.slug}`,
        organizer: { '@type': 'Organization', name: 'Build in El Salvador', url: 'https://buildinelsalvador.com/' },
      };
      if (ev.end) node.endDate = ev.end;
      if (ev.location) {
        node.location = { '@type': 'Place', name: splitLocation(ev.location)[0], address: { '@type': 'PostalAddress', streetAddress: ev.location, addressCountry: 'SV' } };
        if (ev.geo) node.location.geo = { '@type': 'GeoCoordinates', latitude: ev.geo.lat, longitude: ev.geo.lon };
      }
      if (ev.cover) node.image = [ev.cover];
      const about = richHtml(ev.description_html).textContent.replace(/\s+/g, ' ').trim();
      if (about) node.description = about.slice(0, 300);
      if (ev.tickets.length) {
        const soon = ev.availability && ev.availability.reason === 'soon';
        const state = (t) => (ev.sales === 'closed' ? (soon ? 'PreSale' : 'SoldOut')
          : t.available ? 'InStock' : t.reserved ? 'LimitedAvailability' : t.not_on_sale === 'soon' ? 'PreSale' : 'SoldOut');
        node.offers = ev.tickets.map((t) => ({
          '@type': 'Offer', name: t.name, price: t.price, priceCurrency: ev.currency, url: ev.tickets_url,
          availability: `https://schema.org/${state(t)}`,
        }));
      }
      return node;
    });
    if (!nodes.length) return;
    const tag = h('script', { type: 'application/ld+json' });
    tag.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes });
    document.head.append(tag);
  }

  // ---------- load ----------
  async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok || !data || !Array.isArray(data.upcoming)) throw new Error(`events: ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function normalise(ev) {
    ev.tickets = Array.isArray(ev.tickets) ? ev.tickets : [];
    ev.host = ev.host || 'Build in El Salvador';
    ev.title = ev.title || 'BIES event';
    return ev;
  }

  async function load() {
    let data = null;
    try { data = await getJson(API); } catch (err) {
      if (IS_LOCAL) {
        try { data = await getJson(SAMPLE); console.info('events: showing local sample data from', SAMPLE); } catch (_) { /* fall through */ }
      }
    }
    const up = $('ev-upcoming'), past = $('ev-past');
    if (!data) {
      up.replaceChildren();
      up.removeAttribute('aria-busy');
      $('ev-fallback').hidden = false;
      return;
    }
    // A saved copy (served while pretix is down) can be days old: an event that has ended
    // since the copy was built moves to Past, without a ticket button. pretix had already
    // sorted anything that ended before then, and fresh data is minutes old, so only saved
    // copies are checked (a wrong device clock can't hide a live event). No end: six hours.
    const built = Date.parse(data.generated_at) || 0;
    const ended = (ev) => {
      const s = toDate(ev.start), e = toDate(ev.end) || (s && new Date(s.getTime() + 6 * 3600e3));
      return Boolean(e && e.getTime() < Date.now() && e.getTime() >= built);
    };
    const listed = data.upcoming.map(normalise).filter((ev) => SLUG_RE.test(ev.slug));
    if (data.stale) for (const ev of listed) if (ended(ev)) { ev.is_past = true; ev.sales = 'past'; }
    const upcoming = listed.filter((ev) => !ev.is_past);
    const onList = new Set(listed.map((ev) => ev.slug)); // an event in both lists keeps its upcoming copy
    const previous = [...listed.filter((ev) => ev.is_past),
      ...(data.past || []).map(normalise).filter((ev) => SLUG_RE.test(ev.slug) && !onList.has(ev.slug))]
      .sort((a, b) => (toDate(b.start) || 0) - (toDate(a.start) || 0));
    for (const ev of [...upcoming, ...previous]) bySlug.set(ev.slug, ev);

    renderList(up, upcoming, false);
    $('ev-empty').hidden = upcoming.length > 0;
    if (previous.length) { renderList(past, previous, true); $('past').hidden = false; }
    if (data.stale) {
      const note = $('ev-stale');
      note.textContent = 'Showing our last saved listing. Live availability is on the ticket site.';
      note.hidden = false;
    }
    jsonLd(upcoming);

    const slug = hashSlug();
    if (slug && bySlug.has(slug)) openEvent(slug, false);
    else if (location.hash && !document.getElementById(location.hash.slice(1))) history.replaceState(null, '', location.pathname + location.search);
  }

  load();
})();
