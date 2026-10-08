const statusMessage = document.getElementById("status");
const retryButton = document.getElementById("retry");
retryButton?.addEventListener("click", () => location.replace("/"));
window.addEventListener("online", () => {
  if (statusMessage) statusMessage.textContent = "Connection restored. Reload TradeLab to refresh current information.";
  if (retryButton) retryButton.textContent = "Reload TradeLab";
});
