// About page: draw "Partners and Collaborators" from /api/partners, the list BIES admins
// edit on /admin/ (see src/partners.js). The logos written into about.html stay as they are
// if the list can't be loaded, so the strip is never empty.
(() => {
  const strip = document.querySelector('.logo-strip[data-partners]');
  if (!strip || !window.fetch) return;
  const LOGO_PATH = /^\/(assets\/images\/partners|partner-logos)\/[A-Za-z0-9._-]+$/;

  const isWebUrl = (s) => {
    try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (_) { return false; }
  };

  fetch('/api/partners', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const list = data && Array.isArray(data.partners) ? data.partners : [];
      const items = [];
      for (const p of list) {
        if (!p || typeof p.name !== 'string' || typeof p.logo !== 'string' || !LOGO_PATH.test(p.logo)) continue;
        const span = document.createElement('span');
        const img = document.createElement('img');
        img.src = p.logo;
        img.alt = p.name;
        img.loading = 'lazy';
        const size = Number(p.size);
        img.style.setProperty('--lh', String(size >= 0.4 && size <= 1.6 ? size : 1));
        if (typeof p.url === 'string' && isWebUrl(p.url)) {
          const a = document.createElement('a');
          a.href = p.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.append(img);
          span.append(a);
        } else {
          span.append(img);
        }
        items.push(span);
      }
      if (items.length) strip.replaceChildren(...items);
    })
    .catch(() => { /* keep the logos already on the page */ });
})();
