import { normalizeLevelData, publishLevel, deleteCustomLevelRow, fetchCustomLevelRows, isAdminSession, onAdminChange } from "./customLevels.js";
import { PROTECTED_IDS } from "./levels.js";
import { onScreen, currentScreen, emit, on as busOn, setModalOpen } from "./uiBus.js";
import { ensureUiRoot } from "./uiRoot.js";

/* Admin gear button + modal, independent of the canvas/game loop. Interop:
 * screen changes arrive on the uiBus; "Enter Map Editor" is emitted back as
 * a uiBus action (game.js is the single reducer); uploads still call
 * window.__reloadCustomLevels. The gear lives on the #ui-root artboard next
 * to the trophy — its old flank (W/2+254) overlapped the canvas-drawn LINE
 * chip. Visible only to the hardcoded admin account — real enforcement is
 * the Supabase RLS policy on `custom_levels`, this is just UI gating.
 * isAdminSession/onAdminChange are owned by customLevels.js (single source
 * of truth, also read by editor.js's PUBLISH button). */

let btnEl = null;
let overlayEl = null;

function setStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.className = "admin-status" + (kind ? ` admin-status-${kind}` : "");
}

async function handleUpload(nameInput, textarea, statusEl) {
  setStatus(statusEl, "");
  let raw;
  try { raw = JSON.parse(textarea.value); }
  catch { setStatus(statusEl, "Invalid JSON.", "error"); return; }

  let levelData;
  try { levelData = normalizeLevelData(raw, { name: nameInput.value }); }
  catch (e) { setStatus(statusEl, `Invalid level: ${e.message}`, "error"); return; }

  const name = nameInput.value.trim() || levelData.name;
  levelData.name = name; // keep the embedded name in sync with the DB `name` column
  setStatus(statusEl, "Uploading…");
  try {
    // upsert by embedded level id (PR8) — re-uploading updates, never duplicates
    const { updated } = await publishLevel(name, levelData);
    setStatus(statusEl, `${updated ? "Updated" : "Uploaded"} "${name}".${PROTECTED_IDS.has(levelData.id) ? " (LIVE OVERRIDE of a shipped level)" : ""}`, "ok");
    await window.__reloadCustomLevels?.();
    refreshManage();
  } catch (e) {
    setStatus(statusEl, `Upload failed: ${e.message}`, "error");
  }
}

// ---- PR8: the manage list — every online row, override-badged, deletable.
// Deleting an OVERRIDE row reverts that shipped level to its repo version;
// deleting a community row removes the level for everyone.
let manageListEl = null;
let manageStatusEl = null;
async function refreshManage() {
  if (!manageListEl) return;
  manageListEl.textContent = "loading…";
  const rows = await fetchCustomLevelRows();
  manageListEl.textContent = "";
  if (!rows.length) { manageListEl.textContent = "no online levels yet."; return; }
  for (const row of rows) {
    const id = row.level_data?.id || "?";
    const isOverride = PROTECTED_IDS.has(id);
    const line = document.createElement("div");
    line.className = "admin-level-row";
    const label = document.createElement("span");
    label.className = "admin-level-name";
    label.textContent = row.name || id;
    const meta = document.createElement("span");
    meta.className = "admin-level-meta";
    meta.textContent = id + (isOverride ? " · OVERRIDE" : "");
    if (isOverride) meta.classList.add("admin-level-override");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "admin-del-btn";
    del.textContent = "✕";
    del.title = isOverride ? "Delete override (revert to the shipped level)" : "Delete this online level";
    let armed = false;
    del.addEventListener("click", async () => {
      if (!armed) { armed = true; del.textContent = "sure?"; setTimeout(() => { armed = false; del.textContent = "✕"; }, 2600); return; }
      del.disabled = true;
      try {
        await deleteCustomLevelRow(row.id);
        setStatus(manageStatusEl, isOverride ? `Override removed — "${id}" reverted to the shipped version.` : `Deleted "${row.name || id}".`, "ok");
        await window.__reloadCustomLevels?.();
        refreshManage();
      } catch (e) {
        del.disabled = false;
        setStatus(manageStatusEl, `Delete failed: ${e.message}`, "error");
      }
    });
    line.append(label, meta, del);
    manageListEl.appendChild(line);
  }
}

