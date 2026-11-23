// Shared header, footer and small page widgets used on every public page.
(() => {
  const emailAlertButton = document.createElement('a');
  emailAlertButton.className = 'floating-email-cta floating-action';
  emailAlertButton.href = document.querySelector('#email-alert-section') ? '#email-alert-section' : '/#email-alert-section';
  emailAlertButton.setAttribute('aria-label', 'Get email alerts');
  emailAlertButton.innerHTML = '<i class="ph ph-bell" aria-hidden="true"></i><span>Get email alerts</span>';

  const donationButton = document.createElement('button');
  donationButton.type = 'button';
  donationButton.className = 'floating-donation-cta floating-action';
  donationButton.setAttribute('aria-label', 'Support BoardExamTracker');
  donationButton.setAttribute('aria-haspopup', 'dialog');
  donationButton.title = 'Support Us';
  donationButton.innerHTML = '<span class="donation-gift-icon" aria-hidden="true">🎁</span><span>Support Us</span>';

  const floatingActions = document.createElement('div');
  floatingActions.className = 'floating-actions';
  floatingActions.append(donationButton, emailAlertButton);
  document.body.append(floatingActions);

  // Donation pop-up
  const DONATION_SEEN_KEY = 'boardexamtracker:donation-popup:last-seen';
  const DONATION_SEEN_DAYS = 7;
  const donationDialog = document.createElement('dialog');
  donationDialog.className = 'donation-dialog';
  donationDialog.setAttribute('aria-labelledby', 'donation-dialog-title');
  donationDialog.innerHTML = `
    <div class="donation-dialog-inner">
      <button type="button" class="dialog-close donation-close" aria-label="Close donation pop-up"><i class="ph ph-x" aria-hidden="true"></i></button>
      <p class="donation-support-title">Support BoardExamTracker 💙</p>
      <h2 id="donation-dialog-title">Help Us Keep BoardExamTracker Free!</h2>
      <p class="donation-description">Help us keep BoardExamTracker free and ad-free! Your voluntary donation will help cover website hosting, maintenance, and operating expenses. Every contribution, no matter how small, is greatly appreciated.</p>
      <section class="donation-qr-section" hidden>
        <p class="donation-qr-label">Scan to Donate</p>
        <div class="donation-qr-frame"><img class="donation-qr-image" alt="Donation QR code" loading="lazy" decoding="async"></div>
      </section>
      <p class="donation-disclaimer">Donations are completely optional. No payment is required to access or use any BoardExamTracker feature. The website will remain free for everyone.</p>
      <div class="donation-actions-row">
        <button type="button" class="btn btn-outline donation-later">Maybe Later</button>
      </div>
    </div>`;
  document.body.append(donationDialog);

  const donationClose = donationDialog.querySelector('.donation-close');
  const donationLater = donationDialog.querySelector('.donation-later');
  const donationQrSection = donationDialog.querySelector('.donation-qr-section');
  const donationQrImage = donationDialog.querySelector('.donation-qr-image');

  function markDonationSeen() {
    try { localStorage.setItem(DONATION_SEEN_KEY, String(Date.now())); } catch {}
  }

  function canAutoShowDonation() {
    try {
      const lastSeen = Number(localStorage.getItem(DONATION_SEEN_KEY) || 0);
      return !lastSeen || Date.now() - lastSeen >= DONATION_SEEN_DAYS * 24 * 60 * 60 * 1000;
    } catch {
      return false;
    }
  }

  async function refreshDonationQr() {
    try {
      const response = await fetch('/api/donation/settings', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load donation settings');
      const data = await response.json();
      if (data && data.hasQr && data.qrImageUrl) {
        donationQrImage.src = data.qrImageUrl;
        donationQrSection.hidden = false;
      } else {
        donationQrImage.removeAttribute('src');
        donationQrSection.hidden = true;
      }
    } catch {
      donationQrImage.removeAttribute('src');
      donationQrSection.hidden = true;
    }
  }

  async function openDonationPopup({ automatic = false } = {}) {
    await refreshDonationQr();
    if (!donationDialog.open) donationDialog.showModal();
    if (automatic) markDonationSeen();
  }

  function dismissDonationPopup() {
    markDonationSeen();
    if (donationDialog.open) donationDialog.close();
  }

  donationButton.addEventListener('click', () => { openDonationPopup({ automatic: false }); });
  donationClose.addEventListener('click', dismissDonationPopup);
  donationLater.addEventListener('click', dismissDonationPopup);
  donationDialog.addEventListener('click', (event) => {
    if (event.target === donationDialog) dismissDonationPopup();
  });
  donationDialog.addEventListener('cancel', () => {
    markDonationSeen();
  });

  if (canAutoShowDonation()) {
    window.setTimeout(() => {
      if (canAutoShowDonation() && !donationDialog.open) {
        openDonationPopup({ automatic: true });
      }
    }, 4000);
  }

  // Desktop header: the Professions dropdown. Phones and tablets use the bottom tab bar instead.
  document.querySelectorAll('.nav-drop').forEach((drop) => {
    const button = drop.querySelector('button');
    const panel = drop.querySelector('.drop-panel');
    const setOpen = (open) => { button.setAttribute('aria-expanded', String(open)); panel.hidden = !open; };
    button.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('click', (event) => { if (!drop.contains(event.target)) setOpen(false); });
    drop.addEventListener('keydown', (event) => { if (event.key === 'Escape') { setOpen(false); button.focus(); } });
  });

  const disclaimerDialog = document.querySelector('#disclaimer-dialog');
  if (disclaimerDialog) {
    document.querySelector('#open-disclaimer')?.addEventListener('click', () => disclaimerDialog.showModal());
    document.querySelector('#disclaimer-close')?.addEventListener('click', () => disclaimerDialog.close());
    disclaimerDialog.addEventListener('click', (event) => { if (event.target === disclaimerDialog) disclaimerDialog.close(); });
  }
  const year = document.querySelector('#year');
  if (year) year.textContent = new Date().getFullYear();

  // Homepage "Access PRC Archives": point the button at the chosen year on PRC.gov.ph.
  const archiveYear = document.querySelector('#archive-year');
  const archiveLink = document.querySelector('#archive-link');
  if (archiveYear && archiveLink) {
    const syncArchive = () => { archiveLink.href = `https://www.prc.gov.ph/archives/${encodeURIComponent(archiveYear.value)}`; };
    archiveYear.addEventListener('change', syncArchive);
    syncArchive();
  }

  // Results filters: always open beside the list on desktop, collapsible above it on smaller screens.
  const filterPanel = document.querySelector('#result-filters');
  if (filterPanel) {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const hasActiveFilter = ['q', 'profession', 'year'].some((key) => new URLSearchParams(location.search).get(key));
    filterPanel.open = desktop.matches || hasActiveFilter || location.hash === '#result-search';
    if (location.hash === '#result-search') document.querySelector('#search-input')?.focus({ preventScroll: true });
    filterPanel.querySelector('summary').addEventListener('click', (event) => { if (desktop.matches) event.preventDefault(); });
    desktop.addEventListener('change', (event) => { if (event.matches) filterPanel.open = true; });
  }

  // Professions directory: filter the static list as the visitor types.
  const professionSearch = document.querySelector('#profession-search');
  if (professionSearch) {
    const tiles = [...document.querySelectorAll('#profession-directory .prof-tile')];
    const shown = document.querySelector('#profession-shown');
    const empty = document.querySelector('#profession-empty');
    const filterTiles = () => {
      const terms = professionSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
      let visible = 0;
      tiles.forEach((tile) => {
        const match = terms.every((term) => tile.dataset.keywords.includes(term));
        tile.hidden = !match;
        if (match) visible += 1;
      });
      if (shown) shown.textContent = visible;
      if (empty) empty.hidden = visible !== 0;
    };
    professionSearch.addEventListener('input', filterTiles);
    professionSearch.closest('form')?.addEventListener('submit', (event) => { event.preventDefault(); filterTiles(); });
    const initial = new URLSearchParams(location.search).get('q');
    if (initial) professionSearch.value = initial;
    filterTiles();
  }
})();
