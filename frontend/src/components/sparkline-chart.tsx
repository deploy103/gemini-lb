import { useMemo } from "react";
import { Sparkline } from "@/components/dither-kit/sparkline";
import { isDitherColor } from "@/components/dither-kit/palette";

import { useReducedMotion } from "@/hooks/use-reduced-motion";

export type SparklineChartProps = {
  data: { value: number }[];
  color: string;
  index: number;
  height?: number;
};

export function SparklineChart({ data, color, index, height = 40 }: SparklineChartProps) {
  const reducedMotion = useReducedMotion();
  const values = useMemo(() => data.map((point) => point.value), [data]);
  const seed = isDitherColor(color) ? color : index % 2 === 0 ? "blue" : "purple";

  return (
    <div style={{ height }} aria-hidden="true">
      <Sparkline data={values} color={seed} variant={index % 2 === 0 ? "gradient" : "hatched"}
        bloom={{ blur: 4, brightness: 1.2, opacity: 0.12 }} animate={!reducedMotion} className="h-full w-full" />
    </div>
  );
}
