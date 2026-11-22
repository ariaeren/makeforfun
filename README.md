# Push-optimal Sokoban solver

A self-contained Node 22 program for the `sokoban-solver-01` bounty kit.

## Approach

- Parse XSB levels into flat typed arrays.
- Decompose each board into independent rooms by cutting the dead squares of the
  player's hallway out of the floor. Levels from this generator have one door per
  room and boxes that cannot leave their room, so room optima add up to the level's
  push optimum.
- Solve each room with breadth-first search **over pushes**. A state is the sorted
  box positions plus the player's reachable region (identified by its lowest
  square). BFS over pushes finds the fewest-push solution first.
- Prune boxes on squares from which no box can reach a goal (reverse-pull closure),
  and box configurations frozen in a 2x2 block of walls/boxes containing a box off
  its goal. Both prunings are sound, so optimality is preserved.
- Stitch the rooms together with shortest deterministic walks between pushes.
- Fall back to the same push search on the whole level if room decomposition fails.

The search is bounded by fixed state counters, never by wall-clock time. All
iteration orders are fixed (u, d, l, r and square order), so repeated runs write
byte-identical solutions. No dependencies, native code, network or randomness.

## Usage

```sh
mkdir -p /output
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

It writes `/output/<id>/solution.txt` for every `<id>` directory under the input
directory. Licensed under MIT; see `LICENSE`.
