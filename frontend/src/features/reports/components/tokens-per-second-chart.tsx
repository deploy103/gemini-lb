import { useTranslation } from "react-i18next";
import { DitherPattern } from "@/components/dither-pattern";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "@/components/lazy-recharts";
import type { DailyReportRow } from "../schemas";
import { buildContinuousDailyRows } from "../daily-series";
import { ChartTooltip } from "./chart-tooltip";
import { ReportChartCard } from "./report-chart-card";

export type TokensPerSecondChartProps = {
  startDate: string;
  endDate: string;
  data: DailyReportRow[];
};

function formatTps(value: number): string {
  return value.toFixed(1);
}

export function TokensPerSecondChart({ startDate, endDate, data }: TokensPerSecondChartProps) {
  const { t } = useTranslation();
  const chartData = buildContinuousDailyRows(startDate, endDate, data).map((d) => ({
    date: d.date.slice(5),
    tps: d.medianTps ?? 0,
  }));

  return (
    <ReportChartCard title={t("reports.charts.tokensPerSecond")} empty={data.length === 0}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <defs>
              <DitherPattern id="tpsGrad" color="#10b981" />
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatTps}
            />
            <Tooltip
              content={<ChartTooltip names={{ tps: t("reports.charts.medianTps") }} formatValue={formatTps} />}
            />
            <Area
              type="monotone"
              dataKey="tps"
              stroke="#10b981"
              strokeWidth={2}
              fill="url(#tpsGrad)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 1.5, fill: "hsl(var(--popover))" }}
            />
          </AreaChart>
        </ResponsiveContainer>
    </ReportChartCard>
  );
}
