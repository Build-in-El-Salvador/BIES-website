/* team.js — the About page's Meet the Team cards (about.html). Vanilla JS, no libraries.
 *
 * Each card is a button that opens that person's bio, one at a time. Clicking another
 * card switches to it; clicking the open card again, clicking anywhere else on the page,
 * or pressing Escape closes it.
 *
 * A bio spans the full width under its card's row. The cards wrap into rows of 5, 3, 2
 * or 1 depending on the screen, so every card gets an even flex `order` and the open bio
 * is slotted in (at an odd one) straight after the last card of that row.
 */
(() => {
  'use strict';

  const grid = document.querySelector('.team-grid');
  if (!grid) return;
  const cards = [...grid.querySelectorAll('.member')];
  const bioOf = (btn) => document.getElementById(btn.getAttribute('aria-controls'));
  const inside = (el) => el instanceof Element && el.closest('.member-btn, .bio');
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let open = null; // the button whose bio is showing

  cards.forEach((card, i) => { card.style.order = i * 2; });

  // Slot the bio in after the last card of btn's row, and aim its caret at btn.
  function place(btn, bio) {
    const card = btn.parentElement;
    bio.style.order = cards.length * 2; // after every card, so the rows are the cards' own
    let last = cards.indexOf(card);
    cards.forEach((c, i) => { if (c.offsetTop === card.offsetTop) last = Math.max(last, i); });
    bio.style.order = last * 2 + 1;
    const b = btn.getBoundingClientRect();
    bio.style.setProperty('--caret-x', `${b.left + b.width / 2 - bio.getBoundingClientRect().left}px`);
  }

  function close(animate) {
    if (!open) return;
    const btn = open;
    const bio = bioOf(btn);
    open = null;
    btn.setAttribute('aria-expanded', 'false');
    bio.getAnimations().forEach((a) => a.cancel());
    if (!animate || still.matches) { bio.hidden = true; return; }
    const shrink = bio.animate(
      [{ height: `${bio.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: 220, easing: 'ease-in', fill: 'forwards' });
    shrink.onfinish = () => { bio.hidden = true; shrink.cancel(); };
  }

  function show(btn) {
    const cardTop = btn.getBoundingClientRect().top;
    const prev = open && bioOf(open);
    const prevTop = prev ? prev.offsetTop : -1;
    close(false);
    const bio = bioOf(btn);
    bio.getAnimations().forEach((a) => a.cancel());
    bio.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    open = btn;
    place(btn, bio);
    // Closing a bio above this card moved the card up: scroll so it stays where it was.
    // 'instant', because the page sets scroll-behavior:smooth and a glide reads as a jump.
    const moved = btn.getBoundingClientRect().top - cardTop;
    if (moved) window.scrollBy({ top: moved, behavior: 'instant' });
    const bringIntoView = () => bio.scrollIntoView({ block: 'nearest', behavior: still.matches ? 'instant' : 'smooth' });
    if (still.matches) { bringIntoView(); return; }
    if (bio.offsetTop === prevTop) {
      // Another card in the same row: swap the words in place.
      bio.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      bringIntoView();
      return;
    }
    const grow = bio.animate(
      [{ height: '0px', opacity: 0 }, { height: `${bio.offsetHeight}px`, opacity: 1 }],
      { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' });
    grow.onfinish = bringIntoView;
  }

  grid.querySelectorAll('.member-btn').forEach((btn) => {
    btn.addEventListener('click', () => (open === btn ? close(true) : show(btn)));
  });

  // Clicking anywhere but a card or the open bio closes it. Pointer events rather than
  // click: iOS Safari can skip click events on non-interactive elements, and a touch that
  // turns into a scroll ends in pointercancel, so scrolling past doesn't close the bio.
  let downOutside = false;
  document.addEventListener('pointerdown', (e) => {
    downOutside = Boolean(open) && e.button === 0 && !inside(e.target);
  });
  document.addEventListener('pointerup', (e) => {
    if (downOutside && open && !inside(e.target)) close(true);
    downOutside = false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    const btn = open;
    close(true);
    btn.focus();
  });

  // The rows change with the window width, so re-slot the open bio.
  let frame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (open) place(open, bioOf(open)); });
  });
})();
