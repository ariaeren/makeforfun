// Deterministic, push-optimal Sokoban solver for the make.fun sokoban-solver-01 kit.
//
// Strategy
//   1. Parse the XSB level into flat arrays.
//   2. Split the board into independent rooms by cutting the dead squares of the
//      player's hallway out of the floor. A room holds equally many boxes and goals.
//   3. Solve each room with a breadth-first search over PUSHES. A state is the sorted
//      box positions plus the player's reachable region (named by its lowest square).
//      BFS discovers states in nondecreasing push count, so the first solved state is
//      push-optimal. Two sound prunings keep the search small:
//        - a square from which no box can ever reach a goal (reverse-pull closure);
//        - a freshly pushed box frozen in a 2x2 block of walls/boxes with a box off goal.
//   4. Stitch the rooms' push sequences together with shortest walks between pushes.
//
// Everything is driven by work counters, never by the clock or randomness; iteration
// orders are fixed, so two runs write byte-identical answers.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Fixed work budgets (states kept by one search). The generator only keeps rooms whose optimum is found well below this. */
const ROOM_STATE_LIMIT = 300_000;
const WHOLE_STATE_LIMIT = 300_000;

/** Direction order u, d, l, r: the same order is used for every tie, everywhere. */
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

function parseLevel(text) {
  const rows = text.split('\n').filter((row) => row.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((row) => row.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;

  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // Nothing can leave the outermost frame, whatever it shows in the text.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return {
    w, h, size, wall, player,
    goals: goals.sort((a, b) => a - b),
    boxes: boxes.sort((a, b) => a - b),
  };
}

/** Deltas in the u, d, l, r order for a board `w` squares wide. */
function deltasOf(w) {
  return [-w, w, -1, 1];
}

/**
 * Squares a box alone can be pushed onto some goal from: start at the goals and
 * repeatedly pull a box backwards one square across two open squares.
 */
function liveSquares(level, delta) {
  const { wall, goals, size } = level;
  const live = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (const g of goals) {
    if (!live[g]) {
      live[g] = 1;
      queue[tail++] = g;
    }
  }
  while (head < tail) {
    const x = queue[head++];
    for (let k = 0; k < 4; k++) {
      const y = x - delta[k];
      const behind = y - delta[k];
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (wall[y] === 0 && wall[behind] === 0 && live[y] === 0) {
        live[y] = 1;
        queue[tail++] = y;
      }
    }
  }
  return live;
}

/** Flood-fill the player's free region from `from`, marking it with `stamp`; return its lowest square. */
function reachLowest(wall, occupied, from, delta, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + delta[k];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Is `t` part of a 2x2 block of walls/boxes that holds a box off its goal? */
function frozenBlock(wall, occupied, goal, t, w) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    const fa = wall[a] || occupied[a];
    const fb = wall[b] || occupied[b];
    const fc = wall[c] || occupied[c];
    const fd = wall[d] || occupied[d];
    if (!fa || !fb || !fc || !fd) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) ||
        (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and boxes. Ties go to the first
 * direction in u,d,l,r, which makes the emitted move string deterministic.
 */
function walkTo(wall, occupied, from, to, delta) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  prev[from] = from;
  while (head < tail && prev[to] === -1) {
    const p = queue[head++];
    for (let k = 0; k < 4; k++) {
      const q = p + delta[k];
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue[tail++] = q;
    }
  }
  if (prev[to] === -1) return '';
  let path = '';
  for (let p = to; p !== from; p = prev[p]) path = STEP[how[p]] + path;
  return path;
}

/**
 * Breadth-first search over pushes. Returns { pushes, moves }, or null when the
 * state budget is exhausted (or the level is unsolvable).
 */
function solvePushes(level, limit) {
  const { w, size, wall, goals, boxes, player } = level;
  if (boxes.length === 0) return { pushes: 0, moves: '' };

  const delta = deltasOf(w);
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level, delta);
  for (const b of boxes) if (!live[b]) return null;

  const solved = (bs) => {
    for (const b of bs) if (!goal[b]) return false;
    return true;
  };

  // A compact exact key: base `size` digits. Numeric while it stays below 2^53;
  // whole-level fallbacks with many boxes use the string form instead.
  const numeric = Math.pow(size, boxes.length + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (bs, low) => {
    if (!numeric) return `${low}:${bs.join(',')}`;
    let k = low;
    for (let i = 0; i < bs.length; i++) k = k * size + bs[i];
    return k;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);   // region marks of expanded states
  const mark = new Int32Array(size);   // region marks of newly created states
  const stack = new Int32Array(size);
  let stamp = 0;

  // State i: the boxes, the square the player pushed from, the box's old/new square,
  // the direction of the push, and the parent state.
  const stateBoxes = [boxes.slice()];
  const statePlayer = [player];
  const fromSquare = [-1];
  const toSquare = [-1];
  const direction = [-1];
  const parent = [-1];
  const index = new Map();

  for (const b of boxes) occupied[b] = 1;
  const low0 = reachLowest(wall, occupied, player, delta, seen, ++stamp, stack);
  index.set(keyOf(boxes, low0), 0);
  for (const b of boxes) occupied[b] = 0;

  let found = solved(boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const bs = stateBoxes[head];
    for (const b of bs) occupied[b] = 1;
    const here = ++stamp;
    reachLowest(wall, occupied, statePlayer[head], delta, seen, here, stack);

    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = delta[k];
        const from = b - d;
        if (seen[from] !== here) continue;
        const t = b + d;
        if (wall[t] || occupied[t] || !live[t]) continue;

        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(wall, occupied, goal, t, w);
        let key;
        let next = null;
        let lowNext = -1;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          lowNext = reachLowest(wall, occupied, b, delta, mark, ++stamp, stack);
          key = keyOf(next, lowNext);
        }
        occupied[t] = 0;
        occupied[b] = 1;

        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= limit) {
          for (const x of bs) occupied[x] = 0;
          return null;
        }
        const id = stateBoxes.length;
        index.set(key, id);
        stateBoxes.push(next);
        statePlayer.push(b);
        fromSquare.push(b);
        toSquare.push(t);
        direction.push(k);
        parent.push(head);
        if (solved(next)) {
          found = id;
          break;
        }
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Walk back through the states, then turn each push into a walk plus a push letter.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();

  let moves = '';
  let playerNow = player;
  let boxesNow = boxes.slice();
  for (const s of path) {
    const from = fromSquare[s];
    const to = toSquare[s];
    const d = to - from;
    for (const b of boxesNow) occupied[b] = 1;
    moves += walkTo(wall, occupied, playerNow, from - d, delta);
    for (const b of boxesNow) occupied[b] = 0;
    moves += PUSH[direction[s]];
    const at = boxesNow.indexOf(from);
    boxesNow[at] = to;
    boxesNow.sort((x, y) => x - y);
    playerNow = from;
  }
  return { pushes: path.length, moves };
}

