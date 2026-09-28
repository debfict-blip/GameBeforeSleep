(() => {
  const ITEM_ICONS = ['🍎', '🥐', '🧀', '🥛', '🍫', '🥕', '🧃', '🍞', '🥚', '🍯', '🧻', '🥫'];
  const COLS = 6; // must match .shelf's grid-template-columns in style.css
  const HISTORY_LIMIT = 20;
  const START_HAMMERS = 2;
  const START_UNDOS = 2;

  const KEYS = {
    level: 'gbs-level',
    stars: 'gbs-stars',
    hammers: 'gbs-hammers',
    undos: 'gbs-undos',
  };

  const shelfEl = document.getElementById('shelf');
  const winOverlay = document.getElementById('winOverlay');
  const winMessage = document.getElementById('winMessage');
  const levelNumberEl = document.getElementById('levelNumber');
  const starsNumberEl = document.getElementById('starsNumber');
  const movesNumberEl = document.getElementById('movesNumber');
  const hammerCountEl = document.getElementById('hammerCount');
  const undoCountEl = document.getElementById('undoCount');
  const hammerBtn = document.getElementById('hammerBtn');
  const undoBtn = document.getElementById('undoBtn');
  const restartBtn = document.getElementById('restartBtn');
  const nextLevelBtn = document.getElementById('nextLevelBtn');
  const fxLayer = document.getElementById('fxLayer');

  let shelf = []; // single unified board: item cells and `null` (empty) slots
  let lockedGroups = {}; // groupId -> star cost remaining to unlock
  let nextId = 1;
  let drag = null;
  let hammerActive = false;
  let moves = 0;
  let history = [];

  let currentLevel = loadInt(KEYS.level, 1);
  let stars = loadInt(KEYS.stars, 0);
  let hammers = loadInt(KEYS.hammers, START_HAMMERS);
  let undos = loadInt(KEYS.undos, START_UNDOS);

  function loadInt(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const saved = Number(raw);
    return Number.isFinite(saved) && saved >= 0 ? saved : fallback;
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {
      // storage unavailable (private mode, quota) — progress just won't persist
    }
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Difficulty ramps by widening the type variety first, then adding a
  // second (and third...) set of each type once variety hits the icon cap.
  // A few of the rarest types start locked behind a star cost, but at least
  // two types are always left unlocked so a level can always earn enough
  // stars, from its own clears alone, to pay for the rest.
  //
  // `slack` is the number of empty slots scattered in among the items: the
  // board holds exactly items.length + slack cells, and a move can only
  // drop an item into one of those empty cells (never swap two occupied
  // ones). Fewer empty cells means more shuffling to free up the spot you
  // actually need, so slack is the main difficulty knob and tapers down
  // as levels rise — floored above 1 so it stays a puzzle, not a chore.
  function levelConfig(level) {
    const types = Math.min(3 + Math.floor((level - 1) / 2), ITEM_ICONS.length);
    const setsPerType = 1 + Math.floor((level - 1) / (2 * ITEM_ICONS.length));
    const maxLocked = Math.max(0, types - 2);
    const lockedCount = level >= 3 ? Math.min(1 + Math.floor((level - 3) / 4), maxLocked) : 0;
    const slack = Math.max(2, 6 - Math.floor((level - 1) / 3));
    return { types, setsPerType, lockedCount, slack };
  }

  function buildShelfPool(level) {
    const { types, setsPerType, lockedCount, slack } = levelConfig(level);
    const pool = [];
    for (let t = 0; t < types; t++) {
      const locked = t >= types - lockedCount;
      const rank = locked ? t - (types - lockedCount) : -1;
      const cost = locked ? 2 * (rank + 1) : null;
      for (let s = 0; s < setsPerType * 3; s++) {
        pool.push({ type: ITEM_ICONS[t], group: locked ? t : null, cost });
      }
    }
    for (let k = 0; k < slack; k++) pool.push(null); // empty slots, scattered in by the shuffle below
    return shuffle(pool);
  }

  function newLevel(level) {
    currentLevel = level;
    save(KEYS.level, level);
    levelNumberEl.textContent = String(level);

    const pool = buildShelfPool(level);
    shelf = pool.map((p) => (p ? { id: nextId++, type: p.type, group: p.group } : null));
    lockedGroups = {};
    pool.forEach((p) => {
      if (p && p.group !== null) lockedGroups[p.group] = p.cost;
    });

    moves = 0;
    history = [];
    hammerActive = false;
    winOverlay.classList.add('hidden');
    render(); // lay out real slot elements first, so resolveTriples can read their rects
    resolveTriples(); // a fresh shuffle can spawn a triple by pure chance; clear it up front
    updateHud();
    render();
  }

  function updateHud() {
    starsNumberEl.textContent = String(stars);
    movesNumberEl.textContent = String(moves);
    hammerCountEl.textContent = String(hammers);
    undoCountEl.textContent = String(undos);
    hammerBtn.classList.toggle('active', hammerActive);
    hammerBtn.disabled = hammers <= 0;
    undoBtn.disabled = undos <= 0 || history.length === 0;
  }

  function isLocked(cell) {
    return cell && cell.group !== null && lockedGroups[cell.group] !== undefined;
  }

  // FLIP-style motion: capture each item's on-screen position before a
  // state change, then after re-rendering, animate from the old position
  // to the new one so items glide instead of snapping.
  function captureRects() {
    const map = new Map();
    document.querySelectorAll('.item[data-id]').forEach((el) => {
      map.set(el.dataset.id, el.getBoundingClientRect());
    });
    return map;
  }

  function applyFlip(oldRects) {
    if (!oldRects) return;
    document.querySelectorAll('.item[data-id]').forEach((el) => {
      const old = oldRects.get(el.dataset.id);
      if (!old) return;
      const newRect = el.getBoundingClientRect();
      const dx = old.left - newRect.left;
      const dy = old.top - newRect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 220ms ease';
        el.style.transform = '';
      });
    });
  }

  function spawnPopGhost(rect, emoji) {
    if (!rect) return;
    const el = document.createElement('div');
    el.className = 'pop-ghost';
    el.textContent = emoji;
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  function spawnStarFloat(x, y) {
    const el = document.createElement('div');
    el.className = 'star-float';
    el.textContent = '+1⭐';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 750);
  }

  function render() {
    shelfEl.innerHTML = '';
    shelf.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = String(index);
      if (cell) {
        slot.appendChild(isLocked(cell) ? makeLockedEl(cell, index) : makeItemEl(cell, index));
      }
      shelfEl.appendChild(slot);
    });
    updateHud();
  }

  function makeItemEl(cell, index) {
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = cell.type;
    el.dataset.index = String(index);
    el.dataset.id = String(cell.id);
    el.addEventListener('pointerdown', onPointerDown);
    return el;
  }

  function makeLockedEl(cell, index) {
    const el = document.createElement('div');
    el.className = 'item locked';
    el.innerHTML = `<span class="lock-icon">🔒</span><span class="lock-cost">${lockedGroups[cell.group]}⭐</span>`;
    el.addEventListener('click', () => attemptUnlock(cell.group, el));
    return el;
  }

  function attemptUnlock(group, el) {
    const cost = lockedGroups[group];
    if (stars >= cost) {
      stars -= cost;
      save(KEYS.stars, stars);
      delete lockedGroups[group];
      render();
      shelf.forEach((cell) => {
        if (cell && cell.group === group) {
          const revealed = shelfEl.querySelector(`[data-id="${cell.id}"]`);
          if (revealed) revealed.classList.add('reveal-pop');
        }
      });
    } else if (el) {
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 320);
    }
  }

  function onPointerDown(e) {
    if (drag) return;
    const el = e.currentTarget;
    const index = Number(el.dataset.index);
    const cell = shelf[index];
    if (!cell) return;

    if (hammerActive) {
      e.preventDefault();
      const oldRects = captureRects();
      const rect = el.getBoundingClientRect();
      pushHistory();
      shelf[index] = null;
      hammers -= 1;
      hammerActive = false;
      save(KEYS.hammers, hammers);
      resolveTriples();
      checkWin();
      render();
      applyFlip(oldRects);
      spawnPopGhost(rect, cell.type);
      return;
    }

    e.preventDefault();
    el.setPointerCapture(e.pointerId);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = cell.type;
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    document.body.appendChild(ghost);

    el.classList.add('dragging-source');

    drag = {
      pointerId: e.pointerId,
      sourceIndex: index,
      el,
      ghost,
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    const oldRects = captureRects();
    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = dropTarget && dropTarget.closest('.slot');
    if (slotEl) {
      const targetIndex = Number(slotEl.dataset.index);
      attemptMove(drag.sourceIndex, targetIndex);
    }

    endDrag(oldRects);
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag();
  }

  function endDrag(oldRects) {
    drag.ghost.remove();
    drag.el.classList.remove('dragging-source');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    drag = null;
    render();
    applyFlip(oldRects);
  }

  function pushHistory() {
    history.push({
      shelf: shelf.map((c) => (c ? { ...c } : null)),
      moves,
    });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  // A move only ever drops an item into an empty (and unlocked) cell —
  // never a direct swap with an occupied one. That scarcity of empty
  // cells is the whole puzzle: freeing up the one you need takes planning.
  function attemptMove(sourceIndex, targetIndex) {
    if (sourceIndex === targetIndex) return;
    if (shelf[targetIndex]) return; // target must be empty (also blocks locked cells)

    pushHistory();
    shelf[targetIndex] = shelf[sourceIndex];
    shelf[sourceIndex] = null;

    moves += 1;
    resolveTriples();
    checkWin();
  }

  function resolveTriples() {
    let clearedAny = true;
    while (clearedAny) {
      clearedAny = false;
      for (let rowStart = 0; rowStart < shelf.length && !clearedAny; rowStart += COLS) {
        const rowEnd = Math.min(rowStart + COLS, shelf.length);
        for (let i = rowStart; i <= rowEnd - 3; i++) {
          const a = shelf[i], b = shelf[i + 1], c = shelf[i + 2];
          if (a && b && c && a.type === b.type && c.type === b.type) {
            // Grab the slot rects before rendering wipes this frame's DOM, so
            // the clear pop appears exactly where the trio was sitting.
            const rects = [i, i + 1, i + 2].map((idx) => {
              const slotEl = shelfEl.children[idx];
              return slotEl ? slotEl.getBoundingClientRect() : null;
            });
            shelf[i] = shelf[i + 1] = shelf[i + 2] = null;
            clearedAny = true;
            stars += 1;
            save(KEYS.stars, stars);
            rects.forEach((rect) => spawnPopGhost(rect, a.type));
            const midRect = rects[1] || rects[0] || rects[2];
            if (midRect) spawnStarFloat(midRect.left + midRect.width / 2, midRect.top);
            break;
          }
        }
      }
    }
  }

  function undo() {
    if (undos <= 0 || history.length === 0) return;
    const oldRects = captureRects();
    const prev = history.pop();
    shelf = prev.shelf;
    moves = prev.moves;
    undos -= 1;
    save(KEYS.undos, undos);
    render();
    applyFlip(oldRects);
  }

  function toggleHammer() {
    if (hammers <= 0) return;
    hammerActive = !hammerActive;
    updateHud();
  }

  function checkWin() {
    if (shelf.every((c) => c === null)) {
      hammers += 1;
      undos += 1;
      save(KEYS.hammers, hammers);
      save(KEYS.undos, undos);
      winMessage.textContent = `Level ${currentLevel} complete ✨`;
      winOverlay.classList.remove('hidden');
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // offline install support is a nice-to-have; ignore failures
      });
    }
  }

  restartBtn.addEventListener('click', () => newLevel(currentLevel));
  nextLevelBtn.addEventListener('click', () => newLevel(currentLevel + 1));
  hammerBtn.addEventListener('click', toggleHammer);
  undoBtn.addEventListener('click', undo);

  newLevel(currentLevel);
  registerServiceWorker();
})();
