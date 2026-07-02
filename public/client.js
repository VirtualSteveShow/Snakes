'use strict';

const VERSION = 'v1.32';

// ── Difficulty ────────────────────────────────────────────────
const DIFFICULTIES = {
    easy:   { cells: 15, baseMs: 300, minMs: 140, speedStep: 2 },
    normal: { cells: 20, baseMs: 160, minMs:  65, speedStep: 3 },
};
let difficulty = localStorage.getItem('snake_diff') || 'normal';
let CELL_COUNT = DIFFICULTIES[difficulty].cells;
let BASE_MS    = DIFFICULTIES[difficulty].baseMs;
let MIN_MS     = DIFFICULTIES[difficulty].minMs;
let SPEED_STEP = DIFFICULTIES[difficulty].speedStep;
let gameMode   = localStorage.getItem('snake_mode') || 'classic';

function getScoreKey() { return `${gameMode}-${difficulty}`; }

// ── Constants ─────────────────────────────────────────────────
const SWIPE_MIN       = 22;
const MAX_CANVAS      = 500;
const FLY_LIFETIME    = 8000;
const FLY_MOVE_MS     = 250;   // slower = easier to catch
const FLY_POINTS      = 3;
const FLY_SPAWN_CHANCE = 0.25;
const ENTER_DUR       = 550;   // snake slide-in ms
const FOOD_BOUNCE_DUR = 480;   // food throw-in ms
const FLY_ENTER_DUR   = 500;   // fly slide-in ms

// ── Note frequencies (Hz) ─────────────────────────────────────
const F = {
    R:0,
    C3:130.81, D3:146.83, E3:164.81, G3:196.00, A3:220.00,
    C4:261.63, D4:293.66, E4:329.63, G4:392.00, A4:440.00,
    C5:523.25, D5:587.33, E5:659.25, G5:783.99, A5:880.00,
};

// ── Music sequences (16th-note grid, 64 steps = 4 bars @ 128 BPM) ──
// Each entry: [frequency_hz, step_count]
const BPM  = 128;
const STEP = 60 / BPM / 4; // one 16th note ≈ 0.117 s

const MELODY_SEQ = [
    // bar 1
    [F.E5,2],[F.G5,2],[F.A5,2],[F.G5,2],  [F.E5,2],[F.C5,2],[F.D5,4],
    // bar 2
    [F.E5,2],[F.G5,2],[F.A5,2],[F.G5,2],  [F.E5,2],[F.D5,2],[F.C5,4],
    // bar 3
    [F.G5,2],[F.A5,2],[F.G5,2],[F.E5,2],  [F.G5,2],[F.A5,2],[F.G5,4],
    // bar 4
    [F.A5,2],[F.G5,2],[F.E5,2],[F.D5,2],  [F.E5,2],[F.G5,2],[F.E5,2],[F.C5,2],
];
const BASS_SEQ = [
    [F.C3,4],[F.C3,4],[F.G3,4],[F.G3,4],  // bar 1
    [F.C3,4],[F.C3,4],[F.G3,4],[F.G3,4],  // bar 2
    [F.A3,4],[F.A3,4],[F.G3,4],[F.G3,4],  // bar 3
    [F.G3,4],[F.G3,4],[F.G3,4],[F.C3,4],  // bar 4 — resolves to tonic for seamless loop
];

function flattenSeq(seq) {
    const out = [];
    for (const [freq, dur] of seq) {
        out.push(freq);
        for (let i = 1; i < dur; i++) out.push(-1); // hold — no new note
    }
    return out;
}
const MEL_STEPS = flattenSeq(MELODY_SEQ); // 64 entries
const BAS_STEPS = flattenSeq(BASS_SEQ);   // 64 entries

// ── Audio state ───────────────────────────────────────────────
let audioCtx    = null;
let masterGain  = null;
let musicGain   = null;
let sfxGain     = null;
let noiseBuffer = null;
let musicTimer  = null;
let nextBeat    = 0;
let beatIndex   = 0;

let masterVol = parseInt(localStorage.getItem('snake_mvol')   || '80', 10) / 100;
let musicVol  = parseInt(localStorage.getItem('snake_musvol') || '70', 10) / 100;
let sfxVol    = parseInt(localStorage.getItem('snake_sfxvol') || '80', 10) / 100;
let hapticsOn = localStorage.getItem('snake_haptics') !== 'off';

// ── WAV audio buffers ─────────────────────────────────────────
let gameOverBuffer   = null;
let musicBuffer      = null;
let musicSource      = null;
let musicFadeGain    = null;
let gameOverSource   = null;
let gameOverFadeGain = null;
let _goAB  = null;
let _musAB = null;

fetch('gameover.wav').then(r => r.arrayBuffer()).then(ab => { _goAB  = ab; if (audioCtx) _decodeWavs(); }).catch(() => {});
fetch('music.wav'   ).then(r => r.arrayBuffer()).then(ab => { _musAB = ab; if (audioCtx) _decodeWavs(); }).catch(() => {});

function _normalizeBuffer(buf) {
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
    }
    if (peak < 0.001) return;
    const g = 0.88 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g;
    }
}

function _decodeWavs() {
    if (_goAB && !gameOverBuffer) {
        const ab = _goAB; _goAB = null;
        audioCtx.decodeAudioData(ab).then(buf => { _normalizeBuffer(buf); gameOverBuffer = buf; }).catch(() => {});
    }
    if (_musAB && !musicBuffer) {
        const ab = _musAB; _musAB = null;
        audioCtx.decodeAudioData(ab).then(buf => { _normalizeBuffer(buf); musicBuffer = buf; }).catch(() => {});
    }
}

function _fadeStop(src, fadeGain, fadeSecs) {
    if (!src) return;
    if (fadeGain && audioCtx) {
        const now = audioCtx.currentTime;
        fadeGain.gain.cancelScheduledValues(now);
        fadeGain.gain.setValueAtTime(fadeGain.gain.value, now);
        fadeGain.gain.linearRampToValueAtTime(0, now + fadeSecs);
        try { src.stop(now + fadeSecs + 0.02); } catch(_) {}
    } else { try { src.stop(); } catch(_) {} }
}

// ── Game state ────────────────────────────────────────────────
let canvas, ctx;
let score       = 0;
let highScore   = 0;
let snake       = [];
let dir         = 'right';
let nextDir     = 'right';
let food        = { x: 5, y: 5 };
let gameState   = 'start';
let lastTick    = 0;
let tickMs      = BASE_MS;
let deathTime   = 0;
let foodPulse   = 0;
let optionsOpen = false;


// ── Visual juice state ────────────────────────────────────────
const bgImg = new Image();
bgImg.src = 'images/bg_grass.png';
let particles = [], scorePops = [], shakeMag = 0;
let handedness      = localStorage.getItem('snake_hand') || 'right';
let lungePauseUntil = 0;
let lungeQueue      = 0;
let countdownN      = 0;
let tongueFlickBorn = -Infinity;
let holdBoost     = false;
let enterSlideX   = 0;
let enterStart    = 0;
let foodSpawnTime = 0;
let fly           = null;   // {x, y} | null
let flyUntil      = 0;
let flyTimer      = 0;
let flyRegion     = null;   // {cx, cy, r} home zone
let flyEntering   = false;
let flyEnterFrom  = { x: 0, y: 0 };
let flyEnterStart = 0;
let flyBuzzOsc    = null;
let flyBuzzMod    = null;
let flyBuzzGain   = null;

const FOOD_TYPES = ['apple', 'strawberry', 'watermelon', 'cherry', 'grape'];
let foodType = 'apple';
const DEBRIS_COLORS = ['#c8a050','#d4b860','#e8d090','#a06828','#b8cc44','#e0f060'];
const DEBRIS_ANGLE  = { right: Math.PI, left: 0, up: Math.PI/2, down: -Math.PI/2 };

// ── Advanced mode state ───────────────────────────────────────
let coins          = [];       // {x,y}[] on-grid coin pickups
let shopBlock      = null;     // {x,y} | null
let playerCoins    = 0;
let foodForShop    = 0;        // food eaten since last shop spawn
let shopOpen       = false;
let tongue         = null;     // {ex,ey} tongue endpoint while visible
let tongueVisUntil = 0;        // performance.now() deadline for tongue visual
let babySnake      = [];       // {x,y}[] helper snake segments
let babyUntil      = 0;        // performance.now() when sidekick expires
let slowUntil      = 0;        // performance.now() when slow-time expires

let abilityLevels    = { tongue:0, slowtime:0, babysnake:0 };  // 0=locked, 1/2/3
let abilityCooldowns = { tongue:0, slowtime:0, babysnake:0 };  // ready-at timestamp

const ABILITY_CFG = {
    tongue: {
        name: 'TONGUE',
        descs:     ['Snag food/coins in front', 'Longer reach', 'Max range'],
        costs:     [5, 8, 12],
        cooldowns: [8000, 6000, 4000],
        ranges:    [4, 7, 11],
    },
    slowtime: {
        name: 'SLOW TIME',
        descs:     ['3s speed halved', '5s speed halved', '7s speed halved'],
        costs:     [6, 10, 15],
        cooldowns: [12000, 10000, 8000],
        durations: [3000, 5000, 7000],
    },
    babysnake: {
        name: 'SIDEKICK',
        descs:     ['10s coin collector', '15s coin collector', '20s coin collector'],
        costs:     [8, 12, 18],
        cooldowns: [15000, 12000, 10000],
        durations: [10000, 15000, 20000],
    },
};

// ── Profile system ────────────────────────────────────────────
let _pendingAvatar = null;    // base64 data URL from image picker
let _editingProfileId = null; // set when profile-overlay is editing an existing profile