function buildModal() {
  const overlay = document.createElement("div");
  overlay.id = "admin-modal-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) toggleModal(false); });

  const modal = document.createElement("div");
  modal.id = "admin-modal";

  const header = document.createElement("div");
  header.className = "lb-header";
  const title = document.createElement("div");
  title.className = "lb-section-title";
  title.textContent = "Admin Panel";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "lb-close";
  close.textContent = "✕";
  close.addEventListener("click", () => toggleModal(false));
  header.append(title, close);

  const body = document.createElement("div");
  body.className = "lb-body admin-body";

  const editorBtn = document.createElement("button");
  editorBtn.type = "button";
  editorBtn.className = "admin-action-btn";
  editorBtn.textContent = "Enter Map Editor";
  editorBtn.addEventListener("click", () => {
    toggleModal(false);
    emit("action", { action: "editor-new" }); // handled by game.js (uiBus reducer)
  });

  const manageTitle = document.createElement("div");
  manageTitle.className = "lb-section-title admin-upload-title";
  manageTitle.textContent = "Online Levels";
  manageListEl = document.createElement("div");
  manageListEl.className = "admin-level-list";
  manageStatusEl = document.createElement("div");
  manageStatusEl.className = "admin-status";

  const uploadTitle = document.createElement("div");
  uploadTitle.className = "lb-section-title admin-upload-title";
  uploadTitle.textContent = "Upload Level";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Level name";
  nameInput.className = "admin-name-input";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.className = "admin-file-input";

  const textarea = document.createElement("textarea");
  textarea.className = "admin-json-textarea";
  textarea.placeholder = "…or paste level JSON here";
  textarea.rows = 8;

  const statusEl = document.createElement("div");
  statusEl.className = "admin-status";

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "admin-action-btn";
  uploadBtn.textContent = "Upload Level";
  uploadBtn.addEventListener("click", () => handleUpload(nameInput, textarea, statusEl));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    f.text().then((txt) => {
      textarea.value = txt;
      try {
        const parsed = JSON.parse(txt);
        if (parsed?.name && !nameInput.value) nameInput.value = parsed.name;
      } catch {}
    });
  });

  body.append(editorBtn, manageTitle, manageListEl, manageStatusEl,
    uploadTitle, nameInput, fileInput, textarea, uploadBtn, statusEl);
  modal.append(header, body);
  overlay.append(modal);
  (document.getElementById("wrap") || document.body).appendChild(overlay);

  overlayEl = overlay;
}

function toggleModal(show) {
  const next = show ?? overlayEl.style.display !== "flex";
  overlayEl.style.display = next ? "flex" : "none";
  setModalOpen("admin", next); // gates the menu underneath (uiBus contract)
  if (next) refreshManage();   // the manage list is live every time it opens
}

function buildButton() {
  const btn = document.createElement("button");
  btn.id = "admin-open-btn";
  btn.type = "button";
  btn.title = "Admin Panel";
  btn.textContent = "⚙️";
  btn.addEventListener("click", () => toggleModal());
  ensureUiRoot().appendChild(btn);
  btnEl = btn;
}

// visible only to the admin account, and only on the level-select screen —
// re-evaluated on screen changes (uiBus) and admin-session changes
// (customLevels.js auth watcher), never per frame
let lastVisible = null;
function recompute(screen) {
  const visible = isAdminSession && screen === "select";
  if (visible === lastVisible) return;
  lastVisible = visible;
  btnEl.style.display = visible ? "" : "none";
  if (!visible && overlayEl.style.display === "flex") toggleModal(false);
}

export function initAdminModal() {
  if (btnEl) return;
  buildButton();
  buildModal();
  onScreen(recompute);
  onAdminChange(() => recompute(currentScreen()));
  // Esc (or gamepad Ⓑ) while this modal owns input — game.js emits, we close
  busOn("modal-close", () => {
    if (overlayEl.style.display === "flex") toggleModal(false);
  });
}
