'use strict';

const VERSION = 'v1.72';

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
const FLY_EXIT_DUR    = 480;   // fly flies-off-screen ms, instead of just vanishing

// ── Music: tracker-style song loaded from music.json ───────────
// Format: { bpm, stepCount, patterns: [{ name, tracks: [{ name, wave, oct, vol, mute, steps: [{on,note,oct,len}] }] }], song: [patternIndex, ...] }
// "song" arranges patterns in play order (can repeat/reorder bars for a longer, varied,
// non-repetitive arrangement) — swap in a new music.json to change the track, no code changes needed.
const NOTE_SEMITONE = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 };
function noteFreq(note, oct) {
    const semi = NOTE_SEMITONE[note];
    if (semi === undefined) return 0;
    const midi = (oct + 1) * 12 + semi;
    return 440 * Math.pow(2, (midi - 69) / 12);
}
const WAVE_TYPE = { sq: 'square', tri: 'triangle', saw: 'sawtooth', sine: 'sine' };

let BPM  = 128;
let STEP = 60 / BPM / 4;
let songTracks  = [];   // [{ name, wave, vol, mute, steps: [{freq,len}|null, ...] }]
let totalSteps  = 0;
let songReady   = false;

function loadSong(data) {
    BPM = data.bpm || 128;
    const stepsPerBar = data.stepCount || 16;
    STEP = 240 / BPM / stepsPerBar;
    const order = (data.song && data.song.length) ? data.song : data.patterns.map((_, i) => i);
    const names = [];
    for (const p of data.patterns) for (const tr of p.tracks) if (!names.includes(tr.name)) names.push(tr.name);

    songTracks = names.map(name => {
        let wave = 'sq', vol = 0.7, mute = false;
        const steps = [];
        for (const patIdx of order) {
            const pattern = data.patterns[patIdx];
            const track = pattern.tracks.find(t => t.name === name);
            if (!track) { for (let i = 0; i < stepsPerBar; i++) steps.push(null); continue; }
            wave = track.wave; vol = track.vol; mute = track.mute;
            for (let i = 0; i < stepsPerBar; i++) {
                const s = track.steps[i];
                steps.push(s && s.on ? { freq: noteFreq(s.note, s.oct), len: s.len } : null);
            }
        }
        return { name, wave, vol, mute, steps };
    });
    totalSteps = songTracks.length ? songTracks[0].steps.length : 0;
    songReady = true;
}

fetch('music.json').then(r => r.json()).then(loadSong).catch(() => {});

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
let gameOverSource   = null;
let gameOverFadeGain = null;
let _goAB  = null;

fetch('gameover.wav').then(r => r.arrayBuffer()).then(ab => { _goAB  = ab; if (audioCtx) _decodeWavs(); }).catch(() => {});

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
// Sidekick's dedicated target — without a second pickup on the board the sidekick has
// nothing to do that the main snake wasn't already about to eat itself. Spawned once Sidekick
// is first picked (see pickAbility), collectible by anyone (main snake, Sidekick, or Magnet).
let bonusFood         = null;
let bonusFoodType     = 'apple';
let bonusFoodSpawnTime = 0;
let gameState   = 'start';
let lastTick    = 0;
let tickMs      = BASE_MS;
let deathTime   = 0;
let foodPulse   = 0;
let optionsOpen = false;

// ── Continuous movement ──────────────────────────────────────────
// prevSnake holds grid positions from just before the most recent tick, so draw() can
// slide each segment smoothly toward its new cell instead of snapping tick to tick.
let prevSnake   = [];
let curEffMs    = BASE_MS; // interval currently governing tick pacing (set each frame in loop())
let renderSnake = [];      // interpolated snake used by all render code; rebuilt once per draw()

// Food swallowed at the head travels toward the tail as a shrinking bulge, then disappears.
// { segIndex } — index into snake/renderSnake this bolus currently occupies.
let digestingFood = [];

function updateRenderSnake(now) {
    if (gameState !== 'running' || levelUpOpen || !snake.length || now < lastTick) {
        // now < lastTick happens during the post-lunge pause, which parks lastTick in the
        // future as a scheduling hack — nothing is moving then, so show the settled position.
        renderSnake = snake;
        return;
    }
    const t = Math.max(0, Math.min(1, curEffMs > 0 ? (now - lastTick) / curEffMs : 1));
    renderSnake = snake.map((s, i) => {
        const p = i < prevSnake.length ? prevSnake[i] : s;
        return { x: p.x + (s.x - p.x) * t, y: p.y + (s.y - p.y) * t };
    });
}


// ── Visual juice state ────────────────────────────────────────
let particles = [], scorePops = [], shakeMag = 0;

// ── Procedural background (grasslands: mottled grass, dirt patches, stones) ────
// Rendered once per game to an offscreen canvas at a fixed design resolution, then
// stretched to fit — regenerating it from scratch each game is what makes it different
// every time, and drawing it once instead of per-frame keeps it cheap.
const BG_UNIT = 40; // px per grid cell in the offscreen canvas
let bgCanvas = null;

// Adds one blob as a subpath — does NOT call beginPath()/fill() itself, so the caller can
// accumulate several blobs into one path and fill it once. That's what makes overlapping
// patches merge into a single seamless shape instead of double-blending at the overlap.
function addBlobSubpath(bctx, cx, cy, R, n, jitter) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = R * (1 - jitter / 2 + Math.random() * jitter);
        pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    bctx.moveTo((pts[0].x + pts[n - 1].x) / 2, (pts[0].y + pts[n - 1].y) / 2);
    for (let i = 0; i < n; i++) {
        const next = pts[(i + 1) % n];
        const midx = (pts[i].x + next.x) / 2, midy = (pts[i].y + next.y) / 2;
        bctx.quadraticCurveTo(pts[i].x, pts[i].y, midx, midy);
    }
    bctx.closePath();
}

// Draws every dirt patch's outer blob into one shared path (single fill), then every
// patch's inner shading blob into another shared path (single fill) — so overlapping
// patches read as one continuous blob instead of stacked, visibly-seamed layers.
function drawDirtPatches(bctx, patches) {
    // More opaque than before — the base ground is now green, so a patch needs to actually
    // cover it rather than half-blend into a muddy olive tone.
    bctx.beginPath();
    for (const p of patches) addBlobSubpath(bctx, p.cx, p.cy, p.R, 11 + Math.floor(Math.random() * 4), 0.5);
    bctx.fillStyle = 'rgba(150,112,58,0.88)';
    bctx.fill();

    bctx.beginPath();
    for (const p of patches) addBlobSubpath(bctx, p.cx, p.cy, p.R * 0.62, 9 + Math.floor(Math.random() * 3), 0.5);
    bctx.fillStyle = 'rgba(120,88,42,0.6)';
    bctx.fill();
}

// Scatters small dirt-colored dabs just past each patch's edge, fading out in size and
// opacity with distance — breaks the blob's fill from one clean boundary into a ragged,
// randomly-thinning transition, so the soil color already peeking through the grass blends
// into the dirt patch instead of the patch reading as a shape dropped on top of the grass.
function drawDirtFringe(bctx, patches) {
    for (const p of patches) {
        const n = 10 + Math.floor(Math.random() * 10);
        for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2;
            const rad = p.R * (0.85 + Math.random() * 0.55);
            const x = p.cx + Math.cos(ang) * rad;
            const y = p.cy + Math.sin(ang) * rad;
            const size = p.R * (0.10 + Math.random() * 0.16);
            const reach = (rad - p.R * 0.85) / (p.R * 0.55); // 0 at the patch edge, 1 at the fringe's outer limit
            const alpha = 0.5 - reach * 0.45;
            if (alpha <= 0.03) continue;
            bctx.beginPath();
            addBlobSubpath(bctx, x, y, size, 7 + Math.floor(Math.random() * 3), 0.6);
            bctx.fillStyle = `rgba(140,104,52,${alpha.toFixed(3)})`;
            bctx.fill();
        }
    }
}

function drawStone(bctx, x, y, r) {
    const rot = Math.random() * Math.PI;
    bctx.beginPath(); bctx.ellipse(x, y + r * 0.18, r * 0.95, r * 0.8, rot, 0, Math.PI * 2);
    bctx.fillStyle = 'rgba(0,0,0,0.16)'; bctx.fill();
    bctx.beginPath(); bctx.ellipse(x, y, r * 0.9, r * 0.75, rot, 0, Math.PI * 2);
    bctx.fillStyle = '#a89a86'; bctx.fill();
    bctx.strokeStyle = 'rgba(25,18,12,0.75)';
    bctx.lineWidth = Math.max(1, r * 0.16);
    bctx.stroke();
    bctx.beginPath(); bctx.ellipse(x - r * 0.22, y - r * 0.28, r * 0.34, r * 0.26, rot, 0, Math.PI * 2);
    bctx.fillStyle = 'rgba(255,255,255,0.35)'; bctx.fill();
}

// Dirt patch centers/radii in grid-cell units — shared with buildGrassField so blades
// know to leave dirt bare instead of growing through it.
let dirtPatches = [];

