import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { qrArt } from "./qrArt.ts";

const grid = (size: number) => Array.from({ length: size }, () => Array.from({ length: size }, () => true));
const dots = (path: string) => path.split("M").length - 1;

describe("qrArt", () => {
  it("draws every dark module outside the corners and the logo as a dot", () => {
    const art = qrArt(grid(25));
    assert.deepEqual(art.logo, { x: 9, y: 9, size: 7 }, "centred, odd like the grid, about a quarter of the side");
    assert.equal(dots(art.dots), 25 * 25 - 3 * 49 - 7 * 7);
    assert.equal(dots(art.finders), 9, "three nested squares in each of the three corners");
  });

  it("keeps the middle when there's no logo", () => {
    const art = qrArt(grid(21), { logo: false });
    assert.equal(art.logo, null);
    assert.equal(dots(art.dots), 21 * 21 - 3 * 49);
  });

  it("leaves light modules out", () => {
    const g = grid(21).map((row) => row.map(() => false));
    g[10][12] = true;
    assert.equal(qrArt(g, { logo: false }).dots, "M12.5 10.05a0.45 0.45 0 1 1 0 0.9a0.45 0.45 0 1 1 0 -0.9z");
  });
});
