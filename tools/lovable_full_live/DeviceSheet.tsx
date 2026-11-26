import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock, Network, Power, ShieldAlert, ShieldCheck } from "lucide-react";

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
            <ShieldAlert className="size-5 text-status-preview" aria-hidden /> {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-glass-border bg-muted/40 p-3 text-sm">
          <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
          <span>I understand this is a high-risk load and I'm approving it explicitly.</span>
        </label>
        <p className="flex items-start gap-2 text-xs text-muted-foreground" role="note">
          <ShieldAlert className="mt-px size-3.5 shrink-0 text-status-preview" aria-hidden />
          Approval is recorded locally; the backend still refuses unverified writes.
        </p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="approve"
            disabled={!ack}
            onClick={() => {
              onApprove();
              setAck(false);
              onOpenChange(false);
            }}
          >
            <ShieldCheck /> {t("approve")} &amp; send
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
  const { t, connection, sendDeviceCommand, sendDpCommand, points, deviceHistory, log } = useSmartPilot();
  const [pending, setPending] = useState<null | "on" | "off">(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [showRaw, setShowRaw] = useState(false);
  const armTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  const runPower = async (d: Device, value: "on" | "off", approved: boolean) => {
    setBusy(true);
    await sendDeviceCommand(
      d.id,
      { type: "power", value },
      approved
        ? { approvedBy: "local-user", approvedAt: new Date().toISOString() }
        : undefined,
    );
    setBusy(false);
  };

  const request = (d: Device, value: "on" | "off") => {
    const verdict = evaluateDeviceAction(d, false);
    if (!verdict.allowed) {
      setPending(value);
      return;
    }
    void runPower(d, value, true);
  };

  /** Two-tap arm/confirm for high-risk data points; backend gate stays final. */
  const requestDp = async (
    d: Device,
    point: { dp: string; code: string; type: string; value?: unknown },
    value: unknown,
  ) => {
    if (device?.requiresApproval && armed !== point.dp) {
      setArmed(point.dp);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), 4500);
      log({
        kind: "safety",
        status: "warning",
        title: `${d.name}: ${point.code} armed — tap again to confirm`,
        deviceId: d.id,
      });
      return;
    }
    setBusy(true);
    await sendDpCommand(
      d.id,
      point.dp,
      value,
      device?.requiresApproval
        ? { approvedBy: "local-user-two-tap", approvedAt: new Date().toISOString() }
        : undefined,
    );
    setBusy(false);
    setArmed(null);
  };

  const devicePoints = device ? (points[device.id] ?? []) : [];
  const phasePoints = devicePoints.filter((point) => isPhasePoint(point));
  const controlPoints = devicePoints.filter((point) => !isPhasePoint(point));
  const usefulPoints = controlPoints.filter(
    (point) =>
      isMeterPoint(point)
      || /switch|relay|onoff|power|clear_energy/i.test(point.code)
      || /bool/i.test(point.type),
  );
  const rawCount = controlPoints.length - usefulPoints.length;
  const visiblePoints = showRaw ? controlPoints : usefulPoints;
  const history = device ? deviceHistory[device.id] ?? null : null;

  return (
    <Sheet open={!!device} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-glass-border sm:max-w-md">
        {device && (
          <>
            <SheetHeader className="text-left">
              <div className="flex items-center gap-3">
                <DeviceGlyph device={device} size="lg" />
                <div className="min-w-0">
                  <SheetTitle className="truncate">{device.name}</SheetTitle>
                  <SheetDescription>
                    {KIND_LABEL[device.kind]} · {device.location ?? t("room_not_set")}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <section
              className="mt-6 rounded-2xl border border-glass-border bg-muted/30 p-4"
              aria-labelledby="conn-h"
            >
              <h3 id="conn-h" className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Network className="size-4 text-primary" aria-hidden /> {t("connectivity")}
              </h3>
              <div className="divide-y divide-border">
                <Row label="Status">
                  <ConnectionPill status={device.connection} />
                </Row>
                <Row label="Ecosystem">{ECOSYSTEM_LABEL[device.ecosystem]}</Row>
                <Row label="Adapter">{adapter.label}</Row>
                <Row label="Backend">
                  <span className="text-xs text-muted-foreground">{connection.message}</span>
                </Row>
                <Row label="Last seen">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden />
                    {device.lastSeen.known
                      ? new Date(device.lastSeen.value).toLocaleString()
                      : t("status_unknown")}
                  </span>
                </Row>
                <Row label={t("power")}>
                  {device.power.known ? device.power.value.toUpperCase() : t("status_unknown")}
                </Row>
              </div>
            </section>

            <section
              className="mt-4 rounded-2xl border border-glass-border bg-muted/30 p-4"
              aria-labelledby="ctrl-h"
            >
              <h3 id="ctrl-h" className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Power className="size-4 text-primary" aria-hidden /> {t("controls")}
              </h3>
              {device.kind === "air_conditioner" ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Full Manual/Auto, temperature, mode and fan controls live on the Climate screen.
                  </p>
                  <Button asChild variant="hero" size="touch" className="w-full">
                    <Link to="/climate" onClick={() => onOpenChange(false)}>
                      {t("openClimate")} <ArrowRight />
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
                      onClick={() => request(device, "on")}
                    >
                      Turn on
                    </Button>
                    <Button
                      variant="glass"
                      size="touch"
                      data-critical={device.requiresApproval ? "true" : undefined}
                      disabled={busy || connection.state === "refreshing"}
                      aria-busy={busy}
                      onClick={() => request(device, "off")}
                    >
                      Turn off
                    </Button>
                  </div>
                  <div className="divide-y divide-border">
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

            {device.kind !== "air_conditioner" && devicePoints.length > 0 && (
              <section
                className="mt-4 rounded-2xl border border-glass-border bg-muted/30 p-4"
                aria-labelledby="dps-h"
              >
                <h3 id="dps-h" className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Power className="size-4 text-primary" aria-hidden /> Verified data points
                </h3>

                {phasePoints.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {phasePoints.map((point) => {
                      const decoded = decodePhaseDp(point.value);
                      return (
                        <div
                          key={`phase-${point.dp}`}
                          className="rounded-xl border border-glass-border bg-muted/20 p-3"
                        >
                          <p className="text-xs text-muted-foreground">
                            {point.code || `DP ${point.dp}`} · DP {point.dp} · read-only
                          </p>
                          {decoded ? (
                            <dl className="mt-2 grid grid-cols-3 gap-2">
                              {PHASE_READINGS.map((reading) => (
                                <div key={reading.key} className="min-w-0">
                                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                    {reading.label}
                                  </dt>
                                  <dd className="font-display tabular text-sm">
                                    {decoded[reading.key].toFixed(reading.digits)}{" "}
                                    <span className="text-xs text-muted-foreground">
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

                <div className="divide-y divide-border">
                  {visiblePoints.map((point) => {
                    const isBool = /bool/i.test(point.type);
                    const isNum = /int|number/i.test(point.type);
                    const readOnly = isMeterPoint(point);
                    const current =
                      draft[point.dp] ??
                      (point.value === undefined ? "" : String(point.value));
                    return (
                      <div key={point.dp} className="py-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 text-sm">
                            <span className="font-medium">{point.code || `DP ${point.dp}`}</span>
                            <span className="ml-1 text-xs text-muted-foreground">
                              DP {point.dp} · {point.type || "unknown"}
                            </span>
                          </span>
                          {readOnly ? (
                            <span className="shrink-0 text-right font-display tabular text-sm">
                              {formatPointValue(point)}
                              <span className="ml-1 block text-[11px] font-normal text-muted-foreground">
                                read-only measurement
                              </span>
                            </span>
                          ) : isBool ? (
                            <Switch
                              checked={
                                point.value === true || point.value === 1 || point.value === "1"
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
                                onChange={(event) =>
                                  setDraft((old) => ({ ...old, [point.dp]: event.target.value }))
                                }
                                className="h-9 w-24 rounded-lg border border-glass-border bg-muted/40 px-2 text-sm"
                              />
                              <Button
                                variant="glass"
                                size="sm"
                                data-critical={device.requiresApproval ? "true" : undefined}
                                disabled={busy || connection.state === "refreshing"}
                                onClick={() =>
                                  void requestDp(
                                    device,
                                    point,
                                    isNum ? Number(current) : current,
                                  )
                                }
                              >
                                {armed === point.dp ? "Confirm" : "Set"}
                              </Button>
                            </div>
                          )}
                        </div>
                        {armed === point.dp && (
                          <p className="mt-1 text-xs text-status-preview" role="status">
                            Armed — tap again within 4.5 seconds to send the command.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {rawCount > 0 && (
                  <Button
                    type="button"
                    variant="glass"
                    size="sm"
                    className="mt-3"
                    onClick={() => setShowRaw((value) => !value)}
                    aria-expanded={showRaw}
                  >
                    {showRaw ? "Hide raw data points" : `Show raw data points (${rawCount})`}
                  </Button>
                )}
              </section>
            )}

            {device && device.kind !== "air_conditioner" && (
              <section
                className="mt-4 rounded-2xl border border-glass-border bg-muted/30 p-4"
                aria-labelledby="history-h"
              >
                <h3 id="history-h" className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Clock className="size-4 text-primary" aria-hidden /> Device history
                </h3>
                {history ? (
                  <div className="divide-y divide-border text-sm">
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Last ON</span>
                      <span className="text-right">
                        {history.lastOnAt ? new Date(history.lastOnAt).toLocaleString() : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Last OFF</span>
                      <span className="text-right">
                        {history.lastOffAt ? new Date(history.lastOffAt).toLocaleString() : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Units today (sampled)</span>
                      <span className="font-display tabular">{history.todayKwh.toFixed(3)} kWh</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <span className="text-muted-foreground">Runs recorded</span>
                      <span className="tabular">{history.sessions.length}</span>
                    </div>
                    {history.sessions.slice(0, 5).map((session, index) => (
                      <div key={`${session.start}-${index}`} className="py-2 text-xs">
                        <span className="font-medium">
                          {new Date(session.start).toLocaleTimeString()}
                          {" → "}
                          {session.end ? new Date(session.end).toLocaleTimeString() : "running"}
                        </span>
                        <span className="ml-2 text-muted-foreground">
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
                <p className="mt-3 text-xs text-muted-foreground">
                  Recorded on this phone from verified local reads every 30 s. Not a billing meter;
                  gaps while the app is closed are not counted.
                </p>
              </section>
            )}

            <ApprovalDialog
              open={pending !== null}
              onOpenChange={(o) => !o && setPending(null)}
              title={`Approve: ${device.name} ${pending ?? ""}`}
              description={`${device.name} is a high-risk load. This approval is sent only to this app’s command gate; the backend still refuses unverified or unknown controls.`}
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
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