function buildBackground(cols, rows) {
    const w = cols * BG_UNIT, h = rows * BG_UNIT;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const bctx = c.getContext('2d');

    // Base ground is grass-green — this is now the primary "grass" look by default (the
    // interactive blade field on top is an optional, off-by-default layer, see grassEnabled),
    // so the base itself needs to actually read as a lawn, not bare dirt with a few flecks.
    bctx.fillStyle = '#3f8a20';
    bctx.fillRect(0, 0, w, h);

    // Mottling for grass texture variation — lighter and darker patches blended into the
    // base so it doesn't look like one flat color.
    for (let i = 0; i < cols * rows * 1.1; i++) {
        const x = Math.random() * w, y = Math.random() * h;
        const r = 8 + Math.random() * 22;
        bctx.fillStyle = Math.random() < 0.5 ? 'rgba(120,210,70,0.30)' : 'rgba(30,110,10,0.28)';
        bctx.beginPath();
        bctx.ellipse(x, y, r, r * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
        bctx.fill();
    }

    // Dirt patches, scattered — geometry kept in cell units in dirtPatches so the grass
    // field (built separately) can test against the same shapes.
    dirtPatches = [];
    const nPatches = Math.max(3, Math.round((cols * rows) / 32));
    for (let i = 0; i < nPatches; i++) {
        const cx = Math.random() * cols, cy = Math.random() * rows;
        const R  = 1.1 + Math.random() * 1.6;
        dirtPatches.push({ cx, cy, R });
    }
    const bgPatches = dirtPatches.map(p => ({ cx: p.cx * BG_UNIT, cy: p.cy * BG_UNIT, R: p.R * BG_UNIT }));
    drawDirtPatches(bctx, bgPatches);
    drawDirtFringe(bctx, bgPatches);

    // Stones — a light scatter everywhere, plus denser clusters in/around dirt patches
    for (let i = 0; i < cols * rows * 0.3; i++) {
        drawStone(bctx, Math.random() * w, Math.random() * h, 2 + Math.random() * 3.5);
    }
    for (const p of dirtPatches) {
        const n = 6 + Math.floor(Math.random() * 10);
        for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2, rad = Math.random() * p.R * 0.95 * BG_UNIT;
            drawStone(bctx, p.cx*BG_UNIT + Math.cos(ang) * rad, p.cy*BG_UNIT + Math.sin(ang) * rad, 2.5 + Math.random() * 4);
        }
    }

    bgCanvas = c;
}

// ── Interactive grass ────────────────────────────────────────
// A field of small blades drawn over the procedural background; the snake lays them flat
// along its direction of travel as it passes, and they stay laid over — permanently —
// until the snake passes through that exact cell again (from whatever direction it's
// heading that time). Rebuilt whenever CELL_COUNT changes (see startGame()) so density
// always matches the current grid. Off by default — toggled in options (see initOptions);
// the bare procedural ground (soil/dirt patches/stones) still shows either way.
let grassEnabled = localStorage.getItem('snake_grass_on') === 'true';
// Experimental "bold" look: far fewer, much larger blades with a black cartoon outline,
// instead of a dense fine-grained field. These four are live-tunable from the options
// panel's GRASS debug section (see initOptions) — grassPerCell/grassLenScale need a field
// rebuild to take effect (baked into each blade at creation), grassWidthScale/
// grassOutlineScale are read fresh every frame in drawGrassField.
let grassPerCell      = 7;
let grassLenScale     = 1.0;
let grassWidthScale   = 1.0;
let grassOutlineScale = 1.0;
// Cartoon-style black border around the snake's body+head, same "wider shape drawn behind,
// normal shape drawn on top" trick as the grass outline. 0 = off. Live-tunable from the
// options panel's GRASS DEBUG section alongside the grass sliders.
let snakeOutlineScale = 1.0;
const GRASS_PUSH      = 0.65;  // how far (in cell-fractions) a pass lays a blade over
let grassField  = null; // { cols, rows, blades, byCell: Map }

// Discrete color+width combos rather than one fixed look — each blade is assigned one at
// build time (variant), and rendering batches by variant (one stroke() call per variant,
// same idea as the old 2-tone split, just richer) so this stays cheap regardless of count.
// Opacity bumped up from the old fine-grained look — with so few blades each one needs to
// read as a solid, sticker-like shape rather than a faint wisp.
const GRASS_VARIANTS = [
    { color: 'rgba(26, 92,16,0.88)', width: 0.85 },
    { color: 'rgba(40,122,20,0.85)', width: 1.05 },
    { color: 'rgba(58,145,32,0.82)', width: 1.20 },
    { color: 'rgba(85,172,52,0.80)', width: 1.35 },
];

function onDirt(x, y) {
    for (const p of dirtPatches) {
        // Jittered cutoff (called once per candidate blade at build time) instead of a fixed
        // radius — keeps the bare-ground edge ragged rather than a perfect circle, matching
        // the speckled fringe baked into the background.
        const jitter = (Math.random() - 0.5) * 0.5;
        if (Math.hypot(x - p.cx, y - p.cy) < p.R * 0.88 + jitter) return true;
    }
    return false;
}

function buildGrassField(cols, rows) {
    const blades = [];
    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            for (let k = 0; k < grassPerCell; k++) {
                // Full 0-1 range, not a margin inset — an inset left a systematic gap at
                // every cell boundary, which read as a visible grid across the whole field.
                const ox = Math.random();
                const oy = Math.random();
                if (onDirt(cx + ox, cy + oy)) continue;
                blades.push({
                    cx, cy, ox, oy,
                    tilt: (Math.random() - 0.5) * 0.9,   // resting lean — wide range, not all near-upright
                    curveSign: Math.random() < 0.5 ? 1 : -1, // which way the blade bows — was always the same side
                    curveAmt: 0.06 + Math.random() * 0.30,   // how much it bows — some nearly straight, some very hooked
                    len:  (0.85 + Math.random() * 0.55) * grassLenScale, // big stylized tufts, ~1-1.4 cells long
                    variant: Math.floor(Math.random() * GRASS_VARIANTS.length),
                    bx: 0, by: 0,     // currently-rendered bend, eases toward tbx/tby
                    tbx: 0, tby: 0,   // target bend set by bendGrassAt
                    transitioning: false, // in grassTransitioning list?
                    wig: 0, wigT: 0, wiggling: false, // decaying flutter kick, and in grassWiggling list?
                    wigPhase: Math.random() * 6.28,
                });
            }
        }
    }
    const byCell = new Map();
    for (const b of blades) {
        const key = b.cy * cols + b.cx;
        if (!byCell.has(key)) byCell.set(key, []);
        byCell.get(key).push(b);
    }
    grassField = { cols, rows, blades, byCell };
    grassTransitioning = [];
    grassWiggling = [];
}

// The body flattens a strip straight down its centerline and shoulders the grass on
// either side outward at an angle — like it's actually being pushed aside, not just bent
// forward. px,py is the left-hand perpendicular to travel; side = +1 left / -1 right / 0
// center, based on where the blade sits across the cell relative to the direction of travel.
const GRASS_CENTER_HALFWIDTH = 0.13; // fraction of a cell either side of centerline that stays "under" the body
const GRASS_SIDE_MIX = 0.55;          // how much of the side-push is sideways vs forward-lean
const GRASS_EASE = 0.22;              // per-frame fraction of the way from current bend to target
let grassTransitioning = []; // blades whose rendered bend hasn't caught up to their target yet

// A blade whose bend target hasn't changed (e.g. a body segment re-passing over a cell it
// already laid flat while moving in a straight line) gets no new easing motion — that read
// as the trailing grass going static the moment it first settled, even while the body kept
// gliding over it. This kick fires every time any segment passes through a cell, whether or
// not the target changed, and rides on top of the eased bend as a short decaying perpendicular
// flutter — so the grass visibly shivers along the whole length of the body as it moves, not
// just at the leading edge on turns.
const GRASS_WIG_AMOUNT = 0.30; // peak flutter offset, as a fraction of blade length
const GRASS_WIG_SPEED  = 0.9;  // radians of flutter phase advanced per frame
const GRASS_WIG_DECAY  = 0.90; // per-frame multiplicative decay of flutter amplitude
let grassWiggling = []; // blades with an active decaying flutter

function bendGrassAt(cx, cy, dirx, diry) {
    if (!grassField) return;
    const list = grassField.byCell.get(cy * grassField.cols + cx);
    if (!list) return;
    const px = -diry, py = dirx;
    for (const b of list) {
        const perpOffset = (b.ox - 0.5) * px + (b.oy - 0.5) * py;
        if (Math.abs(perpOffset) <= GRASS_CENTER_HALFWIDTH) {
            b.tbx = dirx * GRASS_PUSH;
            b.tby = diry * GRASS_PUSH;
        } else {
            const side = perpOffset > 0 ? 1 : -1;
            b.tbx = (dirx * (1 - GRASS_SIDE_MIX) + px * side * GRASS_SIDE_MIX) * GRASS_PUSH;
            b.tby = (diry * (1 - GRASS_SIDE_MIX) + py * side * GRASS_SIDE_MIX) * GRASS_PUSH;
        }
        if (!b.transitioning) { b.transitioning = true; grassTransitioning.push(b); }
        b.wig = GRASS_WIG_AMOUNT;
        b.wigT = b.wigPhase;
        if (!b.wiggling) { b.wiggling = true; grassWiggling.push(b); }
    }
}

// Eases each disturbed blade's rendered bend (bx/by) toward its target (tbx/tby) over
// several frames instead of snapping instantly — gives the "squish" an actual physical
// transition. Only blades mid-transition are touched, so cost stays proportional to
// recent motion, not total field size.
function updateGrassTransitions() {
    for (let i = grassTransitioning.length - 1; i >= 0; i--) {
        const b = grassTransitioning[i];
        b.bx += (b.tbx - b.bx) * GRASS_EASE;
        b.by += (b.tby - b.by) * GRASS_EASE;
        if (Math.abs(b.tbx - b.bx) < 0.004 && Math.abs(b.tby - b.by) < 0.004) {
            b.bx = b.tbx; b.by = b.tby;
            b.transitioning = false;
            grassTransitioning.splice(i, 1);
        }
    }
}

