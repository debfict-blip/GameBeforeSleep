(() => {
  const ITEM_ICONS = ['🍎', '🥐', '🧀', '🥛', '🍫', '🥕', '🧃', '🍞', '🥚', '🍯', '🧻', '🥫'];
  const COLS = 6; // must match .shelf's grid-template-columns in style.css
  const CELLS = 24; // fixed visible board size (4 rows x 6 cols) regardless of level
  const HISTORY_LIMIT = 20;
  const START_HAMMERS = 2;
  const START_UNDOS = 2;
  const ITEMS_PER_BELT = 7;
  const BELT_ITEM_SIZE = 48;
  const BELT_GAP = 16;
  const BELT_SPACING = BELT_ITEM_SIZE + BELT_GAP; // px between consecutive belt slots

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
  const beltsSectionEl = document.getElementById('beltsSection');

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

  // Each belt is a fixed-length loop of slots that scrolls right-to-left
  // forever (never loses an unclaimed item — no hard fail state). Belts
  // never carry locked items, so isLocked() is never checked on them.
  // slot.baseX is the slot's position along the belt's own virtual track;
  // it gets bumped forward by a full lap once it scrolls off-screen, so
  // the loop is seamless without needing duplicate DOM elements.
  let belts = [];
  let beltAnimHandle = null;
  let beltLastTs = null;

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
  //
  // From level 5 on, some of a level's items ride conveyor belts instead
  // of sitting in the shelf: belts loop forever (an unclaimed item just
  // comes back around, never lost) but they're a second thing to track
  // alongside the grid, and more of them stack in at higher levels.
  function levelConfig(level) {
    const groups = Math.min(6 + (level - 1) * 2, 50);
    const maxLocked = Math.max(0, groups - 2);
    const lockedCount = level >= 3 ? Math.min(1 + Math.floor((level - 3) / 4), maxLocked) : 0;
    const slack = Math.max(2, 6 - Math.floor((level - 1) / 3));
    const beltCount = level >= 5 ? Math.min(1 + Math.floor((level - 5) / 7), 3) : 0;
    const beltSpeed = Math.min(40 + level * 1.2, 90); // px/sec
    return { groups, lockedCount, slack, beltCount, beltSpeed };
  }

  // Builds groups rather than a flat item pool, and keeps each group's 3
  // items together through shuffling — that's what lets splitPools hand
  // belts and the grid whole groups instead of an arbitrary item count,
  // which keeps every type's count a clean multiple of 3 in *both* places
  // (the same property the hammer fix relies on), and lets buildStacks
  // guarantee one whole group starts fully exposed on the grid.
  function buildGroups(level) {
    const { groups, lockedCount } = levelConfig(level);
    const list = [];
    for (let g = 0; g < groups; g++) {
      const locked = g >= groups - lockedCount;
      const rank = locked ? g - (groups - lockedCount) : -1;
      const cost = locked ? 2 * (rank + 1) : null;
      const type = ITEM_ICONS[g % ITEM_ICONS.length];
      const items = [];
      for (let s = 0; s < 3; s++) items.push({ type, group: locked ? g : null, cost });
      list.push({ locked, items });
    }
    return shuffle(list);
  }

  // Splits the level's groups into what rides the belts (always unlocked
  // groups only, so nothing hidden-and-locked ends up somewhere it can't
  // be unlocked from) and what gets distributed into the shelf — at least
  // one unlocked group is always kept back for the grid, both so a level
  // can still fund its own locks from its own clears, and so there's
  // always a whole group available to guarantee exposed on the shelf.
  function splitPools(level) {
    const { beltCount } = levelConfig(level);
    const groupsList = buildGroups(level);
    const unlockedGroups = groupsList.filter((g) => !g.locked);
    const lockedGroups = groupsList.filter((g) => g.locked);

    const beltGroupCount = Math.min(
      Math.floor((beltCount * ITEMS_PER_BELT) / 3),
      Math.max(0, unlockedGroups.length - 1)
    );
    const beltGroups = unlockedGroups.slice(0, beltGroupCount);
    const gridUnlockedGroups = unlockedGroups.slice(beltGroupCount);

    const beltItems = beltGroups.flatMap((g) => g.items);
    const gridPool = shuffle(gridUnlockedGroups.concat(lockedGroups).flatMap((g) => g.items));

    return { gridPool, beltItems, gridUnlockedGroups };
  }

  // Distributes a shuffled item pool across occupied cells as stacks
  // (every occupied cell gets at least one item, then extras land on
  // random occupied cells, producing naturally uneven pile heights) —
  // except for four cells reserved up front to guarantee a genuinely
  // zero-dig opening move.
  //
  // Being merely visible isn't enough: if every spare copy of that type
  // is buried under something else, completing the triple still forces
  // a reveal somewhere. So the reservation is stricter — pick a row and
  // a 3-column window in it; two of those three cells get two of
  // `starterItems` with NOTHING else ever placed on top (depth exactly
  // 1), and the third window cell is left as one of the level's empty
  // slots. The third starter item goes alone (also depth 1) in some
  // other cell entirely. The player can always finish this exact triple
  // with a single drag into that one empty slot, using two items that
  // have nothing hidden under them and disturbing nothing else.
  function buildStacks(level, pool, starterItems) {
    const { slack } = levelConfig(level);
    const allCells = [...Array(CELLS).keys()];

    const row = Math.floor(Math.random() * (CELLS / COLS));
    const col = Math.floor(Math.random() * (COLS - 2)); // 0..COLS-3: a valid 3-wide window
    const windowCells = [row * COLS + col, row * COLS + col + 1, row * COLS + col + 2];
    const emptyPos = windowCells[Math.floor(Math.random() * 3)];
    const fillPositions = windowCells.filter((p) => p !== emptyPos);

    const remaining = shuffle(allCells.filter((p) => !windowCells.includes(p)));
    const otherStarterCell = remaining.pop();
    const restOccupied = remaining.slice(slack - 1); // remaining.slice(0, slack - 1) stay empty

    const stacks = Array.from({ length: CELLS }, () => []);
    stacks[fillPositions[0]].push(starterItems[0]);
    stacks[fillPositions[1]].push(starterItems[1]);
    stacks[otherStarterCell].push(starterItems[2]);

    restOccupied.forEach((cellIndex, i) => {
      if (i < pool.length) stacks[cellIndex].push(pool[i]);
    });
    for (let i = restOccupied.length; i < pool.length; i++) {
      const cellIndex = restOccupied[Math.floor(Math.random() * restOccupied.length)];
      stacks[cellIndex].push(pool[i]);
    }

    return stacks;
  }

  // Lays beltItems out evenly across `beltCount` belts, ITEMS_PER_BELT
  // slots each (unused trailing slots on the last belt stay empty).
  function buildBelts(level, beltItems) {
    const { beltCount, beltSpeed } = levelConfig(level);
    const items = shuffle(beltItems.slice());
    const result = [];
    for (let b = 0; b < beltCount; b++) {
      const slots = [];
      for (let s = 0; s < ITEMS_PER_BELT; s++) {
        const p = items.shift();
        slots.push({
          baseX: s * BELT_SPACING,
          item: p ? { id: nextId++, type: p.type, group: p.group } : null,
          slotEl: null,
          itemEl: null,
        });
      }
      result.push({ speed: beltSpeed, offset: 0, trackEl: null, items: slots });
    }
    return result;
  }

  function newLevel(level) {
    currentLevel = level;
    save(KEYS.level, level);
    levelNumberEl.textContent = String(level);

    const { gridPool, beltItems, gridUnlockedGroups } = splitPools(level);
    const starterGroup = gridUnlockedGroups[Math.floor(Math.random() * gridUnlockedGroups.length)];
    const stacks = buildStacks(level, gridPool, starterGroup.items);
    shelf = stacks.map((stack) => stack.map((p) => ({ id: nextId++, type: p.type, group: p.group })));
    lockedGroups = {};
    stacks.forEach((stack) => {
      stack.forEach((p) => {
        if (p.group !== null) lockedGroups[p.group] = p.cost;
      });
    });

    belts = buildBelts(level, beltItems);
    renderBelts();

    moves = 0;
    history = [];
    hammerActive = false;
    winOverlay.classList.add('hidden');
    render(); // lay out real slot elements first, so resolveTriples can read their rects
    resolveTriples(); // a fresh shuffle can spawn a triple by pure chance; clear it up front
    updateHud();
    render();
    startBeltLoop();
  }

  function renderBelts() {
    beltsSectionEl.innerHTML = '';
    beltsSectionEl.classList.toggle('hidden', belts.length === 0);
    if (belts.length === 0) return;

    const label = document.createElement('span');
    label.className = 'sectionLabel';
    label.textContent = belts.length > 1 ? 'Delivery Belts' : 'Delivery Belt';
    beltsSectionEl.appendChild(label);

    belts.forEach((belt, beltIndex) => {
      const track = document.createElement('div');
      track.className = 'beltTrack';
      belt.trackEl = track;
      // Every slot gets a moving wrapper — occupied or not — so an empty
      // slot is itself a visible, catchable-up-with drop target as it
      // scrolls past, not just dead space between items.
      belt.items.forEach((slot, slotIndex) => {
        const slotEl = document.createElement('div');
        slotEl.className = 'beltSlot';
        slotEl.dataset.beltIndex = String(beltIndex);
        slotEl.dataset.slotIndex = String(slotIndex);
        slot.slotEl = slotEl;
        slot.itemEl = slot.item ? makeBeltItemEl(slot.item, beltIndex, slotIndex) : null;
        if (slot.itemEl) slotEl.appendChild(slot.itemEl);
        track.appendChild(slotEl);
      });
      beltsSectionEl.appendChild(track);
    });
  }

  function makeBeltItemEl(item, beltIndex, slotIndex) {
    const el = document.createElement('div');
    el.className = 'item belt-item';
    el.textContent = item.type;
    el.dataset.source = 'belt';
    el.dataset.beltIndex = String(beltIndex);
    el.dataset.slotIndex = String(slotIndex);
    el.dataset.id = String(item.id);
    el.addEventListener('pointerdown', onPointerDown);
    return el;
  }

  function startBeltLoop() {
    if (beltAnimHandle !== null) return; // already running
    beltLastTs = null;
    const step = (ts) => {
      if (beltLastTs === null) beltLastTs = ts;
      const dt = (ts - beltLastTs) / 1000;
      beltLastTs = ts;

      belts.forEach((belt, beltIndex) => {
        belt.offset += belt.speed * dt;
        const trackLength = ITEMS_PER_BELT * BELT_SPACING;
        belt.items.forEach((slot, idx) => {
          if (!slot.slotEl) return;
          // Freeze the slot currently being dragged (from OR to) — its
          // ghost, or the target highlight, represents it while it moves.
          if (drag && drag.source === 'belt' && drag.beltIndex === beltIndex && drag.slotIndex === idx) return;
          let x = slot.baseX - belt.offset;
          if (x < -BELT_ITEM_SIZE) {
            slot.baseX += trackLength;
            x = slot.baseX - belt.offset;
          }
          slot.slotEl.style.transform = `translateX(${x}px)`;
        });
      });

      beltAnimHandle = requestAnimationFrame(step);
    };
    beltAnimHandle = requestAnimationFrame(step);
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

  // Every group contributes exactly 3 items of its type, and a group is
  // always entirely locked or entirely unlocked (never split) — so the
  // unlocked count of any given type on the board is always a multiple
  // of 3. Finds every currently-unlocked instance of `type`, anywhere on
  // the board (grid, at any depth — not just stack tops — plus belts).
  function findUnlockedByType(type) {
    const found = [];
    shelf.forEach((stack, cellIndex) => {
      stack.forEach((item, depthIndex) => {
        if (item.type === type && !isLocked(item)) {
          found.push({ kind: 'shelf', cellIndex, depthIndex, isTop: depthIndex === stack.length - 1 });
        }
      });
    });
    belts.forEach((belt, beltIndex) => {
      belt.items.forEach((slot, slotIndex) => {
        if (slot.item && slot.item.type === type) {
          found.push({ kind: 'belt', beltIndex, slotIndex, isTop: true });
        }
      });
    });
    return found;
  }

  function locationRect(loc) {
    if (loc.kind === 'shelf') {
      const slotEl = shelfEl.children[loc.cellIndex];
      return slotEl ? slotEl.getBoundingClientRect() : null;
    }
    const slot = belts[loc.beltIndex].items[loc.slotIndex];
    return slot.itemEl ? slot.itemEl.getBoundingClientRect() : null;
  }

  function removeAtLocation(loc) {
    if (loc.kind === 'shelf') {
      shelf[loc.cellIndex].splice(loc.depthIndex, 1);
    } else {
      const slot = belts[loc.beltIndex].items[loc.slotIndex];
      if (slot.itemEl) slot.itemEl.remove();
      slot.item = null;
      slot.itemEl = null;
    }
  }

  // The hammer clears a whole matching triple at once (the tapped item
  // plus two more of the same type pulled from anywhere on the board —
  // stack tops preferred for a cleaner pop, buried ones if that's all
  // that's left) rather than a single item. Removing items one at a time
  // would leave 1 or 2 stragglers of a type that can never line up into
  // a 3-in-a-row again, softlocking the level.
  function hammerClearType(type, tappedLoc) {
    const rest = findUnlockedByType(type).filter(
      (loc) => !(loc.kind === tappedLoc.kind
        && loc.cellIndex === tappedLoc.cellIndex && loc.beltIndex === tappedLoc.beltIndex
        && loc.depthIndex === tappedLoc.depthIndex && loc.slotIndex === tappedLoc.slotIndex)
    );
    rest.sort((a, b) => (b.isTop ? 1 : 0) - (a.isTop ? 1 : 0));
    const toRemove = [tappedLoc, ...rest.slice(0, 2)];

    const rects = toRemove.map(locationRect);
    toRemove.forEach(removeAtLocation);

    if (toRemove.length === 3) {
      stars += 1;
      save(KEYS.stars, stars);
    }
    rects.forEach((rect) => spawnPopGhost(rect, type));
    const midRect = rects[1] || rects[0] || rects[2];
    if (midRect) spawnStarFloat(midRect.left + midRect.width / 2, midRect.top);
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
    el.dataset.source = 'grid';
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
    const fromBelt = el.dataset.source === 'belt';
    const beltIndex = fromBelt ? Number(el.dataset.beltIndex) : null;
    const slotIndex = fromBelt ? Number(el.dataset.slotIndex) : null;
    const index = fromBelt ? null : Number(el.dataset.index);
    const top = fromBelt ? belts[beltIndex].items[slotIndex].item : topOf(shelf[index]);
    if (!top) return;

    if (hammerActive) {
      e.preventDefault();
      const oldRects = captureRects();
      const tappedLoc = fromBelt
        ? { kind: 'belt', beltIndex, slotIndex, isTop: true }
        : { kind: 'shelf', cellIndex: index, depthIndex: shelf[index].length - 1, isTop: true };
      pushHistory();
      hammerClearType(top.type, tappedLoc);
      hammers -= 1;
      hammerActive = false;
      save(KEYS.hammers, hammers);
      resolveTriples();
      checkWin();
      render();
      applyFlip(oldRects);
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

    drag = fromBelt
      ? { pointerId: e.pointerId, source: 'belt', beltIndex, slotIndex, el, ghost }
      : { pointerId: e.pointerId, source: 'grid', sourceIndex: index, el, ghost };

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
    const shelfSlotEl = dropTarget && dropTarget.closest('.shelf .slot');

    if (shelfSlotEl) {
      const targetIndex = Number(shelfSlotEl.dataset.index);
      if (drag.source === 'belt') attemptMoveFromBelt(drag.beltIndex, drag.slotIndex, targetIndex);
      else attemptMove(drag.sourceIndex, targetIndex);
    }
    // Belt slots (empty or not) are never a valid drop target — items only
    // ever come off a belt, never get parked back onto one.

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
      belts: belts.map((belt) => belt.items.map((slot) => (slot.item ? { ...slot.item } : null))),
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

  // Same empty-cell-only rule, just sourced from a belt slot instead of
  // another shelf stack. The claimed slot never refills — that belt
  // just has one less item cycling round from then on.
  function attemptMoveFromBelt(beltIndex, slotIndex, targetIndex) {
    if (shelf[targetIndex].length > 0) return;
    const slot = belts[beltIndex].items[slotIndex];
    if (!slot || !slot.item) return;

    pushHistory();
    shelf[targetIndex].push(slot.item);
    slot.item = null;
    if (slot.itemEl) { slot.itemEl.remove(); slot.itemEl = null; }

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
    restoreBelts(prev.belts);
    undos -= 1;
    save(KEYS.undos, undos);
    render();
    applyFlip(oldRects);
  }

  // Restores which belt slots hold an item. A revived slot gets a fresh
  // DOM element appended into its slot's (still-moving) wrapper; the
  // animation loop then just carries it along from wherever the belt's
  // offset is now (a small visual jump is an acceptable trade for not
  // tracking exact continuous-time positions in undo history).
  function restoreBelts(snapshot) {
    if (!snapshot) return;
    belts.forEach((belt, i) => {
      belt.items.forEach((slot, k) => {
        const wasItem = snapshot[i][k];
        if (wasItem && !slot.item) {
          slot.item = wasItem;
          slot.itemEl = makeBeltItemEl(wasItem, i, k);
          slot.slotEl.appendChild(slot.itemEl);
        } else if (!wasItem && slot.item) {
          if (slot.itemEl) slot.itemEl.remove();
          slot.item = null;
          slot.itemEl = null;
        }
      });
    });
  }

  function toggleHammer() {
    if (hammers <= 0) return;
    hammerActive = !hammerActive;
    updateHud();
  }

  function checkWin() {
    const shelfDone = shelf.every((stack) => stack.length === 0);
    const beltsDone = belts.every((belt) => belt.items.every((slot) => !slot.item));
    if (shelfDone && beltsDone) {
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
