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
const outfitForm = document.querySelector('#outfit-form');
const outfitIdInput = document.querySelector('#outfit-id');
const outfitTitleInput = document.querySelector('#outfit-title');
const outfitAffiliateUrlInput = document.querySelector('#outfit-affiliate-url');
const outfitStatusInput = document.querySelector('#outfit-status');
const outfitImageInput = document.querySelector('#outfit-image');
const outfitImagePreview = document.querySelector('#outfit-image-preview');
const outfitPreviewTitle = document.querySelector('#outfit-preview-title');
const outfitAdminStatus = document.querySelector('#outfit-admin-status');
const outfitList = document.querySelector('#admin-outfit-list');
const outfitSaveButton = document.querySelector('#outfit-save-button');
const outfitCancelEditButton = document.querySelector('#outfit-cancel-edit');
let subscribers = [];
let viewerRefreshTimer = null;
let blogPosts = [];
let editingBlogPost = null;
let removeExistingBlogPhoto = false;
let blogPhotoObjectUrl = null;
let outfits = [];
let editingOutfitId = null;
let outfitSelectedObjectUrl = null;
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
    await refreshViewerCount();
    await loadAdminBlogPosts();
    await loadAdminOutfits();
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



function setOutfitAdminStatus(message, type = '') {
  if (!outfitAdminStatus) return;
  outfitAdminStatus.textContent = message;
  outfitAdminStatus.className = `status ${type}`.trim();
}

function clearOutfitSelectedObjectUrl() {
  if (outfitSelectedObjectUrl) URL.revokeObjectURL(outfitSelectedObjectUrl);
  outfitSelectedObjectUrl = null;
}

function currentEditingOutfit() {
  return outfits.find((outfit) => outfit.id === editingOutfitId) || null;
}

