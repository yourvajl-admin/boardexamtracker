const views = ['loading-view', 'setup-view', 'login-view', 'dashboard-view'];
const loginForm = document.querySelector('#login-form');
const loginStatus = document.querySelector('#login-status');
const dashboardStatus = document.querySelector('#dashboard-status');
const subscriberRows = document.querySelector('#subscriber-rows');
const subscriberEmpty = document.querySelector('#subscriber-empty');
const searchInput = document.querySelector('#subscriber-search');
const subscriberSort = document.querySelector('#subscriber-sort');
const subscriberPagination = document.querySelector('#subscriber-pagination');
const themeToggle = document.querySelector('#theme-toggle');
const latestAlertForm = document.querySelector('#latest-alert-form');
const latestAlertStatus = document.querySelector('#latest-alert-status');
const adsToggleButton = document.querySelector('#ads-toggle-button');
const adsControlStatus = document.querySelector('#ads-control-status');
const blogPostList = document.querySelector('#admin-blog-posts');
const blogAdminStatus = document.querySelector('#blog-admin-status');
const blogPostDialog = document.querySelector('#blog-post-dialog');
const blogPostForm = document.querySelector('#blog-post-form');
const blogPostTitle = document.querySelector('#blog-post-title');
const blogPostBody = document.querySelector('#blog-post-body');
const blogPhotoInput = document.querySelector('#blog-post-photo');
const blogPhotoPreview = document.querySelector('#blog-photo-preview');
const removeBlogPhotoButton = document.querySelector('#remove-blog-photo');
const donationForm = document.querySelector('#donation-form');
const donationQrInput = document.querySelector('#donation-qr-input');
const donationCurrentPreview = document.querySelector('#donation-current-preview');
const donationSelectedPreview = document.querySelector('#donation-selected-preview');
const donationCurrentStatus = document.querySelector('#donation-current-status');
const donationStatus = document.querySelector('#donation-status');
const donationSaveButton = document.querySelector('#donation-save-button');
const donationRemoveButton = document.querySelector('#donation-remove-button');
let subscribers = [];
let viewerRefreshTimer = null;
let blogPosts = [];
let editingBlogPost = null;
let removeExistingBlogPhoto = false;
let blogPhotoObjectUrl = null;
let donationSelectedObjectUrl = null;
let donationHasQr = false;
let subscriberPage = 1;
const SUBSCRIBERS_PER_PAGE = 50;

function showView(id) {
  views.forEach((viewId) => { document.getElementById(viewId).hidden = viewId !== id; });
  document.querySelector('.admin-shell').classList.toggle('is-dashboard', id === 'dashboard-view');
}

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function setDashboardStatus(message, type = '') {
  dashboardStatus.textContent = message;
  dashboardStatus.className = `notice ${type}`.trim();
  dashboardStatus.hidden = !message;
}