function _profiles() {
    try {
        const ps = JSON.parse(localStorage.getItem('snake_profiles') || '[]');
        return ps.map(p => {
            if (p.highScore !== undefined && !p.scores) { p.scores = {'classic-normal': p.highScore}; delete p.highScore; }
            if (!p.scores) p.scores = {};
            return p;
        });
    } catch(_) { return []; }
}
function _saveProfiles(ps) { localStorage.setItem('snake_profiles', JSON.stringify(ps)); }
function _currentId()      { return localStorage.getItem('snake_current_profile') || ''; }
function _genId()          { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function getCurrentProfile() {
    const id = _currentId();
    return _profiles().find(p => p.id === id) || null;
}

function createProfile(name, avatar) {
    const ps = _profiles();
    const p = { id: _genId(), name: (name || 'Anonymous').trim().slice(0, 16), avatar: avatar || null, scores: {} };
    ps.push(p);
    _saveProfiles(ps);
    localStorage.setItem('snake_current_profile', p.id);
    return p;
}

function updateProfile(id, name, avatar) {
    const ps = _profiles();
    const p = ps.find(p => p.id === id);
    if (!p) return;
    p.name = (name || 'Anonymous').trim().slice(0, 16);
    p.avatar = avatar || null;
    _saveProfiles(ps);
}

function saveProfileHighScore() {
    const id = _currentId(); if (!id) return;
    const ps = _profiles();
    const p = ps.find(p => p.id === id); if (!p) return;
    if (!p.scores) p.scores = {};
    const key = getScoreKey();
    if (score > (p.scores[key] || 0)) { p.scores[key] = score; _saveProfiles(ps); }
}

function loadProfileHighScore() {
    const p = getCurrentProfile();
    highScore = p ? (p.scores[getScoreKey()] || 0) : 0;
    const av = document.getElementById('sb-av');
    const nm = document.getElementById('sb-name-text');
    if (av) {
        if (p && p.avatar) { av.innerHTML = `<img src="${p.avatar}">`; }
        else { av.innerHTML = '🐍'; }
    }
    if (nm) nm.textContent = p ? p.name : '';
    updateScoreDisplay();
}

function deleteProfile(id) {
    const ps = _profiles().filter(p => p.id !== id);
    _saveProfiles(ps);
    if (_currentId() === id) {
        if (ps.length > 0) {
            switchProfile(ps[0].id);
        } else {
            localStorage.removeItem('snake_current_profile');
            loadProfileHighScore();
        }
    }
}

function switchProfile(id) {
    localStorage.setItem('snake_current_profile', id);
    loadProfileHighScore();
    stopMusic();
    if (gameState === 'running' || gameState === 'paused') { gameState = 'start'; stopMusic(); updatePauseBtn(); }
}

// ── Avatar helper ─────────────────────────────────────────────
function processAvatarFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas'); c.width = c.height = 120;
            const cx = c.getContext('2d');
            const s = Math.min(img.naturalWidth, img.naturalHeight);
            cx.drawImage(img, (img.naturalWidth-s)/2, (img.naturalHeight-s)/2, s, s, 0, 0, 120, 120);
            _pendingAvatar = c.toDataURL('image/jpeg', 0.75);
            const prev = document.getElementById('avatar-preview');
            if (prev) { prev.innerHTML = ''; const i = document.createElement('img'); i.src = _pendingAvatar; prev.appendChild(i); }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// ── Profile / Leaderboard UI ──────────────────────────────────
function showProfileCreation() {
    _editingProfileId = null;
    _pendingAvatar = null;
    const prev = document.getElementById('avatar-preview');
    if (prev) prev.innerHTML = '🐍';
    const inp = document.getElementById('input-name');
    if (inp) inp.value = '';
    document.getElementById('profile-overlay-title').textContent = 'CREATE PROFILE';
    document.getElementById('btn-save-profile').textContent = "LET'S GO ▶";
    document.getElementById('btn-skip-profile').textContent = 'Skip';
    document.getElementById('profile-overlay').classList.remove('hidden');
}

function showProfileEdit() {
    const p = getCurrentProfile();
    if (!p) { showProfileCreation(); return; }
    _editingProfileId = p.id;
    _pendingAvatar = p.avatar || null;
    const prev = document.getElementById('avatar-preview');
    if (prev) prev.innerHTML = p.avatar ? `<img src="${p.avatar}">` : '🐍';
    const inp = document.getElementById('input-name');
    if (inp) inp.value = p.name;
    document.getElementById('profile-overlay-title').textContent = 'EDIT PROFILE';
    document.getElementById('btn-save-profile').textContent = 'SAVE ▶';
    document.getElementById('btn-skip-profile').textContent = 'Cancel';
    document.getElementById('profile-overlay').classList.remove('hidden');
}

function hideProfileOverlay() { document.getElementById('profile-overlay').classList.add('hidden'); }

function showLeaderboard() {
    const key = getScoreKey();
    const ps = _profiles().sort((a, b) => (b.scores[key] || 0) - (a.scores[key] || 0));
    const currentId = _currentId();
    const list = document.getElementById('lb-list');
    list.innerHTML = '';
    if (ps.length === 0) {
        list.innerHTML = '<div style="color:#444;font-size:12px;font-family:monospace;text-align:center;padding:16px">No profiles yet</div>';
    }
    const modeLabel = document.createElement('div');
    modeLabel.style.cssText = 'font-size:9px;color:#444;font-family:monospace;letter-spacing:1px;text-align:center;padding-bottom:4px';
    modeLabel.textContent = `${gameMode.toUpperCase()} · ${difficulty.toUpperCase()}`;
    list.appendChild(modeLabel);
    ps.forEach((p, i) => {
        const row = document.createElement('div'); row.className = 'lb-entry';
        const rank = document.createElement('div'); rank.className = 'lb-rank'; rank.textContent = i + 1;
        const av = document.createElement('div'); av.className = 'lb-av';
        if (p.avatar) { const img = document.createElement('img'); img.src = p.avatar; av.appendChild(img); }
        else av.textContent = '🐍';
        const info = document.createElement('div'); info.className = 'lb-info';
        const nm = document.createElement('div'); nm.className = 'lb-name' + (p.id === currentId ? ' me' : ''); nm.textContent = p.name;
        const sc = document.createElement('div'); sc.className = 'lb-score-val'; sc.textContent = p.scores[key] || 0;
        info.append(nm, sc);
        const btn = document.createElement('button');
        btn.className = 'lb-play-btn' + (p.id === currentId ? ' me' : '');
        btn.textContent = p.id === currentId ? '✓ You' : '▶ Play';
        btn.onclick = () => { switchProfile(p.id); document.getElementById('leaderboard-overlay').classList.add('hidden'); };
        const delBtn = document.createElement('button');
        delBtn.className = 'lb-del-btn';
        delBtn.textContent = '🗑';
        delBtn.title = 'Delete profile';
        delBtn.onclick = () => {
            if (confirm(`Delete profile "${p.name}"? This can't be undone.`)) {
                deleteProfile(p.id);
                if (!getCurrentProfile()) { document.getElementById('leaderboard-overlay').classList.add('hidden'); showProfileCreation(); }
                else showLeaderboard();
            }
        };
        row.append(rank, av, info, btn, delBtn);
        list.appendChild(row);
    });
    // Reset scores button with math confirmation
    const lb = document.getElementById('lb-bottom');
    if (lb) {
        lb.innerHTML = '';
        const resetBtn = document.createElement('button');
        resetBtn.className = 'overlay-btn secondary';
        resetBtn.style.cssText = 'margin-top:8px;font-size:10px;color:#333;border-color:#222';
        resetBtn.textContent = 'Reset All Scores';
        resetBtn.onclick = () => {
            const a = Math.floor(Math.random() * 9) + 2;
            const b = Math.floor(Math.random() * 9) + 2;
            const ans = prompt(`Confirm reset — what is ${a} × ${b}?`);
            if (ans !== null && parseInt(ans, 10) === a * b) {
                const ps = _profiles();
                ps.forEach(p => { p.scores = {}; });
                _saveProfiles(ps);
                loadProfileHighScore();
                showLeaderboard();
            }
        };
        lb.appendChild(resetBtn);
    }
    document.getElementById('leaderboard-overlay').classList.remove('hidden');
}

function initProfileUI() {
    document.getElementById('btn-take-photo').addEventListener('click', () => document.getElementById('input-camera').click());
    document.getElementById('btn-pick-photo').addEventListener('click', () => document.getElementById('input-gallery').click());
    document.getElementById('avatar-preview').addEventListener('click', () => document.getElementById('input-gallery').click());

    document.getElementById('input-camera').addEventListener('change', e => { if (e.target.files[0]) processAvatarFile(e.target.files[0]); e.target.value=''; });
    document.getElementById('input-gallery').addEventListener('change', e => { if (e.target.files[0]) processAvatarFile(e.target.files[0]); e.target.value=''; });

    document.getElementById('btn-save-profile').addEventListener('click', () => {
        const name = (document.getElementById('input-name').value || '').trim();
        if (!name) { document.getElementById('input-name').focus(); return; }
        if (_editingProfileId) updateProfile(_editingProfileId, name, _pendingAvatar);
        else createProfile(name, _pendingAvatar);
        hideProfileOverlay();
        loadProfileHighScore();
    });

    document.getElementById('btn-skip-profile').addEventListener('click', () => {
        if (_editingProfileId) { hideProfileOverlay(); return; }
        if (!getCurrentProfile()) createProfile('Anonymous', null);
        hideProfileOverlay();
        loadProfileHighScore();
    });

    document.getElementById('btn-lb-close').addEventListener('click', () => document.getElementById('leaderboard-overlay').classList.add('hidden'));
    document.getElementById('btn-new-profile').addEventListener('click', () => {
        document.getElementById('leaderboard-overlay').classList.add('hidden');
        showProfileCreation();
    });

    document.getElementById('btn-lb').addEventListener('click', e => { e.stopPropagation(); showLeaderboard(); });
    document.getElementById('player-name-disp').addEventListener('click', e => { e.stopPropagation(); showProfileEdit(); });

    // If no profile exists, show creation screen immediately
    if (!getCurrentProfile()) showProfileCreation();
}

// ── Audio: setup ──────────────────────────────────────────────
function ensureAudio() {
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return;
    }
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (_) { return; }

    masterGain = audioCtx.createGain(); masterGain.gain.value = masterVol;
    masterGain.connect(audioCtx.destination);

    sfxGain = audioCtx.createGain(); sfxGain.gain.value = sfxVol;
    sfxGain.connect(masterGain);

    musicGain = audioCtx.createGain(); musicGain.gain.value = musicVol;
    musicGain.connect(masterGain);

    _decodeWavs();

    // Pre-baked noise buffer for hi-hats (reused every step)
    const len  = Math.ceil(audioCtx.sampleRate * 0.08);
    noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data  = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
}

// ── Audio: music sequencer ────────────────────────────────────
function schedNote(freq, dest, t, dur, type) {
    if (freq <= 0 || !audioCtx) return;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(dest);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(1, t + 0.005);
    gain.gain.setValueAtTime(1, t + dur * 0.72);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.97);
    osc.start(t); osc.stop(t + dur);
}

