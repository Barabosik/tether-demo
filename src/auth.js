import { supabase } from "./supabaseClient.js";
import { onScreen } from "./uiBus.js";

/* Account chip + dropdown, independent of the canvas/game loop. Mounted
 * INSIDE #wrap: that is the element toggleFullscreen() fullscreens, so
 * body-level children would simply vanish in fullscreen (the old bug). */

let panelEl = null;
let chipEl = null;
let formEl = null;
let statusEl = null;
let logoutBtn = null;
let errorEl = null;
let usernameInput = null;
let emailInput = null;
let passwordInput = null;
let submitBtn = null;
let toggleLink = null;

let mode = "login"; // "login" | "register"

function buildPanel() {
  // compact account chip — the form is a DROPDOWN it toggles, so no screen
  // ever sits under a permanent login form
  const mount = document.getElementById("wrap") || document.body;
  const chip = document.createElement("button");
  chip.id = "auth-chip";
  chip.type = "button";
  chip.textContent = "👤 SIGN IN ▾";
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    panelEl.classList.toggle("open");
  });
  mount.appendChild(chip);
  chipEl = chip;
  document.addEventListener("mousedown", (e) => {
    if (panelEl && panelEl.classList.contains("open") &&
        !panelEl.contains(e.target) && e.target !== chip)
      panelEl.classList.remove("open");
  });

  const panel = document.createElement("div");
  panel.id = "auth-panel";

  const status = document.createElement("div");
  status.className = "auth-status";

  const logout = document.createElement("button");
  logout.type = "button";
  logout.textContent = "Logout";
  logout.addEventListener("click", handleLogout);

  const form = document.createElement("div");
  form.className = "auth-form";

  const username = document.createElement("input");
  username.type = "text";
  username.placeholder = "Username";
  username.autocomplete = "username";

  const email = document.createElement("input");
  email.type = "email";
  email.placeholder = "Email";
  email.autocomplete = "email";

  const password = document.createElement("input");
  password.type = "password";
  password.placeholder = "Password";
  password.autocomplete = "current-password";

  const error = document.createElement("div");
  error.className = "auth-error";

  const submit = document.createElement("button");
  submit.type = "button";
  submit.addEventListener("click", () => {
    if (mode === "login") handleLogin(email.value, password.value);
    else handleRegister(email.value, password.value, username.value);
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "auth-toggle";
  toggle.addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    showError("");
    renderMode();
  });

  form.append(username, email, password, error, submit, toggle);
  panel.append(status, logout, form);
  mount.appendChild(panel);

  panelEl = panel; formEl = form; statusEl = status; logoutBtn = logout; errorEl = error;
  usernameInput = username; emailInput = email; passwordInput = password;
  submitBtn = submit; toggleLink = toggle;
}

function renderMode() {
  usernameInput.style.display = mode === "register" ? "block" : "none";
  submitBtn.textContent = mode === "register" ? "Register" : "Login";
  toggleLink.textContent = mode === "register"
    ? "Already have an account? Login"
    : "Need an account? Register";
}

function showError(msg) {
  errorEl.textContent = msg || "";
  errorEl.style.display = msg ? "block" : "none";
}

async function handleLogin(email, password) {
  showError("");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) showError(error.message);
}

async function handleRegister(email, password, username) {
  showError("");
  if (!username.trim()) { showError("Username is required."); return; }
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username: username.trim() } },
  });
  if (error) showError(error.message);
  else showError("Check your email to confirm registration.");
}

async function handleLogout() {
  showError("");
  await supabase.auth.signOut();
}

function renderAuthState(session) {
  const user = session?.user;
  if (user) {
    const name = user.user_metadata?.username || user.email;
    chipEl.textContent = `👤 ${name} ▾`;
    chipEl.classList.add("authed");
    statusEl.textContent = `Logged in as ${name}`;
    statusEl.style.display = "block";
    logoutBtn.style.display = "block";
    formEl.style.display = "none";
  } else {
    chipEl.textContent = "👤 SIGN IN ▾";
    chipEl.classList.remove("authed");
    statusEl.style.display = "none";
    logoutBtn.style.display = "none";
    formEl.style.display = "flex";
    mode = "login";
    renderMode();
  }
}

export function initAuthPanel() {
  if (panelEl) return;
  buildPanel();
  renderMode();
  renderAuthState(null); // default to logged-out until getSession() resolves
  supabase.auth.onAuthStateChange((_event, session) => renderAuthState(session));
  supabase.auth.getSession().then(({ data }) => renderAuthState(data.session));
  // menu-only chrome: the chip shows on the select screen (the trophy's rule)
  // so gameplay keeps a clean frame — event-driven via the uiBus, replacing
  // the old per-frame rAF poll of window.__tether.screen
  onScreen((screen) => {
    const onMenu = screen === "select";
    chipEl.style.display = onMenu ? "" : "none";
    if (!onMenu) panelEl.classList.remove("open");
  });
}
