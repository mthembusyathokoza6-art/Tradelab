import { apiRequest } from "/assets/js/api.js";

function message(element, text, tone = "warning") {
  if (!element) return;
  element.textContent = text;
  element.style.color = tone === "success" ? "#86efac" : "#fbbf24";
}

const loginForm = document.querySelector("#login-form");
loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#form-message");
  message(status, "Checking securely…");
  const form = new FormData(loginForm);
  try {
    await apiRequest("/auth/login", {
      method: "POST",
      body: { email: String(form.get("email") || "").trim(), password: String(form.get("password") || "") }
    });
    window.location.assign("/accounts.html");
  } catch (error) {
    message(status, error.message || "Sign-in is not available in this preview.");
  }
});

document.querySelector("#resend-verification")?.addEventListener("click", async () => {
  const status = document.querySelector("#form-message");
  const email = String(new FormData(loginForm || document.createElement("form")).get("email") || "").trim();
  if (!email) {
    message(status, "Enter your email address first.");
    return;
  }
  message(status, "Requesting a verification email…");
  try {
    const result = await apiRequest("/auth/resend-verification", { method: "POST", body: { email } });
    message(status, result.message || "If an eligible account exists, a verification email will be sent.", "success");
  } catch (error) {
    message(status, error.message || "Resend is not available in this preview.");
  }
});

const registerForm = document.querySelector("#register-form");
registerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#form-message");
  if (!registerForm.reportValidity()) return;
  const form = new FormData(registerForm);
  const password = String(form.get("password") || "");
  if (password !== String(form.get("confirmPassword") || "")) {
    message(status, "The passwords do not match.");
    return;
  }
  if (password.length < 12) {
    message(status, "Use a password with at least 12 characters.");
    return;
  }
  message(status, "Sending securely…");
  try {
    const result = await apiRequest("/auth/register", {
      method: "POST",
      body: {
        firstName: String(form.get("firstName") || "").trim(),
        lastName: String(form.get("lastName") || "").trim(),
        email: String(form.get("email") || "").trim(),
        phone: String(form.get("phone") || "").trim(),
        country: String(form.get("country") || "").trim(),
        dateOfBirth: String(form.get("dateOfBirth") || ""),
        password,
        termsAccepted: form.get("termsAccepted") === "on",
        riskAccepted: form.get("riskAccepted") === "on",
        privacyAcknowledged: form.get("privacyAcknowledged") === "on"
      }
    });
    message(status, result.message || "Account created. You can sign in now; verify your email before requesting a payout.", "success");
    registerForm.reset();
  } catch (error) {
    message(status, error.message || "Registration is not available in this preview.");
  }
});
