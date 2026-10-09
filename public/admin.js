const views = ['loading-view', 'setup-view', 'login-view', 'dashboard-view'];
const loginForm = document.querySelector('#login-form');
const loginStatus = document.querySelector('#login-status');
const overviewStatus = document.querySelector('#overview-status');

function showView(id) {
  views.forEach((viewId) => { document.getElementById(viewId).hidden = viewId !== id; });
}

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function setNotice(message, type = '') {
  overviewStatus.textContent = message;
  overviewStatus.className = `notice ${type}`.trim();
}

async function loadOverview() {
  showView('dashboard-view');
  setNotice('Loading configuration…');
  try {
    const data = await request('/api/admin/overview');
    document.querySelector('#email-state').textContent = data.emailConfigured ? 'Configured' : 'Not configured';
    document.querySelector('#email-sender').textContent = data.sender || 'Not set';
    document.querySelector('#subscriber-confirmed').textContent = String(data.subscribers.confirmed);
    document.querySelector('#subscriber-pending').textContent = String(data.subscribers.pending);
    document.querySelector('#storage-note').textContent = 'This server currently stores subscriber records in a local data file. That file is private and ignored by Git, but it is not durable on serverless hosting such as Vercel.';
    setNotice(data.emailConfigured ? 'Email delivery is configured. New subscribers must confirm their address before alerts begin.' : 'Email delivery is not configured yet. Add the Resend environment variables in the hosting dashboard and redeploy.', data.emailConfigured ? 'good' : 'bad');
  } catch (error) {
    if (error.message.includes('Admin sign-in required')) showView('login-view');
    else setNotice(error.message, 'bad');
  }
}

async function initialize() {
  try {
    const data = await request('/api/admin/session');
    if (!data.configured) showView('setup-view');
    else if (data.authenticated) await loadOverview();
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
    await loadOverview();
  } catch (error) {
    loginStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await request('/api/admin/logout', { method: 'POST' }); } catch { /* Signing out still returns to the login screen. */ }
  showView('login-view');
});

initialize();
