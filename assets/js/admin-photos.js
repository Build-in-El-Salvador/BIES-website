// Website admin, Photos (/admin/): every photo admins can change, grouped by page. The
// server side is src/photos.js. Edits stay on this page until "Save changes".
(() => {
  const A = window.BIESAdmin;
  const $ = (sel, root = document) => root.querySelector(sel);
  const groups = $('#groups');
  const dlg = $('#photo-dialog');
  const MAX_EDGE = 2000; // longest side of an uploaded photo, enough for a full-width banner
  const MAX_BYTES = 1.45 * 1024 * 1024;

  let sections = []; // from the server: { id, page, path, title, kind, min, max, shape, phoneShape, hint, defaultPos, original, photos, changed }
  let saved = {};    // id -> JSON of the photos as last saved, to show what's unsaved
  const bar = A.saveBar(save);
  const app = A.boot({ onReady: load, isDirty: bar.isDirty });

  // ---------- load and save ----------

  async function load() {
    if (bar.isDirty()) { render(); return true; } // signed in again after a session ran out
    const r = await A.api('photos');
    if (r.status === 401) return 'signed_out';
    if (!r.ok) return false;
    take(r.body.sections);
    render();
    return true;
  }

  function take(list) {
    sections = list.map((s) => ({ ...s, photos: s.photos.map((p) => ({ ...p })) }));
    saved = Object.fromEntries(sections.map((s) => [s.id, JSON.stringify(s.photos)]));
  }

  async function save() {
    const payload = {};
    for (const s of sections) {
      if (s.photos.some((p) => !p.alt.trim())) return { ok: false, message: `${s.page}, ${s.title}: every photo needs a description.` };
      payload[s.id] = same(s.photos, s.original) ? null : s.photos.map(({ src, alt, pos, orig, crop }) => (crop ? { src, alt, pos, orig, crop } : { src, alt, pos }));
    }
    const r = await A.sendJson('photos', 'PUT', { sections: payload });
    if (r.ok) {
      take(r.body.sections);
      render();
      return { ok: true, message: 'Saved. The pages show the new photos within a minute.' };
    }
    if (r.status === 401) { app.showSignin('Your session ended. Sign in again, and your changes will still be here.'); return { ok: false }; }
    return { ok: false, message: r.body.detail ? `Not saved: ${r.body.detail}.` : 'Not saved. Check your connection and try again.' };
  }

  function same(a, b) {
    const list = (photos) => JSON.stringify(photos.map(({ src, alt, pos, crop }) => [src, alt, pos, crop || null]));
    return list(a) === list(b);
  }

  function changed(s) {
    bar.set(sections.some((x) => JSON.stringify(x.photos) !== saved[x.id]));
    renderSection(s);
  }

  // ---------- page ----------

  function render() {
    const byPage = new Map();
    for (const s of sections) {
      if (!byPage.has(s.page)) byPage.set(s.page, []);
      byPage.get(s.page).push(s);
    }
    groups.replaceChildren(...[...byPage].map(([page, list]) => {
      const g = document.createElement('section');
      g.className = 'adm-group';
      const h = document.createElement('div');
      h.className = 'adm-group-head';
      const h2 = document.createElement('h2');
      h2.textContent = page;
      h.append(h2);
      if (page !== 'Every page') {
        const a = document.createElement('a');
        a.href = list[0].path;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open the page';
        h.append(a);
      }
      g.append(h, ...list.map((s) => { const el = document.createElement('article'); el.className = 'adm-sec'; el.id = `sec-${s.id}`; return el; }));
      return g;
    }));
    sections.forEach(renderSection);
  }

  function renderSection(s) {
    const el = document.getElementById(`sec-${s.id}`);
    if (!el) return;
    const unsaved = JSON.stringify(s.photos) !== saved[s.id];
    const edited = !same(s.photos, s.original);

    const head = document.createElement('header');
    head.className = 'adm-sec-head';
    const h3 = document.createElement('h3');
    h3.textContent = s.title;
    head.append(h3);
    if (unsaved || edited) {
      const chip = document.createElement('span');
      chip.className = `adm-chip${unsaved ? ' is-unsaved' : ''}`;
      chip.textContent = unsaved ? 'Not saved yet' : 'Changed from the original';
      head.append(chip);
    }
    if (edited) {
      const restore = button('Restore the original', 'adm-link adm-restore', () => { s.photos = s.original.map((p) => ({ ...p })); changed(s); });
      head.append(restore);
    }

    const hint = document.createElement('p');
    hint.className = 'adm-sec-hint';
    const rule = s.kind === 'strip' ? `${s.min} to ${s.max} photos.` : 'One photo.';
    hint.textContent = [s.hint, rule].filter(Boolean).join(' ');
    if (s.missing) { hint.textContent = 'This spot could not be found on the page. Ask whoever maintains the website.'; hint.classList.add('is-warn'); }

    const tiles = document.createElement('ol');
    tiles.className = `adm-tiles${s.kind === 'single' ? ' is-single' : ''}`;
    s.photos.forEach((p, i) => tiles.append(tile(s, p, i)));
    if (s.kind === 'strip' && s.photos.length < s.max) tiles.append(addTile(s));
    el.replaceChildren(head, hint, tiles);
  }

  function tile(s, p, i) {
    const li = document.createElement('li');
    li.className = 'adm-tile';
    li.append(frame(s.shape, p));
    const alt = document.createElement('p');
    alt.className = 'adm-tile-alt';
    alt.textContent = p.alt || 'No description yet';
    if (!p.alt) alt.classList.add('is-warn');
    const actions = document.createElement('div');
    actions.className = 'adm-tile-actions';
    const label = s.kind === 'strip' ? `photo ${i + 1} of ${s.title}` : s.title;
    const edit = button('Edit', 'adm-icon', () => openEditor(s, i));
    edit.setAttribute('aria-label', `Edit ${label}`);
    actions.append(edit);
    if (s.kind === 'strip') {
      const left = button('←', 'adm-icon', () => move(s, i, -1));
      left.setAttribute('aria-label', `Move ${label} left`);
      left.disabled = i === 0;
      const right = button('→', 'adm-icon', () => move(s, i, 1));
      right.setAttribute('aria-label', `Move ${label} right`);
      right.disabled = i === s.photos.length - 1;
      const remove = button('Remove', 'adm-icon adm-danger', () => { s.photos.splice(i, 1); changed(s); });
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.disabled = s.photos.length <= s.min;
      if (remove.disabled) remove.title = `This strip needs at least ${s.min} photos`;
      actions.append(left, right, remove);
    }
    li.append(alt, actions);
    return li;
  }

  function addTile(s) {
    const li = document.createElement('li');
    li.className = 'adm-tile adm-add';
    const label = document.createElement('label');
    label.className = 'adm-add-btn';
    const text = document.createElement('span');
    text.textContent = '+ Add photo';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('aria-label', `Add a photo to ${s.page}, ${s.title}`);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      text.textContent = 'Uploading…';
      const r = await uploadFile(file);
      text.textContent = '+ Add photo';
      if (r.error) { bar.show(r.error, 'is-error'); return; }
      openEditor(s, s.photos.length, { src: r.src, alt: '', pos: '50% 50%' });
    });
    label.append(text, input);
    li.append(label);
    return li;
  }

  function frame(shape, p) {
    const box = document.createElement('div');
    box.className = `adm-frame${shape === 'natural' ? ' is-natural' : ''}`;
    if (shape !== 'natural') box.style.aspectRatio = shape;
    const img = document.createElement('img');
    img.src = p.src.startsWith('/') ? p.src : `/${p.src}`;
    img.alt = '';
    img.loading = 'lazy';
    img.style.objectPosition = p.pos;
    box.append(img);
    return box;
  }

  function move(s, i, step) {
    const j = i + step;
    [s.photos[i], s.photos[j]] = [s.photos[j], s.photos[i]];
    changed(s);
    const btn = document.querySelectorAll(`#sec-${s.id} .adm-tile`)[j]?.querySelectorAll('.adm-icon')[step < 0 ? 1 : 2];
    if (btn && !btn.disabled) btn.focus();
  }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }


  // ---------- the editor ----------
  //
  // Shows the whole photo with a box over it: the part the website shows. Drag the box to
  // move it; drag a corner or use Zoom to crop in closer. Spots that change shape on phones
  // get a second, dashed box for what phones show. All of it is in fractions of the photo:
  //   crop  [x, y, w, h], the part of the photo kept, or null for the whole photo
  //   pos   [x, y] from 0 to 1, the CSS object-position the frames use inside the crop
  // A frame covers the crop and pos says where it sits (visible()), exactly as the site's CSS
  // does. While the box is as big as its frame allows nothing is cut off, so only pos is
  // saved. A smaller box is a crop: Done makes a cropped copy, uploads it, and keeps the
  // original (orig) so the crop can be changed or undone later.

  const EPS = 0.004;
  const clamp = (v, lo, hi) => Math.max(Math.min(lo, hi), Math.min(hi, v));
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const url = (src) => (src.startsWith('/') ? src : `/${src}`);
  const ratio = (shape) => { if (!shape || shape === 'natural') return null; const [a, b] = shape.split('/').map(Number); return a / b; };
  const posText = ([x, y]) => `${Math.round(x * 100)}% ${Math.round(y * 100)}%`;
  // Narrowest crop, in pixels, that still looks sharp in this spot on a big screen.
  const need = (s) => (s.kind === 'strip' ? 450 : ratio(s.shape) >= 2 ? 1200 : 700);

  let draft = null; // { s, index, isNew, photo, base, crop, pos, desk, phone, iw, ih }
  let drag = null;
  let previews = []; // [aspect, frame, img]
  const ui = {
    title: $('#dlg-title'), where: $('#dlg-where'), help: $('#dlg-help'), crop: $('#dlg-crop'), img: $('#dlg-img'),
    box: $('#dlg-box'), boxTag: $('#dlg-box-tag'), phone: $('#dlg-phone'), corners: [...document.querySelectorAll('#dlg-crop [data-corner]')],
    zoom: $('#dlg-zoom'), uncrop: $('#dlg-uncrop'), size: $('#dlg-size'), file: $('#dlg-file'), msg: $('#dlg-msg'),
    previews: $('#dlg-previews'), alt: $('#dlg-alt'), altError: $('#dlg-alt-error'), done: $('#dlg-done'),
  };

  async function openEditor(s, index, fresh) {
    const p = fresh || s.photos[index];
    draft = {
      s, index, isNew: Boolean(fresh), photo: { ...p },
      base: p.orig || p.src, crop: p.crop ? [...p.crop] : null, pos: p.pos.split(' ').map((v) => parseFloat(v) / 100),
      desk: ratio(s.shape), phone: ratio(s.phoneShape), iw: 0, ih: 0,
    };
    ui.title.textContent = fresh ? 'Add a photo' : 'Edit photo';
    ui.where.textContent = `${s.page} · ${s.title}${s.kind === 'strip' ? ` · photo ${index + 1}` : ''}`;
    ui.help.textContent = !draft.desk
      ? 'This spot shows the whole photo. To cut off the edges, drag the corners of the box: the website shows what’s inside it.'
      : `The box is the part of the photo the website shows. Drag it to move it. Drag a corner, or use Zoom, to crop in closer.${draft.phone ? ' Phones show a different shape: drag the dashed box to choose that part.' : ''}`;
    ui.boxTag.textContent = draft.phone ? 'On a computer' : 'On the website';
    ui.alt.value = draft.photo.alt;
    ui.altError.textContent = '';
    ui.msg.textContent = '';
    ui.msg.className = 'adm-row-msg';
    ui.done.disabled = false;
    dlg.showModal();
    await showBase();
    if (fresh) ui.alt.focus(); else ui.box.focus();
  }

  // Loads the photo the editor works on (the original, for a cropped photo).
  async function showBase() {
    const d = draft;
    d.iw = 0;
    ui.crop.classList.add('is-loading');
    ui.size.textContent = '';
    ui.img.src = url(d.base);
    try { await ui.img.decode(); } catch (_) { /* checked below */ }
    if (draft !== d) return;
    if (!ui.img.naturalWidth) { ui.msg.className = 'adm-row-msg is-warn'; ui.msg.textContent = 'This photo couldn’t be loaded. Close this and try again.'; return; }
    d.iw = ui.img.naturalWidth;
    d.ih = ui.img.naturalHeight;
    ui.crop.classList.remove('is-loading');
    const s = d.s;
    const shapes = !d.desk ? [['Shown whole', null]]
      : d.phone ? [['On a computer', d.desk], ['On a phone', d.phone]]
      : [[s.kind === 'strip' ? 'Each frame' : 'On the page', d.desk]];
    previews = shapes.map(([label, aspect]) => {
      const f = document.createElement('figure');
      const box = document.createElement('div');
      box.className = 'adm-frame is-crop';
      const img = document.createElement('img');
      img.src = url(d.base);
      img.alt = '';
      box.append(img);
      const cap = document.createElement('figcaption');
      cap.textContent = label;
      f.append(box, cap);
      return [aspect, box, img, f];
    });
    ui.previews.replaceChildren(...previews.map((x) => x[3]));
    drawDraft();
  }

  // A frame's width / height, in fractions of this photo (a 3/4 frame on a 3:2 photo is 0.5).
  const fr = (aspect) => (aspect * draft.ih) / draft.iw;
  // The biggest box with this width / height (in fractions) that fits inside the photo.
  const biggest = (r) => (r >= 1 ? [1, 1 / r] : [r, 1]);
  const smallest = () => [Math.min(1, 160 / draft.iw), Math.min(1, 160 / draft.ih)];
  const boxRatio = (rect) => (draft.desk ? fr(draft.desk) : rect[2] / rect[3]);

  // The part of the photo a frame of this shape shows (null: shown whole).
  function visible(aspect) {
    const [cx, cy, cw, ch] = draft.crop || [0, 0, 1, 1];
    if (!aspect) return [cx, cy, cw, ch];
    const r = fr(aspect);
    let w = cw;
    let h = ch;
    if (cw / ch > r) w = ch * r; else h = cw / r;
    return [cx + (cw - w) * draft.pos[0], cy + (ch - h) * draft.pos[1], w, h];
  }

  // The website's box was moved or resized to this rectangle.
  function setBox([x, y, w, h]) {
    const d = draft;
    if (!d.desk) {
      d.crop = w >= 1 - EPS && h >= 1 - EPS ? null : [x, y, w, h];
    } else {
      const [bw, bh] = biggest(fr(d.desk));
      if (w >= bw - EPS && h >= bh - EPS) {
        // As big as the frame allows: nothing is cut off, the frame only sits further along.
        d.crop = null;
        if (1 - w > EPS) d.pos[0] = clamp(x / (1 - w), 0, 1);
        if (1 - h > EPS) d.pos[1] = clamp(y / (1 - h), 0, 1);
      } else d.crop = [x, y, w, h];
    }
    drawDraft();
  }

  // The phones' box was moved: it always fills the crop one way and slides the other.
  function setPhone([x, y, w, h]) {
    const [cx, cy, cw, ch] = draft.crop || [0, 0, 1, 1];
    if (cw - w > EPS) draft.pos[0] = clamp((x - cx) / (cw - w), 0, 1);
    if (ch - h > EPS) draft.pos[1] = clamp((y - cy) / (ch - h), 0, 1);
    drawDraft();
  }

  function dragTo([fx, fy]) {
    const d = draft;
    if (drag.mode === 'box' || drag.mode === 'phone') {
      const [x0, y0, w, h] = drag.rect;
      const x = x0 + fx - drag.start[0];
      const y = y0 + fy - drag.start[1];
      if (drag.mode === 'box') { setBox([clamp(x, 0, 1 - w), clamp(y, 0, 1 - h), w, h]); return; }
      const [cx, cy, cw, ch] = d.crop || [0, 0, 1, 1];
      setPhone([clamp(x, cx, cx + cw - w), clamp(y, cy, cy + ch - h), w, h]);
      return;
    }
    // A corner: the opposite corner stays where it is.
    const [x0, y0, w0, h0] = drag.rect;
    const east = drag.corner.includes('e');
    const south = drag.corner.includes('s');
    const ax = east ? x0 : x0 + w0;
    const ay = south ? y0 : y0 + h0;
    const roomX = east ? 1 - ax : ax;
    const roomY = south ? 1 - ay : ay;
    const wantX = east ? fx - ax : ax - fx;
    const wantY = south ? fy - ay : ay - fy;
    const [minW, minH] = smallest();
    let w;
    let h;
    if (d.desk) {
      // The corner follows the pointer along the box's diagonal (the nearest point to it on
      // screen, worked out in pixels so a tall photo behaves like a wide one).
      const r = fr(d.desk);
      const R = d.desk;
      const want = (wantX * d.iw + (wantY * d.ih) / R) / (1 + 1 / (R * R)) / d.iw;
      w = clamp(want, Math.max(minW, minH * r), Math.min(roomX, roomY * r));
      h = w / r;
    } else {
      w = clamp(wantX, minW, roomX);
      h = clamp(wantY, minH, roomY);
    }
    setBox([east ? ax : ax - w, south ? ay : ay - h, w, h]);
  }

  // Zoom 1 is the biggest box the frame allows; higher numbers crop in, keeping the centre.
  function zoomTo(z) {
    const [x, y, w0, h0] = visible(draft.desk);
    const r = boxRatio([x, y, w0, h0]);
    const [bw] = biggest(r);
    const [minW, minH] = smallest();
    const w = clamp(bw / z, Math.max(minW, minH * r), bw);
    const h = w / r;
    setBox([clamp(x + w0 / 2 - w / 2, 0, 1 - w), clamp(y + h0 / 2 - h / 2, 0, 1 - h), w, h]);
  }

  function drawDraft() {
    const d = draft;
    if (!d || !d.iw) return;
    const place = (el, [x, y, w, h]) => Object.assign(el.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    const box = visible(d.desk);
    place(ui.box, box);
    for (const c of ui.corners) {
      const k = c.dataset.corner;
      c.style.left = `${(box[0] + (k.includes('e') ? box[2] : 0)) * 100}%`;
      c.style.top = `${(box[1] + (k.includes('s') ? box[3] : 0)) * 100}%`;
    }
    ui.phone.hidden = !d.phone;
    if (d.phone) place(ui.phone, visible(d.phone));

    const r = boxRatio(box);
    const [bw] = biggest(r);
    const [minW, minH] = smallest();
    const most = Math.max(1, Math.min(6, bw / Math.max(minW, minH * r)));
    ui.zoom.max = most.toFixed(2);
    ui.zoom.value = String(bw / box[2]);
    ui.zoom.disabled = most < 1.02;
    ui.uncrop.disabled = !d.crop;

    const pw = Math.round(box[2] * d.iw);
    const ph = Math.round(box[3] * d.ih);
    const low = pw < Math.min(need(d.s), d.iw * 0.98);
    ui.size.textContent = `Shows ${pw} × ${ph} pixels of the photo.${low ? ' That’s few for this spot, so it may look blurry on big screens. Zoom out a little.' : ''}`;
    ui.size.classList.toggle('is-warn', low);

    for (const [aspect, frame, img] of previews) {
      const [x, y, w, h] = visible(aspect);
      const ar = aspect || (w * d.iw) / (h * d.ih);
      frame.style.aspectRatio = String(ar);
      frame.style.width = aspect ? '' : `min(100%, ${Math.round(240 * ar)}px)`;
      Object.assign(img.style, { width: `${100 / w}%`, height: `${100 / h}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` });
    }
  }

  const at = (e) => {
    const r = ui.img.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  ui.crop.addEventListener('pointerdown', (e) => {
    if (!draft || !draft.iw || e.button > 0) return;
    const p = at(e);
    const t = e.target;
    if (t.dataset.corner) drag = { mode: 'corner', corner: t.dataset.corner, rect: visible(draft.desk) };
    else if (t === ui.phone) drag = { mode: 'phone', start: p, rect: visible(draft.phone) };
    else if (t === ui.box) drag = { mode: 'box', start: p, rect: visible(draft.desk) };
    else {
      // Outside the box: bring the box here, centred on the pointer, and keep dragging.
      const [, , w, h] = visible(draft.desk);
      setBox([clamp(p[0] - w / 2, 0, 1 - w), clamp(p[1] - h / 2, 0, 1 - h), w, h]);
      drag = { mode: 'box', start: p, rect: visible(draft.desk) };
    }
    ui.crop.setPointerCapture(e.pointerId);
    e.preventDefault();
    (t === ui.phone ? ui.phone : ui.box).focus({ preventScroll: true });
  });
  ui.crop.addEventListener('pointermove', (e) => { if (drag && draft) dragTo(at(e)); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) ui.crop.addEventListener(type, () => { drag = null; });

  function onKey(e, mode) {
    if (!draft || !draft.iw) return;
    if (mode === 'box' && ['+', '=', '-', '_'].includes(e.key)) {
      e.preventDefault();
      const z = Number(ui.zoom.value) * (e.key === '-' || e.key === '_' ? 1 / 1.1 : 1.1);
      zoomTo(clamp(z, 1, Number(ui.zoom.max)));
      return;
    }
    const n = e.shiftKey ? 0.1 : 0.02;
    const step = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[e.key];
    if (!step) return;
    e.preventDefault();
    drag = { mode, start: [0, 0], rect: visible(mode === 'box' ? draft.desk : draft.phone) };
    dragTo(step);
    drag = null;
  }
  ui.box.addEventListener('keydown', (e) => onKey(e, 'box'));
  ui.phone.addEventListener('keydown', (e) => onKey(e, 'phone'));
  ui.zoom.addEventListener('input', () => { if (draft && draft.iw) zoomTo(Number(ui.zoom.value)); });
  ui.uncrop.addEventListener('click', () => { draft.crop = null; drawDraft(); ui.box.focus(); });

  ui.file.addEventListener('change', async () => {
    const file = ui.file.files && ui.file.files[0];
    ui.file.value = '';
    if (!file || !draft) return;
    const d = draft;
    ui.msg.className = 'adm-row-msg';
    ui.msg.textContent = 'Preparing and uploading the photo…';
    const r = await uploadFile(file);
    if (draft !== d) return;
    if (r.error) { ui.msg.className = 'adm-row-msg is-warn'; ui.msg.textContent = r.error; return; }
    Object.assign(d, { photo: { src: r.src, alt: '', pos: '50% 50%' }, base: r.src, crop: null, pos: [0.5, 0.5] });
    ui.alt.value = '';
    ui.msg.textContent = 'New photo ready. Describe it below, then press Done.';
    await showBase();
    ui.alt.focus();
  });

  $('#dlg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = draft;
    if (!d || ui.done.disabled) return;
    const alt = ui.alt.value.trim().replace(/\s+/g, ' ');
    if (!alt) { ui.altError.textContent = 'Describe the photo in a few words, for example “Members talking at a dinner”.'; ui.alt.focus(); return; }
    // Done before the photo has loaded: nothing but the description can have changed.
    const photo = d.iw ? { src: d.base, alt, pos: posText(d.pos) } : { ...d.photo, alt };
    if (d.iw && d.crop) {
      const crop = d.crop.map(r4);
      if (d.photo.orig === d.base && JSON.stringify(d.photo.crop) === JSON.stringify(crop)) {
        Object.assign(photo, { src: d.photo.src, orig: d.base, crop });
      } else {
        ui.done.disabled = true;
        ui.msg.className = 'adm-row-msg';
        ui.msg.textContent = 'Cropping the photo…';
        const r = await uploadCrop(d.base, crop);
        ui.done.disabled = false;
        if (draft !== d) return;
        if (r.error) { ui.msg.className = 'adm-row-msg is-warn'; ui.msg.textContent = r.error; return; }
        Object.assign(photo, { src: r.src, orig: d.base, crop });
      }
    }
    const { s, index, isNew } = d;
    if (isNew) s.photos.push(photo); else s.photos[index] = photo;
    dlg.close();
    changed(s);
    const tiles = document.querySelectorAll(`#sec-${s.id} .adm-tile`);
    const target = tiles[isNew ? s.photos.length - 1 : index];
    if (target) target.querySelector('.adm-icon').focus();
  });
  $('#dlg-cancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { draft = null; drag = null; });

  // ---------- uploading ----------

  async function uploadFile(file) {
    try {
      return await send(await preparePhoto(file));
    } catch (err) {
      return { error: err.message };
    }
  }

  // Cuts the crop out of the original at full size and uploads it as a new photo.
  async function uploadCrop(src, [x, y, w, h]) {
    try {
      const res = await fetch(url(src), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('The original photo couldn’t be loaded. Close this, reload the page and try again.');
      const img = await A.loadImage(await res.blob());
      const W = img.width || img.naturalWidth;
      const H = img.height || img.naturalHeight;
      const sx = Math.round(x * W);
      const sy = Math.round(y * H);
      return await send(await encode(img, [sx, sy, Math.max(1, Math.min(W - sx, Math.round(w * W))), Math.max(1, Math.min(H - sy, Math.round(h * H)))], 0.88));
    } catch (err) {
      return { error: err.message };
    }
  }

  async function send(blob) {
    let res;
    try {
      res = await fetch('/api/admin/photos/upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
    } catch (_) {
      return { error: 'The upload didn’t work. Check your connection and try again.' };
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { app.showSignin('Your session ended. Sign in again, then try the photo again.'); return { error: 'You were signed out.' }; }
    if (!res.ok) return { error: res.status === 413 ? 'That photo is too large even after shrinking.' : 'The upload didn’t work. Try again.' };
    return { src: body.src };
  }

  // Shrinks the photo to at most 2000 pixels on its longest side and re-saves it, which
  // also drops the camera details and location stored inside photo files.
  async function preparePhoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose a photo file (JPG, PNG, WebP or HEIC).');
    if (file.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. Choose a smaller photo.');
    const img = await A.loadImage(file);
    const w0 = img.width || img.naturalWidth;
    const h0 = img.height || img.naturalHeight;
    if (!w0 || !h0) throw new Error('That photo couldn’t be read.');
    return encode(img, [0, 0, w0, h0], 0.82);
  }

  // Draws [sx, sy, sw, sh] of the image at up to 2000 pixels and saves it as WebP (JPEG
  // where the browser can't make WebP), lowering the quality until it's small enough.
  async function encode(img, [sx, sy, sw, sh], quality) {
    for (const [edge, q] of [[MAX_EDGE, quality], [MAX_EDGE, 0.7], [1600, 0.7]]) {
      const scale = Math.min(1, edge / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * scale));
      c.height = Math.max(1, Math.round(sh * scale));
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      let blob = await A.toBlob(c, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await A.toBlob(c, 'image/jpeg', q + 0.05);
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error('That photo is too detailed to shrink enough. Try a different one.');
  }
})();
