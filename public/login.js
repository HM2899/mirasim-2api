const form = document.querySelector("#login-form");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const error = document.querySelector("#login-error");
const submit = document.querySelector("#login-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  submit.textContent = "登录中";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || "登录失败。");
    window.location.assign("/");
  } catch (reason) {
    error.textContent = reason.message || "登录失败。";
    error.hidden = false;
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});
