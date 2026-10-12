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
import { formatCurrency } from "@/utils/formatters";
import { ChartTooltip } from "./chart-tooltip";
import { ReportChartCard } from "./report-chart-card";

export type CostPerDayChartProps = {
  startDate: string;
  endDate: string;
  data: DailyReportRow[];
};

export function CostPerDayChart({ startDate, endDate, data }: CostPerDayChartProps) {
  const { t } = useTranslation();
  const chartData = buildContinuousDailyRows(startDate, endDate, data).map((d) => ({
    date: d.date.slice(5),
    cost: d.costUsd,
  }));

  return (
    <ReportChartCard title={t("reports.charts.costByDay")} empty={data.length === 0}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <defs>
              <DitherPattern id="costGrad" color="#3b82f6" />
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
              tickFormatter={formatCurrency}
            />
            <Tooltip
              content={<ChartTooltip names={{ cost: t("reports.dailyBreakdown.columns.cost") }} formatValue={formatCurrency} />}
            />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#costGrad)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 1.5, fill: "hsl(var(--popover))" }}
            />
          </AreaChart>
        </ResponsiveContainer>
    </ReportChartCard>
  );
}