// Decays each fluttering blade's kick amplitude back to zero over a fraction of a second.
// Only blades kicked recently are touched, so cost stays proportional to how much of the
// field the body currently spans, not total field size.
function updateGrassWiggle() {
    for (let i = grassWiggling.length - 1; i >= 0; i--) {
        const b = grassWiggling[i];
        b.wigT += GRASS_WIG_SPEED;
        b.wig  *= GRASS_WIG_DECAY;
        if (b.wig < 0.01) {
            b.wig = 0;
            b.wiggling = false;
            grassWiggling.splice(i, 1);
        }
    }
}

// Builds one blade's curve into the given Path2D.
function addBladePath(path, b, cell) {
    const baseX = (b.cx + b.ox) * cell;
    const baseY = (b.cy + b.oy) * cell;
    const len   = b.len * cell;

    // Blend direction from upright (plus a little natural tilt) toward the bend
    // direction as bend magnitude grows, rather than adding the bend offset on
    // top of the upright tip — that stretched bent blades noticeably longer than
    // unbent ones instead of just leaning them over at a constant length.
    const bendMag = Math.hypot(b.bx, b.by);
    const lean = Math.min(1, bendMag / GRASS_PUSH);
    let dx = b.tilt * (1 - lean) + (bendMag > 1e-6 ? (b.bx / bendMag) * lean : 0);
    let dy = -1 * (1 - lean)     + (bendMag > 1e-6 ? (b.by / bendMag) * lean : 0);
    const dmag = Math.hypot(dx, dy) || 1;
    dx /= dmag; dy /= dmag;

    let tipX = baseX + dx * len;
    let tipY = baseY + dy * len;
    const perpX = -dy, perpY = dx;
    const bulge = len * b.curveAmt * b.curveSign;
    let midX = baseX + dx * len * 0.5 + perpX * bulge;
    let midY = baseY + dy * len * 0.5 + perpY * bulge;

    // Decaying perpendicular flutter from a recent pass — makes the tip (and the
    // curve's control point, half as much) shiver for a moment instead of the blade
    // going instantly rigid the moment its bend target is reached.
    if (b.wig > 0) {
        const wob = Math.sin(b.wigT) * b.wig * len;
        tipX += perpX * wob;
        tipY += perpY * wob;
        midX += perpX * wob * 0.5;
        midY += perpY * wob * 0.5;
    }

    path.moveTo(baseX, baseY);
    path.quadraticCurveTo(midX, midY, tipX, tipY);
}

// Strokes one Path2D per variant — a wide black outline pass, then the colored fill pass on
// top (the cartoon-outline trick).
function strokeVariantPaths(paths, cell) {
    for (let vi = 0; vi < GRASS_VARIANTS.length; vi++) {
        const variant = GRASS_VARIANTS[vi];
        const fillWidth = Math.max(2, cell * 0.16 * variant.width * grassWidthScale);
        // grassOutlineScale <= 0 means no minimum floor — the outline pass ends up the same
        // width as the fill pass and is fully covered by it, i.e. genuinely no outline.
        const outlinePad = grassOutlineScale > 0 ? Math.max(2, cell * 0.05 * grassOutlineScale) : 0;
        ctx.strokeStyle = 'rgba(15,15,15,0.88)';
        ctx.lineWidth = fillWidth + outlinePad;
        ctx.stroke(paths[vi]);
        ctx.strokeStyle = variant.color;
        ctx.lineWidth = fillWidth;
        ctx.stroke(paths[vi]);
    }
}

// Batched by variant into a handful of Path2D objects (one stroke() call each) instead of
// one stroke() per blade — thousands of individual stroke calls was the actual cost, not
// the blade count.
function drawGrassField(cell) {
    if (!grassEnabled || !grassField) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const paths = GRASS_VARIANTS.map(() => new Path2D());
    for (const b of grassField.blades) addBladePath(paths[b.variant], b, cell);
    strokeVariantPaths(paths, cell);
    ctx.restore();
}

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
let flyPrev       = null;   // grid position before the most recent move, for interpolation
let flyUntil      = 0;
let flyTimer      = 0;
let flyRegion     = null;   // {cx, cy, r} home zone
let flyEntering   = false;
let flyEnterFrom  = { x: 0, y: 0 };
let flyEnterStart = 0;
let flyExiting    = false;
let flyExitFrom   = { x: 0, y: 0 };
let flyExitTo     = { x: 0, y: 0 };
let flyExitStart  = 0;
let flyBuzzOsc    = null;
let flyBuzzMod    = null;
let flyBuzzGain   = null;

const FOOD_TYPES = ['apple', 'strawberry', 'watermelon', 'cherry', 'grape'];
let foodType = 'apple';
const DEBRIS_COLORS = ['#c8a050','#d4b860','#e8d090','#a06828','#b89848','#8a6828'];
const GRASS_FLECK_COLORS = ['#2f7a1a','#3f9722','#5ab52f','#7bcf4a'];
const DEBRIS_ANGLE  = { right: Math.PI, left: 0, up: Math.PI/2, down: -Math.PI/2 };

// ── Advanced mode state ───────────────────────────────────────
// XP/level-up system (Vampire-Survivors style): eating food/flies grants XP, filling xpBar;
// crossing a threshold queues a level-up prompt offering 2-3 random ability picks. No economy,
// no ability buttons — Sprint/Dash keep their classic gesture triggers (hold/tap), the rest
// auto-trigger once picked. See tick() for the per-tick auto-ability checks.
let xp             = 0;
let xpLevel        = 1;
let levelUpQueue   = 0;        // pending level-up prompts not yet shown
let levelUpOpen    = false;    // pauses tick()/input while a level-up card is up (like shopOpen did)
let levelUpChoices = [];       // ability keys currently offered
let armorCharges   = 0;        // remaining Armor charges (see tick()'s collision checks)
let tongue         = null;     // {ex,ey} tongue endpoint while visible
let tongueVisUntil = 0;        // performance.now() deadline for tongue visual
let babySnake      = [];       // {x,y}[] sidekick helper segments
let babyUntil      = 0;        // performance.now() when the sidekick's current cycle ends (auto-respawns)
let slowUntil      = 0;        // performance.now() when slow-time expires

let abilityLevels    = { sprint:0, dash:0, tongue:0, slowtime:0, sidekick:0, armor:0, magnet:0, ring:0 }; // 0=locked, 1/2/3
let abilityCooldowns = { dash:0, tongue:0, slowtime:0 }; // ready-at timestamp — only the 3 cooldown-based abilities need this

function xpForLevel(l) { return 5 + (l - 1) * 3; }

const ABILITY_CFG = {
    sprint: {
        name: 'SPRINT',
        descs: ['Hold to move faster', 'Hold for more speed', 'Hold for max speed'],
        floorMult: [0.85, 0.70, 0.55], // MIN_MS floor multiplier
        factor:    [0.70, 0.58, 0.45], // tickMs multiplier while held
    },
    dash: {
        name: 'DASH',
        descs: ['Tap to dash to food (short range)', 'Longer range, shorter cooldown', 'Max range, fastest cooldown'],
        cooldowns: [4000, 2200, 800],
        maxRange:  [6, 12, 999],
    },
    tongue: {
        name: 'TONGUE',
        descs: ['Auto-grabs food ahead', 'Longer reach', 'Max range'],
        cooldowns: [8000, 6000, 4000],
        ranges:    [4, 7, 11],
    },
    slowtime: {
        name: 'SLOW TIME',
        descs: ['Periodic 3s slow-mo', 'Periodic 5s slow-mo', 'Periodic 7s slow-mo'],
        cooldowns: [12000, 10000, 8000],
        durations: [3000, 5000, 7000],
    },
    sidekick: {
        name: 'SIDEKICK',
        descs: ['A helper snake collects food for you', 'Faster-cycling helper', 'Best helper'],
        durations: [10000, 15000, 20000],
    },
    armor: {
        name: 'ARMOR',
        descs: ['Survive 1 fatal hit', 'Survive 2 fatal hits', 'Survive 3 fatal hits'],
        charges: [1, 2, 3],
    },
    magnet: {
        name: 'MAGNET',
        descs: ['Auto-collect food within 1 tile', 'Auto-collect within 2 tiles', 'Auto-collect within 3 tiles'],
        radius: [1, 2, 3],
    },
    ring: {
        name: 'WEIGHTED RING',
        descs: ['Slower, but +25% XP', 'Slower still, +50% XP', 'Slowest, +75% XP'],
        slowFactor: [1.08, 1.15, 1.22], // multiplies every tick interval — bigger = slower
        xpMult:     [1.25, 1.50, 1.75],
    },
};
const ABILITY_POOL = Object.keys(ABILITY_CFG);

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

// ── Audio: music sequencer (drives the loaded tracker song) ────
function schedNote(freq, dest, t, dur, type, vol = 1) {
    if (freq <= 0 || !audioCtx) return;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(dest);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.005);
    gain.gain.setValueAtTime(vol, t + dur * 0.72);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.97);
    osc.start(t); osc.stop(t + dur);
}

function schedHihat(t, vol = 0.3) {
    if (!audioCtx || !noiseBuffer) return;
    const src    = audioCtx.createBufferSource(); src.buffer = noiseBuffer;
    const filter = audioCtx.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 9000;
    const gain   = audioCtx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(filter); filter.connect(gain); gain.connect(musicGain);
    src.start(t); src.stop(t + 0.05);
}

function schedStep(step, t) {
    const s = step % totalSteps;
    for (const track of songTracks) {
        if (track.mute) continue;
        const note = track.steps[s];
        if (!note) continue;
        const dur = note.len * STEP * 0.92;
        if (track.wave === 'nse') schedHihat(t, track.vol);
        else schedNote(note.freq, musicGain, t, dur, WAVE_TYPE[track.wave] || 'square', track.vol);
    }
}

