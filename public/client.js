// --- Establish connection to the server ---
const loadingMessage = document.getElementById('loading-message');

// --- CRITICAL DEBUGGING STEP ---
// This code runs immediately. If you don't see this message, the client.js file itself is not loading.
loadingMessage.textContent = '1. client.js script has started.';

// This function will now check if the core Socket.IO library loaded correctly.
function initializeSocketConnection() {
    if (typeof io === 'undefined') {
        // This is the most likely error. It means socket.io.js failed to load from the server.
        loadingMessage.textContent = 'FATAL ERROR: Socket.IO library (io) not found. Check server logs and Network tab for 404 errors on socket.io.js.';
        return; // Stop execution
    }

    loadingMessage.textContent = '2. Socket.IO library found. Connecting to server...';
    const socket = io();
    
    // Attach all socket event listeners inside this function
    setupSocketListeners(socket);
}


// --- Game State & Settings ---
let gameLoopId;
let currentUser = null;
let currentGameState = {
    bird: null, pipes: [], score: 0, gameOver: false, frame: 0,
    mode: 'single', gameId: null, opponentName: null, difficulty: 'medium',
    countdown: 3, gameStarted: false
};
let gameSettings = {
    jumpLevel: 7, // Default jump level (Normal)
    darkMode: false
};

// --- UI Elements ---
const screens = {
    loading: document.getElementById('loading-screen'),
    login: document.getElementById('login-screen'),
    mainMenu: document.getElementById('main-menu-screen'),
    multiplayerLobby: document.getElementById('multiplayer-lobby-screen'),
    game: document.getElementById('game-screen'),
};
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const countdownOverlay = document.getElementById('countdown-overlay');

// --- Utility Functions ---
function showScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    if (screens[screenName]) screens[screenName].classList.add('active');
}

// --- Settings Management ---
function saveSettings() {
    localStorage.setItem('flappyBirdSettings', JSON.stringify(gameSettings));
}

function loadSettings() {
    const saved = localStorage.getItem('flappyBirdSettings');
    if (saved) {
        gameSettings = JSON.parse(saved);
        document.getElementById('dark-mode-toggle').checked = gameSettings.darkMode;
        document.body.classList.toggle('dark-mode', gameSettings.darkMode);
        const jumpSlider = document.getElementById('jump-level-slider');
        jumpSlider.value = gameSettings.jumpLevel;
        updateJumpLevelDisplay(gameSettings.jumpLevel);
    }
}

function updateJumpLevelDisplay(value) {
    const display = document.getElementById('jump-level-value');
    const numericValue = Number(value);
    if (numericValue < 6) display.textContent = 'Weak';
    else if (numericValue < 8) display.textContent = 'Normal';
    else display.textContent = 'Strong';
}