function schedHihat(t) {
    if (!audioCtx || !noiseBuffer) return;
    const src    = audioCtx.createBufferSource(); src.buffer = noiseBuffer;
    const filter = audioCtx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 9000;
    const gain   = audioCtx.createGain();
    gain.gain.setValueAtTime(0.11, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(filter); filter.connect(gain); gain.connect(musicGain);
    src.start(t); src.stop(t + 0.05);
}

function schedStep(step, t) {
    const s   = step % 64;
    const mel = MEL_STEPS[s];
    const bas = BAS_STEPS[s];
    if (mel > 0) schedNote(mel, musicGain, t, STEP * 0.80, 'square');
    if (bas > 0) schedNote(bas, musicGain, t, STEP * 3.55, 'triangle');
    if (s % 2 === 0) schedHihat(t); // 8th-note hi-hats
}

function musicScheduler() {
    if (!audioCtx) return;
    while (nextBeat < audioCtx.currentTime + 0.12) {
        schedStep(beatIndex, nextBeat);
        nextBeat += STEP;
        beatIndex = (beatIndex + 1) % 64;
    }
}

function startMusic() {
    if (!audioCtx) return;
    stopMusic(0.25); // fade out any previous music quickly before starting new
    if (musicBuffer) {
        musicFadeGain = audioCtx.createGain();
        musicFadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
        musicFadeGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.65);
        musicFadeGain.connect(musicGain);
        musicSource = audioCtx.createBufferSource();
        musicSource.buffer = musicBuffer;
        musicSource.loop = true;
        musicSource.connect(musicFadeGain);
        musicSource.start();
    } else {
        nextBeat  = audioCtx.currentTime + 0.08;
        beatIndex = 0;
        musicTimer = setInterval(musicScheduler, 25);
    }
}

function stopMusic(fadeSecs = 0.4) {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    _fadeStop(musicSource, musicFadeGain, fadeSecs);
    musicSource = null; musicFadeGain = null;
}

function playGameOver() {
    if (!audioCtx) return;
    if (gameOverBuffer) {
        gameOverFadeGain = audioCtx.createGain();
        gameOverFadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
        gameOverFadeGain.gain.linearRampToValueAtTime(0.45, audioCtx.currentTime + 0.4);
        gameOverFadeGain.connect(musicGain); // music channel so MUSIC slider controls it
        gameOverSource = audioCtx.createBufferSource();
        gameOverSource.buffer = gameOverBuffer;
        gameOverSource.connect(gameOverFadeGain);
        gameOverSource.onended = () => { gameOverSource = null; gameOverFadeGain = null; };
        gameOverSource.start();
    } else { sfxDie(); }
}

function stopGameOver(fadeSecs = 0.35) {
    _fadeStop(gameOverSource, gameOverFadeGain, fadeSecs);
    gameOverSource = null; gameOverFadeGain = null;
}

// ── Pause ─────────────────────────────────────────────────────
function togglePause() {
    if (gameState === 'running') {
        gameState = 'paused';
        stopMusic();
        updatePauseBtn();
    } else if (gameState === 'paused') {
        startCountdown();
    }
}

function startCountdown() {
    gameState = 'countdown';
    countdownN = 3;
    updatePauseBtn();
    const step = () => {
        if (document.hidden) { gameState = 'paused'; updatePauseBtn(); return; }
        countdownN--;
        if (countdownN <= 0) {
            gameState = 'running';
            lastTick = performance.now();
            startMusic();
            updatePauseBtn();
        } else {
            setTimeout(step, 1000);
        }
    };
    setTimeout(step, 1000);
}

// Pause the game and cut audio the moment the tab/app leaves the foreground —
// AudioContext keeps playing in the background otherwise.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (gameState === 'running' || gameState === 'countdown') {
            gameState = 'paused';
            stopMusic();
            updatePauseBtn();
        }
        if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
    } else if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
});

function updatePauseBtn() {
    const btn = document.getElementById('btn-pause');
    if (gameState === 'running' || gameState === 'countdown' || gameState === 'entering') {
        btn.textContent = '⏸';
        btn.dataset.state = 'running';
    } else if (gameState === 'paused') {
        btn.textContent = '▶';
        btn.dataset.state = 'paused';
    } else {
        btn.textContent = '⏸';
        btn.dataset.state = '';
    }
}

// ── Audio: SFX ────────────────────────────────────────────────
function sfxEat() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(sfxGain);
    osc.type = 'square';
    osc.frequency.setValueAtTime(620, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(980, audioCtx.currentTime + 0.07);
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.10);
    osc.start(); osc.stop(audioCtx.currentTime + 0.10);
}

function sfxCoin() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(sfxGain);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.start(); osc.stop(audioCtx.currentTime + 0.12);
}

function sfxDie() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(sfxGain);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(55, audioCtx.currentTime + 0.38);
    gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.38);
    osc.start(); osc.stop(audioCtx.currentTime + 0.38);
}

function vibrate(pattern) {
    if (!hapticsOn) return;
    try { navigator.vibrate(pattern); } catch (_) {}
}