/**
 * Rooms are the components of the floor after removing the dead squares of the
 * player's row. Returns null when the board is not a set of independent rooms.
 */
function roomsOf(level) {
  const { w, size, wall, goals, boxes, player } = level;
  const delta = deltasOf(w);
  const live = liveSquares(level, delta);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;

  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let qi = 0; qi < squares.length; qi++) {
      const p = squares[qi];
      for (let k = 0; k < 4; k++) {
        const q = p + delta[k];
        if (q < 0 || q >= size || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r].boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  for (const r of rooms) {
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Square reached after replaying a move string from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    if (ch === 'u' || ch === 'U') p -= w;
    else if (ch === 'd' || ch === 'D') p += w;
    else if (ch === 'l' || ch === 'L') p -= 1;
    else p += 1;
  }
  return p;
}

function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);

  if (rooms === null) {
    const whole = solvePushes(level, WHOLE_STATE_LIMIT);
    return whole === null ? '' : whole.moves;
  }

  let player = level.player;
  let moves = '';
  const done = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    // Solved rooms are walls on their goals; unsolved rooms are walls on their boxes.
    const wall = level.wall.slice();
    for (let rj = 0; rj < rooms.length; rj++) {
      if (rj === ri) continue;
      const cells = done[rj] ? rooms[rj].goals : rooms[rj].boxes;
      for (const c of cells) wall[c] = 1;
    }
    const sub = {
      w: level.w, h: level.h, size: level.size, wall,
      goals: rooms[ri].goals.slice(),
      boxes: rooms[ri].boxes.slice(),
      player,
    };
    const part = solvePushes(sub, ROOM_STATE_LIMIT);
    if (part === null) return '';
    moves += part.moves;
    player = endOf(level.w, player, part.moves);
    done[ri] = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
