const socket = io();

// --- Global State ---
let currentUser = null, gameLoopId, singlePlayerDifficulty = 'easy';
let friends = [], onlineFriendIds = [];
let currentGameState = { bird: null, pipes: [], score: 0, gameOver: false, frame: 0, mode: 'single', gameId: null };

// --- UI Elements ---
const screens = { loading: document.getElementById('loading-screen'), login: document.getElementById('login-screen'), mainMenu: document.getElementById('main-menu-screen'), multiplayerLobby: document.getElementById('multiplayer-lobby-screen'), game: document.getElementById('game-screen') };
const welcomeMessage = document.getElementById('welcome-message'), userIdDisplay = document.getElementById('user-id-display');
const canvas = document.getElementById('gameCanvas'), ctx = canvas.getContext('2d');
const sounds = { flap: document.getElementById('flap-sound'), score: document.getElementById('score-sound'), gameOver: document.getElementById('gameover-sound') };
const difficultyModal = document.getElementById('difficulty-modal');

// --- Game Physics Configuration ---
const difficulties = {
    easy:   { BIRD_GRAVITY: 0.3, BIRD_LIFT: -6.5, PIPE_GAP: 180, PIPE_SPEED: 3 },
    medium: { BIRD_GRAVITY: 0.4, BIRD_LIFT: -7.0, PIPE_GAP: 160, PIPE_SPEED: 4 },
    hard:   { BIRD_GRAVITY: 0.5, BIRD_LIFT: -7.5, PIPE_GAP: 140, PIPE_SPEED: 5 }
};
let GAME_CONFIG = {};
function updateGameConstants(height, difficulty = 'medium') {
    const scale = height / 800;
    const config = difficulties[difficulty];
    GAME_CONFIG.BIRD_RADIUS = 15 * scale;
    GAME_CONFIG.PIPE_WIDTH = 80 * scale;
    GAME_CONFIG.BIRD_GRAVITY = config.BIRD_GRAVITY * scale;
    GAME_CONFIG.BIRD_LIFT = config.BIRD_LIFT * scale;
    GAME_CONFIG.PIPE_GAP = config.PIPE_GAP * scale;
    GAME_CONFIG.PIPE_SPEED = config.PIPE_SPEED * scale;
}

// --- Utility & UI Functions ---
function showScreen(screenName) { Object.values(screens).forEach(s => s.classList.remove('active')); if(screens[screenName]) screens[screenName].classList.add('active'); document.body.classList.toggle('p-4', screenName !== 'game'); }
function checkLoginStatus() { fetch('/api/user').then(res => res.ok ? res.json().then(handleLoginSuccess) : showLoginScreen()).catch(err => { console.error("API error:", err); showLoginScreen(); }); }
function showLoginScreen() { showScreen('login'); screens.loading.classList.remove('active'); }

function handleLoginSuccess(user) {
    currentUser = user;
    welcomeMessage.textContent = `Welcome, ${user.customUsername || user.displayName}!`;
    userIdDisplay.textContent = user._id;
    showScreen('mainMenu');
    screens.loading.classList.remove('active');
    document.getElementById('logout-btn').href = user.isGuest ? '#' : '/auth/logout';
    if (!user.isGuest) socket.emit('requestInitialData');
}

// --- Event Listeners ---
socket.on('connect', () => { console.log('Socket.IO connected.'); checkLoginStatus(); });
document.getElementById('guest-login-btn').addEventListener('click', () => socket.emit('guestLogin'));
socket.on('loginSuccess', handleLoginSuccess);

document.getElementById('logout-btn').addEventListener('click', (e) => { if (currentUser && currentUser.isGuest) { e.preventDefault(); window.location.reload(); } });

// --- Multiplayer Lobby ---
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
    document.querySelector('.tab-btn.active').classList.remove('active');
    e.target.classList.add('active');
    document.querySelector('.tab-content.active').classList.remove('active');
    document.getElementById(e.target.dataset.tab + '-tab').classList.add('active');
    if (e.target.dataset.tab === 'leaderboards' && currentUser && !currentUser.isGuest) socket.emit('getLeaderboards');
}));

document.getElementById('add-friend-btn').addEventListener('click', () => {
    const friendId = document.getElementById('add-friend-input').value;
    if (friendId) socket.emit('addFriend', friendId);
});

socket.on('friendsList', ({ friends: f, onlineFriendIds: o }) => { friends = f; onlineFriendIds = o; renderFriendsList(); });
socket.on('friendAdded', (newFriend) => { friends.push(newFriend); renderFriendsList(); });

