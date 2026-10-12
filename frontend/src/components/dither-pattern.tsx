import { BAYER } from "@/components/dither-kit/dither-paint";

/** Dither Kit's ordered threshold texture inside the retained Recharts SVG.
 * Only the paint changes: domains, gaps, tooltips and selection stay upstream. */
export function DitherPattern({ id, color, hatched = false }: {
  id: string;
  color: string;
  hatched?: boolean;
}) {
  return (
    <pattern id={id} width={8} height={8} patternUnits="userSpaceOnUse">
      {BAYER.flatMap((row, y) => row.map((threshold, x) => (
        <rect key={`${x}-${y}`} x={x * 2} y={y * 2} width={2} height={2}
          fill={color} opacity={hatched && ((x + y) & 3) >= 2 ? 0 : threshold < 0.5 ? 0.45 : 0.10} />
      )))}
    </pattern>
  );
}
