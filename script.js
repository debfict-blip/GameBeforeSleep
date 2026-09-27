(() => {
  const ITEM_ICONS = ['🧸', '🎈', '🍦', '🎁', '🧦', '🪀', '🍪', '🧶', '🪁', '🧩', '🍬', '🚗'];
  const TRAY_SLOTS = 7;
  const STORAGE_KEY = 'gbs-level';

  const shelfEl = document.getElementById('shelf');
  const trayEl = document.getElementById('tray');
  const winOverlay = document.getElementById('winOverlay');
  const winMessage = document.getElementById('winMessage');
  const levelNumberEl = document.getElementById('levelNumber');
  const restartBtn = document.getElementById('restartBtn');
  const nextLevelBtn = document.getElementById('nextLevelBtn');

  let shelf = [];
  let tray = [];
  let nextId = 1;
  let drag = null;
  let currentLevel = loadLevel();

  function loadLevel() {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(saved) && saved > 0 ? saved : 1;
  }

  function saveLevel(level) {
    try {
      localStorage.setItem(STORAGE_KEY, String(level));
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
  function levelConfig(level) {
    const types = Math.min(3 + Math.floor((level - 1) / 2), ITEM_ICONS.length);
    const setsPerType = 1 + Math.floor((level - 1) / (2 * ITEM_ICONS.length));
    return { types, setsPerType };
  }

  function buildShelfPool(level) {
    const { types, setsPerType } = levelConfig(level);
    const pool = [];
    for (let t = 0; t < types; t++) {
      for (let s = 0; s < setsPerType * 3; s++) pool.push(ITEM_ICONS[t]);
    }
    return shuffle(pool);
  }

  function newLevel(level) {
    currentLevel = level;
    saveLevel(level);
    levelNumberEl.textContent = String(level);

    const pool = buildShelfPool(level);
    shelf = pool.map((type) => ({ id: nextId++, type }));
    tray = new Array(TRAY_SLOTS).fill(null);
    winOverlay.classList.add('hidden');
    render();
  }

  function render() {
    shelfEl.innerHTML = '';
    shelf.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.zone = 'shelf';
      slot.dataset.index = String(index);
      if (cell) slot.appendChild(makeItemEl(cell, 'shelf', index));
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

  function onPointerDown(e) {
    if (drag) return;
    const el = e.currentTarget;
    const zone = el.dataset.zone;
    const index = Number(el.dataset.index);
    const cell = zone === 'shelf' ? shelf[index] : tray[index];
    if (!cell) return;

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

  function attemptMove(sourceZone, sourceIndex, targetZone, targetIndex) {
    if (targetZone === 'shelf') return; // items never move back onto the shelf

    if (sourceZone === 'shelf') {
      if (sourceZone === targetZone && sourceIndex === targetIndex) return;
      if (tray[targetIndex]) return; // shelf items only land in an empty tray slot
      tray[targetIndex] = shelf[sourceIndex];
      shelf[sourceIndex] = null;
    } else if (sourceZone === 'tray') {
      if (sourceIndex === targetIndex) return;
      const temp = tray[targetIndex];
      tray[targetIndex] = tray[sourceIndex];
      tray[sourceIndex] = temp; // swap; moving into a hole leaves target's old spot empty
    }

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
          break;
        }
      }
    }
  }

  function checkWin() {
    const shelfEmpty = shelf.every((c) => c === null);
    const trayEmpty = tray.every((c) => c === null);
    if (shelfEmpty && trayEmpty) {
      winMessage.textContent = `Level ${currentLevel} complete ✨`;
      winOverlay.classList.remove('hidden');
    }
  }

  restartBtn.addEventListener('click', () => newLevel(currentLevel));
  nextLevelBtn.addEventListener('click', () => newLevel(currentLevel + 1));

  newLevel(currentLevel);
})();
