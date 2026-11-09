// Website admin, Partners (/admin/partners/): the Partners and Collaborators logos on the
// About and Ecosystem (membership.html) pages. The server side is src/partners.js. Edits stay on this page until "Save changes".
(() => {
  const A = window.BIESAdmin;
  const $ = (sel) => document.querySelector(sel);
  const ui = { rows: $('#rows'), add: $('#add'), preview: $('#preview'), previewEmpty: $('#preview-empty'), template: $('#row-template') };
  const LOGO_BOX = { w: 660, h: 260 }; // the size the site's existing logos were made at
  const MAX_FILE = 10 * 1024 * 1024;

  let partners = [];
  const bar = A.saveBar(save);
  const app = A.boot({ onReady: load, isDirty: bar.isDirty });

  async function load() {
    if (!bar.isDirty()) { // keep unsaved edits if the session ran out and the admin signed in again
      const r = await A.api('partners');
      if (r.status === 401) return 'signed_out';
      if (!r.ok) return false;
      partners = r.body.partners.map((p) => ({ ...p }));
    }
    render();
    return true;
  }

  async function save() {
    for (const [i, p] of partners.entries()) {
      const li = ui.rows.children[i];
      if (!p.name.trim()) return fail(li, '.f-name', 'Give this partner a name.');
      if (p.url && !A.isWebUrl(p.url)) return fail(li, '.f-url', 'The link must start with https:// (copy it from the browser’s address bar).');
    }
    const payload = partners.map(({ id, name, url, logo, size, visible }) => ({ id, name, url, logo, size, visible }));
    const r = await A.sendJson('partners', 'PUT', { partners: payload });
    if (r.ok) {
      partners = r.body.partners.map((p) => ({ ...p }));
      render();
      return { ok: true, message: 'Saved. The About and Ecosystem pages show the new list within a minute.' };
    }
    if (r.status === 401) { app.showSignin('Your session ended. Sign in again, and your changes will still be here.'); return { ok: false }; }
    return { ok: false, message: r.body.detail ? `Not saved: ${r.body.detail}.` : 'Not saved. Check your connection and try again.' };
  }

  function fail(li, sel, text) {
    const field = li.querySelector(sel);
    field.setAttribute('aria-invalid', 'true');
    status(li, partners[[...ui.rows.children].indexOf(li)], { text, warn: true });
    field.focus();
    return { ok: false, message: 'Fix the highlighted field, then save.' };
  }

  // ---------- list ----------

  function render() {
    ui.rows.replaceChildren(...partners.map((p, i) => row(p, i)));
    renderPreview();
  }

  function row(p, i) {
    const li = ui.template.content.firstElementChild.cloneNode(true);
    const q = (sel) => li.querySelector(sel);
    li.dataset.id = p.id;
    li.classList.toggle('is-new', Boolean(p.isNew));

    const img = q('.adm-logo-box img');
    if (p.logo) { img.src = p.logo; img.alt = `${p.name || 'Partner'} logo`; img.hidden = false; q('.adm-nologo').hidden = true; }
    img.style.setProperty('--lh', String(p.size));
    q('.adm-upload-label').textContent = p.logo ? 'Replace logo' : 'Upload logo';

    const name = q('.f-name');
    name.value = p.name;
    name.addEventListener('input', () => { p.name = name.value; name.removeAttribute('aria-invalid'); changed(li, p); });

    const link = q('.f-url');
    link.value = p.url;
    link.addEventListener('input', () => { p.url = link.value.trim(); link.removeAttribute('aria-invalid'); changed(li, p); });

    const size = q('.f-size');
    const out = q('.f-size-out');
    size.value = String(Math.round(p.size * 100));
    out.textContent = `${size.value}%`;
    size.addEventListener('input', () => {
      p.size = Number(size.value) / 100;
      out.textContent = `${size.value}%`;
      img.style.setProperty('--lh', String(p.size));
      changed(li, p);
    });

    const visible = q('.f-visible');
    visible.checked = p.visible;
    visible.addEventListener('change', () => { p.visible = visible.checked; changed(li, p); });

    q('.adm-upload input').addEventListener('change', (e) => upload(e.target, p, li));

    const up = q('.f-up');
    const down = q('.f-down');
    up.disabled = i === 0;
    down.disabled = i === partners.length - 1;
    up.setAttribute('aria-label', `Move ${p.name || 'this partner'} up`);
    down.setAttribute('aria-label', `Move ${p.name || 'this partner'} down`);
    up.addEventListener('click', () => move(i, -1, '.f-up'));
    down.addEventListener('click', () => move(i, 1, '.f-down'));

    const confirm = q('.adm-confirm');
    const remove = q('.f-remove');
    remove.addEventListener('click', () => { remove.hidden = true; confirm.hidden = false; q('.f-no').focus(); });
    q('.f-no').addEventListener('click', () => { confirm.hidden = true; remove.hidden = false; remove.focus(); });
    q('.f-yes').addEventListener('click', () => {
      partners.splice(i, 1);
      bar.set(true);
      render();
      const next = ui.rows.children[Math.min(i, partners.length - 1)];
      (next ? next.querySelector('.f-name') : ui.add).focus();
    });

    status(li, p);
    return li;
  }

  function changed(li, p) {
    status(li, p);
    bar.set(true);
    renderPreview();
  }

  function status(li, p, extra) {
    const msg = li.querySelector('.adm-row-msg');
    li.classList.toggle('is-hidden', !(p.visible && p.logo));
    msg.classList.toggle('is-warn', Boolean(extra && extra.warn));
    msg.textContent = extra ? extra.text
      : !p.logo ? 'Not on the website yet: add a logo.'
      : !p.visible ? 'Hidden from the website.'
      : !p.url ? 'Shown on the website, without a link.'
      : 'Shown on the website.';
  }

  function move(i, step, focusSel) {
    const j = i + step;
    if (j < 0 || j >= partners.length) return;
    [partners[i], partners[j]] = [partners[j], partners[i]];
    bar.set(true);
    render();
    const btn = ui.rows.children[j].querySelector(focusSel);
    (btn.disabled ? ui.rows.children[j].querySelector('.f-name') : btn).focus();
  }

  ui.add.addEventListener('click', () => {
    partners.push({ id: `p-${crypto.randomUUID().slice(0, 8)}`, name: '', url: '', logo: '', size: 1, visible: true, isNew: true });
    bar.set(true);
    render();
    ui.rows.lastElementChild.querySelector('.f-name').focus();
  });

  function renderPreview() {
    const shown = partners.filter((p) => p.visible && p.logo);
    ui.preview.replaceChildren(...shown.map((p) => {
      const span = document.createElement('span');
      const img = document.createElement('img');
      img.src = p.logo;
      img.alt = p.name;
      img.style.setProperty('--lh', String(p.size));
      if (A.isWebUrl(p.url)) {
        const a = document.createElement('a');
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.append(img);
        span.append(a);
      } else {
        span.append(img);
      }
      return span;
    }));
    ui.previewEmpty.hidden = shown.length > 0;
  }

  // ---------- logos ----------

  async function upload(input, p, li) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    status(li, p, { text: 'Preparing the logo…' });
    let prepared;
    try {
      prepared = await prepareLogo(file);
    } catch (err) {
      status(li, p, { text: err.message, warn: true });
      return;
    }
    status(li, p, { text: 'Uploading…' });
    const r = await fetch('/api/admin/logos', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': prepared.blob.type }, body: prepared.blob })
      .then(async (res) => ({ ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }))
      .catch(() => ({ ok: false, status: 0, body: {} }));
    if (r.status === 401) { status(li, p, { text: 'You were signed out. Sign in again, then upload the logo again.', warn: true }); app.showSignin('Your session ended. Sign in to keep editing.'); return; }
    if (!r.ok) { status(li, p, { text: r.status === 413 ? 'That logo is too large even after shrinking. Try a simpler file.' : 'The upload didn’t work. Try again.', warn: true }); return; }
    p.logo = r.body.logo;
    p.size = prepared.suggestedSize;
    bar.set(true);
    render();
    const fresh = ui.rows.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
    if (fresh) {
      status(fresh, p, prepared.solidBackground
        ? { text: 'This logo has a solid background, which shows as a box on the website. A PNG or SVG with a transparent background looks better.', warn: true }
        : { text: 'Logo ready. Press Save changes to publish it.' });
      fresh.querySelector('.adm-upload input').focus();
    }
  }

  // Draws the file on a canvas, trims see-through edges, and shrinks it to fit 660x260, the
  // size the site's logos use. Also suggests a size so wide and tall logos look balanced.
  async function prepareLogo(file) {
    if (file.size > MAX_FILE) throw new Error('That file is over 10 MB. Use a smaller logo file.');
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error('Use a PNG, JPG, WebP or SVG file.');
    const img = await A.loadImage(file);
    let w = img.width || img.naturalWidth || LOGO_BOX.w;
    let h = img.height || img.naturalHeight || LOGO_BOX.h;
    // Work at up to twice the final size; vector files (SVG) are drawn that big too.
    const work = Math.min((LOGO_BOX.w * 2) / w, (LOGO_BOX.h * 2) / h, file.type === 'image/svg+xml' ? Infinity : 1);
    w = Math.max(1, Math.round(w * work));
    h = Math.max(1, Math.round(h * work));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) throw new Error('That image is completely transparent.');
    const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
    const solidBackground = corners.every(([x, y]) => data[(y * w + x) * 4 + 3] > 250);

    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const fit = Math.min(LOGO_BOX.w / bw, LOGO_BOX.h / bh, 1);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(bw * fit));
    out.height = Math.max(1, Math.round(bh * fit));
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(c, x0, y0, bw, bh, 0, 0, out.width, out.height);

    let blob = await A.toBlob(out, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') blob = await A.toBlob(out, 'image/png');
    if (!blob) throw new Error('This browser couldn’t prepare the logo. Try Chrome.');

    // Wide logos are set smaller and tall ones larger, as on the live strip.
    const ratio = out.width / out.height;
    const suggestedSize = Math.round(Math.min(1.25, Math.max(0.45, 1.05 / Math.sqrt(ratio))) * 100) / 100;
    return { blob, suggestedSize, solidBackground };
  }
})();