// --- Socket.IO Event Listeners ---
function setupSocketListeners(socket) {
    socket.on('connect', () => {
        loadingMessage.textContent = '3. Connected to server! Checking authentication...';
        fetch('/api/user').then(res => res.json()).then(user => {
            loadingMessage.textContent = '4. Auth check complete.';
            if (user && user._id) {
                currentUser = user;
                if (!user.customUsername) {
                    document.getElementById('username-modal').style.display = 'flex';
                } else {
                    showMainMenu();
                }
            } else {
                showScreen('login');
            }
        }).catch((err) => {
            loadingMessage.textContent = 'ERROR: Authentication failed. This usually means your Environment Variables on Render are incorrect or the server crashed. Check the Render logs.';
            console.error("Auth fetch failed:", err);
        });
    });

    socket.on('loginSuccess', (user) => {
        currentUser = user;
        showMainMenu();
    });

    socket.on('inviteReceived', ({ fromId, fromName }) => {
        const modal = document.getElementById('invite-modal');
        document.getElementById('invite-from-text').textContent = `${fromName} has invited you to play!`;
        modal.style.display = 'flex';
        document.getElementById('accept-invite-btn').onclick = () => {
            socket.emit('acceptInvite', fromId);
            modal.style.display = 'none';
        };
        document.getElementById('decline-invite-btn').onclick = () => modal.style.display = 'none';
    });

    socket.on('showDifficultySelect', ({ gameId }) => {
        currentGameState.gameId = gameId;
        document.getElementById('difficulty-modal').style.display = 'flex';
        document.getElementById('difficulty-status-text').textContent = 'Choose your difficulty!';
    });

    socket.on('updateDifficultyChoices', ({ myChoice, opponentChoice, opponentName }) => {
        const text = `You: ${myChoice || '...'} | ${opponentName}: ${opponentChoice || '...'}`;
        document.getElementById('difficulty-status-text').textContent = text;
    });

    socket.on('gameStart', ({ gameId, opponentName, difficulty }) => {
        document.getElementById('difficulty-modal').style.display = 'none';
        startMultiplayerGame(gameId, opponentName, difficulty);
    });

    socket.on('opponentScoreUpdate', score => {
        if (document.getElementById('opponent-score')) {
            document.getElementById('opponent-score').textContent = score
        }
    });

    socket.on('friendAdded', friend => addFriendToList(friend, true));

    socket.on('friendsList', ({ friends, onlineFriendIds }) => {
        const list = document.getElementById('friends-list');
        if (!list) return;
        list.innerHTML = '';
        friends.forEach(friend => addFriendToList(friend, onlineFriendIds.includes(friend._id.toString())));
    });

    socket.on('leaderboards', ({ singlePlayer, multiPlayer }) => {
        const spList = document.getElementById('single-player-leaderboard');
        if (spList) spList.innerHTML = singlePlayer.map(s => `<li>${s.username}: ${s.score}</li>`).join('') || '<li>No scores yet.</li>';
        const mpList = document.getElementById('multiplayer-leaderboard');
        if (mpList) mpList.innerHTML = multiPlayer.map(p => `<li>${p.customUsername}: ${p.wins} wins</li>`).join('') || '<li>No wins yet.</li>';
    });
}


// --- Main Menu and Lobby Logic ---
function showMainMenu() {
    document.getElementById('welcome-message').textContent = `Welcome, ${currentUser.customUsername}!`;
    document.getElementById('user-id-display').textContent = currentUser._id;
    showScreen('main-menu');
}

document.getElementById('guest-login-btn').addEventListener('click', () => socket.emit('guestLogin'));

document.getElementById('set-username-btn').addEventListener('click', () => {
    const username = document.getElementById('username-input').value.trim();
    if (username && username.length > 2) {
        socket.emit('setUsername', username);
        document.getElementById('username-modal').style.display = 'none';
    } else { alert('Username must be at least 3 characters.'); }
});

document.getElementById('multiplayer-btn').addEventListener('click', () => {
    showScreen('multiplayer-lobby');
    document.querySelector('.tab-btn[data-tab="friends"]').click();
    socket.emit('getLeaderboards');
    socket.emit('requestInitialData');
});

document.getElementById('lobby-back-btn').addEventListener('click', () => showScreen('main-menu'));

// Tab Switching
document.querySelectorAll('.tab-btn').forEach(button => {
    button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById(`${tab}-tab`).classList.add('active');
        button.classList.add('active');
    });
});

// --- Friends Logic ---
document.getElementById('add-friend-btn').addEventListener('click', () => {
    const friendId = document.getElementById('add-friend-input').value.trim();
    if (friendId) socket.emit('addFriend', friendId);
    document.getElementById('add-friend-input').value = '';
});