// ── Fullscreen ────────────────────────────────────────────────
function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement)
        (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch(() => {});
    else
        (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
}

function onFsChange() {
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.getElementById('btn-fs').textContent = inFs ? '⊠' : '⛶';
}

// ── Mode management ───────────────────────────────────────────
function setMode(m) {
    gameMode = m;
    localStorage.setItem('snake_mode', m);
    syncModeBtns();
    loadProfileHighScore();
    if (gameState === 'running' || gameState === 'paused') { gameState = 'start'; stopMusic(); updatePauseBtn(); }
    updateAdvancedUI();
}

function syncModeBtns() {
    const cl  = document.getElementById('btn-classic');
    const adv = document.getElementById('btn-advanced');
    if (cl)  cl.classList.toggle('off',  gameMode !== 'classic');
    if (adv) adv.classList.toggle('off', gameMode !== 'advanced');
}

function updateAdvancedUI() {
    const hud = document.getElementById('adv-hud');
    const bar = document.getElementById('ability-bar');
    const isAdv = gameMode === 'advanced';
    if (hud) hud.classList.toggle('visible', isAdv);
    if (bar) bar.classList.toggle('visible', isAdv);
    if (isAdv) { updateAdvancedHUD(); updateAbilityBar(); }
    resize();
}

function updateAdvancedHUD() {
    const el = document.getElementById('coin-display');
    if (el) el.textContent = `⚡ ${playerCoins}`;
}

function updateAbilityBar() {
    const now = performance.now();
    for (const key of ['tongue', 'slowtime', 'babysnake']) {
        const btn    = document.getElementById(`abl-${key}`);
        const lvlEl  = document.getElementById(`abl-${key}-level`);
        const cdEl   = document.getElementById(`abl-${key}-cd`);
        if (!btn || !lvlEl || !cdEl) continue;
        const level   = abilityLevels[key];
        const ready   = abilityCooldowns[key] <= now;
        const isActive = (key === 'slowtime'   && now < slowUntil)
                       || (key === 'babysnake' && babySnake.length > 0 && now < babyUntil);
        lvlEl.textContent = level > 0 ? `L${level}` : '–';
        if (level === 0) {
            cdEl.textContent = 'LOCKED'; btn.className = 'abl-btn level0';
        } else if (isActive) {
            cdEl.textContent = 'ACTIVE'; btn.className = 'abl-btn active-now';
        } else if (ready) {
            cdEl.textContent = 'READY';  btn.className = 'abl-btn ready';
        } else {
            const ms = abilityCooldowns[key] - now;
            cdEl.textContent = `${Math.ceil(ms / 1000)}s`; btn.className = 'abl-btn';
        }
    }
}

// ── Shop ──────────────────────────────────────────────────────
function openShop() {
    shopOpen = true;
    renderShop();
    document.getElementById('shop-overlay').classList.remove('hidden');
}

function closeShop() {
    shopOpen = false;
    document.getElementById('shop-overlay').classList.add('hidden');
    lastTick = performance.now();
}

function renderShop() {
    document.getElementById('shop-coin-val').textContent = playerCoins;
    const list = document.getElementById('shop-items');
    list.innerHTML = '';
    for (const key of ['tongue', 'slowtime', 'babysnake']) {
        const cfg   = ABILITY_CFG[key];
        const level = abilityLevels[key];
        const row   = document.createElement('div'); row.className = 'shop-item';
        const info  = document.createElement('div'); info.className = 'shop-item-info';
        const nm    = document.createElement('div'); nm.className = 'shop-item-name'; nm.textContent = cfg.name;
        const desc  = document.createElement('div'); desc.className = 'shop-item-desc';
        desc.textContent = level === 0 ? 'Not owned' : (level === 3 ? 'MAX LEVEL' : `Level ${level} / 3 — ${cfg.descs[level]}`);
        info.append(nm, desc);
        const btn = document.createElement('button');
        if (level >= 3) {
            btn.className = 'shop-upg-btn maxed'; btn.textContent = 'MAX'; btn.disabled = true;
        } else {
            const cost = cfg.costs[level];
            btn.className = 'shop-upg-btn';
            btn.textContent = level === 0 ? `BUY ⚡${cost}` : `L${level+1} ⚡${cost}`;
            btn.disabled = playerCoins < cost;
            btn.onclick = () => {
                if (playerCoins < cost) return;
                playerCoins -= cost;
                abilityLevels[key]++;
                updateAdvancedHUD();
                updateAbilityBar();
                renderShop();
            };
        }
        row.append(info, btn);
        list.appendChild(row);
    }
}

// ── Ability use ───────────────────────────────────────────────
function useAbility(key) {
    if (gameState !== 'running' || gameMode !== 'advanced' || shopOpen) return;
    const level = abilityLevels[key];
    if (level === 0) return;
    const now = performance.now();
    if (abilityCooldowns[key] > now) return;
    if (key === 'tongue')    activateTongue(level);
    if (key === 'slowtime')  activateSlowTime(level);
    if (key === 'babysnake') activateBabySnake(level);
    abilityCooldowns[key] = now + ABILITY_CFG[key].cooldowns[level - 1];
    updateAbilityBar();
}

function activateTongue(level) {
    if (!snake.length) return;
    const range = ABILITY_CFG.tongue.ranges[level - 1];
    const dx = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
    const dy = dir === 'down'  ? 1 : dir === 'up'   ? -1 : 0;
    let ex = snake[0].x, ey = snake[0].y;
    for (let i = 1; i <= range; i++) {
        const tx = snake[0].x + dx*i, ty = snake[0].y + dy*i;
        if (tx < 0 || tx >= CELL_COUNT || ty < 0 || ty >= CELL_COUNT) break;
        ex = tx; ey = ty;
        if (tx === food.x && ty === food.y) {
            score += 1; if (score > highScore) highScore = score;
            updateScoreDisplay(); sfxEat(); vibrate(25); spawnFood();
            foodForShop++;
            if (foodForShop >= 10) { foodForShop = 0; spawnShopBlock(); }
            if (coins.length < 3) spawnCoins(1);
            break;
        }
        const ci = coins.findIndex(c => c.x === tx && c.y === ty);
        if (ci !== -1) { coins.splice(ci, 1); playerCoins++; updateAdvancedHUD(); sfxCoin(); vibrate(10); break; }
    }
    tongue = { ex, ey };
    tongueVisUntil = performance.now() + 380;
}

function activateSlowTime(level) {
    slowUntil = performance.now() + ABILITY_CFG.slowtime.durations[level - 1];
}

function activateBabySnake(level) {
    babyUntil = performance.now() + ABILITY_CFG.babysnake.durations[level - 1];
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    coins.forEach(c => occ.add(`${c.x},${c.y}`));
    if (shopBlock) occ.add(`${shopBlock.x},${shopBlock.y}`);
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    if (free.length < 3) { babyUntil = 0; return; }
    const si = Math.floor(Math.random() * (free.length - 2));
    babySnake = [free[si], free[si+1], free[si+2]];
}

function tickBabySnake() {
    if (!babySnake.length) return;
    const targets = [...coins];
    if (!targets.length) targets.push(food);
    const head = babySnake[0];
    let best = null, bestDist = Infinity;
    for (const t of targets) {
        const d = Math.abs(t.x - head.x) + Math.abs(t.y - head.y);
        if (d < bestDist) { bestDist = d; best = t; }
    }
    if (!best) return;
    const moves = [];
    if (best.x > head.x) moves.push({ dx:1, dy:0 });
    else if (best.x < head.x) moves.push({ dx:-1, dy:0 });
    if (best.y > head.y) moves.push({ dx:0, dy:1 });
    else if (best.y < head.y) moves.push({ dx:0, dy:-1 });
    const fallback = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
    for (const mv of [...moves, ...fallback]) {
        const nx = head.x + mv.dx, ny = head.y + mv.dy;
        if (nx < 0 || nx >= CELL_COUNT || ny < 0 || ny >= CELL_COUNT) continue;
        if (babySnake.some(s => s.x===nx && s.y===ny)) continue;
        if (snake.some(s => s.x===nx && s.y===ny)) continue;
        babySnake.unshift({ x:nx, y:ny }); babySnake.pop();
        const ci = coins.findIndex(c => c.x===nx && c.y===ny);
        if (ci !== -1) { coins.splice(ci, 1); playerCoins++; updateAdvancedHUD(); sfxCoin(); vibrate(10); if (coins.length < 3) spawnCoins(1); }
        break;
    }
}

// ── Advanced spawning ─────────────────────────────────────────
function spawnCoins(n) {
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    if (shopBlock) occ.add(`${shopBlock.x},${shopBlock.y}`);
    coins.forEach(c => occ.add(`${c.x},${c.y}`));
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    for (let i = 0; i < n && free.length; i++) {
        const idx = Math.floor(Math.random() * free.length);
        coins.push(free.splice(idx, 1)[0]);
    }
}

function spawnShopBlock() {
    if (shopBlock) return;
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    coins.forEach(c => occ.add(`${c.x},${c.y}`));
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    if (free.length) shopBlock = free[Math.floor(Math.random() * free.length)];
}

// ── Options panel ─────────────────────────────────────────────
function toggleOptions() {
    optionsOpen = !optionsOpen;
    document.getElementById('options-panel').classList.toggle('open', optionsOpen);
}

function initOptions() {
    document.getElementById('btn-opts').addEventListener('click', e => {
        e.stopPropagation();
        ensureAudio();
        toggleOptions();
    });

    const sliders = [
        { id: 'sl-master', valId: 'vl-master', key: 'snake_mvol',   def: 80,
          apply: v => { masterVol = v; if (masterGain) masterGain.gain.value = v; } },
        { id: 'sl-music',  valId: 'vl-music',  key: 'snake_musvol', def: 28,
          apply: v => { musicVol  = v; if (musicGain)  musicGain.gain.value  = v; } },
        { id: 'sl-sfx',    valId: 'vl-sfx',    key: 'snake_sfxvol', def: 80,
          apply: v => { sfxVol    = v; if (sfxGain)    sfxGain.gain.value    = v; } },
    ];

    for (const s of sliders) {
        const el  = document.getElementById(s.id);
        const val = document.getElementById(s.valId);
        const saved = parseInt(localStorage.getItem(s.key) || String(s.def), 10);
        el.value = saved; val.textContent = saved;
        el.addEventListener('input', () => {
            const v = parseInt(el.value, 10);
            val.textContent = v;
            localStorage.setItem(s.key, String(v));
            s.apply(v / 100);
        });
    }

    const hBtn = document.getElementById('btn-haptics');
    const syncH = () => { hBtn.textContent = hapticsOn ? 'ON' : 'OFF'; hBtn.classList.toggle('off', !hapticsOn); };
    syncH();
    hBtn.addEventListener('click', () => {
        hapticsOn = !hapticsOn;
        localStorage.setItem('snake_haptics', hapticsOn ? 'on' : 'off');
        syncH();
    });

    document.getElementById('btn-easy').addEventListener('click', () => setDifficulty('easy'));
    document.getElementById('btn-normal').addEventListener('click', () => setDifficulty('normal'));
    syncDiffBtns();

    document.getElementById('btn-classic').addEventListener('click',  () => setMode('classic'));
    document.getElementById('btn-advanced').addEventListener('click', () => setMode('advanced'));
    syncModeBtns();

    const bHandR = document.getElementById('btn-hand-r');
    const bHandL = document.getElementById('btn-hand-l');
    if (bHandR) bHandR.addEventListener('click', () => setHandedness('right'));
    if (bHandL) bHandL.addEventListener('click', () => setHandedness('left'));
    setHandedness(handedness);

    const closeBar = document.getElementById('opts-close-bar');
    if (closeBar) closeBar.addEventListener('click', () => { if (optionsOpen) toggleOptions(); });
}

// ── Init ──────────────────────────────────────────────────────
function init() {
    canvas = document.getElementById('game-canvas');
    ctx    = canvas.getContext('2d');

    const fsEl = document.documentElement;
    if (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen) {
        document.getElementById('btn-fs').addEventListener('click', toggleFullscreen);
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);
    } else {
        document.getElementById('btn-fs').style.display = 'none';
    }

    initOptions();
    initProfileUI();
    loadProfileHighScore();

    document.getElementById('btn-pause').addEventListener('click', e => { e.stopPropagation(); togglePause(); });
    document.getElementById('btn-shop-close').addEventListener('click', closeShop);

    for (const key of ['tongue', 'slowtime', 'babysnake']) {
        document.getElementById(`abl-${key}`).addEventListener('click', () => useAbility(key));
    }

    updateAdvancedUI();
    setInterval(() => { if (gameMode === 'advanced') updateAbilityBar(); }, 200);

    updateScoreDisplay();
    resize();
    window.addEventListener('resize', () => { resize(); if (gameState !== 'running') draw(); });
    document.addEventListener('keydown', onKey);
    setupTouch();
    requestAnimationFrame(loop);
}

function resize() {
    const area = document.getElementById('game-area');
    const sb   = document.getElementById('scoreboard');
    const ph   = document.getElementById('profile-header');
    const hud  = document.getElementById('adv-hud');
    const bar  = document.getElementById('ability-bar');
    const extraH = (ph ? ph.offsetHeight : 0)
                 + (hud && hud.classList.contains('visible') ? hud.offsetHeight : 0)
                 + (bar && bar.classList.contains('visible') ? bar.offsetHeight : 0);
    const size = Math.min(area.clientWidth, area.clientHeight - sb.offsetHeight - extraH - 10, MAX_CANVAS);
    canvas.width = canvas.height = Math.max(size, 0);
}

// ── Controls ──────────────────────────────────────────────────
function onKey(e) {
    switch (e.key) {
        case 'ArrowUp':    setDir('up');    e.preventDefault(); break;
        case 'ArrowDown':  setDir('down');  e.preventDefault(); break;
        case 'ArrowLeft':  setDir('left');  e.preventDefault(); break;
        case 'ArrowRight': setDir('right'); e.preventDefault(); break;
        case 'Escape':
            if (optionsOpen) { toggleOptions(); e.preventDefault(); } break;
        case ' ': case 'Enter':
            if (optionsOpen) { toggleOptions(); e.preventDefault(); break; }
            if (gameState === 'entering' || gameState === 'countdown') { e.preventDefault(); break; }
            if (gameState === 'running' || gameState === 'paused') { togglePause(); e.preventDefault(); break; }
            ensureAudio(); startGame(); e.preventDefault();
            break;
    }
}

function setupTouch() {
    let sx = 0, sy = 0;
    document.addEventListener('touchstart', e => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY;
        if (gameState === 'running') holdBoost = true;
    }, { passive: true });
    document.addEventListener('touchcancel', () => { holdBoost = false; }, { passive: true });
    document.addEventListener('touchend', e => {
        holdBoost = false;
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (optionsOpen) { toggleOptions(); return; }
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        const dist = Math.hypot(dx, dy);
        if (gameState === 'paused') { togglePause(); }
        else if (gameState === 'countdown' || gameState === 'entering') { /* no-op */ }
        else if (gameState !== 'running') {
            ensureAudio(); startGame();
            if (dist >= SWIPE_MIN) applySwipe(dx, dy);
        } else if (dist >= SWIPE_MIN) {
            applySwipe(dx, dy);
        } else {
            tryLunge();
        }
    }, { passive: true });
}

function applySwipe(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 'right' : 'left');
    else                             setDir(dy > 0 ? 'down'  : 'up');
}

