import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Gauge, PlugZap, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DeviceGlyph,
  EmptyState,
  LiveBadge,
  PageHeader,
  Panel,
  PanelTitle,
  Stat,
} from "@/components/sp/primitives";
import { getLocalDevices, getUsage, messageOf } from "@/lib/smartpilot/backend-api";
import { getDevice } from "@/lib/smartpilot/devices";

export const Route = createFileRoute("/energy")({
  head: () => ({
    meta: [
      { title: "Energy — Smart Pilot Titanium Control" },
      {
        name: "description",
        content:
          "Measured energy use from verified local readings, recorded on this device.",
      },
      { property: "og:title", content: "Energy — Smart Pilot Titanium Control" },
      {
        property: "og:description",
        content: "Real per-device energy readings from the local backend.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: EnergyPage,
});

interface UsageDevice {
  id: string;
  kwh: number;
}

interface UsageResponse {
  today?: string;
  total_kwh?: number;
  devices?: UsageDevice[];
  ac?: unknown;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function label(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parseUsage(raw: unknown): UsageResponse {
  const result: UsageResponse = {};
  if (!raw || typeof raw !== "object") return result;
  const data = raw as Record<string, unknown>;
  const today = label(data["today"]);
  if (today) result.today = today;
  const total = numberOrNull(data["total_kwh"]);
  if (total !== null) result.total_kwh = total;
  const rows = data["devices"];
  if (Array.isArray(rows)) {
    const devices: UsageDevice[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      const id = label(item["id"]);
      const kwh = numberOrNull(item["kwh"]);
      if (id && kwh !== null) devices.push({ id, kwh });
    }
    result.devices = devices;
  }
  return result;
}

function kwh(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(3)} kWh`;
}

function EnergyPage() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [backendNames, setBackendNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(parseUsage(await getUsage()));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void getLocalDevices()
      .then((reply) => {
        const map: Record<string, string> = {};
        for (const row of reply.devices ?? []) map[row.id] = row.name;
        setBackendNames(map);
      })
      .catch(() => { /* keep raw backend ids as fallback */ });
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const readings = usage?.devices ?? [];
  const max = readings.reduce((acc, item) => Math.max(acc, item.kwh), 0);
  const total = numberOrNull(usage?.total_kwh) ?? readings.reduce((acc, item) => acc + item.kwh, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Energy"
        sub="Measured use from verified local readings. Values are recorded on this device, never estimated."
        eyebrow={<LiveBadge />}
        actions={
          <Button variant="glass" size="touch" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />

      <Panel variant="inset" pad="sm" className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <PlugZap className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {usage?.today ? `Usage recorded on ${usage.today}` : "Today's recorded usage"}
          </p>
          <p className="text-sm text-muted-foreground">
            Only readings sampled from verified local devices are shown here. Nothing is estimated.
          </p>
        </div>
        <Button asChild variant="glass" size="touch">
          <Link to="/settings">Integration status</Link>
        </Button>
      </Panel>

      {error && (
        <Panel pad="sm">
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="min-w-0 flex-1 break-words text-sm text-status-offline">
              Could not load usage: {error}
            </p>
            <Button type="button" size="sm" variant="glass" onClick={() => void load()}>
              <RefreshCw /> Retry
            </Button>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Panel pad="sm">
          <Stat label="Total today" value={kwh(total)} hint="Measured" />
        </Panel>
        <Panel pad="sm">
          <Stat label="Devices reporting" value={String(readings.length)} hint="This device" />
        </Panel>
        <Panel pad="sm">
          <Stat label="Reading date" value={usage?.today ?? "—"} hint="Local day" />
        </Panel>
      </div>

      <Panel>
        <PanelTitle icon={Gauge}>Per-device readings (kWh today)</PanelTitle>
        {loading ? (
          <div className="space-y-3" role="status" aria-label="Loading energy readings">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-2xl bg-muted/50" />
            ))}
          </div>
        ) : readings.length === 0 ? (
          <EmptyState
            icon={PlugZap}
            title="No energy readings recorded yet"
            body="Real values appear here after the local backend samples a verified power reading from a device."
          />
        ) : (
          <div className="overflow-x-hidden">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Real energy readings recorded today</caption>
              <thead>
                <tr className="border-b border-glass-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Device
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    kWh today
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Relative use
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-glass-border">
                {readings.map((item) => {
                  // Static catalogue supplies kind/category for the glyph; the live
                  // backend name takes precedence for the visible label.
                  const device = getDevice(item.id);
                  const name = backendNames[item.id] ?? device?.name ?? item.id;
                  const pct = max > 0 ? Math.round((item.kwh / max) * 100) : 0;
                  return (
                    <tr key={item.id} className="align-middle">
                      <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                        <span className="flex min-w-0 items-center gap-2">
                          {device ? (
                            <DeviceGlyph device={device} size="sm" />
                          ) : (
                            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                              <PlugZap className="size-4" aria-hidden />
                            </span>
                          )}
                          <span className="min-w-0 break-words">{name}</span>
                        </span>
                      </th>
                      <td className="py-2.5 pr-3 font-display tabular">{kwh(item.kwh)}</td>
                      <td className="py-2.5">
                        <span
                          className="block h-2 min-w-[4px] max-w-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                          aria-hidden
                        />
                        <span className="sr-only">{pct}% of the highest reading</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