function addFriendToList(friend, isOnline) {
    const list = document.getElementById('friends-list');
    const friendDiv = document.createElement('div');
    friendDiv.className = 'flex justify-between items-center p-2 rounded';
    friendDiv.innerHTML = `
        <span>${friend.customUsername}</span>
        <button class="invite-btn btn btn-sm py-1 px-2 ${isOnline ? 'btn-green' : 'bg-gray-500'}" 
                data-id="${friend._id}" ${!isOnline ? 'disabled' : ''}>
            ${isOnline ? 'Invite' : 'Offline'}
        </button>
    `;
    list.appendChild(friendDiv);
    friendDiv.querySelector('.invite-btn').addEventListener('click', (e) => {
        socket.emit('sendInvite', { toUserId: e.target.dataset.id });
        alert('Invite sent!');
    });
}

// --- Game Logic ---
const BIRD = { x: 100, y: 150, radius: 15, gravity: 0.4, lift: -7, velocity: 0,
    draw() { ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, 2 * Math.PI); ctx.fillStyle = "#FFD700"; ctx.fill(); ctx.closePath(); },
    update() { this.velocity += this.gravity; this.y += this.velocity; },
    flap() { this.velocity = this.lift; }
};

let PIPE = { gap: 200, width: 60, speed: 3,
    draw(pipe) { ctx.fillStyle = "#008000"; ctx.fillRect(pipe.x, 0, this.width, pipe.top); ctx.fillRect(pipe.x, canvas.height - pipe.bottom, this.width, pipe.bottom); }
};

function setDifficulty(difficulty) {
    currentGameState.difficulty = difficulty;
    switch (difficulty) {
        case 'easy': PIPE = { ...PIPE, speed: 2, gap: 250 }; break;
        case 'hard': PIPE = { ...PIPE, speed: 4, gap: 180 }; break;
        default: PIPE = { ...PIPE, speed: 3, gap: 200 }; break;
    }
}

function resetGameState() {
    currentGameState.bird = { ...BIRD, y: canvas.height / 2, lift: -gameSettings.jumpLevel };
    currentGameState.pipes = [];
    currentGameState.score = 0;
    currentGameState.gameOver = false;
    currentGameState.frame = 0;
    currentGameState.gameStarted = false;
    currentGameState.countdown = 3;
    document.getElementById('local-score').textContent = 0;
    document.getElementById('game-over-message').style.display = 'none';
}

function beginGameCountdown() {
    resetGameState();
    showScreen('game');
    resizeCanvas();
    currentGameState.bird.draw();
    countdownOverlay.textContent = currentGameState.countdown;
    countdownOverlay.style.display = 'flex';
    const countdownInterval = setInterval(() => {
        currentGameState.countdown--;
        if (currentGameState.countdown > 0) {
            countdownOverlay.textContent = currentGameState.countdown;
        } else {
            clearInterval(countdownInterval);
            countdownOverlay.style.display = 'none';
            currentGameState.gameStarted = true;
            gameLoopId = requestAnimationFrame(gameLoop);
        }
    }, 1000);
}

document.getElementById('single-player-btn').addEventListener('click', () => {
    currentGameState.mode = 'single';
    document.getElementById('opponent-score-display').classList.add('hidden');
    document.getElementById('difficulty-modal').style.display = 'flex';
    document.getElementById('difficulty-status-text').textContent = 'Choose your difficulty for this round!';
});

function startMultiplayerGame(gameId, opponentName, difficulty) {
    currentGameState.mode = 'multi';
    currentGameState.gameId = gameId;
    currentGameState.opponentName = opponentName;
    setDifficulty(difficulty);
    document.getElementById('opponent-score').textContent = 0;
    document.getElementById('opponent-score-display').classList.remove('hidden');
    beginGameCountdown();
}

function stopGame() {
    if (gameLoopId) cancelAnimationFrame(gameLoopId);
    gameLoopId = null;
}