function setDir(d) {
    const opp = { up:'down', down:'up', left:'right', right:'left' };
    if (d !== opp[dir] && d !== nextDir) {
        nextDir = d;
        if (gameState === 'running') { sfxSwipe(); vibrate(6); }
    }
}

// ── Game logic ────────────────────────────────────────────────
function setDifficulty(d) {
    difficulty = d;
    localStorage.setItem('snake_diff', d);
    const cfg = DIFFICULTIES[d];
    CELL_COUNT = cfg.cells; BASE_MS = cfg.baseMs; MIN_MS = cfg.minMs; SPEED_STEP = cfg.speedStep;
    syncDiffBtns();
}

function syncDiffBtns() {
    const easy = document.getElementById('btn-easy');
    const norm = document.getElementById('btn-normal');
    if (!easy || !norm) return;
    easy.classList.toggle('off', difficulty !== 'easy');
    norm.classList.toggle('off', difficulty !== 'normal');
}

function startGame() {
    stopGameOver(0.3);
    const cfg = DIFFICULTIES[difficulty];
    CELL_COUNT = cfg.cells; BASE_MS = cfg.baseMs; MIN_MS = cfg.minMs; SPEED_STEP = cfg.speedStep;
    const mid = Math.floor(CELL_COUNT / 2);
    snake     = [{ x:mid, y:mid }, { x:mid-1, y:mid }, { x:mid-2, y:mid }, { x:mid-3, y:mid }];
    dir       = 'right'; nextDir = 'right';
    score     = 0; tickMs = BASE_MS; deathTime = 0; foodPulse = 0;
    lungeQueue = 0; lungePauseUntil = 0; tongueFlickBorn = -Infinity;
    fly = null; flyUntil = 0; flyTimer = 0; flyRegion = null; flyEntering = false; stopFlyBuzz();
    holdBoost = false;
    gameState = 'entering';
    enterSlideX = -canvas.width;
    enterStart  = performance.now();

    coins = []; shopBlock = null; playerCoins = 0; foodForShop = 0; shopOpen = false;
    tongue = null; tongueVisUntil = 0; babySnake = []; babyUntil = 0; slowUntil = 0;
    abilityCooldowns = { tongue:0, slowtime:0, babysnake:0 };
    particles = []; scorePops = []; shakeMag = 0;

    updateScoreDisplay();
    updateAdvancedHUD();
    updatePauseBtn();
    spawnFood();
    if (gameMode === 'advanced') spawnCoins(3);
    lastTick = performance.now(); // music starts after entering animation
}

function spawnFood() {
    const occ  = new Set(snake.map(s => `${s.x},${s.y}`));
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    if (!free.length) { gameState = 'win'; stopMusic(); return; }
    food = free[Math.floor(Math.random() * free.length)];
    foodType = FOOD_TYPES[Math.floor(Math.random() * FOOD_TYPES.length)];
    foodSpawnTime = performance.now();
}

function tick() {
    const cell = canvas.width / CELL_COUNT;
    dir = nextDir;
    const nx = snake[0].x + (dir==='right'?1: dir==='left'?-1:0);
    const ny = snake[0].y + (dir==='down' ?1: dir==='up'  ?-1:0);
    if (nx < 0 || nx >= CELL_COUNT || ny < 0 || ny >= CELL_COUNT) { die(); return; }
    if (snake.slice(0,-1).some(s => s.x===nx && s.y===ny)) { die(); return; }

    if (gameMode === 'advanced') {
        const ci = coins.findIndex(c => c.x===nx && c.y===ny);
        if (ci !== -1) { coins.splice(ci, 1); playerCoins++; updateAdvancedHUD(); sfxCoin(); vibrate(10); }
    }

    const eating = nx===food.x && ny===food.y;
    if (eating && snake[snake.length-1].x===nx && snake[snake.length-1].y===ny) { die(); return; }
    const eatX = food.x * cell + cell/2, eatY = food.y * cell + cell/2;
    snake.unshift({ x:nx, y:ny });
    spawnDebris(cell);

    if (gameMode === 'advanced' && shopBlock && nx===shopBlock.x && ny===shopBlock.y) {
        snake.pop();
        openShop();
        return;
    }

    // Fly catch — grows snake, +FLY_POINTS
    let flyEaten = false;
    if (fly && nx === fly.x && ny === fly.y) {
        flyEaten = true;
        score += FLY_POINTS;
        if (score > highScore) highScore = score;
        updateScoreDisplay(); sfxFlyCatch(); vibrate([15,10,15]);
        scorePops.push({ x: nx*cell+cell/2, y: ny*cell+cell/2, born: performance.now(), val: `+${FLY_POINTS}` });
        stopFlyBuzz(); fly = null;
    }

    if (eating) {
        score += 1;
        if (score > highScore) highScore = score;
        tickMs = Math.max(MIN_MS, BASE_MS - (snake.length-3) * SPEED_STEP);
        updateScoreDisplay(); sfxEat(); vibrate(25); spawnFood();
        shakeMag = 3;
        tongueFlickBorn = performance.now();
        scorePops.push({ x: eatX, y: eatY, born: performance.now() });
        if (gameMode === 'advanced') {
            foodForShop++;
            if (foodForShop >= 10) { foodForShop = 0; spawnShopBlock(); }
            if (coins.length < 3) spawnCoins(1);
        }
        if (!fly && Math.random() < FLY_SPAWN_CHANCE) spawnFly();
    } else if (!flyEaten) { snake.pop(); }

    if (gameMode === 'advanced' && babySnake.length > 0) {
        if (performance.now() < babyUntil) tickBabySnake();
        else { babySnake = []; updateAbilityBar(); }
    }
}

function die() {
    lungeQueue = 0; holdBoost = false;
    gameState = 'over'; deathTime = performance.now();
    if (score > highScore) { highScore = score; updateScoreDisplay(); }
    saveProfileHighScore();
    babySnake = []; tongue = null; slowUntil = 0; shopOpen = false;
    fly = null; flyRegion = null; flyEntering = false; stopFlyBuzz();
    document.getElementById('shop-overlay').classList.add('hidden');
    if (gameMode === 'advanced') updateAbilityBar();
    stopMusic(); playGameOver(); vibrate([60,30,120]); updatePauseBtn();
}

function updateScoreDisplay() {
    document.getElementById('score-val').textContent     = score;
    document.getElementById('highscore-val').textContent = highScore;
}

// ── Lunge ─────────────────────────────────────────────────────
function sfxSwipe() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'square';
    osc.frequency.setValueAtTime(320, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime + 0.07);
    g.gain.setValueAtTime(0.22, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
    osc.start(); osc.stop(audioCtx.currentTime + 0.08);
}

function sfxLunge() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, audioCtx.currentTime + 0.15);
    g.gain.setValueAtTime(0.13, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.start(); osc.stop(audioCtx.currentTime + 0.15);
}

function tryLunge() {
    if (gameState !== 'running' || shopOpen || lungeQueue > 0) return;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    let steps = 0;
    for (let i = 1; i < CELL_COUNT; i++) {
        const tx = snake[0].x + ddx*i;
        const ty = snake[0].y + ddy*i;
        if (tx < 0 || tx >= CELL_COUNT || ty < 0 || ty >= CELL_COUNT) break;
        if (tx === food.x && ty === food.y) { steps = i; break; }
        if (gameMode === 'advanced' && coins.some(c => c.x===tx && c.y===ty)) { steps = i; break; }
    }
    if (steps === 0) return;
    lungeQueue = steps;
    lastTick = performance.now() - 35; // fire first step immediately
    sfxLunge();
}

// ── Fly ───────────────────────────────────────────────────────
function spawnFly() {
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    if (occ.size >= CELL_COUNT * CELL_COUNT) return;
    // Pick a home region away from edges
    const margin = Math.max(2, Math.floor(CELL_COUNT * 0.18));
    const rcx = margin + Math.floor(Math.random() * (CELL_COUNT - margin*2));
    const rcy = margin + Math.floor(Math.random() * (CELL_COUNT - margin*2));
    const zr  = Math.max(2, Math.floor(CELL_COUNT * 0.18));
    flyRegion = { cx: rcx, cy: rcy, r: zr };
    fly = { x: Math.min(CELL_COUNT-1, Math.max(0, rcx)),
            y: Math.min(CELL_COUNT-1, Math.max(0, rcy)) };
    flyUntil = performance.now() + FLY_LIFETIME;
    flyTimer = performance.now();
    // Fly in from a random screen edge
    flyEntering   = true;
    flyEnterStart = performance.now();
    const cell = canvas.width / CELL_COUNT;
    const size = canvas.width;
    const dx = fly.x*cell+cell/2, dy = fly.y*cell+cell/2;
    const side = Math.floor(Math.random() * 4);
    flyEnterFrom = side===0 ? {x:-cell,     y:dy       }
                 : side===1 ? {x:size+cell, y:dy       }
                 : side===2 ? {x:dx,        y:-cell    }
                 :            {x:dx,        y:size+cell};
    startFlyBuzz();
}

function moveFly() {
    if (!fly || !flyRegion) return;
    const dirs = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
    dirs.sort(() => Math.random() - 0.5);
    const occ    = new Set(snake.map(s => `${s.x},${s.y}`));
    const inZone = (x, y) =>
        Math.abs(x - flyRegion.cx) <= flyRegion.r &&
        Math.abs(y - flyRegion.cy) <= flyRegion.r;
    const zoneMoves = dirs.filter(({ dx, dy }) => {
        const nx = fly.x+dx, ny = fly.y+dy;
        return nx>=0 && nx<CELL_COUNT && ny>=0 && ny<CELL_COUNT &&
               !occ.has(`${nx},${ny}`) && inZone(nx, ny);
    });
    const anyMoves = dirs.filter(({ dx, dy }) => {
        const nx = fly.x+dx, ny = fly.y+dy;
        return nx>=0 && nx<CELL_COUNT && ny>=0 && ny<CELL_COUNT && !occ.has(`${nx},${ny}`);
    });
    const picks = (zoneMoves.length && Math.random() < 0.82) ? zoneMoves : anyMoves;
    if (!picks.length) return;
    const { dx, dy } = picks[Math.floor(Math.random() * picks.length)];
    fly.x += dx; fly.y += dy;
}