function showOutfitPreviewImage(src, alt) {
  if (!outfitImagePreview) return;
  outfitImagePreview.replaceChildren();
  if (!src) {
    const empty = document.createElement('p');
    empty.className = 'donation-preview-empty';
    empty.textContent = 'No image selected.';
    outfitImagePreview.append(empty);
    return;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || 'Outfit preview';
  outfitImagePreview.append(img);
}

function renderOutfitPreview() {
  const file = outfitImageInput?.files?.[0];
  if (file) {
    clearOutfitSelectedObjectUrl();
    outfitSelectedObjectUrl = URL.createObjectURL(file);
    if (outfitPreviewTitle) outfitPreviewTitle.textContent = editingOutfitId ? 'New image preview' : 'Upload preview';
    showOutfitPreviewImage(outfitSelectedObjectUrl, 'Selected outfit image preview');
    return;
  }

  const editing = currentEditingOutfit();
  if (editing?.imageUrl) {
    if (outfitPreviewTitle) outfitPreviewTitle.textContent = 'Current outfit image';
    showOutfitPreviewImage(editing.imageUrl, `${editing.title} preview`);
    return;
  }

  if (outfitPreviewTitle) outfitPreviewTitle.textContent = 'Upload preview';
  showOutfitPreviewImage(null);
}

function resetOutfitForm() {
  editingOutfitId = null;
  if (outfitForm) outfitForm.reset();
  if (outfitIdInput) outfitIdInput.value = '';
  if (outfitStatusInput) outfitStatusInput.value = 'published';
  if (outfitSaveButton) outfitSaveButton.textContent = 'Publish outfit';
  if (outfitCancelEditButton) outfitCancelEditButton.hidden = true;
  if (outfitImageInput) outfitImageInput.required = true;
  clearOutfitSelectedObjectUrl();
  renderOutfitPreview();
}

function startEditOutfit(outfit) {
  editingOutfitId = outfit.id;
  if (outfitIdInput) outfitIdInput.value = outfit.id;
  if (outfitTitleInput) outfitTitleInput.value = outfit.title || '';
  if (outfitAffiliateUrlInput) outfitAffiliateUrlInput.value = outfit.affiliateUrl || '';
  if (outfitStatusInput) outfitStatusInput.value = outfit.status === 'unpublished' ? 'unpublished' : 'published';
  if (outfitImageInput) {
    outfitImageInput.value = '';
    outfitImageInput.required = false;
  }
  if (outfitSaveButton) outfitSaveButton.textContent = 'Save changes';
  if (outfitCancelEditButton) outfitCancelEditButton.hidden = false;
  clearOutfitSelectedObjectUrl();
  renderOutfitPreview();
  setOutfitAdminStatus(`Editing “${outfit.title}”. Save changes to update this outfit.`);
  outfitForm?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderAdminOutfits() {
  if (!outfitList) return;
  outfitList.replaceChildren();

  if (!Array.isArray(outfits) || outfits.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'admin-outfit-empty';
    empty.textContent = 'No outfits saved yet. Add an outfit above to display it in the public collection.';
    outfitList.append(empty);
    return;
  }

  for (const outfit of outfits) {
    const card = document.createElement('article');
    card.className = 'admin-outfit-card';

    const thumb = document.createElement('div');
    thumb.className = 'admin-outfit-thumb';
    if (outfit.imageUrl) {
      const img = document.createElement('img');
      img.src = outfit.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'admin-outfit-thumb-empty';
      fallback.textContent = 'No image';
      thumb.append(fallback);
    }

    const copy = document.createElement('div');
    copy.className = 'admin-outfit-copy';

    const title = document.createElement('h4');
    title.textContent = outfit.title || 'Untitled outfit';

    const meta = document.createElement('div');
    meta.className = 'admin-outfit-meta';
    const badge = document.createElement('span');
    const published = outfit.status !== 'unpublished';
    badge.className = `outfit-status-badge ${published ? 'is-published' : 'is-unpublished'}`;
    badge.textContent = published ? 'Published' : 'Unpublished';
    meta.append(badge);

    const url = document.createElement('p');
    url.className = 'admin-outfit-url';
    url.textContent = outfit.affiliateUrl || 'No affiliate link';

    const actions = document.createElement('div');
    actions.className = 'admin-outfit-actions';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'secondary-button';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => startEditOutfit(outfit));

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'toggle-outfit-status';
    toggleButton.textContent = published ? 'Unpublish' : 'Publish';
    toggleButton.addEventListener('click', () => toggleOutfitStatus(outfit, toggleButton));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'unsubscribe-button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteOutfit(outfit, deleteButton));

    actions.append(editButton, toggleButton, deleteButton);
    copy.append(title, meta, url, actions);
    card.append(thumb, copy);
    outfitList.append(card);
  }
}

async function loadAdminOutfits() {
  if (!outfitList) return;
  try {
    const data = await request('/api/admin/outfits');
    if (data.persistentStorage === false) {
      outfits = [];
      renderAdminOutfits();
      if (outfitSaveButton) outfitSaveButton.disabled = true;
      setOutfitAdminStatus('Shared storage is required to manage oath-taking outfits.', 'bad');
      return;
    }
    outfits = Array.isArray(data.outfits) ? data.outfits : [];
    if (outfitSaveButton) outfitSaveButton.disabled = false;
    renderAdminOutfits();
    setOutfitAdminStatus(`${outfits.length} ${outfits.length === 1 ? 'outfit' : 'outfits'} saved.`, 'good');
  } catch (error) {
    if (outfitSaveButton) outfitSaveButton.disabled = true;
    setOutfitAdminStatus(error.message, 'bad');
  }
}

async function compressOutfitImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP outfit image.');
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
  for (const quality of [0.84, 0.76, 0.68, 0.6, 0.52]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (blob && blob.size <= 950_000) break;
  }
  if (!blob || blob.size > 1_000_000) throw new Error('This outfit image is too large to optimize. Choose a smaller image.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected outfit image.'));
    reader.readAsDataURL(blob);
  });
}

