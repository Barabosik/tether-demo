import { startGame } from "./game.js";
import { initAuthPanel } from "./auth.js";
import { initLeaderboardModal } from "./leaderboardModal.js";
import { initAdminModal } from "./adminModal.js";
import { loadFonts } from "./theme.js";
import { icon } from "./icons.js";

// a phone held upright gets a nudge to turn it: the game is a landscape
// frame (CSS shows this only for portrait + coarse pointer)
function addRotateHint() {
  const d = document.createElement("div");
  d.id = "rotate-hint";
  const t = document.createElement("p");
  t.textContent = "Turn your phone sideways to play";
  d.append(icon("rotate"), t);
  document.body.appendChild(d);
}

loadFonts();
addRotateHint();
initAuthPanel();
startGame(document.getElementById("game"));
initLeaderboardModal();
initAdminModal();