function startFlyBuzz() {
    if (!audioCtx || flyBuzzOsc) return;
    flyBuzzOsc  = audioCtx.createOscillator();
    flyBuzzMod  = audioCtx.createOscillator();
    flyBuzzGain = audioCtx.createGain();
    const modScale = audioCtx.createGain();
    flyBuzzOsc.type = 'sawtooth';
    flyBuzzOsc.frequency.value = 185;
    flyBuzzMod.type = 'sine';
    flyBuzzMod.frequency.value = 22;
    modScale.gain.value = 0.045;    // AM depth
    flyBuzzGain.gain.value = 0.025;
    flyBuzzMod.connect(modScale);
    modScale.connect(flyBuzzGain.gain); // amplitude-modulate carrier
    flyBuzzOsc.connect(flyBuzzGain);
    flyBuzzGain.connect(sfxGain);
    flyBuzzOsc.start();
    flyBuzzMod.start();
}

function stopFlyBuzz() {
    if (!flyBuzzOsc || !audioCtx) return;
    const t = audioCtx.currentTime + 0.12;
    flyBuzzGain.gain.setValueAtTime(flyBuzzGain.gain.value, audioCtx.currentTime);
    flyBuzzGain.gain.linearRampToValueAtTime(0, t);
    try { flyBuzzOsc.stop(t + 0.01); } catch(_) {}
    try { flyBuzzMod.stop(t + 0.01); } catch(_) {}
    flyBuzzOsc = null; flyBuzzMod = null; flyBuzzGain = null;
}

function sfxFlyCatch() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.connect(g); g.connect(sfxGain);
    osc.type = 'square';
    osc.frequency.setValueAtTime(620, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(75, audioCtx.currentTime + 0.18);
    g.gain.setValueAtTime(0.18, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.20);
    osc.start(); osc.stop(audioCtx.currentTime + 0.20);
}

