/** A QR code drawn as dots with rounded corner squares and a hole for a logo, from any encoder's module grid. */
export interface QrArt {
  /** Modules per side, without a quiet zone. */
  size: number;
  /** Every data module as a dot, in one SVG path in module units. */
  dots: string;
  /** The three corner squares: an outlined rounded square and a filled one inside it. */
  finders: string;
  /** Where the logo goes, in module units, or null when there's no room for one. */
  logo: { x: number; y: number; size: number } | null;
}

const DOT_RADIUS = 0.45;

/** Share of the side the logo may cover. The caller encodes at level H, which survives about 30% loss. */
const LOGO_SHARE = 0.24;

/** `modules[y][x]` is true for a dark module. */
export function qrArt(modules: readonly (readonly boolean[])[], { logo = true }: { logo?: boolean } = {}): QrArt {
  const size = modules.length;
  const inFinder = (x: number, y: number) => (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);

  let hole = logo ? Math.round(size * LOGO_SHARE) : 0;
  if (hole > 0 && hole % 2 !== size % 2) hole += 1;
  const start = (size - hole) / 2;
  const inHole = (x: number, y: number) => hole > 0 && x >= start && x < start + hole && y >= start && y < start + hole;

  let dots = "";
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark || inFinder(x, y) || inHole(x, y)) return;
      const top = y + 0.5 - DOT_RADIUS;
      const d = DOT_RADIUS * 2;
      dots += `M${x + 0.5} ${top}a${DOT_RADIUS} ${DOT_RADIUS} 0 1 1 0 ${d}a${DOT_RADIUS} ${DOT_RADIUS} 0 1 1 0 -${d}z`;
    }),
  );

  let finders = "";
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    finders += roundedSquare(x, y, 7, 2.2) + roundedSquare(x + 1, y + 1, 5, 1.4, true) + roundedSquare(x + 2, y + 2, 3, 1);
  }

  return { size, dots, finders, logo: hole > 0 ? { x: start, y: start, size: hole } : null };
}

/** Counter-clockwise when `hole`, so with the nonzero fill rule it cuts out of the square around it. */
function roundedSquare(x: number, y: number, side: number, r: number, hole = false): string {
  const s = side - 2 * r;
  return hole
    ? `M${x + r} ${y}a${r} ${r} 0 0 0 -${r} ${r}v${s}a${r} ${r} 0 0 0 ${r} ${r}h${s}a${r} ${r} 0 0 0 ${r} -${r}v-${s}a${r} ${r} 0 0 0 -${r} -${r}z`
    : `M${x + r} ${y}h${s}a${r} ${r} 0 0 1 ${r} ${r}v${s}a${r} ${r} 0 0 1 -${r} ${r}h-${s}a${r} ${r} 0 0 1 -${r} -${r}v-${s}a${r} ${r} 0 0 1 ${r} -${r}z`;
}