function renderFriendsList() {
    const listEl = document.getElementById('friends-list');
    if (!currentUser || currentUser.isGuest) { listEl.innerHTML = `<p class="text-gray-500">Login with Google to add friends.</p>`; return; }
    if (friends.length === 0) { listEl.innerHTML = `<p class="text-gray-500">No friends yet. Add one!</p>`; return; }
    listEl.innerHTML = friends.map(friend => {
        const isOnline = onlineFriendIds.includes(friend._id.toString());
        return `<div class="flex justify-between items-center p-2 border-b">
            <span>${friend.customUsername} <span class="text-xs ${isOnline ? 'text-green-500' : 'text-gray-400'}">${isOnline ? '● Online' : '○ Offline'}</span></span>
            ${isOnline ? `<button class="invite-btn text-xs bg-blue-500 text-white px-2 py-1 rounded" data-id="${friend._id}">Invite</button>` : ''}
        </div>`;
    }).join('');
}
document.getElementById('friends-list').addEventListener('click', e => { if (e.target.classList.contains('invite-btn')) { socket.emit('sendInvite', { toUserId: e.target.dataset.id }); alert('Invite sent!'); } });

socket.on('inviteReceived', ({ fromId, fromName }) => {
    const modal = document.getElementById('invite-modal');
    document.getElementById('invite-from-text').textContent = `${fromName} invited you to play!`;
    modal.style.display = 'flex';
    document.getElementById('accept-invite-btn').onclick = () => { socket.emit('acceptInvite', fromId); modal.style.display = 'none'; };
    document.getElementById('decline-invite-btn').onclick = () => { modal.style.display = 'none'; };
});

socket.on('showDifficultySelect', ({ gameId }) => {
    difficultyModal.dataset.gameId = gameId;
    document.getElementById('my-difficulty-choice').textContent = 'Waiting...';
    document.getElementById('opponent-difficulty-choice').textContent = 'Waiting...';
    difficultyModal.style.display = 'flex';
});

document.getElementById('difficulty-choices').addEventListener('click', e => {
    if (e.target.dataset.difficulty) {
        const gameId = difficultyModal.dataset.gameId;
        const difficulty = e.target.dataset.difficulty;
        socket.emit('difficultySelected', { gameId, difficulty });
    }
});

socket.on('updateDifficultyChoices', ({ myChoice, opponentChoice, opponentName }) => {
    document.getElementById('my-difficulty-choice').textContent = myChoice || 'Waiting...';
    document.getElementById('opponent-difficulty-choice').textContent = opponentChoice || 'Waiting...';
    document.getElementById('opponent-name').textContent = opponentName;
});


// --- Settings ---
document.getElementById('dark-mode-toggle').addEventListener('change', e => document.body.classList.toggle('dark', e.target.checked));
document.getElementById('difficulty-selection').addEventListener('change', e => { singlePlayerDifficulty = e.target.value; });

// --- Leaderboards ---
socket.on('leaderboards', ({ singlePlayer, multiPlayer }) => { /* ... leaderboard rendering logic ... */ });

// --- Game Start/End ---
socket.on('gameStart', ({ gameId, opponentName, difficulty }) => {
    difficultyModal.style.display = 'none';
    startMultiplayerGame(gameId, opponentName, difficulty);
});
socket.on('opponentScoreUpdate', score => document.getElementById('opponent-score').textContent = score);
document.getElementById('single-player-btn').addEventListener('click', () => startSinglePlayerGame());
document.getElementById('multiplayer-btn').addEventListener('click', () => showScreen('multiplayerLobby'));
document.getElementById('lobby-back-btn').addEventListener('click', () => showScreen('mainMenu'));
document.getElementById('game-back-btn').addEventListener('click', () => { stopGame(); showScreen('mainMenu'); });
document.getElementById('restart-btn').addEventListener('click', () => { if (currentGameState.mode === 'single') startSinglePlayerGame(); else { stopGame(); showScreen('mainMenu'); } });
userIdDisplay.addEventListener('click', (e) => navigator.clipboard.writeText(e.target.textContent).then(() => alert('ID Copied!')));