function renderSubscribers() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = subscribers
    .filter((subscriber) => subscriber.email.toLowerCase().includes(query))
    .sort((a, b) => {
      const aCreatedAt = Number(a.createdAt ?? a.confirmedAt ?? 0);
      const bCreatedAt = Number(b.createdAt ?? b.confirmedAt ?? 0);
      const byDate = subscriberSort.value === 'newest' ? bCreatedAt - aCreatedAt : aCreatedAt - bCreatedAt;
      return byDate || a.email.localeCompare(b.email);
    });
  const pageCount = Math.ceil(visible.length / SUBSCRIBERS_PER_PAGE);
  subscriberPage = Math.max(1, Math.min(subscriberPage, pageCount || 1));
  const start = (subscriberPage - 1) * SUBSCRIBERS_PER_PAGE;
  const pageSubscribers = visible.slice(start, start + SUBSCRIBERS_PER_PAGE);
  subscriberRows.replaceChildren();
  for (const subscriber of pageSubscribers) {
    const row = document.createElement('tr');
    const emailCell = document.createElement('td');
    const statusCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'subscriber-actions';
    const resendButton = document.createElement('button');
    const button = document.createElement('button');
    emailCell.textContent = subscriber.email;
    statusCell.textContent = subscriber.status;
    resendButton.className = 'resend-button';
    resendButton.type = 'button';
    resendButton.textContent = 'Resend alert';
    resendButton.disabled = subscriber.status !== 'Confirmed';
    resendButton.title = resendButton.disabled ? 'Only confirmed subscribers can receive alerts.' : `Send the latest result alert to ${subscriber.email}`;
    resendButton.setAttribute('aria-label', `Resend latest result alert to ${subscriber.email}`);
    resendButton.addEventListener('click', () => resendSubscriberAlert(subscriber.email, resendButton));
    button.className = 'unsubscribe-button';
    button.type = 'button';
    button.textContent = 'Unsubscribe';
    button.setAttribute('aria-label', `Unsubscribe ${subscriber.email}`);
    button.addEventListener('click', () => unsubscribeSubscriber(subscriber.email, button));
    actions.append(resendButton, button);
    actionCell.append(actions);
    row.append(emailCell, statusCell, actionCell);
    subscriberRows.append(row);
  }
  document.querySelector('#subscriber-count').textContent = visible.length
    ? `Showing ${start + 1}–${Math.min(start + SUBSCRIBERS_PER_PAGE, visible.length)} of ${visible.length} matching · ${subscribers.length} total`
    : `0 matching · ${subscribers.length} total`;
  subscriberEmpty.hidden = visible.length !== 0;
  subscriberEmpty.textContent = subscribers.length ? 'No subscriber emails match this search.' : 'No subscribers yet.';
  renderSubscriberPagination(pageCount);
}

function renderSubscriberPagination(pageCount) {
  subscriberPagination.replaceChildren();
  subscriberPagination.hidden = pageCount <= 1;
  if (pageCount <= 1) return;

  const addPageButton = (label, page, { current = false, disabled = false } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-button';
    button.textContent = label;
    button.disabled = disabled;
    if (current) button.setAttribute('aria-current', 'page');
    if (/^\d+$/.test(label)) button.setAttribute('aria-label', `Page ${label}`);
    button.addEventListener('click', () => {
      subscriberPage = page;
      renderSubscribers();
    });
    subscriberPagination.append(button);
  };

  addPageButton('Previous', subscriberPage - 1, { disabled: subscriberPage === 1 });
  const pages = pageCount <= 5
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : subscriberPage <= 3
      ? [1, 2, 3, '…', pageCount]
      : subscriberPage >= pageCount - 2
        ? [1, '…', pageCount - 2, pageCount - 1, pageCount]
        : [1, '…', subscriberPage - 1, subscriberPage, subscriberPage + 1, '…', pageCount];
  for (const page of pages) {
    if (page === '…') {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'page-ellipsis';
      ellipsis.textContent = page;
      subscriberPagination.append(ellipsis);
    } else {
      addPageButton(String(page), page, { current: page === subscriberPage });
    }
  }
  addPageButton('Next', subscriberPage + 1, { disabled: subscriberPage === pageCount });
}

async function resendSubscriberAlert(email, button) {
  if (!window.confirm(`Resend the latest board exam result alert to ${email}?`)) return;
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const data = await request('/api/admin/subscribers/resend-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    button.textContent = 'Sent · wait 1 min';
    setDashboardStatus(`Latest result alert sent to ${email}: ${data.title}`, 'good');
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      button.textContent = 'Resend alert';
    }, 60_000);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Resend alert';
    setDashboardStatus(error.message, 'bad');
  }
}

