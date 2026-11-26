import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Clock,
  Loader2,
  Network,
  Power,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSmartPilot } from "@/lib/smartpilot/store";
import { adapter } from "@/lib/smartpilot/adapter";
import {
  decodePhaseDp,
  formatPointValue,
  isMeterPoint,
  isPhasePoint,
  PHASE_READINGS,
} from "@/lib/smartpilot/local-backend-adapter";
import { evaluateDeviceAction } from "@/lib/smartpilot/climate";
import type { Device } from "@/lib/smartpilot/types";
import {
  ApprovalPill,
  CapabilityPill,
  ConnectionPill,
  DeviceGlyph,
  LiveNotice,
} from "./primitives";
import { cn } from "@/lib/utils";

export const ECOSYSTEM_LABEL: Record<Device["ecosystem"], string> = {
  haier_haismart: "Haier HaiSmart",
  tuya_smart_life: "Smart Life / Tuya",
};

export const KIND_LABEL: Record<Device["kind"], string> = {
  air_conditioner: "Air conditioner",
  water_pump: "Water motor",
  breaker: "Circuit breaker",
  water_heater: "Water heater",
};

export function ApprovalDialog({
  open,
  onOpenChange,
  title,
  description,
  onApprove,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  onApprove: () => void;
}) {
  const { t } = useSmartPilot();
  const [ack, setAck] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setAck(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-status-preview" aria-hidden />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-glass-border bg-muted/40 p-3.5 text-sm">
          <Checkbox
            checked={ack}
            onCheckedChange={(v) => setAck(v === true)}
            className="mt-0.5"
          />
          <span>I understand this is a high-risk load and I am approving it explicitly.</span>
        </label>
        <p className="flex items-start gap-2 text-xs text-muted-foreground" role="note">
          <ShieldAlert className="mt-px size-3.5 shrink-0 text-status-preview" aria-hidden />
          <span>Approval is recorded locally; the backend still enforces safety checks.</span>
        </p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="touch" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="approve"
            size="touch"
            disabled={!ack}
            onClick={() => {
              onApprove();
              setAck(false);
              onOpenChange(false);
            }}
          >
            <ShieldCheck className="size-4" aria-hidden />
            {t("approve")} &amp; send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function DeviceSheet({
  device,
  onOpenChange,
}: {
  device: Device | null;
  onOpenChange: (o: boolean) => void;
}) {
  const {
    t,
    connection,
    sendDeviceCommand,
    sendDpCommand,
    points,
    deviceHistory,
    log,
  } = useSmartPilot();
  const [pending, setPending] = useState<null | "on" | "off">(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dpError, setDpError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const armTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    };
  }, []);

  useEffect(() => {
    setArmed(null);
    setDpError(null);
    setPending(null);
  }, [device?.id]);

  const runPower = async (d: Device, value: "on" | "off", approved: boolean) => {
    setBusy(true);
    try {
      await sendDeviceCommand(
        d.id,
        { type: "power", value },
        approved
          ? { approvedBy: "local-user", approvedAt: new Date().toISOString() }
          : undefined,
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const request = (d: Device, value: "on" | "off") => {
    const verdict = evaluateDeviceAction(d, false);
    if (!verdict.allowed) {
      setPending(value);
      return;
    }
    void runPower(d, value, true);
  };

  const requestDp = async (
    d: Device,
    point: { dp: string; code: string; type: string; value?: unknown },
    value: unknown,
  ) => {
    setDpError(null);
    if (d.requiresApproval && armed !== point.dp) {
      setArmed(point.dp);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => {
        if (mountedRef.current) setArmed(null);
      }, 4500);
      log({
        kind: "safety",
        status: "warning",
        title: `${d.name}: ${point.code} armed — tap again to confirm`,
        deviceId: d.id,
      });
      return;
    }

    setBusy(true);
    try {
      await sendDpCommand(
        d.id,
        point.dp,
        value,
        d.requiresApproval
          ? { approvedBy: "local-user-two-tap", approvedAt: new Date().toISOString() }
          : undefined,
      );
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setArmed(null);
      }
    }
  };

  const devicePoints = device ? (points[device.id] ?? []) : [];
  const phasePoints = devicePoints.filter((point) => isPhasePoint(point));
  const controlPoints = devicePoints.filter((point) => !isPhasePoint(point));
  const usefulPoints = controlPoints.filter(
    (point) =>
      isMeterPoint(point) ||
      /switch|relay|onoff|power|clear_energy/i.test(point.code) ||
      /bool/i.test(point.type),
  );
  const rawCount = controlPoints.length - usefulPoints.length;
  const visiblePoints = showRaw ? controlPoints : usefulPoints;
  const history = device ? (deviceHistory[device.id] ?? null) : null;

  return (
    <Sheet open={!!device} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-glass-border sm:max-w-md"
      >
        {device && (
          <div className="space-y-4 pb-4">
            <SheetHeader className="text-left">
              <div className="flex items-center gap-3">
                <DeviceGlyph device={device} size="lg" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate tracking-tight">{device.name}</SheetTitle>
                  <SheetDescription className="truncate">
                    {KIND_LABEL[device.kind]} · {device.location ?? t("room_not_set")}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            {/* Connectivity */}
            <section
              className="rounded-2xl border border-glass-border bg-muted/30 p-4"
              aria-labelledby="conn-h"
            >
              <h3
                id="conn-h"
                className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <Network className="size-3.5 text-primary" aria-hidden />
                {t("connectivity")}
              </h3>
              <div className="divide-y divide-border/60">
                <Row label="Status">
                  <ConnectionPill status={device.connection} />
                </Row>
                <Row label="Ecosystem">{ECOSYSTEM_LABEL[device.ecosystem]}</Row>
                <Row label="Adapter">{adapter.label}</Row>
                <Row label="Backend">
                  <span className="text-xs text-muted-foreground">{connection.message}</span>
                </Row>
                <Row label="Last seen">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground tabular">
                    <Clock className="size-3.5" aria-hidden />
                    {device.lastSeen.known
                      ? new Date(device.lastSeen.value).toLocaleString()
                      : t("status_unknown")}
                  </span>
                </Row>
                <Row label={t("power")}>
                  <span className="font-medium tabular">
                    {device.power.known ? device.power.value.toUpperCase() : t("status_unknown")}
                  </span>
                </Row>
              </div>
            </section>

            {/* Controls */}
            <section
              className="rounded-2xl border border-glass-border bg-muted/30 p-4"
              aria-labelledby="ctrl-h"
            >
              <h3
                id="ctrl-h"
                className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                <Power className="size-3.5 text-primary" aria-hidden />
                {t("controls")}
              </h3>
              {device.kind === "air_conditioner" ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Full Manual/Auto, temperature, mode, and fan controls live on the Climate
                    screen.
                  </p>
                  <Button asChild variant="hero" size="touch" className="w-full">
                    <Link to="/climate" onClick={() => onOpenChange(false)}>
                      {t("openClimate")}
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {device.requiresApproval && <ApprovalPill />}
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="glass"
                      size="touch"
                      data-critical={device.requiresApproval ? "true" : undefined}
                      disabled={busy || connection.state === "refreshing"}
                      aria-busy={busy}
                      className="active:scale-[0.98]"
                      onClick={() => request(device, "on")}
                    >
                      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                      Turn on
                    </Button>
                    <Button
                      variant="glass"
                      size="touch"
                      data-critical={device.requiresApproval ? "true" : undefined}
                      disabled={busy || connection.state === "refreshing"}
                      aria-busy={busy}
                      className="active:scale-[0.98]"
                      onClick={() => request(device, "off")}
                    >
                      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                      Turn off
                    </Button>
                  </div>
                  <div className="divide-y divide-border/60">
                    <Row label="Power switch">
                      <CapabilityPill status={device.capabilities.power} />
                    </Row>
                    <Row label="Timer">
                      <CapabilityPill status={device.capabilities.timer} />
                    </Row>
                    <Row label="Energy metering">
                      <CapabilityPill status={device.capabilities.energyMetering} />
                    </Row>
                  </div>
                </div>
              )}
              <LiveNotice className="mt-3" />
            </section>

            {/* Verified data points */}
            {device.kind !== "air_conditioner" && devicePoints.length > 0 && (
              <section
                className="rounded-2xl border border-glass-border bg-muted/30 p-4"
                aria-labelledby="dps-h"
              >
                <h3
                  id="dps-h"
                  className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  <Power className="size-3.5 text-primary" aria-hidden />
                  Verified data points
                </h3>

                {phasePoints.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {phasePoints.map((point) => {
                      const decoded = decodePhaseDp(point.value);
                      return (
                        <div
                          key={`phase-${point.dp}`}
                          className="rounded-xl border border-glass-border bg-background/40 p-3"
                        >
                          <p className="text-xs text-muted-foreground tabular">
                            {point.code || `DP ${point.dp}`} · DP {point.dp} · Read-only
                          </p>
                          {decoded ? (
                            <dl className="mt-2 grid grid-cols-3 gap-2">
                              {PHASE_READINGS.map((reading) => (
                                <div key={reading.key} className="min-w-0">
                                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                    {reading.label}
                                  </dt>
                                  <dd className="font-display text-sm font-medium tabular">
                                    {decoded[reading.key].toFixed(reading.digits)}{" "}
                                    <span className="text-xs font-normal text-muted-foreground">
                                      {reading.unit}
                                    </span>
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              Packed payload could not be decoded, so no value is shown.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {dpError && (
                  <p className="mb-2 text-xs text-status-offline" role="alert">
                    {dpError}
                  </p>
                )}

                <div className="divide-y divide-border/60">
                  {visiblePoints.map((point) => {
                    const isBool = /bool/i.test(point.type);
                    const isNum = /int|number/i.test(point.type);
                    const readOnly = isMeterPoint(point);
                    const draftKey = `${device.id}:${point.dp}`;
                    const current =
                      draft[draftKey] ??
                      (point.value === undefined ? "" : String(point.value));
                    const isArmed = armed === point.dp;

                    return (
                      <div key={point.dp} className="py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 text-sm">
                            <span className="font-medium">{point.code || `DP ${point.dp}`}</span>
                            <span className="ml-1.5 text-xs text-muted-foreground tabular">
                              DP {point.dp} · {point.type || "unknown"}
                            </span>
                          </span>
                          {readOnly ? (
                            <span className="shrink-0 text-right font-display text-sm tabular">
                              {formatPointValue(point)}
                              <span className="ml-1 block text-[11px] font-sans font-normal text-muted-foreground">
                                Read-only
                              </span>
                            </span>
                          ) : isBool ? (
                            <Switch
                              checked={
                                point.value === true ||
                                point.value === 1 ||
                                point.value === "1"
                              }
                              data-critical={device.requiresApproval ? "true" : undefined}
                              disabled={busy || connection.state === "refreshing"}
                              aria-label={`Set ${point.code || point.dp}`}
                              onCheckedChange={(value) => void requestDp(device, point, value)}
                            />
                          ) : (
                            <div className="flex items-center gap-2">
                              <input
                                type={isNum ? "number" : "text"}
                                value={current}
                                aria-label={`Value for ${point.code || point.dp}`}
                                onChange={(event) => {
                                  setDpError(null);
                                  setDraft((old) => ({
                                    ...old,
                                    [draftKey]: event.target.value,
                                  }));
                                }}
                                className="h-11 w-28 rounded-xl border border-glass-border bg-background/60 px-2.5 text-sm tabular"
                              />
                              <Button
                                variant={isArmed ? "warning" : "glass"}
                                size="touch"
                                className="rounded-xl"
                                data-critical={device.requiresApproval ? "true" : undefined}
                                disabled={busy || connection.state === "refreshing"}
                                onClick={() => {
                                  if (isNum) {
                                    const parsed = Number(current);
                                    if (!current.trim() || !Number.isFinite(parsed)) {
                                      setDpError(`Enter a valid number for ${point.code || `DP ${point.dp}`}.`);
                                      return;
                                    }
                                    void requestDp(device, point, parsed);
                                  } else {
                                    void requestDp(device, point, current);
                                  }
                                }}
                              >
                                {isArmed ? "Confirm" : "Set"}
                              </Button>
                            </div>
                          )}
                        </div>
                        {isArmed && (
                          <p
                            className={cn(
                              "mt-1 text-xs text-status-preview tabular",
                            )}
                            role="status"
                          >
                            Tap again within 4.5s to send.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>

                {rawCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="touch"
                    className="mt-2 rounded-full text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowRaw((value) => !value)}
                    aria-expanded={showRaw}
                  >
                    {showRaw ? "Hide raw data points" : `Show raw data points (${rawCount})`}
                  </Button>
                )}
              </section>
            )}

            {/* Device history */}
            {device.kind !== "air_conditioner" && (
              <section
                className="rounded-2xl border border-glass-border bg-muted/30 p-4"
                aria-labelledby="history-h"
              >
                <h3
                  id="history-h"
                  className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  <Clock className="size-3.5 text-primary" aria-hidden />
                  Device history
                </h3>
                {history ? (
                  <div className="divide-y divide-border/60 text-sm">
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Last ON</span>
                      <span className="text-right text-xs tabular">
                        {history.lastOnAt
                          ? new Date(history.lastOnAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Last OFF</span>
                      <span className="text-right text-xs tabular">
                        {history.lastOffAt
                          ? new Date(history.lastOffAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Units today (sampled)</span>
                      <span className="font-display text-sm tabular">
                        {history.todayKwh.toFixed(3)} kWh
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Runs recorded</span>
                      <span className="tabular">{history.sessions.length}</span>
                    </div>
                    {history.sessions.slice(0, 5).map((session, index) => (
                      <div
                        key={`${session.start}-${index}`}
                        className="flex items-center justify-between gap-2 py-2 text-xs tabular"
                      >
                        <span className="font-medium">
                          {new Date(session.start).toLocaleTimeString()}
                          {" → "}
                          {session.end
                            ? new Date(session.end).toLocaleTimeString()
                            : "running"}
                        </span>
                        <span className="text-muted-foreground">
                          {session.kwh.toFixed(3)} kWh
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No local samples yet. History appears after a verified local read.
                  </p>
                )}
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Sampled locally from verified reads every 30s. Not a billing meter; gaps while
                  closed are not counted.
                </p>
              </section>
            )}

            <ApprovalDialog
              open={pending !== null}
              onOpenChange={(o) => !o && setPending(null)}
              title={`Approve: ${device.name} ${pending ?? ""}`}
              description={`${device.name} is a high-risk load. This approval is recorded locally; the backend still refuses unverified or unknown controls.`}
              onApprove={() => {
                if (!pending) return;
                log({
                  kind: "safety",
                  status: "success",
                  title: `Approval given: ${device.name} ${pending}`,
                  deviceId: device.id,
                });
                void runPower(device, pending, true);
                setPending(null);
              }}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
