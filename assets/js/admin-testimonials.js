// Website admin, Testimonials (/admin/testimonials/). The server side is src/testimonials.js.
// Edits stay on this page until "Save changes".
(() => {
  const A = window.BIESAdmin;
  const $ = (sel) => document.querySelector(sel);
  const ui = { places: $('#places'), list: $('#list'), count: $('#count'), add: $('#add') };
  const PLACES = [
    { page: 'Home', label: 'Highlighted quote', key: 'homeHighlight', many: false, rules: { quote: true, short: true },
      note: 'The big quote on the home page. Visitors can click a card below it to swap.' },
    { page: 'Home', label: 'Cards below it', key: 'homeCards', many: true, rules: { quote: true, short: true } },
    { page: 'About', label: 'Cards', key: 'aboutCards', many: true, rules: { short: true } },
    { page: 'Membership', label: 'Highlighted quote', key: 'membershipHighlight', many: false, rules: { quote: true } },
    { page: 'Membership', label: 'Cards', key: 'membershipCards', many: true, rules: { short: true } },
  ];

  let list = [];
  let placements = {};
  const bar = A.saveBar(save);
  const app = A.boot({ onReady: load, isDirty: bar.isDirty });

  async function load() {
    if (!bar.isDirty()) {
      const r = await A.api('testimonials');
      if (r.status === 401) return 'signed_out';
      if (!r.ok) return false;
      take(r.body);
    }
    render();
    return true;
  }

  function take(data) {
    list = data.list.map((t) => ({ ...t, orgs: (t.orgs || []).map((o) => ({ ...o })), media: t.media ? { ...t.media } : null }));
    placements = JSON.parse(JSON.stringify(data.placements));
  }

  async function save() {
    const r = await A.sendJson('testimonials', 'PUT', { list, placements });
    if (r.ok) { take(r.body); render(); return { ok: true, message: 'Saved. The pages show the changes within a minute.' }; }
    if (r.status === 401) { app.showSignin('Your session ended. Sign in again, and your changes will still be here.'); return { ok: false }; }
    return { ok: false, message: r.body.detail ? `Not saved: ${r.body.detail}.` : 'Not saved. Check your connection and try again.' };
  }

  function changed() {
    bar.set(true);
    render();
  }

  // ---------- where they appear ----------

  function eligible(t, rules) {
    if (!t.photo) return 'needs a photo';
    if (rules.quote && !t.quote) return 'needs a full quote';
    if (rules.short && !t.short) return 'needs a short quote';
    return '';
  }

  function usedIn(id) {
    const out = [];
    for (const p of PLACES) {
      const v = placements[p.key];
      if (p.many ? (v || []).includes(id) : v === id) out.push(`${p.page} ${p.label.toLowerCase()}`);
    }
    return out;
  }

  function renderPlaces() {
    const pages = [...new Set(PLACES.map((p) => p.page))];
    ui.places.replaceChildren(...pages.map((page) => {
      const box = document.createElement('div');
      box.className = 'adm-place';
      const h = document.createElement('h3');
      h.textContent = page;
      box.append(h);
      for (const p of PLACES.filter((x) => x.page === page)) {
        const fs = document.createElement('fieldset');
        const lg = document.createElement('legend');
        lg.textContent = p.label;
        fs.append(lg);
        if (p.note) { const n = document.createElement('p'); n.className = 'adm-note'; n.textContent = p.note; fs.append(n); }
        const slots = p.many ? [0, 1, 2] : [null];
        for (const slot of slots) {
          const sel = document.createElement('select');
          sel.setAttribute('aria-label', `${page}, ${p.label}${slot === null ? '' : `, card ${slot + 1}`}`);
          const current = slot === null ? placements[p.key] : (placements[p.key] || [])[slot];
          for (const t of list) {
            const o = document.createElement('option');
            o.value = t.id;
            const why = eligible(t, p.rules);
            o.textContent = why ? `${t.name} (${why})` : t.name;
            o.disabled = Boolean(why) && t.id !== current;
            if (t.id === current) o.selected = true;
            sel.append(o);
          }
          sel.addEventListener('change', () => {
            if (slot === null) placements[p.key] = sel.value;
            else { const arr = [...(placements[p.key] || [])]; arr[slot] = sel.value; placements[p.key] = arr; }
            changed();
          });
          fs.append(sel);
        }
        box.append(fs);
      }
      return box;
    }));
  }

  // ---------- the list ----------

  function render() {
    renderPlaces();
    ui.count.textContent = `${list.length} in total, ${list.filter((t) => t.stories).length} on the Community page`;
    ui.list.replaceChildren(...list.map(row));
  }

  function avatar(t, cls = 'adm-t-mini') {
    const box = document.createElement('div');
    box.className = cls;
    if (t.photo) {
      const img = document.createElement('img');
      img.src = t.photo.startsWith('/') ? t.photo : `/${t.photo}`;
      img.alt = '';
      img.loading = 'lazy';
      box.append(img);
    } else {
      box.textContent = (t.name.trim()[0] || '?').toUpperCase();
      box.classList.add('is-initial');
    }
    return box;
  }

  function roleText(t) {
    const orgs = (t.orgs || []).map((o) => o.name).filter(Boolean).join(' & ');
    return [t.title, orgs].filter(Boolean).join(', ');
  }

  function row(t, i) {
    const li = document.createElement('li');
    li.className = 'adm-trow';
    if (!t.stories) li.classList.add('is-hidden');
    const main = document.createElement('div');
    main.className = 'adm-trow-main';
    const name = document.createElement('b');
    name.textContent = t.name;
    const role = document.createElement('span');
    role.className = 'adm-note';
    role.textContent = [roleText(t), t.location].filter(Boolean).join(' · ');
    const quote = document.createElement('p');
    quote.className = 'adm-trow-quote';
    quote.textContent = t.quote ? `“${t.quote}”` : 'Video only, no written quote.';
    const tags = document.createElement('div');
    tags.className = 'adm-tags';
    const tag = (text, cls = '') => { const s = document.createElement('span'); s.className = `adm-chip ${cls}`; s.textContent = text; tags.append(s); };
    for (const u of usedIn(t.id)) tag(u, 'is-place');
    if (t.media) tag(t.media.kind === 'video' ? 'Video' : 'Picture');
    if (!t.short) tag('No short quote');
    if (!t.stories) tag('Not on the Community page', 'is-unsaved');
    main.append(name, role, quote, tags);

    const actions = document.createElement('div');
    actions.className = 'adm-actions';
    const btn = (text, cls, fn, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; };
    const up = btn('Move up', 'adm-icon', () => move(i, -1), `Move ${t.name} up`);
    up.disabled = i === 0;
    const down = btn('Move down', 'adm-icon', () => move(i, 1), `Move ${t.name} down`);
    down.disabled = i === list.length - 1;
    const remove = btn('Remove', 'adm-icon adm-danger', () => askRemove(), `Remove ${t.name}`);
    const where = usedIn(t.id);
    if (where.length) { remove.disabled = true; remove.title = `Shown in: ${where.join(', ')}. Choose someone else there first.`; }
    const confirm = document.createElement('span');
    confirm.className = 'adm-confirm';
    confirm.hidden = true;
    const ask = document.createElement('span');
    ask.textContent = `Remove ${t.name}?`;
    const yes = btn('Remove', 'adm-icon adm-danger', () => { list.splice(i, 1); changed(); });
    const no = btn('Keep', 'adm-icon', () => { confirm.hidden = true; remove.hidden = false; remove.focus(); });
    confirm.append(ask, yes, no);
    function askRemove() { remove.hidden = true; confirm.hidden = false; no.focus(); }
    actions.append(btn('Edit', 'adm-icon', () => openEditor(i), `Edit ${t.name}`), up, down, remove, confirm);

    li.append(avatar(t), main, actions);
    return li;
  }

  function move(i, step) {
    const j = i + step;
    [list[i], list[j]] = [list[j], list[i]];
    changed();
    const b = ui.list.children[j].querySelectorAll('.adm-icon')[step < 0 ? 1 : 2];
    (b && !b.disabled ? b : ui.list.children[j].querySelector('.adm-icon')).focus();
  }

  ui.add.addEventListener('click', () => openEditor(-1));

  // ---------- the editor ----------

  const f = {
    dlg: $('#t-dialog'), form: $('#t-form'), title: $('#t-title'), avatar: $('#t-avatar'), photoLabel: $('#t-photo-label'),
    photoFile: $('#t-photo-file'), photoRemove: $('#t-photo-remove'), name: $('#t-name'), role: $('#t-role'),
    org1: $('#t-org1'), url1: $('#t-url1'), org2: $('#t-org2'), url2: $('#t-url2'), loc: $('#t-loc'),
    quote: $('#t-quote'), short: $('#t-short'), media: $('#t-media'), mediaLabel: $('#t-media-label'), mediaFile: $('#t-media-file'),
    mediaRemove: $('#t-media-remove'), stories: $('#t-stories'), msg: $('#t-msg'), error: $('#t-error'),
  };
  let draft = null;
  let editing = -1;

  function openEditor(i) {
    editing = i;
    const t = i >= 0 ? list[i] : { id: `t-${crypto.randomUUID().slice(0, 8)}`, name: '', photo: '', title: '', orgs: [], location: '', quote: '', short: '', media: null, stories: true };
    draft = { ...t, orgs: (t.orgs || []).map((o) => ({ ...o })), media: t.media ? { ...t.media } : null };
    f.title.textContent = i >= 0 ? `Edit ${t.name}` : 'Add a testimonial';
    f.name.value = draft.name;
    f.role.value = draft.title;
    f.org1.value = draft.orgs[0]?.name || '';
    f.url1.value = draft.orgs[0]?.url || '';
    f.org2.value = draft.orgs[1]?.name || '';
    f.url2.value = draft.orgs[1]?.url || '';
    f.loc.value = draft.location;
    f.quote.value = draft.quote;
    f.short.value = draft.short;
    f.stories.checked = draft.stories;
    f.msg.textContent = '';
    f.error.textContent = '';
    for (const el of [f.name, f.url1, f.url2, f.quote]) el.removeAttribute('aria-invalid');
    drawPhoto();
    drawMedia();
    f.dlg.showModal();
    f.name.focus();
  }

  function drawPhoto() {
    f.avatar.replaceChildren(avatar({ ...draft, name: f.name.value || draft.name }, 'adm-t-big'));
    f.photoLabel.textContent = draft.photo ? 'Replace photo' : 'Upload photo';
    f.photoRemove.hidden = !draft.photo;
  }

  function drawMedia() {
    const m = draft.media;
    f.media.replaceChildren();
    if (m) {
      const img = document.createElement('img');
      const src = m.kind === 'video' ? m.poster : m.src;
      img.src = src.startsWith('/') ? src : `/${src}`;
      img.alt = '';
      f.media.append(img);
      if (m.kind === 'video') { const s = document.createElement('span'); s.className = 'adm-chip'; s.textContent = 'Video'; f.media.append(s); }
    } else {
      const p = document.createElement('p');
      p.className = 'adm-note';
      p.textContent = 'No picture.';
      f.media.append(p);
    }
    f.mediaLabel.textContent = m ? (m.kind === 'video' ? 'Replace the video with a picture' : 'Replace picture') : 'Add a picture';
    f.mediaRemove.hidden = !m;
  }

  f.name.addEventListener('input', () => { if (!draft.photo) drawPhoto(); });
  f.photoRemove.addEventListener('click', () => { draft.photo = ''; drawPhoto(); });
  f.mediaRemove.addEventListener('click', () => { draft.media = null; drawMedia(); });

  f.photoFile.addEventListener('change', async () => {
    const file = f.photoFile.files && f.photoFile.files[0];
    f.photoFile.value = '';
    if (!file) return;
    const src = await upload(file, 'square');
    if (src) { draft.photo = src; drawPhoto(); }
  });
  f.mediaFile.addEventListener('change', async () => {
    const file = f.mediaFile.files && f.mediaFile.files[0];
    f.mediaFile.value = '';
    if (!file) return;
    const src = await upload(file, 'picture');
    if (src) { draft.media = { kind: 'image', src, alt: `${f.name.value.trim() || 'A member'} with Build in El Salvador` }; drawMedia(); }
  });

  f.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const bad = (el, text) => { el.setAttribute('aria-invalid', 'true'); f.error.textContent = text; el.focus(); };
    const name = f.name.value.trim();
    if (!name) return bad(f.name, 'Give the person a name.');
    for (const [org, url] of [[f.org1, f.url1], [f.org2, f.url2]]) {
      if (url.value.trim() && !A.isWebUrl(url.value.trim())) return bad(url, 'The link must start with https:// (copy it from the browser’s address bar).');
      if (url.value.trim() && !org.value.trim()) return bad(org, 'Add the business name for this link.');
    }
    const quote = f.quote.value.trim().replace(/^[“"]|[”"]$/g, '').trim();
    if (!quote && !(draft.media && draft.media.kind === 'video')) return bad(f.quote, 'Add the quote. Only a video card can be without one.');
    Object.assign(draft, {
      name,
      title: f.role.value.trim(),
      orgs: [[f.org1, f.url1], [f.org2, f.url2]].map(([o, u]) => ({ name: o.value.trim(), url: u.value.trim() })).filter((o) => o.name),
      location: f.loc.value.trim(),
      quote,
      short: f.short.value.trim().replace(/^[“"]|[”"]$/g, '').trim(),
      stories: f.stories.checked,
    });
    // Someone shown in a spot that needs a quote, a short quote or a photo must keep them.
    for (const p of PLACES) {
      const v = placements[p.key];
      const shown = p.many ? (v || []).includes(draft.id) : v === draft.id;
      const why = shown && eligible(draft, p.rules);
      if (why) { f.error.textContent = `${draft.name} is shown in ${p.page}, ${p.label.toLowerCase()}, so this ${why.replace('needs ', '')} is needed there. Choose someone else there first.`; return; }
    }
    if (editing >= 0) list[editing] = draft; else list.push(draft);
    f.dlg.close();
    changed();
    const at = editing >= 0 ? editing : list.length - 1;
    ui.list.children[at]?.querySelector('.adm-icon')?.focus();
  });
  $('#t-cancel').addEventListener('click', () => f.dlg.close());

  // ---------- uploads ----------

  async function upload(file, kind) {
    f.msg.className = 'adm-row-msg';
    f.msg.textContent = 'Preparing and uploading…';
    let blob;
    try {
      blob = await prepare(file, kind);
    } catch (err) {
      f.msg.className = 'adm-row-msg is-warn';
      f.msg.textContent = err.message;
      return '';
    }
    let res;
    try {
      res = await fetch('/api/admin/testimonials/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    } catch (_) {
      f.msg.className = 'adm-row-msg is-warn';
      f.msg.textContent = 'The upload didn’t work. Check your connection and try again.';
      return '';
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { f.dlg.close(); app.showSignin('Your session ended. Sign in again, then upload the photo again.'); return ''; }
    if (!res.ok) { f.msg.className = 'adm-row-msg is-warn'; f.msg.textContent = 'The upload didn’t work. Try again.'; return ''; }
    f.msg.textContent = 'Uploaded. Press Done, then Save changes.';
    return body.src;
  }

  // A profile photo becomes a 320x320 square from the middle; a card picture is shrunk to
  // 1200 pixels wide at most. Re-saving also drops the camera details and location.
  async function prepare(file, kind) {
    if (!file.type.startsWith('image/')) throw new Error('Choose a photo file (JPG, PNG, WebP or HEIC).');
    if (file.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. Choose a smaller photo.');
    const img = await A.loadImage(file);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (kind === 'square') {
      const side = Math.min(w, h);
      c.width = 320;
      c.height = 320;
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 320, 320);
    } else {
      const scale = Math.min(1, 1200 / w);
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      ctx.drawImage(img, 0, 0, c.width, c.height);
    }
    let blob = await A.toBlob(c, 'image/webp', 0.84);
    if (!blob || blob.type !== 'image/webp') blob = await A.toBlob(c, 'image/jpeg', 0.86);
    if (!blob || blob.size > 1000 * 1024) throw new Error('That photo is too large even after shrinking.');
    return blob;
  }
})();