async function unsubscribeSubscriber(email, button) {
  if (!window.confirm(`Remove ${email} from BoardExamTracker email alerts?`)) return;
  button.disabled = true;
  try {
    await request('/api/admin/subscribers/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    subscribers = subscribers.filter((subscriber) => subscriber.email !== email);
    renderSubscribers();
    setDashboardStatus(`${email} has been unsubscribed.`, 'good');
  } catch (error) {
    button.disabled = false;
    setDashboardStatus(error.message, 'bad');
  }
}

async function refreshViewerCount() {
  const count = document.querySelector('#viewer-count');
  const label = document.querySelector('#viewer-status');
  try {
    const data = await request('/api/admin/viewers');
    if (data.shared) {
      count.textContent = String(data.count);
      label.textContent = 'Active site sessions within the last 90 seconds';
    } else if (data.production) {
      count.textContent = '—';
      label.textContent = 'Add shared Upstash Redis storage in Vercel for a live count';
    } else {
      count.textContent = String(data.count);
      label.textContent = 'Local server count only; shared Redis enables reliable deployed counts';
    }
  } catch (error) {
    count.textContent = '—';
    label.textContent = error.message;
  }
}

function setDonationStatus(message, type = '') {
  donationStatus.textContent = message;
  donationStatus.className = `status ${type}`.trim();
}

function clearDonationSelectedPreview() {
  if (donationSelectedObjectUrl) URL.revokeObjectURL(donationSelectedObjectUrl);
  donationSelectedObjectUrl = null;
  donationQrInput.value = '';
  donationSelectedPreview.innerHTML = '<p class="donation-preview-empty">No new image selected.</p>';
}

function renderDonationCurrentPreview(data) {
  donationHasQr = Boolean(data.hasQr && data.qrImageUrl);
  donationCurrentPreview.replaceChildren();
  if (donationHasQr) {
    const img = document.createElement('img');
    img.src = data.qrImageUrl;
    img.alt = 'Current donation QR code';
    img.loading = 'lazy';
    donationCurrentPreview.append(img);
    const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : 'recently';
    donationCurrentStatus.textContent = `QR code uploaded · Updated ${updated}`;
  } else {
    const empty = document.createElement('p');
    empty.className = 'donation-preview-empty';
    empty.textContent = 'No QR code uploaded.';
    donationCurrentPreview.append(empty);
    donationCurrentStatus.textContent = 'No QR code uploaded. The QR section is hidden on the public donation pop-up.';
  }
  donationRemoveButton.disabled = !donationHasQr;
  donationSaveButton.disabled = false;
}

async function loadDonationSettings() {
  setDonationStatus('');
  try {
    const data = await request('/api/admin/donation');
    if (data.persistentStorage === false) {
      donationCurrentStatus.textContent = 'Shared storage is required to manage the donation QR code.';
      donationSaveButton.disabled = true;
      donationRemoveButton.disabled = true;
      donationCurrentPreview.innerHTML = '<p class="donation-preview-empty">Persistent storage is not configured.</p>';
      setDonationStatus('Configure Upstash Redis REST credentials to upload, replace, or remove the donation QR code.', 'bad');
      return;
    }
    renderDonationCurrentPreview(data);
  } catch (error) {
    donationCurrentStatus.textContent = 'Could not load donation settings.';
    donationSaveButton.disabled = true;
    donationRemoveButton.disabled = true;
    setDonationStatus(error.message, 'bad');
  }
}

async function compressDonationQr(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP QR code image.');
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bitmap.width, 1200 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob;
  for (const quality of [0.92, 0.86, 0.8, 0.72, 0.64]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (blob && blob.size <= 950_000) break;
  }
  if (!blob || blob.size > 1_000_000) throw new Error('This QR code image is too large to optimize. Choose a smaller image.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected QR code image.'));
    reader.readAsDataURL(blob);
  });
}

donationQrInput.addEventListener('change', () => {
  const file = donationQrInput.files?.[0];
  if (donationSelectedObjectUrl) URL.revokeObjectURL(donationSelectedObjectUrl);
  donationSelectedObjectUrl = null;
  donationSelectedPreview.replaceChildren();
  if (!file) {
    donationSelectedPreview.innerHTML = '<p class="donation-preview-empty">No new image selected.</p>';
    return;
  }
  donationSelectedObjectUrl = URL.createObjectURL(file);
  const img = document.createElement('img');
  img.src = donationSelectedObjectUrl;
  img.alt = 'Selected donation QR code preview';
  donationSelectedPreview.append(img);
});

donationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = donationQrInput.files?.[0];
  if (!file) {
    setDonationStatus('Select a QR code image to preview and save.', 'bad');
    return;
  }
  donationSaveButton.disabled = true;
  donationRemoveButton.disabled = true;
  setDonationStatus('Saving QR code…');
  try {
    const image = await compressDonationQr(file);
    const data = await request('/api/admin/donation/qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    renderDonationCurrentPreview(data);
    clearDonationSelectedPreview();
    setDonationStatus('Donation QR code saved. The public donation pop-up will show the updated image.', 'good');
  } catch (error) {
    setDonationStatus(error.message, 'bad');
  } finally {
    donationSaveButton.disabled = false;
    donationRemoveButton.disabled = !donationHasQr;
  }
});

