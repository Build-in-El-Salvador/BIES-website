(() => {
  const dialog = document.getElementById('membership-interview');
  if (typeof dialog.showModal !== 'function') return;

  const title = document.getElementById('interview-title');
  const calendar = document.getElementById('interview-calendar');
  const status = document.getElementById('interview-calendar-status');
  const booking = document.getElementById('interview-booking');
  const email = document.getElementById('interview-email');
  const confirmed = document.getElementById('interview-confirmed');
  let trigger;
  let booked = false;
  let started = false;

  let calendarUrl;
  try {
    const url = new URL(dialog.dataset.calendlyUrl);
    if (url.origin === 'https://calendly.com' && url.pathname.split('/').filter(Boolean).length >= 2) calendarUrl = url;
  } catch { /* Use email scheduling until the interview URL is configured. */ }

  function loadCalendar() {
    if (!calendarUrl || started) return;
    started = true;
    status.hidden = false;
    status.textContent = 'Loading interview calendar…';
    const script = document.createElement('script');
    script.src = 'https://assets.calendly.com/assets/external/widget.js';
    const unavailable = () => {
      calendar.hidden = true;
      calendar.replaceChildren();
      status.textContent = 'The calendar couldn’t load. Email us above to schedule.';
      script.remove();
      started = false;
    };
    script.addEventListener('load', () => {
      try {
        calendar.hidden = false;
        window.Calendly.initInlineWidget({ url: calendarUrl.href, parentElement: calendar });
        const frame = calendar.querySelector('iframe');
        if (!frame) return unavailable();
        frame.title = 'Book your BIES membership interview';
        status.hidden = true;
      } catch {
        unavailable();
      }
    }, { once: true });
    script.addEventListener('error', unavailable, { once: true });
    document.head.append(script);
  }

  for (const link of document.querySelectorAll('[data-interview]')) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      trigger = link;
      const plan = link.closest('.plan');
      const name = plan.querySelector('h3').textContent;
      const annual = document.getElementById('annual').checked;
      const amount = plan.querySelector(annual ? '.price-line.annual .amount' : '.price-line.monthly .amount').textContent;
      const period = annual ? 'Annual' : 'Monthly';
      document.getElementById('interview-plan').textContent = `${name} · ${amount}/${annual ? 'year' : 'month'}`;
      document.getElementById('interview-selection').textContent = `On Satlantis, choose ${name} → ${period}.`;
      email.href = link.href;
      dialog.showModal();
      dialog.scrollTop = 0;
      if (!booked) loadCalendar();
    });
  }

  window.addEventListener('message', (event) => {
    const frame = calendar.querySelector('iframe');
    // This only changes the page. BIES approves after checking the applicant and interview.
    if (!calendarUrl || !frame || booked || event.origin !== calendarUrl.origin ||
        event.source !== frame.contentWindow || event.data?.event !== 'calendly.event_scheduled') return;
    booked = true;
    title.textContent = 'Interview booked';
    booking.hidden = true;
    confirmed.hidden = false;
    dialog.scrollTop = 0;
    if (dialog.open) title.focus();
  });

  dialog.querySelector('.interview-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => trigger?.focus());
})();
