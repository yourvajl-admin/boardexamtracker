const views = ['loading-view', 'setup-view', 'login-view', 'dashboard-view'];
const loginForm = document.querySelector('#login-form');
const loginStatus = document.querySelector('#login-status');
const dashboardStatus = document.querySelector('#dashboard-status');
const subscriberRows = document.querySelector('#subscriber-rows');
const subscriberEmpty = document.querySelector('#subscriber-empty');
const searchInput = document.querySelector('#subscriber-search');
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
let subscribers = [];
let viewerRefreshTimer = null;
let blogPosts = [];
let editingBlogPost = null;
let removeExistingBlogPhoto = false;
let blogPhotoObjectUrl = null;

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
  const visible = subscribers.filter((subscriber) => subscriber.email.toLowerCase().includes(query));
  subscriberRows.replaceChildren();
  for (const subscriber of visible) {
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
  document.querySelector('#subscriber-count').textContent = `${visible.length} shown · ${subscribers.length} total`;
  subscriberEmpty.hidden = visible.length !== 0;
  subscriberEmpty.textContent = subscribers.length ? 'No subscriber emails match this search.' : 'No subscribers yet.';
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
    } else {
      setDashboardStatus('Only admins can see this list. A manual unsubscribe removes the address from future alerts.', 'good');
    }
    await loadAdsControl();
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

searchInput.addEventListener('input', renderSubscribers);

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

initialize();