donationRemoveButton.addEventListener('click', async () => {
  if (!donationHasQr) return;
  if (!window.confirm('Remove the donation QR code from the public donation pop-up?')) return;
  donationSaveButton.disabled = true;
  donationRemoveButton.disabled = true;
  setDonationStatus('Removing QR code…');
  try {
    const data = await request('/api/admin/donation/qr', { method: 'DELETE' });
    renderDonationCurrentPreview(data);
    clearDonationSelectedPreview();
    setDonationStatus('Donation QR code removed. The QR section is now hidden on the public donation pop-up.', 'good');
  } catch (error) {
    setDonationStatus(error.message, 'bad');
  } finally {
    donationSaveButton.disabled = false;
    donationRemoveButton.disabled = !donationHasQr;
  }
});


function renderAdsControl(data) {
  adsToggleButton.setAttribute('aria-pressed', String(data.enabled));
  adsToggleButton.textContent = data.enabled ? 'Turn ads off' : 'Turn ads on';
  adsToggleButton.classList.toggle('is-on', data.enabled);
  adsToggleButton.disabled = !data.configured || (data.production && !data.persistentStorage);
  if (!data.configured) {
    adsControlStatus.textContent = 'Add the AdSense publisher ID and display ad slot ID in Vercel before enabling ads.';
  } else if (data.production && !data.persistentStorage) {
    adsControlStatus.textContent = 'Shared Upstash Redis is required to save this setting reliably in production.';
  } else {
    adsControlStatus.textContent = data.enabled
      ? 'Ads are on. A newly detected exam result will turn them off automatically; open pages reflect changes within about 30 seconds.'
      : 'Ads are off. Review new results, then turn them on here when ready.';
  }
}

async function loadAdsControl() {
  try {
    renderAdsControl(await request('/api/admin/ads'));
  } catch (error) {
    adsToggleButton.disabled = true;
    adsControlStatus.textContent = error.message;
  }
}

function setBlogAdminStatus(message, type = '') {
  blogAdminStatus.textContent = message;
  blogAdminStatus.className = `status ${type}`.trim();
}

function renderAdminBlogPosts() {
  blogPostList.replaceChildren();
  if (!blogPosts.length) {
    const empty = document.createElement('p');
    empty.className = 'admin-blog-empty';
    empty.textContent = 'No posts yet. Select Create Post to publish the first one.';
    blogPostList.append(empty);
    return;
  }
  for (const post of blogPosts) {
    const card = document.createElement('article');
    card.className = 'admin-blog-card';
    if (post.imageUrl) {
      const image = document.createElement('img');
      image.src = post.imageUrl;
      image.alt = '';
      image.loading = 'lazy';
      card.append(image);
    }
    const copy = document.createElement('div');
    copy.className = 'admin-blog-copy';
    const title = document.createElement('h3');
    const date = document.createElement('small');
    const excerpt = document.createElement('p');
    const actions = document.createElement('div');
    const edit = document.createElement('button');
    const remove = document.createElement('button');
    title.textContent = post.title;
    date.textContent = `Updated ${new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(post.updatedAt))}`;
    excerpt.textContent = post.body.length > 180 ? `${post.body.slice(0, 180)}…` : post.body;
    actions.className = 'admin-blog-actions';
    edit.type = 'button';
    edit.className = 'secondary-button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openBlogEditor(post));
    remove.type = 'button';
    remove.className = 'unsubscribe-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteBlogPost(post));
    actions.append(edit, remove);
    copy.append(title, date, excerpt, actions);
    card.append(copy);
    blogPostList.append(card);
  }
}

async function loadAdminBlogPosts() {
  try {
    const data = await request('/api/admin/blog/posts');
    blogPosts = data.posts;
    renderAdminBlogPosts();
    setBlogAdminStatus(`${blogPosts.length} ${blogPosts.length === 1 ? 'post' : 'posts'} · visible on the public blog page.`, 'good');
  } catch (error) {
    setBlogAdminStatus(error.message, 'bad');
  }
}

