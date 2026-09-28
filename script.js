(() => {
  const ITEM_ICONS = ['🍎', '🥐', '🧀', '🥛', '🍫', '🥕', '🧃', '🍞', '🥚', '🍯', '🧻', '🥫'];
  const COLS = 6; // must match .shelf's grid-template-columns in style.css
  const CELLS = 24; // fixed visible board size (4 rows x 6 cols) regardless of level
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

  // shelf[i] is a STACK (array) of item objects, back-to-front; the last
  // element is the visible, draggable top. An empty array means an empty
  // cell. Items further down are genuinely hidden — their type isn't
  // revealed until everything above them is cleared away.
  let shelf = [];
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

  // Difficulty ramps along two axes at once:
  //  - `groups`: how many 3-item stacks-worth of stock exist in total
  //    (types repeat once past the icon set — several separate stacks of
  //    the "same product" is normal for a real shelf). This climbs from 6
  //    groups (18 items) at level 1 toward 50 groups (150 items) by the
  //    time variety and restocking both cap out.
  //  - `slack`: how many of the fixed CELLS visible positions start
  //    completely empty. Occupied cells split the remaining items into
  //    randomly-sized stacks, so most items start hidden underneath
  //    others and only surface once whatever's on top is cleared. Fewer
  //    empty cells (less slack) means less room to maneuver, so slack
  //    tapers from 6 down to a floor of 2 as levels rise.
  // A few of the rarest groups start locked behind a star cost, but at
  // least two groups are always left unlocked so a level can always earn
  // enough stars, from its own clears alone, to pay for the rest.
  function levelConfig(level) {
    const groups = Math.min(6 + (level - 1) * 2, 50);
    const maxLocked = Math.max(0, groups - 2);
    const lockedCount = level >= 3 ? Math.min(1 + Math.floor((level - 3) / 4), maxLocked) : 0;
    const slack = Math.max(2, 6 - Math.floor((level - 1) / 3));
    return { groups, lockedCount, slack };
  }

  function buildItemPool(level) {
    const { groups, lockedCount } = levelConfig(level);
    const pool = [];
    for (let g = 0; g < groups; g++) {
      const locked = g >= groups - lockedCount;
      const rank = locked ? g - (groups - lockedCount) : -1;
      const cost = locked ? 2 * (rank + 1) : null;
      const type = ITEM_ICONS[g % ITEM_ICONS.length];
      for (let s = 0; s < 3; s++) pool.push({ type, group: locked ? g : null, cost });
    }
    return shuffle(pool);
  }

  // Distributes the shuffled item pool across CELLS - slack occupied
  // cells as stacks: every occupied cell is guaranteed at least one item
  // (so slack stays exact), then the rest land on random occupied cells,
  // producing naturally uneven pile heights.
  function buildStacks(level) {
    const { slack } = levelConfig(level);
    const cellOrder = shuffle([...Array(CELLS).keys()]);
    const emptyCells = new Set(cellOrder.slice(0, slack));
    const occupied = cellOrder.slice(slack);

    const pool = buildItemPool(level);
    const stacks = Array.from({ length: CELLS }, () => []);

    occupied.forEach((cellIndex, i) => {
      if (i < pool.length) stacks[cellIndex].push(pool[i]);
    });
    for (let i = occupied.length; i < pool.length; i++) {
      const cellIndex = occupied[Math.floor(Math.random() * occupied.length)];
      stacks[cellIndex].push(pool[i]);
    }

    return { stacks, emptyCells };
  }

  function newLevel(level) {
    currentLevel = level;
    save(KEYS.level, level);
    levelNumberEl.textContent = String(level);

    const { stacks } = buildStacks(level);
    shelf = stacks.map((stack) => stack.map((p) => ({ id: nextId++, type: p.type, group: p.group })));
    lockedGroups = {};
    stacks.forEach((stack) => {
      stack.forEach((p) => {
        if (p.group !== null) lockedGroups[p.group] = p.cost;
      });
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

  function topOf(stack) {
    return stack.length ? stack[stack.length - 1] : null;
  }

  function isLocked(item) {
    return item && item.group !== null && lockedGroups[item.group] !== undefined;
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
    shelf.forEach((stack, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = String(index);
      const top = topOf(stack);
      if (top) {
        slot.appendChild(isLocked(top) ? makeLockedEl(top, index) : makeItemEl(top, index, stack.length));
      }
      shelfEl.appendChild(slot);
    });
    updateHud();
  }

  function makeItemEl(item, index, depth) {
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = item.type;
    el.dataset.index = String(index);
    el.dataset.id = String(item.id);
    if (depth > 1) {
      const badge = document.createElement('span');
      badge.className = 'depth-badge';
      badge.textContent = String(depth);
      el.appendChild(badge);
    }
    el.addEventListener('pointerdown', onPointerDown);
    return el;
  }

  function makeLockedEl(item, index) {
    const el = document.createElement('div');
    el.className = 'item locked';
    el.innerHTML = `<span class="lock-icon">🔒</span><span class="lock-cost">${lockedGroups[item.group]}⭐</span>`;
    el.addEventListener('click', () => attemptUnlock(item.group, el));
    return el;
  }

  function attemptUnlock(group, el) {
    const cost = lockedGroups[group];
    if (stars >= cost) {
      stars -= cost;
      save(KEYS.stars, stars);
      delete lockedGroups[group];
      render();
      shelf.forEach((stack) => {
        const top = topOf(stack);
        if (top && top.group === group) {
          const revealed = shelfEl.querySelector(`[data-id="${top.id}"]`);
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
    const top = topOf(shelf[index]);
    if (!top) return;

    if (hammerActive) {
      e.preventDefault();
      const oldRects = captureRects();
      const rect = el.getBoundingClientRect();
      pushHistory();
      shelf[index].pop();
      hammers -= 1;
      hammerActive = false;
      save(KEYS.hammers, hammers);
      resolveTriples();
      checkWin();
      render();
      applyFlip(oldRects);
      spawnPopGhost(rect, top.type);
      return;
    }

    e.preventDefault();
    el.setPointerCapture(e.pointerId);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = top.type;
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
      shelf: shelf.map((stack) => stack.map((item) => ({ ...item }))),
      moves,
    });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  // A move only ever drops the top item of a stack into a completely
  // empty cell — never a direct swap, and never onto another stack even
  // if it's unlocked. That scarcity of empty cells, combined with items
  // being physically hidden until uncovered, is the whole puzzle.
  function attemptMove(sourceIndex, targetIndex) {
    if (sourceIndex === targetIndex) return;
    if (shelf[targetIndex].length > 0) return; // target must be a genuinely empty cell
    const top = topOf(shelf[sourceIndex]);
    if (!top || isLocked(top)) return;

    pushHistory();
    shelf[targetIndex].push(shelf[sourceIndex].pop());

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
          const a = topOf(shelf[i]), b = topOf(shelf[i + 1]), c = topOf(shelf[i + 2]);
          if (a && b && c && !isLocked(a) && !isLocked(b) && !isLocked(c) && a.type === b.type && c.type === b.type) {
            // Grab the slot rects before rendering wipes this frame's DOM, so
            // the clear pop appears exactly where the trio was sitting.
            const rects = [i, i + 1, i + 2].map((idx) => {
              const slotEl = shelfEl.children[idx];
              return slotEl ? slotEl.getBoundingClientRect() : null;
            });
            shelf[i].pop();
            shelf[i + 1].pop();
            shelf[i + 2].pop();
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
    if (shelf.every((stack) => stack.length === 0)) {
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
