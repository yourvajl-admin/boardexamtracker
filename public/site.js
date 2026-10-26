// Shared header, footer and small page widgets used on every public page.
(() => {
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