async function toggleOutfitStatus(outfit, button) {
  const nextStatus = outfit.status === 'unpublished' ? 'published' : 'unpublished';
  button.disabled = true;
  try {
    const data = await request(`/api/admin/outfits/${encodeURIComponent(outfit.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: outfit.title,
        affiliateUrl: outfit.affiliateUrl,
        status: nextStatus,
      }),
    });
    outfits = outfits.map((item) => (item.id === outfit.id ? data.outfit : item));
    renderAdminOutfits();
    setOutfitAdminStatus(`“${outfit.title}” is now ${nextStatus}.`, 'good');
  } catch (error) {
    button.disabled = false;
    setOutfitAdminStatus(error.message, 'bad');
  }
}

async function deleteOutfit(outfit, button) {
  if (!window.confirm(`Delete “${outfit.title}” from the outfit collection? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/outfits/${encodeURIComponent(outfit.id)}`, { method: 'DELETE' });
    outfits = outfits.filter((item) => item.id !== outfit.id);
    if (editingOutfitId === outfit.id) resetOutfitForm();
    renderAdminOutfits();
    setOutfitAdminStatus(`Deleted “${outfit.title}”.`, 'good');
  } catch (error) {
    button.disabled = false;
    setOutfitAdminStatus(error.message, 'bad');
  }
}

outfitImageInput?.addEventListener('change', () => {
  renderOutfitPreview();
});

outfitStatusInput?.addEventListener('change', () => {
  if (!outfitSaveButton) return;
  if (editingOutfitId) {
    outfitSaveButton.textContent = 'Save changes';
  } else {
    outfitSaveButton.textContent = outfitStatusInput.value === 'unpublished' ? 'Save outfit' : 'Publish outfit';
  }
});

outfitCancelEditButton?.addEventListener('click', () => {
  resetOutfitForm();
  setOutfitAdminStatus('Edit canceled.', 'good');
});

outfitForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!outfitSaveButton) return;

  const title = outfitTitleInput.value.trim();
  const affiliateUrl = outfitAffiliateUrlInput.value.trim();
  const status = outfitStatusInput.value === 'unpublished' ? 'unpublished' : 'published';
  const selectedImage = outfitImageInput.files?.[0];

  if (!title) {
    setOutfitAdminStatus('Enter an outfit title.', 'bad');
    return;
  }
  if (!affiliateUrl) {
    setOutfitAdminStatus('Enter an affiliate purchase link.', 'bad');
    return;
  }
  if (!editingOutfitId && !selectedImage) {
    setOutfitAdminStatus('Choose an outfit image to preview and save.', 'bad');
    return;
  }

  outfitSaveButton.disabled = true;
  if (outfitCancelEditButton) outfitCancelEditButton.disabled = true;
  setOutfitAdminStatus(editingOutfitId ? 'Saving outfit changes…' : 'Saving outfit…');
  try {
    const payload = { title, affiliateUrl, status };
    if (selectedImage) payload.image = await compressOutfitImage(selectedImage);

    const data = editingOutfitId
      ? await request(`/api/admin/outfits/${encodeURIComponent(editingOutfitId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      : await request('/api/admin/outfits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

    if (editingOutfitId) {
      outfits = outfits.map((item) => (item.id === data.outfit.id ? data.outfit : item));
    } else {
      outfits = [data.outfit, ...outfits];
    }
    resetOutfitForm();
    renderAdminOutfits();
    setOutfitAdminStatus(editingOutfitId ? 'Outfit updated.' : 'Outfit saved.', 'good');
  } catch (error) {
    setOutfitAdminStatus(error.message, 'bad');
  } finally {
    outfitSaveButton.disabled = false;
    if (outfitCancelEditButton) outfitCancelEditButton.disabled = false;
  }
});

resetOutfitForm();

const tileTriggers = document.querySelectorAll('.admin-tile-trigger');
const tileModals = document.querySelectorAll('.admin-tile-modal');

function syncAdminTileBodyState() {
  document.body.classList.toggle('admin-tile-open', [...tileModals].some((modal) => !modal.hidden));
}

function closeAdminTiles({ returnFocusTo = null } = {}) {
  for (const modal of tileModals) {
    if (modal.hidden) continue;
    modal.hidden = true;
    const trigger = document.querySelector(`[data-tile-target="${modal.id}"]`);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (!returnFocusTo && document.activeElement && modal.contains(document.activeElement)) {
      returnFocusTo = trigger;
    }
  }
  syncAdminTileBodyState();
  if (returnFocusTo && typeof returnFocusTo.focus === 'function') returnFocusTo.focus();
}

function openAdminTile(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  closeAdminTiles();
  modal.hidden = false;
  const trigger = document.querySelector(`[data-tile-target="${modalId}"]`);
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  syncAdminTileBodyState();
  modal.querySelector('.admin-tile-close')?.focus();
}

for (const trigger of tileTriggers) {
  trigger.addEventListener('click', () => openAdminTile(trigger.dataset.tileTarget));
}

for (const modal of tileModals) {
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-tile-close]')) {
      closeAdminTiles({ returnFocusTo: document.querySelector(`[data-tile-target="${modal.id}"]`) });
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.body.classList.contains('admin-tile-open')) return;
  if (blogPostDialog?.open) return;
  const openModal = [...tileModals].find((modal) => !modal.hidden);
  const trigger = openModal ? document.querySelector(`[data-tile-target="${openModal.id}"]`) : null;
  closeAdminTiles({ returnFocusTo: trigger });
});

initialize();
