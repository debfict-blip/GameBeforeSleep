(() => {
  const ITEM_ICONS = ['🍎', '🥐', '🧀', '🥛', '🍫', '🥕', '🧃', '🍞', '🥚', '🍯', '🧻', '🥫'];
  const COLS = 6; // width of every row, static or moving
  const HISTORY_LIMIT = 20;
  const START_HAMMERS = 2;
  const START_UNDOS = 2;
  const SLOT_SIZE = 46;
  const SLOT_GAP = 16;
  const ROW_SPACING = SLOT_SIZE + SLOT_GAP; // px between consecutive slots in a moving row

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

  // The board is an ordered array of rows (top to bottom), each either
  // static or moving. Every row has `cells`, length COLS, and every cell
  // is a STACK (array of item objects, back-to-front — the last element
  // is the visible, draggable top; empty array means an empty cell).
  // Items further down a stack are genuinely hidden until uncovered.
  //
  // Static row:  { moving: false, index, rowEl, cells: [{stack}, ...] }
  // Moving row:  { moving: true, index, speed, offset,
  //                cells: [{stack, baseX, slotEl, itemEl}, ...] }
  //
  // Moving rows scroll right-to-left forever (an uncaught item just
  // comes back around, never lost) using the same lap-tracking technique
  // as before: cell.baseX is the slot's position along its own virtual
  // track, bumped forward by a full lap once it scrolls off-screen, so
  // the loop is seamless without duplicate DOM elements. They're a pure
  // source/sink though — 3-in-a-row matching only ever resolves on
  // static rows, never mid-scroll, so "what's adjacent" is never
  // ambiguous.
  let board = [];
  let nextId = 1;
  let drag = null;
  let hammerActive = false;
  let moves = 0;
  let history = [];
  let boardAnimHandle = null;
  let boardLastTs = null;

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

  // Difficulty ramps along several axes at once:
  //  - `groups`: how many 3-item stacks-worth of stock exist in total
  //    (types repeat once past the icon set — several separate stacks of
  //    the "same product" is normal for a real shelf). Climbs from 6
  //    groups (18 items) at level 1 toward 50 groups (150 items).
  //  - `slack`: how many of a level's static cells start completely
  //    empty. Fewer empty cells means less room to maneuver, so slack
  //    tapers from 6 down to a floor of 2 as levels rise.
  //  - `totalRows` / `movingRowCount`: the board itself isn't fixed —
  //    it starts at a plain 4-row shelf, grows a little as levels rise
  //    (more surface for the growing item count), and from level 5 on,
  //    some of those rows scroll instead of sitting still. More rows
  //    move, and faster, at higher levels — at least 2 rows always stay
  //    static, so there's always a place for matches to actually happen.
  function levelConfig(level) {
    const groups = Math.min(6 + (level - 1) * 2, 50);
    const slack = Math.max(2, 6 - Math.floor((level - 1) / 3));
    const totalRows = level < 5 ? 4 : Math.min(4 + Math.floor((level - 5) / 10), 6);
    const movingRowCount = level < 5 ? 0 : Math.min(1 + Math.floor((level - 5) / 8), totalRows - 2);
    const rowSpeed = Math.min(40 + level * 1.2, 90); // px/sec
    return { groups, slack, totalRows, movingRowCount, rowSpeed };
  }

  // Builds groups rather than a flat item pool, and keeps each group's 3
  // items together through shuffling — that's what lets splitPools hand
  // moving rows and the grid whole groups instead of an arbitrary item
  // count, which keeps every type's count a clean multiple of 3 in
  // *both* places (the same property the hammer fix relies on), and
  // lets buildStaticRows guarantee one whole group starts fully exposed.
  function buildGroups(level) {
    const { groups } = levelConfig(level);
    const list = [];
    for (let g = 0; g < groups; g++) {
      const type = ITEM_ICONS[g % ITEM_ICONS.length];
      const items = [];
      for (let s = 0; s < 3; s++) items.push({ type });
      list.push({ items });
    }
    return shuffle(list);
  }

  // Splits the level's groups into what rides the moving rows and what
  // gets distributed into the static rows — at least one group is always
  // kept back for the static side, so there's always a whole group
  // available to guarantee exposed there (see buildStaticRows).
  function splitPools(level) {
    const { movingRowCount } = levelConfig(level);
    const groupsList = buildGroups(level);

    const movingCapacity = movingRowCount * COLS;
    const movingGroupCount = Math.min(Math.floor(movingCapacity / 3), Math.max(0, groupsList.length - 1));
    const movingGroups = groupsList.slice(0, movingGroupCount);
    const gridGroups = groupsList.slice(movingGroupCount);

    const movingItems = movingGroups.flatMap((g) => g.items);
    const gridPool = shuffle(gridGroups.flatMap((g) => g.items));

    return { gridPool, movingItems, gridGroups };
  }

  // Distributes a shuffled item pool across the static rows' cells
  // (every occupied cell gets at least one item, then extras land on
  // random occupied cells, producing naturally uneven pile heights) —
  // except for four cells reserved up front to guarantee a genuinely
  // zero-dig opening move.
  //
  // Being merely visible isn't enough: if every spare copy of that type
  // is buried under something else, completing the triple still forces
  // a reveal somewhere. So the reservation is stricter — pick a static
  // row and a 3-column window in it; two of those three cells get two of
  // `starterItems` with NOTHING else ever placed on top (depth exactly
  // 1), and the third window cell is left as one of the level's empty
  // slots. The third starter item goes alone (also depth 1) in some
  // other static cell entirely. The player can always finish this exact
  // triple with a single drag into that one empty slot, using two items
  // that have nothing hidden under them and disturbing nothing else.
  function buildStaticRows(level, pool, starterItems, staticRowCount) {
    const { slack } = levelConfig(level);

    const guaranteeRow = Math.floor(Math.random() * staticRowCount);
    const col = Math.floor(Math.random() * (COLS - 2)); // 0..COLS-3: a valid 3-wide window
    const windowCols = [col, col + 1, col + 2];
    const emptyCol = windowCols[Math.floor(Math.random() * 3)];
    const fillCols = windowCols.filter((c) => c !== emptyCol);

    const allPositions = [];
    for (let r = 0; r < staticRowCount; r++) {
      for (let c = 0; c < COLS; c++) {
        if (r === guaranteeRow && windowCols.includes(c)) continue;
        allPositions.push({ row: r, col: c });
      }
    }
    const remaining = shuffle(allPositions);
    const otherStarterPos = remaining.pop();
    const restOccupied = remaining.slice(slack - 1); // remaining.slice(0, slack - 1) stay empty

    const rows = Array.from({ length: staticRowCount }, () => ({
      moving: false,
      cells: Array.from({ length: COLS }, () => ({ stack: [] })),
    }));

    rows[guaranteeRow].cells[fillCols[0]].stack.push(starterItems[0]);
    rows[guaranteeRow].cells[fillCols[1]].stack.push(starterItems[1]);
    rows[otherStarterPos.row].cells[otherStarterPos.col].stack.push(starterItems[2]);

    restOccupied.forEach((pos, i) => {
      if (i < pool.length) rows[pos.row].cells[pos.col].stack.push(pool[i]);
    });
    for (let i = restOccupied.length; i < pool.length; i++) {
      const pos = restOccupied[Math.floor(Math.random() * restOccupied.length)];
      rows[pos.row].cells[pos.col].stack.push(pool[i]);
    }

    return rows;
  }

  // Lays movingItems out evenly across `movingRowCount` rows, COLS slots
  // each (unused trailing slots stay empty). Moving-row slots hold at
  // most one item apiece — hidden depth stays a static-row-only concept
  // for now, so catching something off a moving row is a pure timing
  // puzzle without also gambling on what's underneath it.
  function buildMovingRows(level, movingItems, movingRowCount) {
    const { rowSpeed } = levelConfig(level);
    const items = shuffle(movingItems.slice());
    const rows = [];
    for (let r = 0; r < movingRowCount; r++) {
      const cells = [];
      for (let c = 0; c < COLS; c++) {
        const p = items.shift();
        cells.push({
          stack: p ? [{ id: nextId++, type: p.type }] : [],
          baseX: c * ROW_SPACING,
          slotEl: null,
          itemEl: null,
        });
      }
      rows.push({ moving: true, speed: rowSpeed, offset: 0, cells });
    }
    return rows;
  }

  function newLevel(level) {
    currentLevel = level;
    save(KEYS.level, level);
    levelNumberEl.textContent = String(level);

    const { totalRows, movingRowCount } = levelConfig(level);
    const staticRowCount = totalRows - movingRowCount;

    const { gridPool, movingItems, gridGroups } = splitPools(level);
    const starterGroup = gridGroups[Math.floor(Math.random() * gridGroups.length)];
    const staticRows = buildStaticRows(level, gridPool, starterGroup.items, staticRowCount);
    const movingRows = buildMovingRows(level, movingItems, movingRowCount);

    // Scatter the moving rows among the static ones (not clumped) so
    // which rows move varies level to level.
    const positions = shuffle([...Array(totalRows).keys()]);
    const movingPositions = new Set(positions.slice(0, movingRowCount));

    board = [];
    let si = 0;
    let mi = 0;
    for (let i = 0; i < totalRows; i++) {
      const row = movingPositions.has(i) ? movingRows[mi++] : staticRows[si++];
      row.index = i;
      board.push(row);
    }

    moves = 0;
    history = [];
    hammerActive = false;
    winOverlay.classList.add('hidden');
    renderBoard(); // lay out real row/slot elements first, so resolveTriples can read their rects
    resolveTriples(); // a fresh shuffle can spawn a triple by pure chance; clear it up front
    updateHud();
    renderStaticRows();
    startBoardLoop();
  }

  function renderBoard() {
    shelfEl.innerHTML = '';
    board.forEach((row) => {
      if (row.moving) {
        row.rowEl = buildMovingRowEl(row);
      } else {
        row.rowEl = document.createElement('div');
        renderStaticRowInto(row);
      }
      shelfEl.appendChild(row.rowEl);
    });
    updateHud();
  }

  // Only re-renders static rows — moving rows are left completely alone
  // so their persistent, continuously-animated DOM never gets torn down
  // by an unrelated move elsewhere on the board.
  function renderStaticRows() {
    board.forEach((row) => {
      if (!row.moving) renderStaticRowInto(row);
    });
    updateHud();
  }

  function renderStaticRowInto(row) {
    row.rowEl.className = 'shelfRow static';
    row.rowEl.innerHTML = '';
    row.cells.forEach((cell, col) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.row = String(row.index);
      slot.dataset.col = String(col);
      const top = topOf(cell.stack);
      if (top) slot.appendChild(makeItemEl(top, row.index, col, cell.stack.length, false));
      row.rowEl.appendChild(slot);
    });
  }

  function buildMovingRowEl(row) {
    const el = document.createElement('div');
    el.className = 'shelfRow moving';
    row.cells.forEach((cell, col) => {
      const slotEl = document.createElement('div');
      slotEl.className = 'beltSlot';
      slotEl.dataset.row = String(row.index);
      slotEl.dataset.col = String(col);
      cell.slotEl = slotEl;
      const top = topOf(cell.stack);
      cell.itemEl = top ? makeItemEl(top, row.index, col, cell.stack.length, true) : null;
      if (cell.itemEl) slotEl.appendChild(cell.itemEl);
      el.appendChild(slotEl);
    });
    return el;
  }

  function makeItemEl(item, rowIndex, col, depth, isMoving) {
    const el = document.createElement('div');
    el.className = isMoving ? 'item belt-item' : 'item';
    el.textContent = item.type;
    el.dataset.row = String(rowIndex);
    el.dataset.col = String(col);
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

  function startBoardLoop() {
    if (boardAnimHandle !== null) return; // already running
    boardLastTs = null;
    const step = (ts) => {
      if (boardLastTs === null) boardLastTs = ts;
      const dt = (ts - boardLastTs) / 1000;
      boardLastTs = ts;

      board.forEach((row) => {
        if (!row.moving) return;
        row.offset += row.speed * dt;
        const trackLength = COLS * ROW_SPACING;
        row.cells.forEach((cell, col) => {
          if (!cell.slotEl) return;
          // Freeze the slot currently being dragged — its ghost represents it now.
          if (drag && drag.rowIndex === row.index && drag.col === col) return;
          let x = cell.baseX - row.offset;
          if (x < -SLOT_SIZE) {
            cell.baseX += trackLength;
            x = cell.baseX - row.offset;
          }
          cell.slotEl.style.transform = `translateX(${x}px)`;
        });
      });

      boardAnimHandle = requestAnimationFrame(step);
    };
    boardAnimHandle = requestAnimationFrame(step);
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

  // Every group contributes exactly 3 items of its type, so the count of
  // any given type on the board is always a multiple of 3. Finds every
  // instance of `type`, anywhere on the board (any row, any depth — not
  // just visible tops).
  function findByType(type) {
    const found = [];
    board.forEach((row, rowIndex) => {
      row.cells.forEach((cell, col) => {
        cell.stack.forEach((item, depthIndex) => {
          if (item.type === type) {
            found.push({ rowIndex, col, depthIndex, isTop: depthIndex === cell.stack.length - 1 });
          }
        });
      });
    });
    return found;
  }

  function locationRect(loc) {
    const row = board[loc.rowIndex];
    const cell = row.cells[loc.col];
    if (row.moving) {
      return cell.itemEl ? cell.itemEl.getBoundingClientRect() : null;
    }
    const slotEl = row.rowEl.children[loc.col];
    return slotEl ? slotEl.getBoundingClientRect() : null;
  }

  function removeAtLocation(loc) {
    const row = board[loc.rowIndex];
    const cell = row.cells[loc.col];
    if (row.moving) {
      if (cell.itemEl) cell.itemEl.remove();
      cell.itemEl = null;
      cell.stack.pop();
    } else {
      cell.stack.splice(loc.depthIndex, 1);
    }
  }

  // The hammer clears a whole matching triple at once (the tapped item
  // plus two more of the same type pulled from anywhere on the board —
  // stack tops preferred for a cleaner pop, buried ones if that's all
  // that's left) rather than a single item. Removing items one at a time
  // would leave 1 or 2 stragglers of a type that can never line up into
  // a 3-in-a-row again, softlocking the level.
  function hammerClearType(type, tappedLoc) {
    const rest = findByType(type).filter(
      (loc) => !(loc.rowIndex === tappedLoc.rowIndex && loc.col === tappedLoc.col && loc.depthIndex === tappedLoc.depthIndex)
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

  function onPointerDown(e) {
    if (drag) return;
    const el = e.currentTarget;
    const rowIndex = Number(el.dataset.row);
    const col = Number(el.dataset.col);
    const row = board[rowIndex];
    const cell = row.cells[col];
    const top = topOf(cell.stack);
    if (!top) return;

    if (hammerActive) {
      e.preventDefault();
      const oldRects = captureRects();
      const tappedLoc = { rowIndex, col, depthIndex: cell.stack.length - 1 };
      pushHistory();
      hammerClearType(top.type, tappedLoc);
      hammers -= 1;
      hammerActive = false;
      save(KEYS.hammers, hammers);
      resolveTriples();
      checkWin();
      renderStaticRows();
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

    drag = { pointerId: e.pointerId, rowIndex, col, el, ghost };

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
    // Only static cells (.slot) are valid drop targets — moving-row
    // slots (.beltSlot) are a different class, so they're never matched
    // here: items only ever come off a moving row, never get parked
    // back onto one.
    const slotEl = dropTarget && dropTarget.closest('.slot');

    if (slotEl) {
      const targetRow = Number(slotEl.dataset.row);
      const targetCol = Number(slotEl.dataset.col);
      attemptMove(drag.rowIndex, drag.col, targetRow, targetCol);
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
    renderStaticRows();
    applyFlip(oldRects);
  }

  function pushHistory() {
    history.push({
      rows: board.map((row) => row.cells.map((cell) => cell.stack.map((item) => ({ ...item })))),
      moves,
    });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  // A move only ever drops the top item of a stack into a completely
  // empty cell — never a direct swap onto another stack. That scarcity
  // of empty cells, combined with items being physically hidden until
  // uncovered, is the whole puzzle. The source can be a static cell or a
  // moving-row slot; the target is always static (moving slots are never
  // valid drop targets, enforced in onPointerUp).
  function attemptMove(sourceRow, sourceCol, targetRow, targetCol) {
    const target = board[targetRow].cells[targetCol];
    if (target.stack.length > 0) return; // target must be a genuinely empty cell

    const sourceRowObj = board[sourceRow];
    const source = sourceRowObj.cells[sourceCol];
    const top = topOf(source.stack);
    if (!top) return;
    if (sourceRow === targetRow && sourceCol === targetCol) return;

    pushHistory();
    source.stack.pop();
    target.stack.push(top);
    if (sourceRowObj.moving && source.itemEl) {
      source.itemEl.remove();
      source.itemEl = null;
    }

    moves += 1;
    resolveTriples();
    checkWin();
  }

  function resolveTriples() {
    let clearedAny = true;
    while (clearedAny) {
      clearedAny = false;
      for (const row of board) {
        if (row.moving) continue;
        for (let i = 0; i <= COLS - 3; i++) {
          const a = topOf(row.cells[i].stack), b = topOf(row.cells[i + 1].stack), c = topOf(row.cells[i + 2].stack);
          if (a && b && c && a.type === b.type && c.type === b.type) {
            // Grab the slot rects before rendering wipes this frame's DOM, so
            // the clear pop appears exactly where the trio was sitting.
            const rects = [i, i + 1, i + 2].map((col) => {
              const slotEl = row.rowEl.children[col];
              return slotEl ? slotEl.getBoundingClientRect() : null;
            });
            row.cells[i].stack.pop();
            row.cells[i + 1].stack.pop();
            row.cells[i + 2].stack.pop();
            clearedAny = true;
            stars += 1;
            save(KEYS.stars, stars);
            rects.forEach((rect) => spawnPopGhost(rect, a.type));
            const midRect = rects[1] || rects[0] || rects[2];
            if (midRect) spawnStarFloat(midRect.left + midRect.width / 2, midRect.top);
            break;
          }
        }
        if (clearedAny) break;
      }
    }
  }

  function undo() {
    if (undos <= 0 || history.length === 0) return;
    const oldRects = captureRects();
    const prev = history.pop();

    prev.rows.forEach((rowSnapshot, r) => {
      const row = board[r];
      rowSnapshot.forEach((stackSnapshot, c) => {
        const cell = row.cells[c];
        cell.stack = stackSnapshot;
        if (!row.moving) return;
        // Moving-row DOM is persistent, so sync it by hand rather than
        // through the usual full static-row rebuild.
        const top = topOf(cell.stack);
        if (top && !cell.itemEl) {
          cell.itemEl = makeItemEl(top, r, c, cell.stack.length, true);
          cell.slotEl.appendChild(cell.itemEl);
        } else if (!top && cell.itemEl) {
          cell.itemEl.remove();
          cell.itemEl = null;
        }
      });
    });

    moves = prev.moves;
    undos -= 1;
    save(KEYS.undos, undos);
    renderStaticRows();
    applyFlip(oldRects);
  }

  function toggleHammer() {
    if (hammers <= 0) return;
    hammerActive = !hammerActive;
    updateHud();
  }

  function checkWin() {
    const allClear = board.every((row) => row.cells.every((cell) => cell.stack.length === 0));
    if (allClear) {
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