function drawFly(cell) {
    if (!fly) return;
    const now = performance.now();
    let fx, fy;
    if (flyEntering) {
        const t = Math.min(1, (now - flyEnterStart) / FLY_ENTER_DUR);
        const ease = 1 - Math.pow(1-t, 2);
        fx = flyEnterFrom.x + (fly.x*cell+cell/2 - flyEnterFrom.x) * ease;
        fy = flyEnterFrom.y + (fly.y*cell+cell/2 - flyEnterFrom.y) * ease;
        if (t >= 1) flyEntering = false;
    } else {
        fx = fly.x * cell + cell/2;
        fy = fly.y * cell + cell/2;
    }
    const r   = Math.max(3, cell * 0.22);
    const flap     = Math.floor(now / 80) % 2 === 0;
    const wingLift = flap ? -r*0.55 : -r*0.22;

    ctx.save();

    // Wings (behind body)
    ctx.globalAlpha = 0.52;
    ctx.fillStyle = '#c8e8ff';
    ctx.beginPath();
    ctx.ellipse(fx - r*1.05, fy + wingLift, r*1.15, r*0.62, -0.28, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(fx + r*1.05, fy + wingLift, r*1.15, r*0.62, 0.28, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Body
    ctx.fillStyle = '#1e1e1e';
    ctx.beginPath();
    ctx.ellipse(fx, fy, r*0.72, r*1.15, 0, 0, Math.PI*2);
    ctx.fill();

    // Abdomen bands
    ctx.strokeStyle = '#484848';
    ctx.lineWidth = Math.max(0.5, r*0.28);
    for (const oy of [r*0.25, r*0.65]) {
        ctx.beginPath();
        ctx.moveTo(fx - r*0.58, fy + oy);
        ctx.lineTo(fx + r*0.58, fy + oy);
        ctx.stroke();
    }

    // Red compound eyes
    ctx.fillStyle = '#cc2200';
    const er = Math.max(1, r*0.36);
    ctx.beginPath(); ctx.arc(fx - r*0.35, fy - r*0.82, er, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(fx + r*0.35, fy - r*0.82, er, 0, Math.PI*2); ctx.fill();

    // Gold warning pulse when about to leave
    const timeLeft = flyUntil - now;
    if (timeLeft < 2500) {
        const pulse = Math.sin(now * 0.015) * 0.5 + 0.5;
        ctx.strokeStyle = `rgba(255,220,0,${pulse * 0.75})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(fx, fy, r * 2.1, 0, Math.PI*2);
        ctx.stroke();
    }

    ctx.restore();
}

// ── Loop ──────────────────────────────────────────────────────
function loop(now) {
    requestAnimationFrame(loop);
    if (gameState === 'running' && !shopOpen) {
        if (lungeQueue > 0) {
            if (now - lastTick >= 35) {
                lastTick = now; tick(); lungeQueue--;
                if (lungeQueue === 0) { lungePauseUntil = now + 350; lastTick = lungePauseUntil; }
            }
        } else {
            let effMs = tickMs;
            if (holdBoost) effMs = Math.max(MIN_MS * 0.55, tickMs * 0.45);
            else if (gameMode === 'advanced' && now < slowUntil) effMs = tickMs * 2.5;
            if (now - lastTick >= effMs && now >= lungePauseUntil) { lastTick = now; tick(); }
        }
    }
    // Snake slide-in intro
    if (gameState === 'entering') {
        const t = Math.min(1, (now - enterStart) / ENTER_DUR);
        enterSlideX = -canvas.width * (1 - (1 - Math.pow(1-t, 3)));
        if (t >= 1) { enterSlideX = 0; gameState = 'running'; lastTick = now; startMusic(); }
    }
    // Fly movement + despawn (independent of snake tick rate)
    if (fly && gameState === 'running' && !shopOpen) {
        if (now - flyTimer >= FLY_MOVE_MS) { flyTimer = now; moveFly(); }
        if (now >= flyUntil) { stopFlyBuzz(); fly = null; flyRegion = null; }
    }
    draw();
}

// ── Drawing ───────────────────────────────────────────────────
function draw() {
    const size = canvas.width; if (!size) return;
    const cell = size / CELL_COUNT;

    // Screen shake — saved context, restore before stable overlays
    ctx.save();
    if (shakeMag > 0.2) {
        ctx.translate((Math.random()-0.5)*shakeMag*2, (Math.random()-0.5)*shakeMag*2);
        shakeMag *= 0.72;
    } else { shakeMag = 0; }

    // Background
    if (bgImg.complete && bgImg.naturalWidth) {
        ctx.drawImage(bgImg, 0, 0, size, size);
    } else {
        ctx.fillStyle = '#111'; ctx.fillRect(0,0,size,size);
    }

    // Grid
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= CELL_COUNT; i++) {
        ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,i*cell); ctx.lineTo(size,i*cell); ctx.stroke();
    }

    if (gameState === 'start') { ctx.restore(); drawStart(size, cell); return; }

    drawFood(cell);
    drawFly(cell);
    if (gameMode === 'advanced') {
        drawCoins(cell);
        if (shopBlock) drawShopBlock(cell);
        if (tongue && performance.now() < tongueVisUntil) drawTongue(cell);
        if (babySnake.length > 0 && performance.now() < babyUntil) drawBabySnake(cell);
    }
    if (gameState === 'entering') { ctx.save(); ctx.translate(enterSlideX, 0); }
    drawSnakeSmooth(cell);
    drawTongueFlick(cell);
    if (gameState === 'entering') ctx.restore();
    drawParticles();
    drawScorePops(cell);

    // Pen border
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, size, size);
    ctx.strokeStyle = '#1a5208';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size-2, size-2);

    if (gameState === 'over') {
        const el = performance.now() - deathTime;
        const fa = Math.max(0, 0.65 - el/550);
        if (fa > 0) { ctx.fillStyle=`rgba(220,0,0,${fa})`; ctx.fillRect(0,0,size,size); }
        if (el > 420) drawGameOver(size, cell);
    } else if (gameState === 'win') { drawWin(size, cell); }
    else if (gameState === 'paused') { drawPaused(size, cell); }
    else if (gameState === 'countdown') { drawCountdown(size, cell); }

    ctx.restore(); // end shake — VERSION stays stable
    ctx.fillStyle='rgba(0,0,0,0.55)';
    ctx.font=`${Math.max(9,Math.floor(cell*0.42))}px monospace`;
    ctx.textAlign='right'; ctx.textBaseline='bottom';
    ctx.fillText(VERSION, size-4, size-3);
}

function foodBounceOffset(t) {
    // Returns Y offset in cells: 3 cells above → fall → 2 diminishing bounces → settle
    if (t >= 1) return 0;
    if (t < 0.42) return -3 * Math.pow(1 - t/0.42, 2);
    const segs = [
        { s:0.42, e:0.62, h:0.75 },
        { s:0.62, e:0.79, h:0.28 },
        { s:0.79, e:1.00, h:0.10 },
    ];
    for (const b of segs) {
        if (t < b.e) return -b.h * Math.sin(Math.PI * (t-b.s) / (b.e-b.s));
    }
    return 0;
}

function drawFood(cell) {
    foodPulse += 0.055;
    const bob  = Math.sin(foodPulse * 1.4) * cell * 0.09;
    const p    = Math.sin(foodPulse) * 0.09 + 0.91;
    const bt   = Math.min(1, (performance.now() - foodSpawnTime) / FOOD_BOUNCE_DUR);
    const fx   = food.x*cell + cell/2;
    const fy   = food.y*cell + cell/2 + bob + foodBounceOffset(bt) * cell;
    const r    = (cell/2 - 1.5) * p;
    const shadowFrac = (bob + cell*0.09) / (cell*0.18);
    ctx.fillStyle = `rgba(0,0,0,${0.22 - shadowFrac*0.10})`;
    ctx.beginPath();
    ctx.ellipse(food.x*cell+cell/2, food.y*cell+cell*0.88, r*(0.7+shadowFrac*0.2), r*0.28, 0, 0, Math.PI*2);
    ctx.fill();
    switch (foodType) {
        case 'strawberry': drawStrawberry(fx, fy, r); break;
        case 'watermelon': drawWatermelon(fx, fy, r); break;
        case 'cherry':     drawCherry(fx, fy, r);     break;
        case 'grape':      drawGrape(fx, fy, r);      break;
        default:           drawApple(fx, fy, r);      break;
    }
}

function drawApple(fx, fy, r) {
    ctx.fillStyle = 'rgba(210,30,30,0.18)';
    ctx.beginPath(); ctx.arc(fx, fy, r+4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#dd2222';
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#4a2000'; ctx.lineWidth = Math.max(1.5, r*0.15); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(fx, fy-r); ctx.lineTo(fx+r*0.22, fy-r-r*0.45); ctx.stroke();
    ctx.fillStyle = '#339922';
    ctx.save(); ctx.translate(fx+r*0.18, fy-r-r*0.28); ctx.rotate(0.55);
    ctx.beginPath(); ctx.ellipse(0, 0, r*0.38, r*0.18, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.33)';
    ctx.beginPath(); ctx.arc(fx-r*0.28, fy-r*0.3, r*0.30, 0, Math.PI*2); ctx.fill();
}

function drawStrawberry(fx, fy, r) {
    ctx.fillStyle = 'rgba(210,0,40,0.2)';
    ctx.beginPath(); ctx.arc(fx, fy, r+3, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#cc1133';
    ctx.beginPath(); ctx.ellipse(fx, fy+r*0.05, r, r, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffee44';
    const sr = Math.max(1, r*0.10);
    for (const [sx, sy] of [[-0.3,-0.22],[0.3,-0.22],[0,-0.06],[-0.4,0.1],[0.4,0.1],[-0.15,0.3],[0.15,0.3],[0,0.44]]) {
        ctx.beginPath(); ctx.arc(fx+sx*r, fy+sy*r, sr, 0, Math.PI*2); ctx.fill();
    }
    ctx.fillStyle = '#22aa22';
    for (let i = 0; i < 5; i++) {
        const a = (i/5)*Math.PI*2 - Math.PI/2;
        ctx.save(); ctx.translate(fx, fy-r*0.92); ctx.rotate(a);
        ctx.beginPath(); ctx.ellipse(0, -r*0.3, r*0.11, r*0.36, 0, 0, Math.PI*2); ctx.fill();
        ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.arc(fx-r*0.26, fy-r*0.3, r*0.27, 0, Math.PI*2); ctx.fill();
}

function drawWatermelon(fx, fy, r) {
    ctx.fillStyle = '#1a8a1a';
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#44cc44';
    for (let i = 0; i < 4; i++) {
        const a = (i/4)*Math.PI*2;
        ctx.save(); ctx.translate(fx, fy); ctx.rotate(a);
        ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,r,-0.18,0.18); ctx.closePath(); ctx.fill();
        ctx.restore();
    }
    ctx.fillStyle = '#ee3333';
    ctx.beginPath(); ctx.arc(fx, fy, r*0.72, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#111';
    const sr2 = Math.max(1, r*0.09);
    for (const [sx, sy] of [[-0.25,-0.15],[0.25,-0.15],[-0.35,0.2],[0.35,0.2],[0,0.35]]) {
        ctx.save(); ctx.translate(fx+sx*r, fy+sy*r); ctx.rotate(Math.PI/4);
        ctx.beginPath(); ctx.ellipse(0, 0, sr2, sr2*1.7, 0, 0, Math.PI*2); ctx.fill();
        ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc(fx-r*0.22, fy-r*0.26, r*0.25, 0, Math.PI*2); ctx.fill();
}

function drawCherry(fx, fy, r) {
    const cr = r * 0.55;
    const lx = fx - cr*0.8, rx = fx + cr*0.8, by = fy + cr*0.2;
    ctx.strokeStyle = '#4a2800'; ctx.lineWidth = Math.max(1.5, r*0.12); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lx, by-cr);
    ctx.bezierCurveTo(lx, fy-r*0.55, fx, fy-r*0.78, fx, fy-r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rx, by-cr);
    ctx.bezierCurveTo(rx, fy-r*0.55, fx, fy-r*0.78, fx, fy-r); ctx.stroke();
    for (const cx of [lx, rx]) {
        ctx.fillStyle = 'rgba(170,0,0,0.22)';
        ctx.beginPath(); ctx.arc(cx, by, cr+2, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#cc1111';
        ctx.beginPath(); ctx.arc(cx, by, cr, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.arc(cx-cr*0.28, by-cr*0.28, cr*0.28, 0, Math.PI*2); ctx.fill();
    }
}

function drawGrape(fx, fy, r) {
    ctx.fillStyle = 'rgba(100,40,200,0.18)';
    ctx.beginPath(); ctx.arc(fx, fy, r+4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#7733cc';
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    for (const [ox, oy] of [[-0.32,-0.22],[0.32,-0.22],[0,0.08],[-0.32,0.3],[0.32,0.3]]) {
        ctx.beginPath(); ctx.arc(fx+ox*r, fy+oy*r, r*0.38, 0, Math.PI*2); ctx.fill();
    }
    ctx.strokeStyle = '#4a2800'; ctx.lineWidth = Math.max(1.5, r*0.14); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(fx, fy-r); ctx.lineTo(fx+r*0.18, fy-r-r*0.38); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.beginPath(); ctx.arc(fx-r*0.28, fy-r*0.28, r*0.30, 0, Math.PI*2); ctx.fill();
}

function drawTongueFlick(cell) {
    const age = performance.now() - tongueFlickBorn;
    if (age > 750 || !snake.length) return;
    const t = age / 750;
    const phase = (t * 2) % 1;
    const ext = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    if (ext < 0.02) return;
    const hw  = cell / 2;
    const hx  = snake[0].x * cell + hw;
    const hy  = snake[0].y * cell + hw;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    const px  = -ddy, py = ddx;
    const hcx = hx + ddx * cell * 0.20;
    const hcy = hy + ddy * cell * 0.20;
    const mouthX = hcx + ddx * cell * 0.70 * 0.86;
    const mouthY = hcy + ddy * cell * 0.70 * 0.86;
    const len  = cell * 1.1 * ext;
    const fork = cell * 0.38 * ext;
    const tipX = mouthX + ddx * len;
    const tipY = mouthY + ddy * len;
    ctx.save();
    ctx.strokeStyle = '#ff5577';
    ctx.lineWidth   = Math.max(1.5, cell * 0.065);
    ctx.lineCap     = 'round';
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(mouthX, mouthY); ctx.lineTo(tipX, tipY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + ddx*fork + px*fork*0.7, tipY + ddy*fork + py*fork*0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + ddx*fork - px*fork*0.7, tipY + ddy*fork - py*fork*0.7); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
}

function drawEyes(head, cell) {
    const hw  = cell / 2;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    const px  = -ddy, py = ddx;
    const hcx = head.x*cell+hw + ddx*cell*0.20;
    const hcy = head.y*cell+hw + ddy*cell*0.20;
    const er   = Math.max(1.5, cell*0.11);
    const fwd  = cell * 0.28;
    const side = cell * 0.25;
    ctx.fillStyle = '#001500';
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(hcx + ddx*fwd + px*side*s, hcy + ddy*fwd + py*side*s, er, 0, Math.PI*2);
        ctx.fill();
    }
    const sr = er * 0.52;
    ctx.fillStyle = 'rgba(255,255,255,0.70)';
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(
            hcx + ddx*fwd + px*side*s - ddx*sr*0.5,
            hcy + ddy*fwd + py*side*s - ddy*sr*0.5,
            sr, 0, Math.PI*2
        );
        ctx.fill();
    }
}

function drawStart(size, cell) {
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(0,0,size,size);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#44ff44'; ctx.font=`bold ${Math.floor(cell*2)}px monospace`;
    ctx.fillText('SNAKE', size/2, size*0.32);
    let y = 0.45;
    if (gameMode === 'advanced') {
        ctx.fillStyle='#44aaff'; ctx.font=`${Math.floor(cell*0.55)}px monospace`;
        ctx.fillText('◆ ADVANCED MODE', size/2, size*y); y += 0.09;
    }
    const prof = getCurrentProfile();
    if (prof) {
        ctx.fillStyle='#555'; ctx.font=`${Math.floor(cell*0.55)}px monospace`;
        ctx.fillText(prof.name, size/2, size*y); y += 0.09;
    }
    if (highScore > 0) {
        ctx.fillStyle='#aaa'; ctx.font=`${Math.floor(cell*0.7)}px monospace`;
        ctx.fillText(`Best: ${highScore}`, size/2, size*y); y += 0.09;
    }
    ctx.fillStyle = difficulty === 'easy' ? '#44ffaa' : '#777';
    ctx.font=`${Math.floor(cell*0.55)}px monospace`;
    ctx.fillText(difficulty === 'easy' ? '● EASY' : '● NORMAL', size/2, size*y); y += 0.10;
    ctx.fillStyle='#555'; ctx.font=`${Math.floor(cell*0.55)}px monospace`;
    ctx.fillText('Swipe or tap to start', size/2, size*y); y += 0.08;
    ctx.fillText('Arrow keys on desktop', size/2, size*y);
}

function drawGameOver(size, cell) {
    const nh = score>0 && score===highScore;
    ctx.fillStyle='rgba(0,0,0,0.75)'; ctx.fillRect(0,size*0.26,size,size*0.48);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#ff4444'; ctx.font=`bold ${Math.floor(cell*1.25)}px monospace`;
    ctx.fillText('GAME OVER', size/2, size*0.40);
    ctx.fillStyle='#fff'; ctx.font=`${Math.floor(cell*0.85)}px monospace`;
    ctx.fillText(`Score: ${score}`, size/2, size*0.51);
    if (nh) { ctx.fillStyle='#ffdd44'; ctx.font=`${Math.floor(cell*0.65)}px monospace`; ctx.fillText('New High Score!', size/2, size*0.60); }
    ctx.fillStyle='#555'; ctx.font=`${Math.floor(cell*0.58)}px monospace`;
    ctx.fillText('Swipe to play again', size/2, nh?size*0.69:size*0.63);
}

function drawPaused(size, cell) {
    ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(0,0,size,size);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#44ff44'; ctx.font=`bold ${Math.floor(cell*1.4)}px monospace`;
    ctx.fillText('PAUSED', size/2, size*0.46);
    ctx.fillStyle='#555'; ctx.font=`${Math.floor(cell*0.6)}px monospace`;
    ctx.fillText('tap ▶ to resume', size/2, size*0.56);
}

function drawCountdown(size, cell) {
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='rgba(0,0,0,0.38)'; ctx.fillRect(0,0,size,size);
    ctx.fillStyle='#44ff44'; ctx.font=`bold ${Math.floor(cell*4)}px monospace`;
    ctx.fillText(String(countdownN), size/2, size/2);
}

function drawWin(size, cell) {
    ctx.fillStyle='rgba(0,30,0,0.82)'; ctx.fillRect(0,0,size,size);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#44ff44'; ctx.font=`bold ${Math.floor(cell*1.6)}px monospace`;
    ctx.fillText('YOU WIN!', size/2, size*0.36);
    ctx.fillStyle='#fff'; ctx.font=`${Math.floor(cell*0.85)}px monospace`;
    ctx.fillText(`Score: ${score}`, size/2, size*0.50);
    ctx.fillStyle='#aaa'; ctx.font=`${Math.floor(cell*0.62)}px monospace`;
    ctx.fillText('Perfect run!', size/2, size*0.59);
    ctx.fillStyle='#555'; ctx.fillText('Swipe to play again', size/2, size*0.68);
}

function drawCoins(cell) {
    const r = cell/2 - 2;
    for (const c of coins) {
        const cx = c.x*cell+cell/2, cy = c.y*cell+cell/2;
        ctx.fillStyle = 'rgba(255,220,50,0.12)';
        ctx.beginPath(); ctx.arc(cx, cy, r+3, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ffdd33';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.beginPath(); ctx.arc(cx-r*0.25, cy-r*0.3, r*0.3, 0, Math.PI*2); ctx.fill();
    }
}

function drawShopBlock(cell) {
    const x=shopBlock.x*cell+1, y=shopBlock.y*cell+1, s=cell-2;
    ctx.fillStyle='#1a1000';
    rr(x,y,s,s,Math.max(2,cell*0.18)); ctx.fill();
    ctx.strokeStyle='#ffaa22'; ctx.lineWidth=1.5;
    rr(x,y,s,s,Math.max(2,cell*0.18)); ctx.stroke();
    ctx.fillStyle='#ffaa22';
    ctx.font=`bold ${Math.max(8,Math.floor(cell*0.55))}px monospace`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('$', shopBlock.x*cell+cell/2, shopBlock.y*cell+cell/2);
}

function drawTongue(cell) {
    if (!tongue || !snake.length) return;
    const frac  = Math.max(0, (tongueVisUntil - performance.now()) / 380);
    const alpha = frac;
    const hx = snake[0].x*cell+cell/2, hy = snake[0].y*cell+cell/2;
    const tx = tongue.ex*cell+cell/2,  ty = tongue.ey*cell+cell/2;
    ctx.strokeStyle = `rgba(255,60,60,${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.fillStyle = `rgba(255,60,60,${alpha})`;
    ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI*2); ctx.fill();
}

function drawBabySnake(cell) {
    const tRem  = babyUntil - performance.now();
    const alpha = Math.min(1, tRem / 2000);
    for (let i = babySnake.length-1; i >= 0; i--) {
        const seg = babySnake[i];
        ctx.fillStyle = `rgba(170,50,210,${alpha * (i===0?1:0.65)})`;
        rr(seg.x*cell+2, seg.y*cell+2, cell-4, cell-4, Math.max(2,cell*0.18)); ctx.fill();
    }
}

function spawnDebris(cell) {
    if (!snake.length) return;
    const head  = snake[0];
    const angle = DEBRIS_ANGLE[dir] + (Math.random()-0.5)*1.4;
    const speed = cell * (0.05 + Math.random() * 0.08);
    particles.push({
        x: head.x*cell + cell/2, y: head.y*cell + cell/2,
        vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed - cell*0.02,
        life: 1, decay: 0.030 + Math.random()*0.025,
        size: cell*(0.18 + Math.random()*0.20),
        color: DEBRIS_COLORS[Math.floor(Math.random()*DEBRIS_COLORS.length)],
    });
}


function drawParticles() {
    for (let i = particles.length-1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.life -= p.decay;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        ctx.globalAlpha = p.life * 0.85;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
}

function drawScorePops(cell) {
    const now = performance.now();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(10, Math.floor(cell*0.72))}px monospace`;
    for (let i = scorePops.length-1; i >= 0; i--) {
        const p   = scorePops[i];
        const age = now - p.born;
        const life = 1 - age/650;
        if (life <= 0) { scorePops.splice(i, 1); continue; }
        ctx.globalAlpha = life;
        ctx.fillStyle = '#ffdd44';
        ctx.fillText(p.val || '+1', p.x, p.y - age*0.045);
    }
    ctx.globalAlpha = 1;
}


function setHandedness(h) {
    handedness = h;
    localStorage.setItem('snake_hand', h);
    const br = document.getElementById('btn-hand-r');
    const bl = document.getElementById('btn-hand-l');
    if (br) br.classList.toggle('off', h !== 'right');
    if (bl) bl.classList.toggle('off', h !== 'left');
    const cls = h === 'right' ? 'hand-right' : 'hand-left';
    const ga = document.getElementById('game-area');
    const sz = document.getElementById('swipe-zone');
    if (ga) ga.className = cls;
    if (sz) sz.className = cls;
}

function drawSnakeSmooth(cell) {
    if (!snake.length) return;
    const hw    = cell / 2;
    const bodyW = cell * 0.80;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    const headOffset = cell * 0.20;
    const rLong      = cell * 0.70;
    const rShort     = cell * 0.44;
    const headAngle  = Math.atan2(ddy, ddx);
    const hcx = snake[0].x*cell+hw + ddx*headOffset;
    const hcy = snake[0].y*cell+hw + ddy*headOffset;

    function path() {
        ctx.beginPath();
        ctx.moveTo(snake[0].x*cell+hw, snake[0].y*cell+hw);
        // stop before last segment — tail drawn separately as a taper
        for (let i = 1; i < snake.length - 1; i++)
            ctx.lineTo(snake[i].x*cell+hw, snake[i].y*cell+hw);
    }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';

    // Shadow
    ctx.save();
    ctx.translate(2, 3);
    path();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = bodyW;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, rLong, rShort, headAngle, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();
    ctx.restore();

    // Body base
    path();
    ctx.strokeStyle = '#278a27';
    ctx.lineWidth = bodyW;
    ctx.stroke();

    // Scales — quadratic bezier arcs across body, bowing toward tail
    {
        const halfH  = bodyW * 0.34; // half-span across body
        const bowAmt = cell * 0.12;  // how far the curve bows toward tail
        ctx.save();
        ctx.strokeStyle = 'rgba(10, 55, 10, 0.30)';
        ctx.lineWidth   = Math.max(1.5, cell * 0.08);
        ctx.lineCap     = 'round';
        const last = snake.length - 1;
        for (let i = 0; i < last; i++) {
            const x0  = snake[i].x     * cell + hw, y0  = snake[i].y     * cell + hw;
            const x1  = snake[i + 1].x * cell + hw, y1  = snake[i + 1].y * cell + hw;
            const tdx = (x1 - x0) / cell, tdy = (y1 - y0) / cell; // unit toward tail
            const pax = -tdy, pay = tdx;                            // unit perpendicular
            const fracs = i === 0       ? [0.46, 0.73]
                        : i === last-1  ? [0.22, 0.52]
                        :                 [0.22, 0.64];
            for (const frac of fracs) {
                const sx = x0 + (x1 - x0) * frac;
                const sy = y0 + (y1 - y0) * frac;
                ctx.beginPath();
                ctx.moveTo(sx - pax * halfH, sy - pay * halfH);
                ctx.quadraticCurveTo(
                    sx + tdx * bowAmt, sy + tdy * bowAmt, // bow toward tail
                    sx + pax * halfH,  sy + pay * halfH
                );
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // Center highlight stripe (reuses same path)
    ctx.strokeStyle = 'rgba(140,255,100,0.22)';
    ctx.lineWidth = bodyW * 0.36;
    ctx.stroke();

    // Tail — 2-segment taper: full width at snake[n-2], half at snake[n-1], point beyond
    if (snake.length >= 2) {
        const n  = snake.length;
        const a  = snake[n-2], b = snake[n-1];
        const dx = b.x-a.x, dy = b.y-a.y;         // tail direction unit vec
        const px = -dy,      py = dx;              // perpendicular unit vec
        const ax = a.x*cell+hw, ay = a.y*cell+hw;
        const bx = b.x*cell+hw, by = b.y*cell+hw;
        const tip = { x: bx + dx*cell*0.95, y: by + dy*cell*0.95 };
        const hw0 = bodyW / 2;          // full half-width at a
        const hw1 = bodyW / 2 * 0.45;  // narrowed half-width at b
        ctx.beginPath();
        ctx.moveTo(ax + px*hw0, ay + py*hw0);
        ctx.lineTo(bx + px*hw1, by + py*hw1);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(bx - px*hw1, by - py*hw1);
        ctx.lineTo(ax - px*hw0, ay - py*hw0);
        ctx.closePath();
        ctx.fillStyle = '#278a27';
        ctx.fill();
    }

    // Head — elongated ellipse in direction of travel
    ctx.fillStyle = '#339933';
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, rLong, rShort, headAngle, 0, Math.PI*2);
    ctx.fill();
    // Head outline — helps it read against the body
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = Math.max(1, cell * 0.055);
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, rLong, rShort, headAngle, 0, Math.PI*2);
    ctx.stroke();
    // Head highlight
    ctx.fillStyle = 'rgba(120,255,90,0.22)';
    ctx.beginPath();
    ctx.ellipse(
        hcx - ddx*rLong*0.10, hcy - ddy*rLong*0.10,
        rLong * 0.55, rShort * 0.65, headAngle, 0, Math.PI*2
    );
    ctx.fill();

    ctx.restore();
    drawEyes(snake[0], cell);

    // Speed lines while lunging
    if (lungeQueue > 0) {
        const hw2 = cell / 2;
        const ddx2 = dir==='right'?1: dir==='left'?-1:0;
        const ddy2 = dir==='down' ?1: dir==='up'  ?-1:0;
        const px2 = -ddy2, py2 = ddx2;
        const hx2 = snake[0].x*cell + hw2, hy2 = snake[0].y*cell + hw2;
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
            const sx = hx2 + px2*i*cell*0.28;
            const sy = hy2 + py2*i*cell*0.28;
            const opa = i === 0 ? 0.55 : 0.28;
            ctx.strokeStyle = `rgba(140,255,100,${opa})`;
            ctx.lineWidth = Math.max(1, cell * (i === 0 ? 0.08 : 0.05));
            ctx.beginPath();
            ctx.moveTo(sx - ddx2*cell*0.5, sy - ddy2*cell*0.5);
            ctx.lineTo(sx - ddx2*cell*2.2, sy - ddy2*cell*2.2);
            ctx.stroke();
        }
        ctx.restore();
    }
}

function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
}

window.addEventListener('DOMContentLoaded', init);
