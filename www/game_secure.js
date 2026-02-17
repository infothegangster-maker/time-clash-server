// ===================================
// TIME CLASH - TRUE CLOUD STREAMING (NO LOCAL TIMER)
// ===================================

const SERVER_URL = "https://time-clash-server.onrender.com"; 

let socket = null;
let hearts = 6;
let isGameRunning = false;

// --- UI Elements ---
const timerDisplay = document.getElementById('timer-display');
const targetDisplay = document.getElementById('target-display');
const heartsDisplay = document.getElementById('hearts-display');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const resultScreen = document.getElementById('screen-result');
const resultText = document.getElementById('result-text');
const prizeText = document.getElementById('prize-text');
const rankText = document.getElementById('rank-text');
const leaderboardList = document.getElementById('leaderboard-list');
const toast = document.getElementById('message-toast');
const toastText = document.getElementById('toast-text');

// --- HELPER FUNCTIONS ---
function updateHearts() {
    let heartString = "";
    for(let i=0; i<hearts; i++) heartString += "❤️";
    for(let i=hearts; i<6; i++) heartString += "🖤"; 
    heartsDisplay.textContent = heartString;
}

function showToast(msg) {
    toastText.textContent = msg;
    toast.style.display = 'block';
    if (!msg.includes('Loading') && !msg.includes('Connecting')) {
        setTimeout(() => toast.style.display = 'none', 2000);
    }
}

function hideToast() {
    toast.style.display = 'none';
}

// --- SOCKET CONNECTION ---
function connectToServer() {
    showToast("Connecting to Cloud...");
    
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
        console.log("Connected to Cloud Server");
        showToast("Connected!");
        setTimeout(hideToast, 1000);
        initGame();
    });

    socket.on('connect_error', (err) => {
        console.error("Connection Error:", err);
        showToast("Connection Failed. Retrying...");
    });

    // --- GAME EVENTS ---

    // 1. GAME READY (Receive Target)
    socket.on('game_ready', (data) => {
        targetDisplay.textContent = data.targetTimeStr;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        isGameRunning = false;
        timerDisplay.textContent = '00:0000';
    });

    // 2. TIMER STREAM (From Cloud)
    socket.on('timer_update', (data) => {
        // DIRECTLY SHOW WHAT SERVER SENDS
        // NO LOCAL CALCULATION
        timerDisplay.textContent = data.timeStr;
    });

    // 3. GAME RESULT (From Cloud)
    socket.on('game_result', (data) => {
        isGameRunning = false;
        timerDisplay.textContent = data.finalTimeStr; // Ensure final display matches result
        
        if (data.win) {
            showResult(true, data);
        } else {
            hearts--;
            updateHearts();
            
            if (hearts > 0) {
                showToast(`Missed by ${data.diff}ms! ${hearts} Lives Left.`);
                // Allow instant retry
                startBtn.disabled = false;
            } else {
                showResult(false, data);
            }
        }
    });
    
    socket.on('leaderboard_update', (leaders) => {
        leaderboardList.innerHTML = '';
        leaders.forEach((leader, index) => {
            const li = document.createElement('li');
            li.textContent = `#${index + 1} - ${leader.score}ms`; 
            leaderboardList.appendChild(li);
        });
    });
}

function initGame() {
    if (!socket) return;
    if (hearts === 0) hearts = 6;
    
    updateHearts();
    socket.emit('init_game', { userId: 'player_' + Math.floor(Math.random()*10000) });
}

// --- BUTTON ACTIONS ---
function startGame() {
    if (!socket) return;
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    isGameRunning = true;
    
    // TELL CLOUD TO START TIMER
    socket.emit('start_timer');
}

function stopGame() {
    if (!socket || !isGameRunning) return;
    
    // TELL CLOUD TO STOP TIMER
    socket.emit('stop_timer');
    stopBtn.disabled = true;
}

function resetGame() {
    hearts = 6;
    updateHearts();
    resultScreen.classList.remove('active');
    initGame();
}

function showResult(win, data) {
    resultScreen.classList.add('active');
    if (win) { 
        resultText.innerHTML = `🎉 UNLOCKED!`;
        resultText.classList.add('win');
        resultText.classList.remove('fail');
        prizeText.innerHTML = `PERFECT TIMING!<br>Diff: 0ms`;
    } else {
        resultText.innerHTML = `❌ GAME OVER`;
        resultText.classList.add('fail');
        resultText.classList.remove('win');
        prizeText.innerHTML = `Ran out of lives!<br>Last Miss: <span style="color:red;">${data.diff}ms</span>`;
    }
}

// Event Listeners
startBtn.addEventListener('click', startGame);
stopBtn.addEventListener('click', stopGame);
document.getElementById('play-again-btn').addEventListener('click', resetGame);

// Start
updateHearts();
connectToServer();