// --- Game Logic ---
const BIRD = { x: 100, y: 150, velocity: 0, draw() { ctx.beginPath(); ctx.arc(this.x, this.y, GAME_CONFIG.BIRD_RADIUS, 0, Math.PI * 2); ctx.fillStyle = "#FFD700"; ctx.fill(); }, update() { this.velocity += GAME_CONFIG.BIRD_GRAVITY; this.y += this.velocity; if (this.y + GAME_CONFIG.BIRD_RADIUS > canvas.height || this.y - GAME_CONFIG.BIRD_RADIUS < 0) currentGameState.gameOver = true; }, flap() { this.velocity = GAME_CONFIG.BIRD_LIFT; sounds.flap.currentTime=0; sounds.flap.play(); } };
const PIPE = { draw(p) { ctx.fillStyle = "#008000"; ctx.fillRect(p.x, 0, GAME_CONFIG.PIPE_WIDTH, p.top); ctx.fillRect(p.x, canvas.height - p.bottom, GAME_CONFIG.PIPE_WIDTH, p.bottom); } };

function resetGameState() { currentGameState = { ...currentGameState, bird: { ...BIRD, y: canvas.height / 2, x: canvas.width / 4 }, pipes: [], score: 0, gameOver: false, frame: 0 }; document.getElementById('game-over-message').style.display = 'none'; }
function startSinglePlayerGame() { resizeCanvas(); updateGameConstants(canvas.height, singlePlayerDifficulty); resetGameState(); currentGameState.mode = 'single'; document.getElementById('local-score').textContent = 0; document.getElementById('opponent-score-display').classList.add('hidden'); showScreen('game'); gameLoop(); }
function startMultiplayerGame(gameId, opponentName, difficulty) { resizeCanvas(); updateGameConstants(canvas.height, difficulty); resetGameState(); currentGameState.mode = 'multi'; currentGameState.gameId = gameId; document.getElementById('local-score').textContent = 0; const oppScore = document.getElementById('opponent-score-display'); oppScore.classList.remove('hidden'); oppScore.childNodes[0].nodeValue = `${opponentName}: `; oppScore.querySelector('span').textContent = 0; showScreen('game'); gameLoop(); }
function stopGame() { cancelAnimationFrame(gameLoopId); gameLoopId = null; }

function gameLoop() {
    if (currentGameState.gameOver) { sounds.gameOver.play(); socket.emit('gameOver', { score: currentGameState.score, mode: currentGameState.mode }); document.getElementById('game-over-message').style.display = 'flex'; stopGame(); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    currentGameState.bird.update();
    if (currentGameState.frame % 90 === 0) { const topHeight = Math.random() * (canvas.height - GAME_CONFIG.PIPE_GAP - 200) + 100; currentGameState.pipes.push({ x: canvas.width, top: topHeight, bottom: canvas.height - topHeight - GAME_CONFIG.PIPE_GAP, passed: false }); }
    for (let i = currentGameState.pipes.length - 1; i >= 0; i--) {
        let p = currentGameState.pipes[i]; p.x -= GAME_CONFIG.PIPE_SPEED; PIPE.draw(p);
        if (currentGameState.bird.x + GAME_CONFIG.BIRD_RADIUS > p.x && currentGameState.bird.x - GAME_CONFIG.BIRD_RADIUS < p.x + GAME_CONFIG.PIPE_WIDTH) { if (currentGameState.bird.y - GAME_CONFIG.BIRD_RADIUS < p.top || currentGameState.bird.y + GAME_CONFIG.BIRD_RADIUS > canvas.height - p.bottom) currentGameState.gameOver = true; }
        if (!p.passed && p.x + GAME_CONFIG.PIPE_WIDTH < currentGameState.bird.x) { currentGameState.score++; p.passed = true; document.getElementById('local-score').textContent = currentGameState.score; sounds.score.currentTime=0; sounds.score.play(); if (currentGameState.mode === 'multi') socket.emit('scoreUpdate', { gameId: currentGameState.gameId, score: currentGameState.score }); }
        if (p.x + GAME_CONFIG.PIPE_WIDTH < 0) currentGameState.pipes.splice(i, 1);
    }
    currentGameState.bird.draw();
    currentGameState.frame++;
    gameLoopId = requestAnimationFrame(gameLoop);
}

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; updateGameConstants(canvas.height, singlePlayerDifficulty); }
window.addEventListener('resize', resizeCanvas);
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !currentGameState.gameOver && gameLoopId) currentGameState.bird.flap(); });
canvas.addEventListener('click', () => { if (!currentGameState.gameOver && gameLoopId) currentGameState.bird.flap(); });
window.onload = () => { resizeCanvas(); };

