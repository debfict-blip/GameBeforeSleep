(() => {
  const ITEM_ICONS = ['🧸', '🎈', '🍦', '🎁', '🧦', '🪀', '🍪', '🧶', '🪁', '🧩', '🍬', '🚗'];
  const TRAY_SLOTS = 7;
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
  const trayEl = document.getElementById('tray');
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

  let shelf = [];
  let tray = [];
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
  function levelConfig(level) {
    const types = Math.min(3 + Math.floor((level - 1) / 2), ITEM_ICONS.length);
    const setsPerType = 1 + Math.floor((level - 1) / (2 * ITEM_ICONS.length));
    const maxLocked = Math.max(0, types - 2);
    const lockedCount = level >= 3 ? Math.min(1 + Math.floor((level - 3) / 4), maxLocked) : 0;
    return { types, setsPerType, lockedCount };
  }

  function buildShelfPool(level) {
    const { types, setsPerType, lockedCount } = levelConfig(level);
    const pool = [];
    for (let t = 0; t < types; t++) {
      const locked = t >= types - lockedCount;
      const rank = locked ? t - (types - lockedCount) : -1;
      const cost = locked ? 2 * (rank + 1) : null;
      for (let s = 0; s < setsPerType * 3; s++) {
        pool.push({ type: ITEM_ICONS[t], group: locked ? t : null, cost });
      }
    }
    return shuffle(pool);
  }

  function newLevel(level) {
    currentLevel = level;
    save(KEYS.level, level);
    levelNumberEl.textContent = String(level);

    const pool = buildShelfPool(level);
    shelf = pool.map((p) => ({ id: nextId++, type: p.type, group: p.group }));
    lockedGroups = {};
    pool.forEach((p) => {
      if (p.group !== null) lockedGroups[p.group] = p.cost;
    });

    tray = new Array(TRAY_SLOTS).fill(null);
    moves = 0;
    history = [];
    hammerActive = false;
    winOverlay.classList.add('hidden');
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

  function render() {
    shelfEl.innerHTML = '';
    shelf.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.zone = 'shelf';
      slot.dataset.index = String(index);
      if (cell) {
        slot.appendChild(isLocked(cell) ? makeLockedEl(cell, index) : makeItemEl(cell, 'shelf', index));
      }
      shelfEl.appendChild(slot);
    });

    trayEl.innerHTML = '';
    tray.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.zone = 'tray';
      slot.dataset.index = String(index);
      if (cell) slot.appendChild(makeItemEl(cell, 'tray', index));
      trayEl.appendChild(slot);
    });

    updateHud();
  }

  function makeItemEl(cell, zone, index) {
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = cell.type;
    el.dataset.zone = zone;
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
    } else if (el) {
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 320);
    }
  }

  function onPointerDown(e) {
    if (drag) return;
    const el = e.currentTarget;
    const zone = el.dataset.zone;
    const index = Number(el.dataset.index);
    const cell = zone === 'shelf' ? shelf[index] : tray[index];
    if (!cell) return;

    if (hammerActive) {
      e.preventDefault();
      pushHistory();
      if (zone === 'shelf') shelf[index] = null;
      else tray[index] = null;
      hammers -= 1;
      hammerActive = false;
      save(KEYS.hammers, hammers);
      resolveTriples();
      checkWin();
      render();
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
      sourceZone: zone,
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

    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = dropTarget && dropTarget.closest('.slot');
    if (slotEl) {
      const targetZone = slotEl.dataset.zone;
      const targetIndex = Number(slotEl.dataset.index);
      attemptMove(drag.sourceZone, drag.sourceIndex, targetZone, targetIndex);
    }

    endDrag();
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag();
  }

  function endDrag() {
    drag.ghost.remove();
    drag.el.classList.remove('dragging-source');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    drag = null;
    render();
  }

  function pushHistory() {
    history.push({
      shelf: shelf.map((c) => (c ? { ...c } : null)),
      tray: tray.map((c) => (c ? { ...c } : null)),
      moves,
    });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  function attemptMove(sourceZone, sourceIndex, targetZone, targetIndex) {
    if (targetZone === 'shelf') return; // items never move back onto the shelf

    if (sourceZone === 'shelf') {
      if (sourceZone === targetZone && sourceIndex === targetIndex) return;
      if (tray[targetIndex]) return; // shelf items only land in an empty tray slot
      pushHistory();
      tray[targetIndex] = shelf[sourceIndex];
      shelf[sourceIndex] = null;
    } else if (sourceZone === 'tray') {
      if (sourceIndex === targetIndex) return;
      pushHistory();
      const temp = tray[targetIndex];
      tray[targetIndex] = tray[sourceIndex];
      tray[sourceIndex] = temp; // swap; moving into a hole leaves target's old spot empty
    } else {
      return;
    }

    moves += 1;
    resolveTriples();
    checkWin();
  }

  function resolveTriples() {
    let cleared = true;
    while (cleared) {
      cleared = false;
      for (let i = 0; i <= tray.length - 3; i++) {
        const a = tray[i], b = tray[i + 1], c = tray[i + 2];
        if (a && b && c && a.type === b.type && c.type === b.type) {
          tray[i] = tray[i + 1] = tray[i + 2] = null;
          cleared = true;
          stars += 1;
          save(KEYS.stars, stars);
          break;
        }
      }
    }
  }

  function undo() {
    if (undos <= 0 || history.length === 0) return;
    const prev = history.pop();
    shelf = prev.shelf;
    tray = prev.tray;
    moves = prev.moves;
    undos -= 1;
    save(KEYS.undos, undos);
    render();
  }

  function toggleHammer() {
    if (hammers <= 0) return;
    hammerActive = !hammerActive;
    updateHud();
  }

  function checkWin() {
    const shelfEmpty = shelf.every((c) => c === null);
    const trayEmpty = tray.every((c) => c === null);
    if (shelfEmpty && trayEmpty) {
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