function gameLoop() {
    if (currentGameState.gameOver) {
        let won = false;
        if (currentGameState.mode === 'multi') {
            const myScore = currentGameState.score;
            const opponentScore = parseInt(document.getElementById('opponent-score').textContent);
            won = myScore > opponentScore;
            document.getElementById('game-over-text').textContent = won ? "You Win!" : "You Lose!";
        } else {
            document.getElementById('game-over-text').textContent = "Game Over";
        }
        document.getElementById('game-over-message').style.display = 'flex';
        socket.emit('gameOver', { score: currentGameState.score, mode: currentGameState.mode, won });
        stopGame();
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (currentGameState.gameStarted) currentGameState.bird.update();
    if (currentGameState.bird.y + currentGameState.bird.radius > canvas.height || currentGameState.bird.y - currentGameState.bird.radius < 0) currentGameState.gameOver = true;
    if (currentGameState.gameStarted) {
        if (currentGameState.frame % 100 === 0) {
            const top = Math.random() * (canvas.height - PIPE.gap - 100) + 50;
            const bottom = canvas.height - top - PIPE.gap;
            currentGameState.pipes.push({ x: canvas.width, top, bottom, passed: false });
        }
        for (let i = currentGameState.pipes.length - 1; i >= 0; i--) {
            let p = currentGameState.pipes[i];
            p.x -= PIPE.speed;
            if (p.x + PIPE.width < 0) { currentGameState.pipes.splice(i, 1); continue; }
            if (currentGameState.bird.x + currentGameState.bird.radius > p.x && currentGameState.bird.x - currentGameState.bird.radius < p.x + PIPE.width &&
                (currentGameState.bird.y - currentGameState.bird.radius < p.top || currentGameState.bird.y + currentGameState.bird.radius > canvas.height - p.bottom)) {
                currentGameState.gameOver = true;
            }
            if (!p.passed && p.x + PIPE.width < currentGameState.bird.x) {
                currentGameState.score++;
                p.passed = true;
                document.getElementById('local-score').textContent = currentGameState.score;
                if (currentGameState.mode === 'multi') socket.emit('scoreUpdate', currentGameState.score);
            }
            PIPE.draw(p);
        }
    }
    currentGameState.bird.draw();
    currentGameState.frame++;
    gameLoopId = requestAnimationFrame(gameLoop);
}

// --- Event Listeners & Initializers ---
document.addEventListener('keydown', e => { if (e.code === 'Space' && !currentGameState.gameOver && gameLoopId) currentGameState.bird.flap(); });
canvas.addEventListener('click', () => { if (!currentGameState.gameOver && gameLoopId) currentGameState.bird.flap(); });
document.getElementById('game-back-btn').addEventListener('click', () => { stopGame(); showScreen('main-menu'); });

document.querySelectorAll('.difficulty-btn').forEach(button => {
    button.addEventListener('click', (e) => {
        const difficulty = e.target.dataset.difficulty;
        if (currentGameState.mode === 'single') {
            document.getElementById('difficulty-modal').style.display = 'none';
            setDifficulty(difficulty);
            beginGameCountdown();
        } else {
            socket.emit('difficultySelected', { gameId: currentGameState.gameId, difficulty });
        }
    });
});

document.getElementById('dark-mode-toggle').addEventListener('change', (e) => {
    gameSettings.darkMode = e.target.checked;
    document.body.classList.toggle('dark-mode', gameSettings.darkMode);
    saveSettings();
});

document.getElementById('jump-level-slider').addEventListener('input', (e) => {
    gameSettings.jumpLevel = e.target.value;
    updateJumpLevelDisplay(e.target.value);
    saveSettings();
});

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

// Initialize
window.onload = () => {
    loadSettings();
    showScreen('loading');
    initializeSocketConnection();
};
```

### **Step 2: Deploy and Report the Message**

1.  Replace the code in your local `server.js`, `public/index.html`, and `public/client.js` files.
2.  Push the changes to GitHub using the force push command:
    ```bash
    git add .
    git commit -m "Add robust debugging for blank screen"
    git push --force origin main
    