function musicScheduler() {
    if (!audioCtx || !totalSteps) return;
    while (nextBeat < audioCtx.currentTime + 0.12) {
        schedStep(beatIndex, nextBeat);
        nextBeat += STEP;
        beatIndex = (beatIndex + 1) % totalSteps;
    }
}

function startMusic() {
    if (!audioCtx || !songReady) return;
    stopMusic();
    nextBeat  = audioCtx.currentTime + 0.08;
    beatIndex = 0;
    musicTimer = setInterval(musicScheduler, 25);
}

function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
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
    const isAdv = gameMode === 'advanced';
    if (hud) hud.classList.toggle('visible', isAdv);
    if (isAdv) updateAdvancedHUD();
    resize();
}

function updateAdvancedHUD() {
    const fill = document.getElementById('xp-bar-fill');
    const lvl  = document.getElementById('xp-level-badge');
    if (fill) fill.style.width = `${Math.min(100, (xp / xpForLevel(xpLevel)) * 100)}%`;
    if (lvl)  lvl.textContent = `Lv ${xpLevel}`;
}

// ── XP / level-up ─────────────────────────────────────────────
function gainXP(n) {
    if (abilityLevels.ring > 0) n *= ABILITY_CFG.ring.xpMult[abilityLevels.ring - 1];
    xp += n;
    while (xp >= xpForLevel(xpLevel)) {
        xp -= xpForLevel(xpLevel);
        xpLevel++;
        levelUpQueue++;
    }
    updateAdvancedHUD();
    if (levelUpQueue > 0 && !levelUpOpen) showNextLevelUp();
}

function rollAbilityChoices() {
    const pool = ABILITY_POOL.filter(k => abilityLevels[k] < 3);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 3);
}

function showNextLevelUp() {
    if (levelUpQueue <= 0) return;
    const choices = rollAbilityChoices();
    levelUpQueue--;
    if (!choices.length) { if (levelUpQueue > 0) showNextLevelUp(); return; } // everything maxed
    levelUpChoices = choices;
    levelUpOpen = true;
    renderLevelUp();
    document.getElementById('levelup-overlay').classList.remove('hidden');
    sfxCoin(); vibrate([20, 20, 20]);
}

function pickAbility(key) {
    abilityLevels[key]++;
    const level = abilityLevels[key];
    if (key === 'sidekick' && level === 1) { activateBabySnake(level); spawnBonusFood(); }
    if (key === 'armor') armorCharges = ABILITY_CFG.armor.charges[level - 1];
    document.getElementById('levelup-overlay').classList.add('hidden');
    levelUpOpen = false;
    lastTick = performance.now();
    if (levelUpQueue > 0) showNextLevelUp();
}

function renderLevelUp() {
    const list = document.getElementById('levelup-cards');
    list.innerHTML = '';
    for (const key of levelUpChoices) {
        const cfg   = ABILITY_CFG[key];
        const level = abilityLevels[key];
        const card = document.createElement('button'); card.className = 'lvlup-card';
        const nm = document.createElement('div'); nm.className = 'lvlup-name'; nm.textContent = cfg.name;
        const lv = document.createElement('div'); lv.className = 'lvlup-lvl';
        lv.textContent = level === 0 ? 'NEW' : `Lv ${level} → ${level + 1}`;
        const ds = document.createElement('div'); ds.className = 'lvlup-desc'; ds.textContent = cfg.descs[level];
        card.append(nm, lv, ds);
        card.onclick = () => pickAbility(key);
        list.appendChild(card);
    }
}

// ── Ability effects ───────────────────────────────────────────
// Shared by the main snake (via tick()), Tongue, Sidekick, and Magnet — grants the same
// reward as eating normally without requiring the main snake's body to occupy the cell.
// foodObj/respawnFn let this work against either the main food or bonusFood.
function collectFoodAt(x, y, foodObj, respawnFn) {
    if (!foodObj || x !== foodObj.x || y !== foodObj.y) return false;
    score += 1; if (score > highScore) highScore = score;
    updateScoreDisplay(); sfxCoin(); vibrate(15);
    if (gameMode === 'advanced') gainXP(1);
    respawnFn();
    return true;
}

function activateTongue(level) {
    if (!snake.length) return false;
    const range = ABILITY_CFG.tongue.ranges[level - 1];
    const dx = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
    const dy = dir === 'down'  ? 1 : dir === 'up'   ? -1 : 0;
    for (let i = 1; i <= range; i++) {
        const tx = snake[0].x + dx*i, ty = snake[0].y + dy*i;
        if (tx < 0 || tx >= CELL_COUNT || ty < 0 || ty >= CELL_COUNT) break;
        if (tx === food.x && ty === food.y) {
            collectFoodAt(tx, ty, food, spawnFood);
            tongue = { ex: tx, ey: ty };
            tongueVisUntil = performance.now() + 380;
            abilityCooldowns.tongue = performance.now() + ABILITY_CFG.tongue.cooldowns[level - 1];
            return true;
        }
        if (bonusFood && tx === bonusFood.x && ty === bonusFood.y) {
            collectFoodAt(tx, ty, bonusFood, spawnBonusFood);
            tongue = { ex: tx, ey: ty };
            tongueVisUntil = performance.now() + 380;
            abilityCooldowns.tongue = performance.now() + ABILITY_CFG.tongue.cooldowns[level - 1];
            return true;
        }
    }
    return false;
}

function activateSlowTime(level) {
    slowUntil = performance.now() + ABILITY_CFG.slowtime.durations[level - 1];
    abilityCooldowns.slowtime = slowUntil + ABILITY_CFG.slowtime.cooldowns[level - 1];
}

function activateBabySnake(level) {
    babyUntil = performance.now() + ABILITY_CFG.sidekick.durations[level - 1];
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    if (bonusFood) occ.add(`${bonusFood.x},${bonusFood.y}`);
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    if (free.length < 3) { babyUntil = performance.now() + 500; return; } // board's full, retry shortly
    const si = Math.floor(Math.random() * (free.length - 2));
    babySnake = [free[si], free[si+1], free[si+2]];
}

// Chases bonusFood specifically, not the main food — without its own dedicated target the
// sidekick was just racing the player to the one food item on the board, which the player
// almost always reached first, making it pointless.
function tickBabySnake() {
    if (!babySnake.length || !bonusFood) return;
    const head = babySnake[0];
    const moves = [];
    if (bonusFood.x > head.x) moves.push({ dx:1, dy:0 });
    else if (bonusFood.x < head.x) moves.push({ dx:-1, dy:0 });
    if (bonusFood.y > head.y) moves.push({ dx:0, dy:1 });
    else if (bonusFood.y < head.y) moves.push({ dx:0, dy:-1 });
    const fallback = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
    for (const mv of [...moves, ...fallback]) {
        const nx = head.x + mv.dx, ny = head.y + mv.dy;
        if (nx < 0 || nx >= CELL_COUNT || ny < 0 || ny >= CELL_COUNT) continue;
        if (babySnake.some(s => s.x===nx && s.y===ny)) continue;
        if (snake.some(s => s.x===nx && s.y===ny)) continue;
        babySnake.unshift({ x:nx, y:ny }); babySnake.pop();
        collectFoodAt(nx, ny, bonusFood, spawnBonusFood);
        break;
    }
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

    const gBtn = document.getElementById('btn-grass');
    const syncG = () => { gBtn.textContent = grassEnabled ? 'ON' : 'OFF'; gBtn.classList.toggle('off', !grassEnabled); };
    syncG();
    gBtn.addEventListener('click', () => {
        grassEnabled = !grassEnabled;
        localStorage.setItem('snake_grass_on', grassEnabled ? 'true' : 'false');
        syncG();
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

    // Live-tunable grass/snake look (grassPerCell/grassLenScale/grassWidthScale/
    // grassOutlineScale/snakeOutlineScale, declared up near buildGrassField/drawGrassField/
    // drawSnakeSmooth). Grass count and length are baked into each blade at creation, so
    // those two rebuild the field on change; everything else is read fresh every frame and
    // doesn't need a rebuild.
    const rebuildGrass = () => buildGrassField(CELL_COUNT, CELL_COUNT);
    const grassSliders = [
        { id: 'sl-grass-count',   valId: 'vl-grass-count',   key: 'snake_grass_count',   def: 7,   pct: false, rebuild: true,
          apply: v => { grassPerCell = v; } },
        { id: 'sl-grass-len',     valId: 'vl-grass-len',     key: 'snake_grass_len',     def: 100, pct: true,  rebuild: true,
          apply: v => { grassLenScale = v / 100; } },
        { id: 'sl-grass-width',   valId: 'vl-grass-width',   key: 'snake_grass_width',   def: 100, pct: true,  rebuild: false,
          apply: v => { grassWidthScale = v / 100; } },
        { id: 'sl-grass-outline', valId: 'vl-grass-outline', key: 'snake_grass_outline', def: 100, pct: true,  rebuild: false,
          apply: v => { grassOutlineScale = v / 100; } },
        { id: 'sl-snake-outline', valId: 'vl-snake-outline', key: 'snake_body_outline',  def: 100, pct: true,  rebuild: false,
          apply: v => { snakeOutlineScale = v / 100; } },
    ];
    for (const s of grassSliders) {
        const el  = document.getElementById(s.id);
        const val = document.getElementById(s.valId);
        const saved = parseInt(localStorage.getItem(s.key) || String(s.def), 10);
        el.value = saved;
        val.textContent = s.pct ? `${saved}%` : String(saved);
        s.apply(saved);
        el.addEventListener('input', () => {
            const v = parseInt(el.value, 10);
            val.textContent = s.pct ? `${v}%` : String(v);
            localStorage.setItem(s.key, String(v));
            s.apply(v);
            if (s.rebuild) rebuildGrass();
        });
    }
    const grassResetBtn = document.getElementById('btn-grass-reset');
    if (grassResetBtn) grassResetBtn.addEventListener('click', () => {
        for (const s of grassSliders) {
            document.getElementById(s.id).value = s.def;
            document.getElementById(s.valId).textContent = s.pct ? `${s.def}%` : String(s.def);
            localStorage.setItem(s.key, String(s.def));
            s.apply(s.def);
        }
        rebuildGrass();
    });

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

    updateAdvancedUI();

    buildBackground(CELL_COUNT, CELL_COUNT);
    buildGrassField(CELL_COUNT, CELL_COUNT); // so the title screen isn't bare before the first game starts
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
    const extraH = (ph ? ph.offsetHeight : 0)
                 + (hud && hud.classList.contains('visible') ? hud.offsetHeight : 0);
    const size = Math.min(area.clientWidth, area.clientHeight - sb.offsetHeight - extraH - 10, MAX_CANVAS);
    canvas.width = canvas.height = Math.max(size, 0);
}

// ── Controls ──────────────────────────────────────────────────
const GAMEOVER_INPUT_LOCK_MS = 1000; // ignore restart input right after death so it can't be swiped away instantly
function gameOverLocked() {
    return gameState === 'over' && performance.now() - deathTime < GAMEOVER_INPUT_LOCK_MS;
}

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
            if (gameOverLocked()) { e.preventDefault(); break; }
            ensureAudio(); startGame(); e.preventDefault();
            break;
    }
}

