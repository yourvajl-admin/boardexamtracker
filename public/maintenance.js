(() => {
  const notice = document.querySelector(".maintenance-dialog");
  if (!notice || typeof notice.showModal !== "function") return;

  const dismissedKey = "boardexamtracker-maintenance-dismissed";
  try {
    if (sessionStorage.getItem(dismissedKey) === "1") return;
  } catch {}

  const dismiss = () => notice.close();
  notice.querySelector(".maintenance-close")?.addEventListener("click", dismiss);
  notice.querySelector(".maintenance-continue")?.addEventListener("click", dismiss);
  notice.addEventListener("close", () => {
    try {
      sessionStorage.setItem(dismissedKey, "1");
    } catch {}
  });

  notice.showModal();
})();
