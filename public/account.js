(() => {
  const $ = (s) => document.querySelector(s);
  const pageStatus = $('#pageStatus');
  const authSection = $('#authSection');
  const dashboardSection = $('#dashboardSection');
  const logoutBtn = $('#logoutBtn');
  const planBadge = $('#planBadge');
  const subSummary = $('#subSummary');
  const accountSummary = $('#accountSummary');
  const paymentsBody = $('#paymentsBody');
  const checkoutOption = $('#checkoutOption');
  const checkoutDisclosure = $('#checkoutDisclosure');
  const checkoutResult = $('#checkoutResult');
  const manageStatus = $('#manageStatus');
  const alertsToggleBtn = $('#alertsToggleBtn');
  let me = null;
  let config = null;

  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function fmtDate(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' }); }
  function fmtMoney(n) { return `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
  function showStatus(el, msg, kind='') { el.textContent = msg; el.className = `status ${kind}`.trim(); el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function show(el) { el.classList.remove('hidden'); }
  async function api(url, opts={}) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json', ...(opts.body ? {'Content-Type':'application/json'} : {}), ...(opts.headers||{}) }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function renderAuth(loggedIn) {
    authSection.classList.toggle('hidden', loggedIn);
    dashboardSection.classList.toggle('hidden', !loggedIn);
    logoutBtn.classList.toggle('hidden', !loggedIn);
  }

  function renderPayments(payments) {
    if (!payments?.length) { paymentsBody.innerHTML = '<tr><td colspan="5" class="muted">No payments yet.</td></tr>'; return; }
    paymentsBody.innerHTML = payments.map((p) => `<tr><td>${esc(fmtDate(p.createdAt))}</td><td>${esc(fmtMoney(p.amount))}</td><td>${esc(p.method || '')}</td><td>${esc(p.reference || '—')}</td><td>${esc(p.status || '')}</td></tr>`).join('');
  }

  function renderCheckoutOptions() {
    const opts = [];
    const ganap = config?.ganap;
    const monthlyPrice = Number(config?.monthlyPrice || 20);
    if (ganap?.enabled) {
      opts.push({
        value: 'ganap-monthly:1',
        label: `Monthly subscription — ${fmtMoney(monthlyPrice)}/month via Ganap`,
        months: 1,
        method: 'Ganap',
        amount: monthlyPrice,
        disclosure: `You will pay ${fmtMoney(monthlyPrice)} for 1 month of Premium Email Alerts through Ganap. After you continue, you’ll receive the Ganap payment QR/code or redirect to complete payment. Your subscription activates only after server-side payment verification.`,
      });
      for (const p of (config?.prepaidOptions || [])) {
        const months = Number(p.months);
        const amount = Number(p.amount);
        if (!Number.isInteger(months) || months < 1) continue;
        if (!Number.isFinite(amount) || amount <= 0) continue;
        opts.push({
          value: `ganap:${months}:${amount}:${p.label}`,
          label: `${p.label} — ${fmtMoney(amount)} via Ganap`,
          months,
          method: 'Ganap',
          amount,
          disclosure: `You will pay ${fmtMoney(amount)} for ${months} month(s) through Ganap at the ₱20/month equivalent. Your subscription activates only after server-side payment verification.`,
        });
      }
    } else {
      opts.push({
        value: 'monthly:1',
        label: `Monthly subscription — ${fmtMoney(monthlyPrice)}/month`,
        months: 1,
        method: 'Manual',
        amount: monthlyPrice,
        disclosure: `Premium Email Alerts is ${fmtMoney(monthlyPrice)} per month. Ganap checkout is currently unavailable. Your payment request will be recorded as pending until an admin confirms your payment.`,
      });
    }
    checkoutOption.innerHTML = opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    checkoutOption._opts = opts;
    const update = () => { const o = opts[checkoutOption.selectedIndex] || opts[0]; checkoutDisclosure.textContent = o?.disclosure || ''; };
    checkoutOption.onchange = update; update();
  }

  function renderDashboard(data) {
    me = data;
    config = data.config || config;
    const sub = data.subscription || {};
    const status = sub.status || 'free';
    const statusLabel = ({ active: 'Premium Active', expired: 'Expired', pending: 'Pending Payment', cancelled: 'Cancelled', free: 'Free' })[status] || status;
    planBadge.textContent = status === 'active' ? 'Premium' : status === 'pending' ? 'Pending' : 'Free';
    planBadge.className = `badge ${status === 'active' ? 'active' : status}`;
    const payments = data.payments || [];
    const lastPaid = payments.find((p) => p.status === 'paid') || payments[0] || null;
    const nextRenewal = status === 'active' && !sub.cancelAtPeriodEnd ? sub.expirationDate : null;
    subSummary.innerHTML = `
      <div><span class="muted">Subscription Status</span><div><span class="badge ${esc(status)}">${esc(statusLabel)}</span></div></div>
      <div><span class="muted">Current Plan</span><div>Premium Email Alerts</div></div>
      <div><span class="muted">Subscription Price</span><div>₱20/month</div></div>
      <div><span class="muted">Subscription Start Date</span><div>${esc(fmtDate(sub.startDate))}</div></div>
      <div><span class="muted">Subscription Expiration Date</span><div>${esc(fmtDate(sub.expirationDate))}</div></div>
      <div><span class="muted">Registered Email Address</span><div>${esc(data.user?.email || '—')}</div></div>
      <div><span class="muted">Email Alerts Status</span><div>${status === 'active' ? (sub.alertsPaused ? 'Paused' : 'Enabled') : 'Disabled'}</div></div>
      <div><span class="muted">Last Payment Date</span><div>${esc(fmtDate(lastPaid?.paidAt || lastPaid?.createdAt))}</div></div>
      <div><span class="muted">Next Renewal Date</span><div>${nextRenewal ? esc(fmtDate(nextRenewal)) : 'Not applicable'}</div></div>
    `;
    if (alertsToggleBtn) { alertsToggleBtn.textContent = sub.alertsPaused ? 'Resume email alerts' : 'Pause email alerts'; alertsToggleBtn.disabled = status !== 'active'; }
    accountSummary.innerHTML = `
      <div><span class="muted">Name</span><div>${esc(data.user?.fullName || '—')}</div></div>
      <div><span class="muted">Email</span><div>${esc(data.user?.email || '—')}</div></div>
      <div><span class="muted">Account type</span><div>${status === 'active' ? 'Premium subscriber' : 'Free account'}</div></div>
    `;
    $('#checkoutName').value = data.user?.fullName || '';
    renderPayments(data.payments || []);
    renderCheckoutOptions();
  }

  async function loadMe() {
    try {
      const data = await api('/api/premium/me');
      renderAuth(true);
      renderDashboard(data);
    } catch {
      renderAuth(false);
    }
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hide(pageStatus);
    const fd = new FormData(e.target);
    try {
      await api('/api/premium/login', { method:'POST', body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
      await loadMe();
      showStatus(pageStatus, 'Signed in successfully.', 'ok');
    } catch (err) { showStatus(pageStatus, err.message, 'error'); }
  });

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hide(pageStatus);
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/premium/register', { method:'POST', body: JSON.stringify({ fullName: fd.get('fullName'), email: fd.get('email'), password: fd.get('password') }) });
      if (data.requiresVerification) {
        e.target.reset();
        showStatus(pageStatus, data.message || 'Check your email to verify your account before signing in.', 'ok');
        return;
      }
      await loadMe();
      showStatus(pageStatus, 'Account created. You can now subscribe to Premium Email Alerts.', 'ok');
    } catch (err) { showStatus(pageStatus, err.message, 'error'); }
  });

  logoutBtn.addEventListener('click', async () => {
    await api('/api/premium/logout', { method:'POST', body: '{}' }).catch(() => {});
    me = null; renderAuth(false); showStatus(pageStatus, 'Signed out.', 'ok');
  });

  $('#checkoutForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hide(checkoutResult);
    const opt = checkoutOption._opts[checkoutOption.selectedIndex];
    if (!opt) return;
    const fullName = $('#checkoutName').value.trim();
    try {
      const data = await api('/api/premium/checkout', { method:'POST', body: JSON.stringify({ months: opt.months, method: opt.method, fullName }) });
      if (data.manual) {
        showStatus(checkoutResult, data.message || 'Payment request recorded. An admin will confirm it after payment is received.', 'ok');
        await loadMe();
        return;
      }
      const checkout = data.checkout || {};
      if (checkout.redirectType === 'url' && checkout.redirectUrl) {
        showStatus(checkoutResult, 'Redirecting to secure payment...', 'ok');
        window.location.href = checkout.redirectUrl;
        return;
      }
      if (checkout.redirectType === 'image' && checkout.redirectUrl) {
        checkoutResult.innerHTML = `<div><strong>Scan to pay ${esc(fmtMoney(data.payment?.amount))}</strong></div><div class="muted" style="margin:8px 0">Reference: ${esc(checkout.referenceNumber || data.payment?.id || '')}</div><img src="${esc(checkout.redirectUrl)}" alt="Payment QR code" style="max-width:280px;width:100%;border:1px solid #dbe5f0;border-radius:12px">`;
        checkoutResult.className = 'status'; checkoutResult.classList.remove('hidden');
        return;
      }
      if (checkout.redirectType === 'qr_payload' && checkout.redirectUrl) {
        checkoutResult.innerHTML = `<div><strong>Payment QR payload</strong></div><div class="muted" style="margin:8px 0">Use your payment app to scan or process this QR payload. Reference: ${esc(checkout.referenceNumber || '')}</div><textarea readonly style="width:100%;min-height:120px">${esc(checkout.redirectUrl)}</textarea>`;
        checkoutResult.className = 'status'; checkoutResult.classList.remove('hidden');
        return;
      }
      showStatus(checkoutResult, 'Checkout created, but no redirect URL was returned.', 'error');
    } catch (err) { showStatus(checkoutResult, err.message, 'error'); }
  });

  alertsToggleBtn?.addEventListener('click', async () => {
    hide(manageStatus);
    const paused = !(me?.subscription?.alertsPaused);
    try {
      await api('/api/premium/alerts', { method:'POST', body: JSON.stringify({ paused }) });
      showStatus(manageStatus, paused ? 'Email alerts paused.' : 'Email alerts resumed.', 'ok');
      await loadMe();
    } catch (err) { showStatus(manageStatus, err.message, 'error'); }
  });

  $('#cancelBtn').addEventListener('click', async () => {
    if (!confirm('Cancel your Premium Email Alerts subscription? You will keep free access to board exam results.')) return;
    hide(manageStatus);
    try {
      await api('/api/premium/cancel', { method:'POST', body: '{}' });
      showStatus(manageStatus, 'Subscription cancelled. You can renew anytime.', 'ok');
      await loadMe();
    } catch (err) { showStatus(manageStatus, err.message, 'error'); }
  });

  $('#emailChangeForm').addEventListener('submit', async (e) => {
    e.preventDefault(); hide(manageStatus);
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/premium/email-change/request', { method:'POST', body: JSON.stringify({ newEmail: fd.get('newEmail') }) });
      showStatus(manageStatus, data.message || 'Confirmation email sent.', 'ok');
      e.target.reset();
    } catch (err) { showStatus(manageStatus, err.message, 'error'); }
  });

  const forgotForm = $('#forgotForm');
  const resetForm = $('#resetForm');
  const resetToken = new URLSearchParams(location.search).get('reset') || '';
  $('#showForgot')?.addEventListener('click', (e) => { e.preventDefault(); forgotForm.classList.toggle('hidden'); });
  if (resetToken) { resetForm.classList.remove('hidden'); showStatus(pageStatus, 'Enter a new password for your account.', ''); }
  forgotForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); hide(pageStatus);
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/premium/forgot-password', { method:'POST', body: JSON.stringify({ email: fd.get('email') }) });
      showStatus(pageStatus, data.message || 'If an account exists for that email, a password reset link has been sent.', 'ok');
      e.target.reset();
    } catch (err) { showStatus(pageStatus, err.message, 'error'); }
  });
  resetForm?.addEventListener('submit', async (e) => {
    e.preventDefault(); hide(pageStatus);
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/premium/reset-password', { method:'POST', body: JSON.stringify({ token: resetToken, password: fd.get('password') }) });
      showStatus(pageStatus, data.message || 'Password updated. You can now sign in.', 'ok');
      e.target.reset();
      history.replaceState({}, '', '/account');
      resetForm.classList.add('hidden');
    } catch (err) { showStatus(pageStatus, err.message, 'error'); }
  });

  loadMe();
})();