const HOLD_BOOST_DELAY = 130; // ms — a quick tap/swipe shouldn't trigger a burst of sprint speed
let holdBoostTimer = null;

function setupTouch() {
    let sx = 0, sy = 0;
    document.addEventListener('touchstart', e => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY;
        // Sprint — advanced mode only, and only once picked (see ABILITY_CFG.sprint).
        if (gameState === 'running' && gameMode === 'advanced' && abilityLevels.sprint > 0) {
            clearTimeout(holdBoostTimer);
            holdBoostTimer = setTimeout(() => { holdBoost = true; }, HOLD_BOOST_DELAY);
        }
    }, { passive: true });
    document.addEventListener('touchcancel', () => { clearTimeout(holdBoostTimer); holdBoost = false; }, { passive: true });
    document.addEventListener('touchend', e => {
        clearTimeout(holdBoostTimer);
        holdBoost = false;
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (optionsOpen) { toggleOptions(); return; }
        if (gameOverLocked()) return;
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
    // Fresh every game, not just when the grid size changes — that's what makes it new each time.
    buildBackground(CELL_COUNT, CELL_COUNT);
    buildGrassField(CELL_COUNT, CELL_COUNT);
    const mid = Math.floor(CELL_COUNT / 2);
    snake     = [{ x:mid, y:mid }, { x:mid-1, y:mid }, { x:mid-2, y:mid }, { x:mid-3, y:mid }, { x:mid-4, y:mid }];
    prevSnake = snake.map(s => ({ x: s.x, y: s.y }));
    renderSnake = snake;
    digestingFood = [];
    dir       = 'right'; nextDir = 'right';
    score     = 0; tickMs = BASE_MS; deathTime = 0; foodPulse = 0;
    lungeQueue = 0; lungePauseUntil = 0; tongueFlickBorn = -Infinity;
    fly = null; flyPrev = null; flyUntil = 0; flyTimer = 0; flyRegion = null; flyEntering = false; flyExiting = false; stopFlyBuzz();
    holdBoost = false;
    gameState = 'entering';
    enterSlideX = -canvas.width;
    enterStart  = performance.now();

    xp = 0; xpLevel = 1; levelUpQueue = 0; levelUpOpen = false; levelUpChoices = []; armorCharges = 0;
    abilityLevels    = { sprint:0, dash:0, tongue:0, slowtime:0, sidekick:0, armor:0, magnet:0, ring:0 };
    abilityCooldowns = { dash:0, tongue:0, slowtime:0 };
    tongue = null; tongueVisUntil = 0; babySnake = []; babyUntil = 0; slowUntil = 0;
    bonusFood = null;
    particles = []; scorePops = []; shakeMag = 0;
    document.getElementById('levelup-overlay').classList.add('hidden');

    updateScoreDisplay();
    updateAdvancedHUD();
    updatePauseBtn();
    spawnFood();
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

function spawnBonusFood() {
    const occ = new Set(snake.map(s => `${s.x},${s.y}`));
    occ.add(`${food.x},${food.y}`);
    babySnake.forEach(s => occ.add(`${s.x},${s.y}`));
    const free = [];
    for (let x = 0; x < CELL_COUNT; x++)
        for (let y = 0; y < CELL_COUNT; y++)
            if (!occ.has(`${x},${y}`)) free.push({ x, y });
    if (!free.length) return;
    bonusFood = free[Math.floor(Math.random() * free.length)];
    bonusFoodType = FOOD_TYPES[Math.floor(Math.random() * FOOD_TYPES.length)];
    bonusFoodSpawnTime = performance.now();
}

function tick() {
    prevSnake = snake.map(s => ({ x: s.x, y: s.y }));
    const cell = canvas.width / CELL_COUNT;
    dir = nextDir;
    const nx = snake[0].x + (dir==='right'?1: dir==='left'?-1:0);
    const ny = snake[0].y + (dir==='down' ?1: dir==='up'  ?-1:0);
    if (nx < 0 || nx >= CELL_COUNT || ny < 0 || ny >= CELL_COUNT) {
        const ix = snake[0].x*cell + cell/2 + (dir==='right'?cell/2: dir==='left'?-cell/2:0);
        const iy = snake[0].y*cell + cell/2 + (dir==='down' ?cell/2: dir==='up'  ?-cell/2:0);
        if (gameMode === 'advanced' && armorCharges > 0) {
            armorCharges--; spawnArmorBreak(ix, iy); vibrate(40); shakeMag = 6;
            return;
        }
        die('wall', ix, iy);
        return;
    }
    if (snake.slice(0,-1).some(s => s.x===nx && s.y===ny)) {
        if (gameMode === 'advanced' && armorCharges > 0) {
            const hx = snake[0].x*cell+cell/2, hy = snake[0].y*cell+cell/2;
            armorCharges--; spawnArmorBreak(hx, hy); vibrate(40); shakeMag = 6;
            return;
        }
        die('self'); return;
    }

    // Digesting food travels toward the tail as a physical piece of the body — every tick
    // shifts each body identity back one array slot (a new head gets prepended), so bump
    // segIndex here, before that shift happens, then add this tick's own swallow at 0 below.
    for (const b of digestingFood) b.segIndex++;

    const eating = nx===food.x && ny===food.y;
    if (eating && snake[snake.length-1].x===nx && snake[snake.length-1].y===ny) { die(); return; }
    const eatX = food.x * cell + cell/2, eatY = food.y * cell + cell/2;
    snake.unshift({ x:nx, y:ny });
    spawnDebris(cell);

    // The main snake can grab the sidekick's bonus fruit too if it happens to path over it —
    // it doesn't grow you (that's what the main food is for), just score+XP, same as Magnet.
    if (gameMode === 'advanced' && bonusFood) collectFoodAt(nx, ny, bonusFood, spawnBonusFood);

    // Fly catch — grows snake, +FLY_POINTS
    let flyEaten = false;
    if (fly && nx === fly.x && ny === fly.y) {
        flyEaten = true;
        score += FLY_POINTS;
        if (score > highScore) highScore = score;
        updateScoreDisplay(); sfxFlyCatch(); vibrate([15,10,15]);
        scorePops.push({ x: nx*cell+cell/2, y: ny*cell+cell/2, born: performance.now(), val: `+${FLY_POINTS}` });
        stopFlyBuzz(); fly = null;
        digestingFood.push({ segIndex: 0 });
        if (gameMode === 'advanced') gainXP(3);
    }

    if (eating) {
        score += 1;
        if (score > highScore) highScore = score;
        tickMs = Math.max(MIN_MS, BASE_MS - (snake.length-3) * SPEED_STEP);
        updateScoreDisplay(); sfxEat(); vibrate(25); spawnFood();
        shakeMag = 3;
        tongueFlickBorn = performance.now();
        scorePops.push({ x: eatX, y: eatY, born: performance.now() });
        digestingFood.push({ segIndex: 0 });
        if (gameMode === 'advanced') gainXP(1);
        if (!fly && Math.random() < FLY_SPAWN_CHANCE) spawnFly();
    } else if (!flyEaten) { snake.pop(); }
    digestingFood = digestingFood.filter(b => b.segIndex < snake.length);

    // The whole body disturbs grass as it glides through, not just the leading edge —
    // each segment's own movement this tick (its prevSnake position to its new one, same
    // pairing the render interpolation uses) bends the grass under it. A freshly-grown
    // tail segment has no prevSnake counterpart and didn't move, so it's skipped.
    if (grassEnabled) {
        for (let i = 0; i < snake.length; i++) {
            const p = i < prevSnake.length ? prevSnake[i] : snake[i];
            const s = snake[i];
            const gdx = s.x - p.x, gdy = s.y - p.y;
            if (gdx || gdy) bendGrassAt(s.x, s.y, gdx, gdy);
        }
    }

    // Auto-triggering abilities — Sprint/Dash keep their gesture triggers (see setupTouch/
    // tryLunge), everything else fires on its own once picked.
    if (gameMode === 'advanced') {
        if (abilityLevels.tongue > 0 && performance.now() >= abilityCooldowns.tongue) {
            activateTongue(abilityLevels.tongue);
        }
        if (abilityLevels.slowtime > 0 && performance.now() >= abilityCooldowns.slowtime) {
            activateSlowTime(abilityLevels.slowtime);
        }
        if (abilityLevels.magnet > 0) {
            const mr = ABILITY_CFG.magnet.radius[abilityLevels.magnet - 1];
            const d  = Math.max(Math.abs(food.x - snake[0].x), Math.abs(food.y - snake[0].y));
            if (d > 0 && d <= mr) collectFoodAt(food.x, food.y, food, spawnFood);
            if (bonusFood) {
                const d2 = Math.max(Math.abs(bonusFood.x - snake[0].x), Math.abs(bonusFood.y - snake[0].y));
                if (d2 > 0 && d2 <= mr) collectFoodAt(bonusFood.x, bonusFood.y, bonusFood, spawnBonusFood);
            }
        }
        if (abilityLevels.sidekick > 0) {
            if (babySnake.length === 0 || performance.now() >= babyUntil) activateBabySnake(abilityLevels.sidekick);
            else tickBabySnake();
        }
    }
}

function spawnWallImpact(x, y) {
    const n = 16;
    const colors = ['#ffe066', '#ff8844', '#ff5544', '#ffffff'];
    for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.5;
        const speed = 1.8 + Math.random() * 3.2;
        particles.push({
            x, y,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1.5,
            life: 1, decay: 0.028 + Math.random() * 0.02,
            size: 3 + Math.random() * 4.5,
            color: colors[Math.floor(Math.random() * colors.length)],
            kind: 'impact', // drawn after the snake, for a punchy death effect (see draw())
        });
    }
}

// Armor's charge-consumed cue — a small cyan/white burst, distinct from the death explosion
// (spawnWallImpact) so surviving a hit doesn't read as if the snake just died.
function spawnArmorBreak(x, y) {
    const n = 10;
    const colors = ['#66ddff', '#aaeeff', '#ffffff'];
    for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n;
        const speed = 1.5 + Math.random() * 2.5;
        particles.push({
            x, y,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1,
            life: 1, decay: 0.035 + Math.random() * 0.02,
            size: 3 + Math.random() * 3.5,
            color: colors[Math.floor(Math.random() * colors.length)],
            kind: 'impact',
        });
    }
}

