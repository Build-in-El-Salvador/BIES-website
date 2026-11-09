// Shared by the website admin tools (/admin/ photos, /admin/partners/): sign-in, sign-out,
// the save bar at the bottom, and calls to the server (src/admin.js).
window.BIESAdmin = (() => {
  const $ = (sel) => document.querySelector(sel);

  async function api(path, opts = {}) {
    try {
      const res = await fetch(`/api/admin/${path}`, { credentials: 'same-origin', ...opts });
      let body = null;
      try { body = await res.json(); } catch (_) { /* empty */ }
      return { ok: res.ok, status: res.status, body: body || {} };
    } catch (_) {
      return { ok: false, status: 0, body: {} };
    }
  }

  function sendJson(path, method, data) {
    return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  }

  function isWebUrl(s) {
    if (!s) return false;
    try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (_) { return false; }
  }

  // The save bar: "Save changes" plus a status line. onSave() returns { ok, message }.
  function saveBar(onSave) {
    const button = $('#save');
    const status = $('#save-status');
    let dirty = false;
    let saving = false;
    const show = (text, kind = '') => { status.textContent = text; status.className = kind; };
    const set = (value) => {
      dirty = value;
      button.disabled = !dirty || saving;
      show(dirty ? 'You have unsaved changes.' : 'All changes saved.', dirty ? 'is-dirty' : '');
    };
    button.addEventListener('click', async () => {
      saving = true;
      button.disabled = true;
      show('Saving…');
      const r = await onSave();
      saving = false;
      if (r.ok) { set(false); show(r.message, 'is-ok'); } else { button.disabled = !dirty; if (r.message) show(r.message, 'is-error'); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
    return { set, show, isDirty: () => dirty };
  }

  // Shows sign-in, the "not switched on" note, or the tool. onReady() loads the tool.
  function boot({ onReady, isDirty }) {
    const ui = {
      loading: $('#loading'), setup: $('#setup'), signin: $('#signin'), editor: $('#editor'),
      password: $('#password'), error: $('#signin-error'), signout: $('#signout'),
    };

    function showSignin(message = '') {
      ui.editor.hidden = true;
      ui.signout.hidden = true;
      ui.signin.hidden = false;
      ui.error.textContent = message;
      ui.password.focus();
    }

    async function open() {
      ui.signin.hidden = true;
      const ok = await onReady();
      if (ok === 'signed_out') return showSignin();
      if (!ok) { ui.loading.hidden = false; ui.loading.textContent = 'This could not be loaded. Reload the page to try again.'; return; }
      ui.editor.hidden = false;
      ui.signout.hidden = false;
    }

    ui.signin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = ui.password.value;
      if (!password) { ui.error.textContent = 'Enter the admin password.'; return; }
      ui.error.textContent = '';
      const r = await sendJson('login', 'POST', { password });
      if (r.ok) { ui.password.value = ''; return open(); }
      ui.error.textContent = r.status === 401 ? 'That password isn’t right. Check the BIES Bitwarden and try again.'
        : r.status === 429 ? 'Too many tries. Wait 15 minutes, then try again.'
        : 'Sign-in didn’t work. Check your connection and try again.';
    });

    ui.signout.addEventListener('click', async () => {
      if (isDirty() && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
      await api('logout', { method: 'POST' });
      window.location.reload();
    });

    (async () => {
      const r = await api('session');
      ui.loading.hidden = true;
      if (!r.ok) { ui.loading.hidden = false; ui.loading.textContent = 'The admin page could not reach the website. Check your connection and reload.'; return; }
      if (!r.body.configured) { ui.setup.hidden = false; return; }
      if (r.body.signedIn) return open();
      showSignin();
    })();

    return { showSignin };
  }

  // Loads an image file (any size, EXIF rotation applied) as something canvas can draw.
  async function loadImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fall back */ }
    }
    const src = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('That file couldn’t be opened as an image. If it came from an iPhone, save it as JPG first.'));
        el.src = src;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(src), 1000);
    }
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  return { api, sendJson, isWebUrl, saveBar, boot, loadImage, toBlob };
})();