function clearBlogPhotoObjectUrl() {
  if (blogPhotoObjectUrl) URL.revokeObjectURL(blogPhotoObjectUrl);
  blogPhotoObjectUrl = null;
}

function showBlogPhotoPreview(source) {
  clearBlogPhotoObjectUrl();
  if (!source) {
    blogPhotoPreview.removeAttribute('src');
    blogPhotoPreview.hidden = true;
    removeBlogPhotoButton.hidden = true;
    return;
  }
  blogPhotoPreview.src = source;
  blogPhotoPreview.hidden = false;
  removeBlogPhotoButton.hidden = false;
}

function openBlogEditor(post = null) {
  editingBlogPost = post;
  removeExistingBlogPhoto = false;
  blogPostForm.reset();
  blogPhotoInput.value = '';
  blogPostTitle.value = post?.title || '';
  blogPostBody.value = post?.body || '';
  document.querySelector('#blog-post-dialog-title').textContent = post ? 'Edit Post' : 'Create Post';
  document.querySelector('#save-blog-post').textContent = post ? 'Save Changes' : 'Publish Post';
  document.querySelector('#blog-dialog-status').textContent = '';
  showBlogPhotoPreview(post?.imageUrl || null);
  blogPostDialog.showModal();
  blogPostTitle.focus();
}

function closeBlogEditor() {
  if (blogPostDialog.open) blogPostDialog.close();
  clearBlogPhotoObjectUrl();
  blogPhotoPreview.removeAttribute('src');
}

async function compressBlogPhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bitmap.width, 1200 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob;
  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (blob && blob.size <= 950_000) break;
  }
  if (!blob || blob.size > 1_000_000) throw new Error('This photo is too large to optimize. Choose a smaller image.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected photo.'));
    reader.readAsDataURL(blob);
  });
}

