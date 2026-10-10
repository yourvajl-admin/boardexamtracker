const views = ['loading-view', 'setup-view', 'login-view', 'dashboard-view'];
const loginForm = document.querySelector('#login-form');
const loginStatus = document.querySelector('#login-status');
const dashboardStatus = document.querySelector('#dashboard-status');
const subscriberRows = document.querySelector('#subscriber-rows');
const subscriberEmpty = document.querySelector('#subscriber-empty');
const searchInput = document.querySelector('#subscriber-search');
const testAlertForm = document.querySelector('#test-alert-form');
const testAlertStatus = document.querySelector('#test-alert-status');
const adsToggleButton = document.querySelector('#ads-toggle-button');
const adsControlStatus = document.querySelector('#ads-control-status');
let subscribers = [];
let viewerRefreshTimer = null;

function showView(id) {
  views.forEach((viewId) => { document.getElementById(viewId).hidden = viewId !== id; });
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
      ? 'Ads are on for eligible homepage visitors. Open pages reflect changes within about 30 seconds.'
      : 'Ads are off. Turn them on when you want the homepage ad placement displayed.';
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
      ? 'Ads are on for eligible homepage visitors. Open pages reflect changes within about 30 seconds.'
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

testAlertForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = testAlertForm.querySelector('button');
  const email = document.querySelector('#test-alert-email').value.trim();
  button.disabled = true;
  testAlertStatus.textContent = 'Preparing latest result email…';
  try {
    const data = await request('/api/admin/test-latest-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    testAlertStatus.textContent = `Test alert sent to ${email}. Check your inbox and spam folder.`;
  } catch (error) {
    testAlertStatus.textContent = error.message;
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
