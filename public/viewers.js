function createViewerSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 3) | 8).toString(16);
  });
}

function getViewerSessionId() {
  const key = 'boardexamtracker-viewer-session';
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = createViewerSessionId();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return createViewerSessionId();
  }
}

const viewerSessionId = getViewerSessionId();
function sendViewerHeartbeat() {
  if (document.visibilityState !== 'visible') return;
  fetch('/api/viewers/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: viewerSessionId }),
    keepalive: true,
  }).catch(() => {});
}

sendViewerHeartbeat();
setInterval(sendViewerHeartbeat, 30_000);
document.addEventListener('visibilitychange', sendViewerHeartbeat);