async function deleteBlogPost(post) {
  if (!window.confirm(`Delete “${post.title}” from the public blog? This cannot be undone.`)) return;
  try {
    await request(`/api/admin/blog/posts/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
    setBlogAdminStatus(`Deleted “${post.title}”.`, 'good');
    await loadAdminBlogPosts();
  } catch (error) {
    setBlogAdminStatus(error.message, 'bad');
  }
}

document.querySelector('#create-blog-post').addEventListener('click', () => openBlogEditor());
document.querySelector('#close-blog-dialog').addEventListener('click', closeBlogEditor);
document.querySelector('#cancel-blog-post').addEventListener('click', closeBlogEditor);
blogPostDialog.addEventListener('click', (event) => {
  if (event.target === blogPostDialog) closeBlogEditor();
});
blogPhotoInput.addEventListener('change', () => {
  const file = blogPhotoInput.files?.[0];
  removeExistingBlogPhoto = false;
  if (!file) {
    showBlogPhotoPreview(editingBlogPost?.imageUrl || null);
    return;
  }
  clearBlogPhotoObjectUrl();
  blogPhotoObjectUrl = URL.createObjectURL(file);
  blogPhotoPreview.src = blogPhotoObjectUrl;
  blogPhotoPreview.hidden = false;
  removeBlogPhotoButton.hidden = false;
});
removeBlogPhotoButton.addEventListener('click', () => {
  blogPhotoInput.value = '';
  removeExistingBlogPhoto = true;
  showBlogPhotoPreview(null);
});
blogPostForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const saveButton = document.querySelector('#save-blog-post');
  const dialogStatus = document.querySelector('#blog-dialog-status');
  saveButton.disabled = true;
  dialogStatus.textContent = 'Saving post…';
  try {
    const payload = { title: blogPostTitle.value.trim(), body: blogPostBody.value.trim() };
    const selectedPhoto = blogPhotoInput.files?.[0];
    if (selectedPhoto) payload.image = await compressBlogPhoto(selectedPhoto);
    else if (!editingBlogPost || removeExistingBlogPhoto) payload.image = null;
    const url = editingBlogPost
      ? `/api/admin/blog/posts/${encodeURIComponent(editingBlogPost.id)}`
      : '/api/admin/blog/posts';
    await request(url, {
      method: editingBlogPost ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    closeBlogEditor();
    setBlogAdminStatus(editingBlogPost ? 'Post updated.' : 'Post published.', 'good');
    await loadAdminBlogPosts();
  } catch (error) {
    dialogStatus.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
});

adsToggleButton.addEventListener('click', async () => {
  const enabled = adsToggleButton.getAttribute('aria-pressed') !== 'true';
  adsToggleButton.disabled = true;
  adsToggleButton.textContent = 'Saving…';
  try {
    const data = await request('/api/admin/ads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    adsToggleButton.setAttribute('aria-pressed', String(data.enabled));
    adsToggleButton.textContent = data.enabled ? 'Turn ads off' : 'Turn ads on';
    adsToggleButton.classList.toggle('is-on', data.enabled);
    adsControlStatus.textContent = data.enabled
      ? 'Ads are on. A newly detected exam result will turn them off automatically; open pages reflect changes within about 30 seconds.'
      : 'Ads are off. Open pages will hide the placement within about 30 seconds.';
    await loadAdsControl();
  } catch (error) {
    adsControlStatus.textContent = error.message;
    await loadAdsControl();
  }
});

async function loadDashboard() {
  showView('dashboard-view');
  setDashboardStatus('Loading subscriber addresses…');
  try {
    const data = await request('/api/admin/subscribers');
    subscribers = data.subscribers;
    renderSubscribers();
    if (!data.persistentStorage && data.production) {
      setDashboardStatus('Persistent subscriber storage is not connected. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel to reliably store and manage subscribers.', 'bad');
    } else if (data.migration?.imported > 0) {
      setDashboardStatus(`Restored ${data.migration.imported} subscriber${data.migration.imported === 1 ? '' : 's'} from the previous Redis database. The original records were kept, and no emails were sent.`, 'good');
    } else {
      setDashboardStatus('Only admins can see this list. A manual unsubscribe removes the address from future alerts.', 'good');
    }
    await loadAdsControl();
    await loadDonationSettings();
    await refreshViewerCount();
    await loadAdminBlogPosts();
    if (!viewerRefreshTimer) viewerRefreshTimer = setInterval(refreshViewerCount, 15_000);
  } catch (error) {
    if (error.message.includes('Admin sign-in required')) showView('login-view');
    else setDashboardStatus(error.message, 'bad');
  }
}

async function initialize() {
  try {
    const data = await request('/api/admin/session');
    if (!data.configured) showView('setup-view');
    else if (data.authenticated) await loadDashboard();
    else showView('login-view');
  } catch (error) {
    showView('login-view');
    loginStatus.textContent = error.message;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  loginStatus.textContent = 'Signing in…';
  try {
    await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.querySelector('#admin-username').value,
        password: document.querySelector('#admin-password').value,
      }),
    });
    loginForm.reset();
    loginStatus.textContent = '';
    await loadDashboard();
  } catch (error) {
    loginStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

searchInput.addEventListener('input', () => {
  subscriberPage = 1;
  renderSubscribers();
});
subscriberSort.addEventListener('change', () => {
  subscriberPage = 1;
  renderSubscribers();
});

latestAlertForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = latestAlertForm.querySelector('button');
  const email = document.querySelector('#latest-alert-email').value.trim();
  button.disabled = true;
  latestAlertStatus.textContent = 'Preparing latest result alert…';
  try {
    const data = await request('/api/admin/send-latest-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    latestAlertStatus.textContent = `Latest result alert sent to ${email}: ${data.title}. Check the inbox and spam folder.`;
  } catch (error) {
    latestAlertStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await request('/api/admin/logout', { method: 'POST' }); } catch { /* Signing out still returns to the login screen. */ }
  if (viewerRefreshTimer) clearInterval(viewerRefreshTimer);
  viewerRefreshTimer = null;
  showView('login-view');
});

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = isDark ? '#101b2c' : '#f4f7fb';
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.textContent = `Switch to ${isDark ? 'light' : 'dark'} mode`;
  window.localStorage.setItem('boardexamtracker-admin-theme', isDark ? 'dark' : 'light');
}

themeToggle.addEventListener('click', () => {
  setTheme(themeToggle.getAttribute('aria-pressed') === 'true' ? 'light' : 'dark');
});

setTheme(window.localStorage.getItem('boardexamtracker-admin-theme') === 'dark' ? 'dark' : 'light');
initialize();
