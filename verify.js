import { apiRequest } from "/assets/js/api.js";

const message = document.querySelector("#verify-message");
const params = new URLSearchParams(window.location.search);
const token = params.get("token") || "";
window.history.replaceState({}, document.title, window.location.pathname);

if (!token) {
  if (message) message.textContent = "This verification link is missing or has expired. Request a new verification email.";
} else {
  try {
    const result = await apiRequest("/auth/verify-email", { method: "POST", body: { token } });
    if (message) message.textContent = result.message || "Email verified. You may sign in.";
  } catch (error) {
    if (message) message.textContent = error.message || "This verification link is invalid or expired.";
  }
}
