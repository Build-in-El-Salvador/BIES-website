// Home page, "What Members Are Saying": click a member's card (or its "Read full quote"
// button) to show that member's full quote in the highlight above. The member who was in
// the highlight takes the card's place, with their short quote.
//
// Every member is written once in index.html. The highlight (#member-spot) shows the full
// quote and keeps the short one in data-short; each card shows the short quote and keeps the
// full one in data-long. This script only moves those between the two spots, so editing a
// quote means editing index.html in one place.
(() => {
  const band = document.querySelector('.members');
  const spot = band && band.querySelector('#member-spot');
  const cards = band ? [...band.querySelectorAll('.member-card')] : [];
  if (!spot || !cards.length) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LONG_QUOTE = 420; // characters; a longer full quote is set smaller in the highlight
  const FADE_MS = 160;

  function read(el, isSpot) {
    const quote = el.querySelector('blockquote');
    const shown = (isSpot ? quote : quote.querySelector('p')).textContent.trim();
    return {
      key: el.dataset.member,
      photo: el.querySelector('img').getAttribute('src'),
      name: el.querySelector('.m-name').textContent,
      // The role is the site's own markup (links to members' businesses), never visitor input.
      role: el.querySelector('.m-role').innerHTML,
      loc: el.querySelector(isSpot ? '.fq-loc' : '.loc').textContent.trim(),
      short: isSpot ? quote.dataset.short : shown,
      long: isSpot ? shown : quote.dataset.long,
    };
  }

  function write(el, m, isSpot) {
    el.dataset.member = m.key;
    const img = el.querySelector('img');
    img.src = m.photo;
    img.alt = m.name;
    el.querySelector('.m-name').textContent = m.name;
    const role = el.querySelector('.m-role');
    role.innerHTML = m.role;
    role.hidden = !m.role;
    const loc = el.querySelector(isSpot ? '.fq-loc' : '.loc'); // the text after the pin icon
    if (loc.lastChild && loc.lastChild.nodeType === Node.TEXT_NODE) loc.lastChild.textContent = m.loc;
    else loc.append(m.loc);
    loc.hidden = !m.loc;
    const quote = el.querySelector('blockquote');
    if (isSpot) {
      quote.textContent = m.long;
      quote.dataset.short = m.short;
      quote.classList.toggle('is-long', m.long.length > LONG_QUOTE);
    } else {
      quote.querySelector('p').textContent = m.short;
      quote.dataset.long = m.long;
      el.querySelector('.member-more').setAttribute('aria-label', `Read ${m.name}’s full quote`);
    }
  }

  function bringIntoView() {
    const top = spot.getBoundingClientRect().top;
    // On phones the highlight is above the cards and often off screen by now.
    if (top < 0 || top > window.innerHeight * 0.5) {
      spot.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function swap(card) {
    const was = read(spot, true);
    const now = read(card, false);
    const apply = () => { write(spot, now, true); write(card, was, false); };
    if (reduceMotion.matches) {
      apply();
    } else {
      spot.classList.add('is-fading');
      card.classList.add('is-fading');
      setTimeout(() => {
        apply();
        spot.classList.remove('is-fading');
        card.classList.remove('is-fading');
      }, FADE_MS);
    }
    bringIntoView();
  }

  write(spot, read(spot, true), true); // sets the size for the first full quote
  for (const card of cards) {
    const more = card.querySelector('.member-more');
    more.hidden = false;
    card.classList.add('is-pickable');
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // links to a member's business still just open the link
      swap(card);
    });
  }
})();