function die(reason = 'self', ix, iy) {
    lungeQueue = 0; holdBoost = false;
    gameState = 'over'; deathTime = performance.now();
    if (score > highScore) { highScore = score; updateScoreDisplay(); }
    saveProfileHighScore();
    babySnake = []; tongue = null; slowUntil = 0;
    fly = null; flyPrev = null; flyRegion = null; flyEntering = false; flyExiting = false; stopFlyBuzz();
    if (reason === 'wall') { shakeMag = 9; spawnWallImpact(ix, iy); }
    else { shakeMag = 5; }
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

// How many steps a dash would take to reach food right now (0 = no target in range) — shared
// by tryLunge() (actually triggers it) and dashReady() (just checks, for the on-screen ring
// indicator letting the player know a tap would connect before they commit to one).
function dashTargetSteps() {
    if (gameMode !== 'advanced' || abilityLevels.dash === 0 || !snake.length) return 0;
    const level    = abilityLevels.dash;
    const maxRange = Math.min(ABILITY_CFG.dash.maxRange[level-1], CELL_COUNT - 1);
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    for (let i = 1; i <= maxRange; i++) {
        const tx = snake[0].x + ddx*i;
        const ty = snake[0].y + ddy*i;
        if (tx < 0 || tx >= CELL_COUNT || ty < 0 || ty >= CELL_COUNT) break;
        if (tx === food.x && ty === food.y) return i;
    }
    return 0;
}

// True when a Dash tap right now would actually connect — off cooldown AND food within this
// level's range along the current heading. Drives the pulsing ready-ring around the head.
function dashReady() {
    return gameMode === 'advanced' && abilityLevels.dash > 0
        && performance.now() >= abilityCooldowns.dash
        && dashTargetSteps() > 0;
}

// Dash — advanced mode only, and only once picked (see ABILITY_CFG.dash). Its own cooldown
// (abilityCooldowns.dash) gates re-use; range is capped per level instead of always scanning
// the whole board.
function tryLunge() {
    if (gameState !== 'running' || levelUpOpen || lungeQueue > 0) return;
    if (gameMode !== 'advanced' || abilityLevels.dash === 0) return;
    const now = performance.now();
    if (now < abilityCooldowns.dash) return;
    const steps = dashTargetSteps();
    if (steps === 0) return;
    lungeQueue = steps;
    lastTick = now - 35; // fire first step immediately
    abilityCooldowns.dash = now + ABILITY_CFG.dash.cooldowns[abilityLevels.dash-1];
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
    flyPrev = { x: fly.x, y: fly.y };
    fly.x += dx; fly.y += dy;
}

// Instead of just vanishing when its lifetime is up, the fly flies off toward whichever
// screen edge is nearest to where it currently is.
function startFlyExit(now) {
    flyExiting = true;
    flyExitStart = now;
    const cell = canvas.width / CELL_COUNT;
    const size = canvas.width;
    const fx = fly.x * cell + cell/2, fy = fly.y * cell + cell/2;
    flyExitFrom = { x: fx, y: fy };
    const distLeft = fx, distRight = size - fx, distTop = fy, distBottom = size - fy;
    const minDist = Math.min(distLeft, distRight, distTop, distBottom);
    flyExitTo = minDist === distLeft   ? { x: -cell,     y: fy }
              : minDist === distRight  ? { x: size+cell, y: fy }
              : minDist === distTop    ? { x: fx,        y: -cell }
              :                          { x: fx,        y: size+cell };
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
    if (flyExiting) {
        const t = Math.min(1, (now - flyExitStart) / FLY_EXIT_DUR);
        const ease = t * t; // accelerate away, like darting off startled
        fx = flyExitFrom.x + (flyExitTo.x - flyExitFrom.x) * ease;
        fy = flyExitFrom.y + (flyExitTo.y - flyExitFrom.y) * ease;
    } else if (flyEntering) {
        const t = Math.min(1, (now - flyEnterStart) / FLY_ENTER_DUR);
        const ease = 1 - Math.pow(1-t, 2);
        fx = flyEnterFrom.x + (fly.x*cell+cell/2 - flyEnterFrom.x) * ease;
        fy = flyEnterFrom.y + (fly.y*cell+cell/2 - flyEnterFrom.y) * ease;
        if (t >= 1) flyEntering = false;
    } else {
        // Slide from its previous cell to its current one instead of snapping, same idea
        // as the snake's continuous movement.
        const t  = Math.max(0, Math.min(1, (now - flyTimer) / FLY_MOVE_MS));
        const px = flyPrev ? flyPrev.x : fly.x, py = flyPrev ? flyPrev.y : fly.y;
        fx = (px + (fly.x - px) * t) * cell + cell/2;
        fy = (py + (fly.y - py) * t) * cell + cell/2;
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
    ctx.strokeStyle = 'rgba(10,10,20,0.5)';
    ctx.lineWidth = Math.max(1, r*0.09);
    ctx.beginPath();
    ctx.ellipse(fx - r*1.05, fy + wingLift, r*1.15, r*0.62, -0.28, 0, Math.PI*2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(fx + r*1.05, fy + wingLift, r*1.15, r*0.62, 0.28, 0, Math.PI*2);
    ctx.stroke();

    // Body
    ctx.fillStyle = '#1e1e1e';
    ctx.beginPath();
    ctx.ellipse(fx, fy, r*0.72, r*1.15, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = Math.max(1, r*0.14);
    ctx.stroke();

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
    if (gameState === 'running' && !levelUpOpen) {
        if (lungeQueue > 0) {
            if (now - lastTick >= 35) {
                lastTick = now; curEffMs = 35; tick(); lungeQueue--;
                // Don't also shove lastTick into the future here — that skipped the final
                // lunge step's interpolation entirely (an instant snap-to-place "glitch"
                // right as the lunge finished). now >= lungePauseUntil below still enforces
                // the post-lunge breather on its own.
                if (lungeQueue === 0) { lungePauseUntil = now + 350; }
            }
        } else {
            let effMs = tickMs;
            if (holdBoost) {
                const l = abilityLevels.sprint;
                effMs = Math.max(MIN_MS * ABILITY_CFG.sprint.floorMult[l-1], tickMs * ABILITY_CFG.sprint.factor[l-1]);
            } else if (gameMode === 'advanced' && now < slowUntil) effMs = tickMs * 2.5;
            // Weighted Ring — a flat drag on top of whatever speed state is active (base,
            // Sprint, or Slow Time), traded for bonus XP (see gainXP()).
            if (gameMode === 'advanced' && abilityLevels.ring > 0) {
                effMs *= ABILITY_CFG.ring.slowFactor[abilityLevels.ring - 1];
            }
            // curEffMs (used for render interpolation) only latches when a tick actually
            // fires — recomputing it every frame let holdBoost/slowtime toggling mid-slide
            // retroactively shrink the interval and made the snake visibly jump forward.
            if (now - lastTick >= effMs && now >= lungePauseUntil) { lastTick = now; curEffMs = effMs; tick(); }
        }
    }
    updateRenderSnake(now);
    updateGrassTransitions();
    updateGrassWiggle();
    // Snake slide-in intro
    if (gameState === 'entering') {
        const t = Math.min(1, (now - enterStart) / ENTER_DUR);
        enterSlideX = -canvas.width * (1 - (1 - Math.pow(1-t, 3)));
        if (t >= 1) { enterSlideX = 0; gameState = 'running'; lastTick = now; startMusic(); }
    }
    // Fly movement + despawn (independent of snake tick rate)
    if (fly && gameState === 'running' && !levelUpOpen) {
        if (flyExiting) {
            if (now - flyExitStart >= FLY_EXIT_DUR) {
                stopFlyBuzz(); fly = null; flyRegion = null; flyExiting = false;
            }
        } else {
            if (now - flyTimer >= FLY_MOVE_MS) { flyTimer = now; moveFly(); }
            if (now >= flyUntil) startFlyExit(now);
        }
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
    if (bgCanvas) {
        ctx.drawImage(bgCanvas, 0, 0, bgCanvas.width, bgCanvas.height, 0, 0, size, size);
    } else {
        ctx.fillStyle = '#5c4526'; ctx.fillRect(0,0,size,size);
    }
    drawGrassField(cell);

    // Grid
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= CELL_COUNT; i++) {
        ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,i*cell); ctx.lineTo(size,i*cell); ctx.stroke();
    }

    if (gameState === 'start') { ctx.restore(); drawStart(size, cell); return; }

    updateParticles();
    // Dust kicked up by movement belongs on the ground, not floating on top of the snake —
    // it used to draw after the body, so a particle freshly spawned at the head's own
    // position (every tick) sat on the body as a flat, unoutlined square for its first few
    // frames before drifting clear, which read as a rendering glitch against the outlined
    // art style everything else now uses. The death-explosion burst (spawnWallImpact) is the
    // opposite case — it should read as a punchy effect on top of things, so it's drawn
    // separately, after the snake, further down.
    drawParticles('debris');
    drawFood(cell);
    drawFly(cell);
    if (gameMode === 'advanced') {
        if (tongue && performance.now() < tongueVisUntil) drawTongue(cell);
        if (babySnake.length > 0) drawBabySnake(cell);
        if (dashReady()) drawDashReady(cell);
    }
    if (gameState === 'entering') { ctx.save(); ctx.translate(enterSlideX, 0); }
    drawSnakeSmooth(cell);
    drawTongueFlick(cell);
    if (gameState === 'entering') ctx.restore();
    drawParticles('impact');
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
    ctx.font=`bold ${Math.max(15,Math.floor(cell*0.6))}px monospace`;
    ctx.textAlign='right'; ctx.textBaseline='bottom';
    ctx.lineJoin='round';
    ctx.lineWidth=3;
    ctx.strokeStyle='rgba(0,0,0,0.65)';
    ctx.strokeText(VERSION, size-6, size-4);
    ctx.fillStyle='rgba(255,255,255,0.92)';
    ctx.fillText(VERSION, size-6, size-4);
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
    foodPulse += 0.055; // shared bounce/pulse clock for both fruits — advanced once per frame here
    drawFruit(cell, food, foodType, foodSpawnTime, false);
    if (gameMode === 'advanced' && bonusFood) drawFruit(cell, bonusFood, bonusFoodType, bonusFoodSpawnTime, true);
}

// isBonus: smaller + a purple glow ring, so the Sidekick's dedicated target reads as visually
// distinct from the main food rather than a second identical fruit.
function drawFruit(cell, obj, type, spawnTime, isBonus) {
    const bob  = Math.sin(foodPulse * 1.4) * cell * 0.09;
    const p    = Math.sin(foodPulse) * 0.09 + 0.91;
    const bt   = Math.min(1, (performance.now() - spawnTime) / FOOD_BOUNCE_DUR);
    const fx   = obj.x*cell + cell/2;
    const fy   = obj.y*cell + cell/2 + bob + foodBounceOffset(bt) * cell;
    const r    = (cell/2 - 1.5) * p * (isBonus ? 0.78 : 1);
    const shadowFrac = (bob + cell*0.09) / (cell*0.18);
    ctx.fillStyle = `rgba(0,0,0,${0.22 - shadowFrac*0.10})`;
    ctx.beginPath();
    ctx.ellipse(obj.x*cell+cell/2, obj.y*cell+cell*0.88, r*(0.7+shadowFrac*0.2), r*0.28, 0, 0, Math.PI*2);
    ctx.fill();
    if (isBonus) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
        ctx.strokeStyle = `rgba(170,60,220,${0.45 + 0.3*pulse})`;
        ctx.lineWidth = Math.max(1.5, cell*0.05);
        ctx.beginPath(); ctx.arc(fx, fy, r*1.4, 0, Math.PI*2); ctx.stroke();
    }
    switch (type) {
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
    ctx.strokeStyle = 'rgba(15,5,0,0.85)'; ctx.lineWidth = Math.max(1.5, r*0.12);
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.stroke();
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
    ctx.strokeStyle = 'rgba(20,0,5,0.85)'; ctx.lineWidth = Math.max(1.5, r*0.12);
    ctx.beginPath(); ctx.ellipse(fx, fy+r*0.05, r, r, 0, 0, Math.PI*2); ctx.stroke();
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
    ctx.strokeStyle = 'rgba(5,20,5,0.85)'; ctx.lineWidth = Math.max(1.5, r*0.12);
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.stroke();
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
        ctx.strokeStyle = 'rgba(20,0,0,0.85)'; ctx.lineWidth = Math.max(1.5, cr*0.16);
        ctx.beginPath(); ctx.arc(cx, by, cr, 0, Math.PI*2); ctx.stroke();
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
    ctx.strokeStyle = 'rgba(15,0,25,0.85)'; ctx.lineWidth = Math.max(1.5, r*0.12);
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI*2); ctx.stroke();
}

function drawTongueFlick(cell) {
    const age = performance.now() - tongueFlickBorn;
    if (age > 750 || !renderSnake.length) return;
    const t = age / 750;
    const phase = (t * 2) % 1;
    const ext = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    if (ext < 0.02) return;
    const hw  = cell / 2;
    const hx  = renderSnake[0].x * cell + hw;
    const hy  = renderSnake[0].y * cell + hw;
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

// Mouth opens as the snake closes in on food it's heading straight toward —
// 0 while food isn't dead ahead or is more than MOUTH_OPEN_DIST cells out, 1 when adjacent.
const MOUTH_OPEN_DIST = 4;
function mouthOpenAmount() {
    if (!snake.length) return 0;
    const head = snake[0];
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    let dist;
    if (ddx !== 0) { if (food.y !== head.y) return 0; dist = (food.x - head.x) * ddx; }
    else if (ddy !== 0) { if (food.x !== head.x) return 0; dist = (food.y - head.y) * ddy; }
    else return 0;
    if (dist <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - (dist - 1) / (MOUTH_OPEN_DIST - 1)));
}

function drawMouth(cell) {
    if (gameState !== 'running') return;
    const amt = mouthOpenAmount();
    if (amt <= 0.02) return;
    const hw = cell / 2;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    const px  = -ddy, py = ddx;
    const rLong = cell * 0.70, rShort = cell * 0.44;
    const hcx = renderSnake[0].x*cell+hw + ddx*cell*0.20;
    const hcy = renderSnake[0].y*cell+hw + ddy*cell*0.20;

    const tipX  = hcx + ddx*rLong*0.98, tipY  = hcy + ddy*rLong*0.98;
    const backX = hcx + ddx*rLong*(0.98 - 0.95*amt), backY = hcy + ddy*rLong*(0.98 - 0.95*amt);
    const halfW = rShort * 1.15 * amt;

    ctx.save();
    ctx.fillStyle = '#8a2438';
    ctx.beginPath();
    ctx.moveTo(backX, backY);
    ctx.lineTo(tipX + px*halfW, tipY + py*halfW);
    ctx.quadraticCurveTo(tipX + ddx*rLong*0.08, tipY + ddy*rLong*0.08, tipX - px*halfW, tipY - py*halfW);
    ctx.closePath();
    ctx.fill();
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

// Pulsing gold ring around the head while a Dash tap right now would actually connect —
// otherwise there's no way to tell whether a tap will do anything before committing to it.
function drawDashReady(cell) {
    if (!renderSnake.length) return;
    const hw = cell / 2;
    const hx = renderSnake[0].x*cell+hw, hy = renderSnake[0].y*cell+hw;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);
    ctx.save();
    ctx.strokeStyle = `rgba(255,220,60,${0.55 + 0.35*pulse})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.08);
    ctx.beginPath();
    ctx.arc(hx, hy, cell*0.85 + pulse*cell*0.12, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
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

// A scaled-down version of the main snake's own look (body stroke + black outline + head
// ellipse + simple eyes) rather than a separate purple-block sprite — reads as "a smaller
// snake helping out" instead of a generic marker.
const SIDEKICK_SCALE = 0.6;
function drawBabySnake(cell) {
    if (babySnake.length < 2) return;
    const tRem  = babyUntil - performance.now();
    const alpha = Math.max(0, Math.min(1, tRem / 2000));
    if (alpha <= 0) return;
    const hw     = cell / 2;
    const bodyW  = cell * 0.72 * SIDEKICK_SCALE;
    const head   = babySnake[0], neck = babySnake[1];
    const ddx    = Math.sign(head.x - neck.x) || 1;
    const ddy    = Math.sign(head.y - neck.y) || 0;
    const angle  = Math.atan2(ddy, ddx);
    const rLong  = cell * 0.70 * SIDEKICK_SCALE, rShort = cell * 0.44 * SIDEKICK_SCALE;
    const hcx = head.x*cell+hw + ddx*cell*0.20*SIDEKICK_SCALE;
    const hcy = head.y*cell+hw + ddy*cell*0.20*SIDEKICK_SCALE;

    function path() {
        ctx.beginPath();
        ctx.moveTo(babySnake[0].x*cell+hw, babySnake[0].y*cell+hw);
        for (let i = 1; i < babySnake.length; i++)
            ctx.lineTo(babySnake[i].x*cell+hw, babySnake[i].y*cell+hw);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // Black outline (same double-stroke trick as the main snake)
    path();
    ctx.strokeStyle = 'rgba(8,8,8,0.92)';
    ctx.lineWidth = bodyW + Math.max(1.5, cell*0.10*SIDEKICK_SCALE);
    ctx.stroke();

    // Body
    path();
    ctx.strokeStyle = '#278a27';
    ctx.lineWidth = bodyW;
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.ellipse(hcx, hcy, rLong, rShort, angle, 0, Math.PI*2);
    ctx.fillStyle = '#339933';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = Math.max(1, cell*0.055*SIDEKICK_SCALE);
    ctx.stroke();

    // Simple eyes
    const px = -ddy, py = ddx;
    const fwd = cell*0.28*SIDEKICK_SCALE, side = cell*0.25*SIDEKICK_SCALE;
    const er  = Math.max(1, cell*0.11*SIDEKICK_SCALE);
    ctx.fillStyle = '#001500';
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(hcx + ddx*fwd + px*side*s, hcy + ddy*fwd + py*side*s, er, 0, Math.PI*2);
        ctx.fill();
    }

    ctx.restore();
}

// Dirt patches kick up dust squares; everywhere else (i.e. grass) kicks up little flying
// blade-shaped clippings instead — reads as the snake actually disturbing the grass it's
// gliding through, rather than a generic dust trail regardless of what's underfoot.
function spawnDebris(cell) {
    if (!snake.length) return;
    const head = snake[0];
    if (!grassEnabled || onDirt(head.x + 0.5, head.y + 0.5)) {
        const angle = DEBRIS_ANGLE[dir] + (Math.random()-0.5)*1.4;
        const speed = cell * (0.05 + Math.random() * 0.08);
        particles.push({
            x: head.x*cell + cell/2, y: head.y*cell + cell/2,
            vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed - cell*0.02,
            life: 1, decay: 0.030 + Math.random()*0.025,
            size: cell*(0.18 + Math.random()*0.20),
            color: DEBRIS_COLORS[Math.floor(Math.random()*DEBRIS_COLORS.length)],
            shape: 'square',
            kind: 'debris', // drawn on the ground layer, under the snake (see draw())
        });
        return;
    }
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
        const angle = DEBRIS_ANGLE[dir] + (Math.random()-0.5)*1.9;
        const speed = cell * (0.06 + Math.random() * 0.11);
        particles.push({
            x: head.x*cell + cell/2 + (Math.random()-0.5)*cell*0.4,
            y: head.y*cell + cell/2 + (Math.random()-0.5)*cell*0.4,
            vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed - cell*0.04,
            life: 1, decay: 0.024 + Math.random()*0.018,
            size: cell*(0.22 + Math.random()*0.22) * grassLenScale,
            color: GRASS_FLECK_COLORS[Math.floor(Math.random()*GRASS_FLECK_COLORS.length)],
            shape: 'blade',
            rot: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random()-0.5) * 0.5,
            kind: 'debris', // drawn on the ground layer, under the snake (see draw())
        });
    }
}

// Physics only, once per frame regardless of how many kinds get drawn — drawParticles()
// below is called twice (debris under the snake, impact bursts on top of it) and must not
// double-update the same particles.
function updateParticles() {
    for (let i = particles.length-1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.life -= p.decay;
        if (p.rotSpeed) p.rot += p.rotSpeed;
        if (p.life <= 0) particles.splice(i, 1);
    }
}

function drawParticles(kind) {
    for (const p of particles) {
        if (p.kind !== kind) continue;
        ctx.globalAlpha = p.life * 0.85;
        if (p.shape === 'blade') {
            // A short flying grass-blade sliver, spinning as it flies off — reads as a
            // clipping of the grass being disturbed rather than generic dust. Sized and
            // outlined with the same grassWidthScale/grassOutlineScale sliders as the field
            // itself (grassLenScale is baked into p.size at spawn time) so it's one set of
            // debug dials for both, and so it actually reads against the field instead of
            // blending into it as a bare, unoutlined line.
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(-p.size*0.5, 0);
            ctx.lineTo(p.size*0.5, 0);
            const fillWidth = Math.max(1.5, p.size * 0.32 * grassWidthScale);
            const outlinePad = grassOutlineScale > 0 ? Math.max(1, p.size * 0.16 * grassOutlineScale) : 0;
            if (outlinePad > 0) {
                ctx.strokeStyle = 'rgba(15,15,15,0.88)';
                ctx.lineWidth = fillWidth + outlinePad;
                ctx.stroke();
            }
            ctx.strokeStyle = p.color;
            ctx.lineWidth = fillWidth;
            ctx.stroke();
            ctx.restore();
        } else {
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
        }
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

// Swallowed food renders as a shrinking bulge riding along renderSnake toward the tail —
// same color as the body (this is skin stretching over something, not a colored blob), but
// with its own dark outline so it reads as a raised shape rather than blending flat into the
// body fill. Sized to clearly overflow the body's silhouette near the head (roughly 1.5x the
// body's half-width at segIndex 0), shrinking back under it before it reaches the tail. Drawn
// from drawSnakeSmooth AFTER the scales/highlight stripe so those don't wash it out, and the
// segIndex===0 case is expected to start out mostly under the head — like a real swallow —
// then clearly pop out from behind it within a tick or two as it's carried backward.
function drawDigestion(cell, bodyW) {
    if (!digestingFood.length || !renderSnake.length) return;
    const hw = cell / 2;
    const span = Math.max(1, renderSnake.length - 1);
    ctx.save();
    for (const b of digestingFood) {
        if (b.segIndex < 0 || b.segIndex >= renderSnake.length) continue;
        const seg  = renderSnake[b.segIndex];
        const frac = Math.max(0, 1 - b.segIndex / (span * 0.65)); // fades out well before the tail
        if (frac <= 0) continue;
        const r = bodyW / 2 * (1 + 0.9 * frac); // clearly overflows the body width near the head
        const x = seg.x*cell+hw, y = seg.y*cell+hw;
        ctx.fillStyle = '#278a27'; // same green as the body — a shape, not a color
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.88, 0, 0, Math.PI*2);
        ctx.fill();
        // black outline gives the bulge a firm edge to read against the body fill, matching
        // the cartoon-outline style used elsewhere (grass, snake, fruit, stones, fly)
        ctx.strokeStyle = 'rgba(8,8,8,0.85)';
        ctx.lineWidth = Math.max(1.5, cell * 0.06);
        ctx.stroke();
        // highlight for a bit of roundness, same treatment as the head's
        ctx.fillStyle = 'rgba(140,255,100,0.20)';
        ctx.beginPath();
        ctx.ellipse(x, y - r*0.15, r*0.5, r*0.45, 0, 0, Math.PI*2);
        ctx.fill();
    }
    ctx.restore();
}

function drawSnakeSmooth(cell) {
    if (!renderSnake.length) return;
    const rs    = renderSnake;
    const hw    = cell / 2;
    const bodyW = cell * 0.72;
    const ddx = dir==='right'?1: dir==='left'?-1:0;
    const ddy = dir==='down' ?1: dir==='up'  ?-1:0;
    const headOffset = cell * 0.20;
    const rLong      = cell * 0.70;
    const rShort     = cell * 0.44;
    const headAngle  = Math.atan2(ddy, ddx);
    const hcx = rs[0].x*cell+hw + ddx*headOffset;
    const hcy = rs[0].y*cell+hw + ddy*headOffset;

    // Body is constant width the whole way — the tail just ends in the stroke's own round
    // cap (lineCap: 'round' below), same as classic Snake's rounded tail end. No taper.
    function path() {
        ctx.beginPath();
        ctx.moveTo(rs[0].x*cell+hw, rs[0].y*cell+hw);
        for (let i = 1; i < rs.length; i++)
            ctx.lineTo(rs[i].x*cell+hw, rs[i].y*cell+hw);
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

    // Black outline — a wider black silhouette drawn behind the body+head, which the
    // normal-width fills below then cover everything but a border, same double-shape trick
    // used for the grass outline.
    if (snakeOutlineScale > 0) {
        const outlinePad = Math.max(2, cell * 0.10 * snakeOutlineScale);
        path();
        ctx.strokeStyle = 'rgba(8,8,8,0.92)';
        ctx.lineWidth = bodyW + outlinePad * 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(hcx, hcy, rLong + outlinePad, rShort + outlinePad, headAngle, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(8,8,8,0.92)';
        ctx.fill();
    }

    // Body base
    path();
    ctx.strokeStyle = '#278a27';
    ctx.lineWidth = bodyW;
    ctx.stroke();

    // Scales — quadratic bezier arcs across body, bowing toward tail.
    {
        const halfH  = bodyW * 0.34; // half-span across body
        const bowAmt = cell * 0.12;  // how far the curve bows toward tail
        ctx.save();
        ctx.strokeStyle = 'rgba(10, 55, 10, 0.30)';
        ctx.lineWidth   = Math.max(1.5, cell * 0.08);
        ctx.lineCap     = 'round';
        const last = rs.length - 1;
        for (let i = 0; i < last; i++) {
            const x0  = rs[i].x     * cell + hw, y0  = rs[i].y     * cell + hw;
            const x1  = rs[i + 1].x * cell + hw, y1  = rs[i + 1].y * cell + hw;
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

    drawDigestion(cell, bodyW);

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
    drawMouth(cell);
    drawEyes(rs[0], cell);

    // Speed lines while lunging
    if (lungeQueue > 0) {
        const hw2 = cell / 2;
        const ddx2 = dir==='right'?1: dir==='left'?-1:0;
        const ddy2 = dir==='down' ?1: dir==='up'  ?-1:0;
        const px2 = -ddy2, py2 = ddx2;
        const hx2 = rs[0].x*cell + hw2, hy2 = rs[0].y*cell + hw2;
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
