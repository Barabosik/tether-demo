import { startGame } from "./game.js";
import { initAuthPanel } from "./auth.js";
import { initLeaderboardModal } from "./leaderboardModal.js";
import { initAdminModal } from "./adminModal.js";

initAuthPanel();
startGame(document.getElementById("game"));
initLeaderboardModal();
initAdminModal();
