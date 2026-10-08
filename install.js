(() => {
  let promptEvent = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    promptEvent = event;
  });
  window.addEventListener("appinstalled", () => { promptEvent = null; });

  function showInstallHelp() {
    const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const message = ios
      ? "On iPhone or iPad, open this page in Safari, tap Share, then Add to Home Screen."
      : "Open the browser menu and choose Install app or Add to Home screen. If the option is absent, keep using TradeLab in your browser.";
    window.alert(message);
  }

  window.installTradeLab = async () => {
    if (!promptEvent) {
      showInstallHelp();
      return "instructions";
    }
    const current = promptEvent;
    promptEvent = null;
    try {
      await current.prompt();
      const result = await current.userChoice;
      return result?.outcome || "dismissed";
    } catch (error) {
      console.warn("PWA install prompt unavailable:", error);
      showInstallHelp();
      return "instructions";
    }
  };

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((error) => console.warn("Service worker registration failed:", error));
    }, { once: true });
  }
})();
