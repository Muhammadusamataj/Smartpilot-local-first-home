// Local, deterministic guidance engine for the Assistant / Auto-Pilot screen.
//
// No cloud or LLM calls, and no device commands. Every statement is derived
// from three live sources only:
//   1. the device catalogue in useSmartPilot() (names, kinds, locations,
//      connection, lastSeen, power, capabilities, requiresApproval);
//   2. the verified DP points from the last fresh local read (points);
//   3. the local /api/local/* read endpoints (scenes, rules, scheduler,
//      events, usage), fetched through backend-api.
// If a read fails, the assistant says so instead of inventing a value.

import {
  getEvents,
  getRules,
  getScheduler,
  getScenes,
  getUsage,
  messageOf,
} from "@/lib/smartpilot/backend-api";
import type {
  AcDevice,
  AcPreviewState,
  Device,
  SwitchDevice,
} from "@/lib/smartpilot/types";

export type ChatLinkTo =
  | "/devices"
  | "/climate"
  | "/automations"
  | "/settings"
  | "/energy"
  | "/activity";

export interface ChatLink {
  label: string;
  to: ChatLinkTo;
}

export interface Advisory {
  tone: "info" | "warning" | "safety";
  title: string;
  body: string;
  links?: ChatLink[];
}

/** A human-readable plan. It is never executed by the chat. */
export interface AssistantDraft {
  title: string;
  reason: string;
  deviceIds: string[];
  steps: string[];
  to: ChatLinkTo;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  advisories?: Advisory[];
  links?: ChatLink[];
  draft?: AssistantDraft;
}

export interface AssistantReply {
  text: string;
  advisories?: Advisory[];
  links?: ChatLink[];
  draft?: AssistantDraft;
}

/** Structural match for the verified points exposed by the live adapter. */
export interface DpPoint {
  dp: string;
  code: string;
  type: string;
  value?: unknown;
}

export interface AssistantContext {
  devices: Device[];
  points: Record<string, DpPoint[]>;
  ac: Record<string, AcPreviewState>;
  connection?: { state: string; message?: string; refreshedAt?: string | null };
  /** Injected by tests; defaults to now. Only used for last-seen freshness. */
  now?: Date;
}

export interface LiveFacts {
  loadedAt: string;
  scenes: { total: number | null; scheduled: number | null; names: string[] };
  rules: {
    total: number | null;
    enabled: number | null;
    byDevice: Record<string, number>;
    names: string[];
  };
  scheduler: {
    active: boolean | null;
    nextRun: string | null;
    nextScene: string | null;
    note: string;
  };
  events: { total: number | null; recent: Array<{ title: string; kind: string; at: number }> };
  usage: {
    available: boolean;
    today: string;
    totalKwh: number | null;
    devices: Array<{ id: string; kwh: number }>;
  };
  errors: string[];
}

// --- JSON narrowing (backend payloads are plain objects) --------------------
interface ScenesPayload {
  scenes?: unknown;
}
interface SceneRow {
  name?: unknown;
  schedule?: unknown;
}
interface ScheduleRow {
  enabled?: unknown;
  time?: unknown;
}
interface RulesPayload {
  rules?: unknown;
}
interface RuleRow {
  name?: unknown;
  enabled?: unknown;
  device_id?: unknown;
}
interface SchedulerPayload {
  active?: unknown;
  next_run?: unknown;
  next_scene?: unknown;
  note?: unknown;
}
interface EventsPayload {
  events?: unknown;
}
interface EventRow {
  title?: unknown;
  kind?: unknown;
  at?: unknown;
}
interface UsagePayload {
  today?: unknown;
  total_kwh?: unknown;
  devices?: unknown;
}
interface UsageDeviceRow {
  id?: unknown;
  kwh?: unknown;
}

function asRecord<T>(value: unknown): T {
  return (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as T;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function flag(value: unknown): boolean {
  return value === true;
}

/**
 * Reads the existing local endpoints. Every call is a GET through backend-api;
 * failures are recorded, never replaced with sample values.
 */
export async function loadLiveFacts(): Promise<LiveFacts> {
  const [scenesResult, rulesResult, schedulerResult, eventsResult, usageResult] =
    await Promise.allSettled([getScenes(), getRules(), getScheduler(), getEvents(), getUsage()]);

  const errors: string[] = [];

  let scenesTotal: number | null = null;
  let scenesScheduled: number | null = null;
  const sceneNames: string[] = [];
  if (scenesResult.status === "rejected") {
    errors.push(`scenes: ${messageOf(scenesResult.reason)}`);
  } else {
    const rows = asArray(asRecord<ScenesPayload>(scenesResult.value).scenes);
    scenesTotal = rows.length;
    let scheduled = 0;
    for (const row of rows) {
      const scene = asRecord<SceneRow>(row);
      const name = text(scene.name);
      if (name) sceneNames.push(name);
      if (flag(asRecord<ScheduleRow>(scene.schedule).enabled)) scheduled += 1;
    }
    scenesScheduled = scheduled;
  }

  let rulesTotal: number | null = null;
  let rulesEnabled: number | null = null;
  const rulesByDevice: Record<string, number> = {};
  const ruleNames: string[] = [];
  if (rulesResult.status === "rejected") {
    errors.push(`rules: ${messageOf(rulesResult.reason)}`);
  } else {
    const rows = asArray(asRecord<RulesPayload>(rulesResult.value).rules);
    rulesTotal = rows.length;
    let enabled = 0;
    for (const row of rows) {
      const rule = asRecord<RuleRow>(row);
      const name = text(rule.name);
      if (name) ruleNames.push(name);
      if (flag(rule.enabled)) enabled += 1;
      const deviceId = text(rule.device_id);
      if (deviceId) rulesByDevice[deviceId] = (rulesByDevice[deviceId] ?? 0) + 1;
    }
    rulesEnabled = enabled;
  }

  let schedulerActive: boolean | null = null;
  let nextRun: string | null = null;
  let nextScene: string | null = null;
  let schedulerNote = "";
  if (schedulerResult.status === "rejected") {
    errors.push(`scheduler: ${messageOf(schedulerResult.reason)}`);
  } else {
    const row = asRecord<SchedulerPayload>(schedulerResult.value);
    schedulerActive = flag(row.active);
    nextRun = text(row.next_run) || null;
    nextScene = text(row.next_scene) || null;
    schedulerNote = text(row.note);
  }

  const recent: Array<{ title: string; kind: string; at: number }> = [];
  let eventsTotal: number | null = null;
  if (eventsResult.status === "rejected") {
    errors.push(`events: ${messageOf(eventsResult.reason)}`);
  } else {
    const rows = asArray(asRecord<EventsPayload>(eventsResult.value).events);
    eventsTotal = rows.length;
    for (const row of rows.slice(0, 3)) {
      const event = asRecord<EventRow>(row);
      const title = text(event.title);
      if (!title) continue;
      recent.push({ title, kind: text(event.kind), at: finite(event.at) ?? 0 });
    }
  }

  let usageAvailable = false;
  let usageToday = "";
  let usageTotal: number | null = null;
  const usageDevices: Array<{ id: string; kwh: number }> = [];
  if (usageResult.status === "rejected") {
    errors.push(`usage: ${messageOf(usageResult.reason)}`);
  } else {
    usageAvailable = true;
    const row = asRecord<UsagePayload>(usageResult.value);
    usageToday = text(row.today);
    usageTotal = finite(row.total_kwh);
    for (const item of asArray(row.devices)) {
      const device = asRecord<UsageDeviceRow>(item);
      const id = text(device.id);
      const kwh = finite(device.kwh);
      if (id && kwh !== null) usageDevices.push({ id, kwh });
    }
  }

  return {
    loadedAt: new Date().toISOString(),
    scenes: { total: scenesTotal, scheduled: scenesScheduled, names: sceneNames },
    rules: { total: rulesTotal, enabled: rulesEnabled, byDevice: rulesByDevice, names: ruleNames },
    scheduler: { active: schedulerActive, nextRun, nextScene, note: schedulerNote },
    events: { total: eventsTotal, recent },
    usage: { available: usageAvailable, today: usageToday, totalKwh: usageTotal, devices: usageDevices },
    errors,
  };
}

// --- Verified facts only -----------------------------------------------------
function label(id: string, ctx: AssistantContext): string {
  return ctx.devices.find((device) => device.id === id)?.name ?? id;
}
function isAc(device: Device): device is AcDevice {
  return device.kind === "air_conditioner";
}
function isSwitch(device: Device): device is SwitchDevice {
  return device.kind !== "air_conditioner";
}
function verified(device: Device): boolean {
  return device.connection === "online";
}
function pointsFor(ctx: AssistantContext, id: string): DpPoint[] {
  return ctx.points[id] ?? [];
}
function isBooleanSwitchPoint(point: DpPoint): boolean {
  return /bool/i.test(point.type) && /switch|relay|onoff|power/i.test(point.code);
}
function switchPoints(ctx: AssistantContext, id: string): DpPoint[] {
  return pointsFor(ctx, id).filter(isBooleanSwitchPoint);
}
function isMeterPoint(point: DpPoint): boolean {
  return /int|number|float|double/i.test(point.type) &&
    /energy|kwh|power|consumption/i.test(point.code);
}
function meterPoints(ctx: AssistantContext, id: string): DpPoint[] {
  return pointsFor(ctx, id).filter(isMeterPoint);
}
function hasMetering(device: Device, ctx: AssistantContext): boolean {
  return device.capabilities.energyMetering === "supported" || meterPoints(ctx, device.id).length > 0;
}
function supportedModes(device: AcDevice): string[] {
  const modes = device.capabilities.modes;
  return (Object.keys(modes) as Array<keyof typeof modes>).filter((key) => modes[key] === "supported");
}
function supportedFans(device: AcDevice): string[] {
  const fans = device.capabilities.fanSpeeds;
  return (Object.keys(fans) as Array<keyof typeof fans>).filter((key) => fans[key] === "supported");
}
function controlMode(ctx: AssistantContext, id: string): "manual" | "auto" | null {
  return ctx.ac[id]?.controlMode ?? null;
}
function lastSeenMs(device: Device): number | null {
  if (!device.lastSeen.known) return null;
  const value = Date.parse(device.lastSeen.value);
  return Number.isFinite(value) ? value : null;
}
function stale(device: Device, now: Date): boolean {
  const value = lastSeenMs(device);
  return value !== null && now.getTime() - value > 120_000;
}
function fresh(device: Device, now: Date): boolean {
  return verified(device) && !stale(device, now);
}
function names(devices: Device[]): string {
  return devices.length ? devices.map((device) => device.name).join(", ") : "none";
}
function kindLabel(device: SwitchDevice): string {
  if (device.kind === "breaker") return "circuit breaker";
  if (device.kind === "water_heater") return "water heater";
  return "water pump";
}
function matchedDevices(ctx: AssistantContext, query: string): Device[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  const found = ctx.devices.filter((device) => {
    const haystack = `${device.name} ${device.id} ${device.location ?? ""} ${device.kind}`.toLowerCase();
    return words.some((word) => haystack.includes(word));
  });
  if (/\b(ac|air conditioner|climate)\b/.test(query.toLowerCase())) {
    for (const device of ctx.devices) {
      if (isAc(device) && !found.includes(device)) found.push(device);
    }
  }
  return found;
}
function makeReply(
  replyText: string,
  advisories: Advisory[] = [],
  links: ChatLink[] = [],
  draft?: AssistantDraft,
): AssistantReply {
  return {
    text: replyText,
    ...(advisories.length ? { advisories } : {}),
    ...(links.length ? { links } : {}),
    ...(draft ? { draft } : {}),
  };
}
function ruleSummary(facts: LiveFacts | null): string {
  if (!facts) return "I couldn't read the local automation endpoints, so I won't claim any rule history.";
  if (facts.errors.length) {
    return `I couldn't read every local automation endpoint (${facts.errors.join("; ")}), so I won't claim a complete rule history.`;
  }
  const rules = facts.rules.total ?? 0;
  const enabled = facts.rules.enabled ?? 0;
  const scenes = facts.scenes.total ?? 0;
  const scheduled = facts.scenes.scheduled ?? 0;
  const scheduler = facts.scheduler.active === null ? "unknown" : facts.scheduler.active ? "active" : "inactive";
  const next = facts.scheduler.nextRun ? ` Next scheduled run: ${facts.scheduler.nextRun}.` : "";
  return `The local endpoints report ${rules} rule(s), ${enabled} enabled, and ${scenes} scene(s), ${scheduled} with a schedule. The scheduler is ${scheduler}.${next}`;
}

// --- Deterministic intent handlers ------------------------------------------
function statusReply(ctx: AssistantContext, now: Date): AssistantReply {
  const freshDevices = ctx.devices.filter((device) => fresh(device, now));
  const staleDevices = ctx.devices.filter((device) => stale(device, now));
  const unknownDevices = ctx.devices.filter(
    (device) => !verified(device) && !stale(device, now),
  );
  const replyText = [
    `Verified by a fresh local read (${freshDevices.length}): ${names(freshDevices)}.`,
    `Last read older than two minutes (${staleDevices.length}): ${names(staleDevices)}.`,
    `No verified read (${unknownDevices.length}): ${names(unknownDevices)}.`,
    "I do not report power, temperature or usage for a device without a fresh read.",
  ].join(" ");
  const advisories: Advisory[] = [];
  if (ctx.connection) {
    advisories.push({
      tone: ctx.connection.state === "live" ? "info" : "warning",
      title: "Local connection",
      body: ctx.connection.message
        ? `${ctx.connection.state} — ${ctx.connection.message}`
        : `Connection state: ${ctx.connection.state}.`,
    });
  }
  if (freshDevices.length === 0) {
    advisories.push({
      tone: "info",
      title: "Nothing is verified yet",
      body: "Refresh device status. Until a fresh read succeeds every value stays unknown.",
      ...(ctx.connection && ctx.connection.state !== "live"
        ? { links: [{ label: "Connection settings", to: "/settings" as const }] }
        : {}),
    });
  }
  return makeReply(replyText, advisories, [{ label: "Device details", to: "/devices" }]);
}

function safetyReply(ctx: AssistantContext, targets: Device[]): AssistantReply {
  const critical = targets.filter((device) => device.requiresApproval);
  const list = critical.length ? critical : ctx.devices.filter((device) => device.requiresApproval);
  const replyText = list.length
    ? `${list.length === 1 ? `${list[0]?.name ?? "This device"} is` : `${names(list)} are`} marked critical. The backend refuses unverified and critical writes without explicit approval. I never send commands or run scenes/rules from this chat: a plan is only a draft until you create and confirm it on Automations.`
    : "No device in the current catalogue is marked critical. Even so, I never send commands from this chat; any scene or rule is created and run on Automations after your confirmation.";
  return makeReply(
    replyText,
    [
      {
        tone: "safety",
        title: "Approval is mandatory for critical loads",
        body: "Water motors, breakers and heaters keep their server-side gates. A chat proposal cannot bypass them.",
      },
    ],
    [
      { label: "Automations", to: "/automations" },
      { label: "Approval settings", to: "/settings" },
    ],
  );
}

function capabilityReply(ctx: AssistantContext, targets: Device[]): AssistantReply {
  const device = targets[0];
  if (!device) {
    return makeReply(
      "Name a device from your catalogue and I'll describe only the capabilities the local data marks as supported.",
      [],
      [{ label: "Browse devices", to: "/devices" }],
    );
  }
  const links: ChatLink[] = [{ label: "Device details", to: "/devices" }];
  if (isAc(device)) {
    const modes = supportedModes(device);
    const fans = supportedFans(device);
    const mode = controlMode(ctx, device.id);
    const modeText = mode === "manual" || mode === "auto" ? mode : "not reported by a verified read";
    links.push({ label: "Climate", to: "/climate" });
    links.push({ label: "Automations", to: "/automations" });
    return makeReply(
      `${device.name} is a Haier AC. Supported modes from the catalogue: ${modes.join(", ") || "none"}. Supported fan speeds: ${fans.join(", ") || "none"}. Its declared temperature range is ${device.capabilities.minTemp}–${device.capabilities.maxTemp}°C. Modes and speeds not listed are not marked supported, so I won't suggest them. Control mode is ${modeText}; ${mode === "manual" ? "Manual is never overridden, so Auto-Pilot skips this slot." : "within Auto, any draft must stay inside those limits."}`,
      mode === "manual"
        ? [
            {
              tone: "warning",
              title: `${device.name} is in Manual`,
              body: "Auto-Pilot never overrides Manual. Switch it to Auto on Climate before a rule can act on this slot.",
              links: [{ label: "Climate", to: "/climate" }],
            },
          ]
        : [],
      links,
    );
  }

  const points = pointsFor(ctx, device.id);
  const switches = switchPoints(ctx, device.id);
  const meters = meterPoints(ctx, device.id);
  if (device.requiresApproval) links.push({ label: "Approval settings", to: "/settings" });
  links.push({ label: "Automations", to: "/automations" });
  const pointText = points.length
    ? points.map((point) => `${point.code} (DP ${point.dp}, ${point.type})`).join(", ")
    : "none returned by the last read";
  const switchText = switches.length
    ? `The boolean switch point ${switches[0]?.code} (DP ${switches[0]?.dp}) can be used for a timed on/off rule drafted on Automations.`
    : "No boolean switch point was reported, so a timed power rule cannot be drafted.";
  const meterText = hasMetering(device, ctx)
    ? `Metering is declared${meters.length ? ` and DP ${meters[0]?.code} was reported` : ""}, so local usage can be reviewed on Energy.`
    : "No verified energy metering was reported for this device.";
  return makeReply(
    `${device.name} is a ${kindLabel(device)}${device.location ? ` in ${device.location}` : ""}. Verified data points: ${pointText}. ${switchText} ${meterText}${device.requiresApproval ? " It is a critical load, so any automatic action needs explicit approval." : ""}`,
    device.requiresApproval
      ? [
          {
            tone: "safety",
            title: "Critical load",
            body: "The backend refuses unapproved writes for this device. A chat plan cannot run it.",
          },
        ]
      : [],
    links,
  );
}

function autoPilotReply(
  ctx: AssistantContext,
  targets: Device[],
  facts: LiveFacts | null,
  now: Date,
): AssistantReply {
  const scope = targets.length ? targets : ctx.devices;
  const eligible: Device[] = [];
  const blocked: string[] = [];
  const steps: string[] = [];
  const advisories: Advisory[] = [];

  for (const device of scope) {
    if (!fresh(device, now)) {
      blocked.push(`${device.name}: no fresh verified read`);
      continue;
    }
    if (isAc(device)) {
      const mode = controlMode(ctx, device.id);
      if (mode === "manual") {
        blocked.push(`${device.name}: Manual is never overridden`);
        advisories.push({
          tone: "warning",
          title: `${device.name} is in Manual`,
          body: "Auto-Pilot skips this slot while Manual. Switch to Auto on Climate first.",
          links: [{ label: "Climate", to: "/climate" }],
        });
        continue;
      }
      const modes = supportedModes(device);
      const fans = supportedFans(device);
      if (modes.length === 0) {
        blocked.push(`${device.name}: no mode is marked supported`);
        continue;
      }
      eligible.push(device);
      steps.push(`${device.name}: stay within supported modes (${modes.join(", ")}) and fans (${fans.join(", ") || "none"}); 16–30°C is the declared range`);
    } else {
      const switches = switchPoints(ctx, device.id);
      if (switches.length === 0) {
        blocked.push(`${device.name}: no verified boolean switch DP`);
        continue;
      }
      if (device.requiresApproval) {
        blocked.push(
          `${device.name}: critical load, backend refuses unapproved runs${switches.length ? " (a duration draft is possible, but each run needs approval)" : ""}`,
        );
        advisories.push({
          tone: "safety",
          title: `${device.name} needs approval`,
          body: "A duration rule can be drafted, but the backend gate refuses each automatic run until you approve it on Automations.",
          links: [{ label: "Automations", to: "/automations" }],
        });
        continue;
      }
      eligible.push(device);
      steps.push(`${device.name}: boolean switch ${switches[0]?.code} (DP ${switches[0]?.dp}) from the verified read can back a duration rule`);
    }
  }

  const draft: AssistantDraft | undefined = eligible.length
    ? {
        title: `Auto-Pilot draft for ${names(eligible)}`,
        reason: "Derived only from verified reads and the supported capabilities listed above.",
        deviceIds: eligible.map((device) => device.id),
        steps,
        to: "/automations",
      }
    : undefined;

  const replyText = [
    eligible.length ? `Eligible for an Auto-Pilot draft: ${names(eligible)}.` : "No device here is eligible for an Auto-Pilot rule right now.",
    blocked.length ? `Not eligible: ${blocked.join("; ")}.` : "",
    ruleSummary(facts),
    "Drafts are never executed by this chat. Create and run any rule on Automations after explicit confirmation.",
  ]
    .filter(Boolean)
    .join(" ");

  return makeReply(
    replyText,
    advisories,
    [
      { label: "Automations", to: "/automations" },
      { label: "Device specs", to: "/devices" },
      { label: "Policies", to: "/settings" },
    ],
    draft,
  );
}

function usageReply(
  ctx: AssistantContext,
  targets: Device[],
  facts: LiveFacts | null,
): AssistantReply {
  const lines: string[] = [];
  if (facts?.usage.available) {
    lines.push(
      facts.usage.totalKwh !== null
        ? `The local usage endpoint reports ${facts.usage.totalKwh.toFixed(2)} kWh${facts.usage.today ? ` for ${facts.usage.today}` : ""} today.`
        : "The local usage endpoint did not return a total for today.",
    );
  } else {
    lines.push("I couldn't read local usage just now, so I won't quote a figure.");
  }
  if (facts?.errors.length) {
    lines.push(`Some local reads were unavailable (${facts.errors.join("; ")}).`);
  }

  const scope = targets.length ? targets : ctx.devices.filter((device) => hasMetering(device, ctx));
  for (const device of scope.slice(0, 4)) {
    const meters = meterPoints(ctx, device.id);
    const reported = facts?.usage.devices.find((row) => row.id === device.id);
    lines.push(
      `${device.name}: ${hasMetering(device, ctx) ? "metering is available" : "no verified metering is available"}${meters.length ? ` (DP ${meters[0]?.code})` : ""}${reported ? `; the usage endpoint reports ${reported.kwh} kWh today` : "; no device-specific figure was returned"}.`,
    );
  }

  return makeReply(
    `${lines.join(" ")} I never invent a reading: a value appears only when the local endpoint returned it.`,
    [
      {
        tone: "info",
        title: "Read-only guidance",
        body: "Usage here is reported by the local backend. A meter reading alone does not create or run a rule.",
      },
    ],
    [
      { label: "Energy", to: "/energy" },
      { label: "Automations", to: "/automations" },
    ],
  );
}

function coolingReply(ctx: AssistantContext, targets: Device[], now: Date): AssistantReply {
  const chosen = targets.filter(isAc)[0] ?? ctx.devices.filter(isAc)[0];
  if (!chosen) {
    return makeReply(
      "No Haier AC is in the current catalogue, so I won't suggest a cooling plan.",
      [],
      [{ label: "Devices", to: "/devices" }],
    );
  }
  const modes = supportedModes(chosen);
  const fans = supportedFans(chosen);
  const mode = modes.includes("cool") ? "cool" : modes[0];
  const fan = fans.includes("auto") ? "auto" : fans[0];
  const target = Math.max(chosen.capabilities.minTemp, Math.min(24, chosen.capabilities.maxTemp));
  const steps: string[] = [];
  if (mode) steps.push(`Use ${mode} mode — listed as supported for ${chosen.name}`);
  steps.push(`Target ${target}°C — inside the declared ${chosen.capabilities.minTemp}–${chosen.capabilities.maxTemp}°C range`);
  if (fan) steps.push(`Use ${fan} fan — listed as supported`);
  const modeText = controlMode(ctx, chosen.id);
  const advisories: Advisory[] = [];
  if (modeText === "manual") {
    advisories.push({
      tone: "warning",
      title: `${chosen.name} is in Manual`,
      body: "Auto-Pilot does not override Manual; switch to Auto on Climate before a rule can act.",
      links: [{ label: "Climate", to: "/climate" }],
    });
  }
  if (!fresh(chosen, now)) {
    advisories.push({
      tone: "info",
      title: "No fresh verified read",
      body: "I can describe supported settings, but I won't claim a current power or room temperature for this AC.",
    });
  }
  const draft: AssistantDraft | undefined = fresh(chosen, now)
    ? {
        title: `Cooling draft for ${chosen.name}`,
        reason: "Settings chosen only from the AC's declared capabilities.",
        deviceIds: [chosen.id],
        steps,
        to: "/automations",
      }
    : undefined;
  return makeReply(
    `${chosen.name} supports modes ${modes.join(", ") || "none"} and fans ${fans.join(", ") || "none"}. A cooling draft would stay at ${target}°C with ${mode ?? "no supported mode"}${fan ? ` and ${fan} fan` : ""}. ${fresh(chosen, now) ? "It has a fresh verified read." : "It has no fresh verified read, so no draft is offered."} Nothing is sent from this chat.`,
    advisories,
    [
      { label: "Climate", to: "/climate" },
      { label: "Automations", to: "/automations" },
    ],
    draft,
  );
}

function waterReply(ctx: AssistantContext, targets: Device[], now: Date): AssistantReply {
  const pump = targets.find((device) => isSwitch(device) && device.kind === "water_pump") ??
    ctx.devices.find((device) => isSwitch(device) && device.kind === "water_pump");
  if (!pump) {
    return makeReply(
      "No water pump is in the current catalogue, so I won't draft a fill run.",
      [],
      [{ label: "Devices", to: "/devices" }],
    );
  }
  const switches = switchPoints(ctx, pump.id);
  const advisories: Advisory[] = [
    {
      tone: "safety",
      title: "Confirm the tank actually needs water",
      body: "No tank-level sensor was reported. Running a motor on an empty or full tank can damage it, and approval is mandatory.",
      links: [{ label: "Devices", to: "/devices" }],
    },
  ];
  const draft: AssistantDraft | undefined =
    fresh(pump, now) && switches.length
      ? {
          title: `Duration-rule draft for ${pump.name}`,
          reason: `Based on the verified boolean switch ${switches[0]?.code} (DP ${switches[0]?.dp}).`,
          deviceIds: [pump.id],
          steps: [
            `Turn on with ${switches[0]?.code} (DP ${switches[0]?.dp}) — reported as boolean by the last read`,
            "Choose the run duration on Automations; no duration was inferred from a sensor",
            "Turn off with the same DP after the chosen duration",
          ],
          to: "/automations",
        }
      : undefined;
  return makeReply(
    `${pump.name} is a water pump. ${switches.length ? `The last verified read reported boolean switch ${switches[0]?.code} (DP ${switches[0]?.dp}), which can back a duration rule.` : "No boolean switch point was reported, so I can't draft a timed run."} ${fresh(pump, now) ? "It has a fresh verified read." : "It has no fresh verified read, so I won't propose an action yet."} ${draft ? "Review the draft on Automations; the chat sends nothing." : "Refresh status on Devices first."}`,
    advisories,
    [
      { label: "Automations", to: "/automations" },
      { label: "Devices", to: "/devices" },
    ],
    draft,
  );
}

function geyserReply(ctx: AssistantContext, targets: Device[], now: Date): AssistantReply {
  const heater = targets.find((device) => isSwitch(device) && device.kind === "water_heater") ??
    ctx.devices.find((device) => isSwitch(device) && device.kind === "water_heater");
  if (!heater) {
    return makeReply(
      "No water heater is in the current catalogue, so I won't draft a heating window.",
      [],
      [{ label: "Devices", to: "/devices" }],
    );
  }
  const switches = switchPoints(ctx, heater.id);
  const draft: AssistantDraft | undefined =
    fresh(heater, now) && switches.length
      ? {
          title: `Approval-gated window draft for ${heater.name}`,
          reason: `Uses the verified boolean switch ${switches[0]?.code} (DP ${switches[0]?.dp}); the backend gate still requires approval.`,
          deviceIds: [heater.id],
          steps: [
            `Switch ${switches[0]?.code} (DP ${switches[0]?.dp}) from the verified read`,
            "Set the window and enable approval-on-run on Automations",
          ],
          to: "/automations",
        }
      : undefined;
  return makeReply(
    `${heater.name} is a high-risk load. The backend requires explicit approval for every run, and this chat never sends a command. ${switches.length ? `The verified boolean switch ${switches[0]?.code} (DP ${switches[0]?.dp}) can be used for an approval-gated window draft.` : "No boolean switch point was reported, so I can't draft a window."} ${fresh(heater, now) ? "" : "There is no fresh verified read, so no draft is offered."}`,
    [
      {
        tone: "safety",
        title: "Explicit approval required",
        body: "Heaters, water motors and breakers cannot run without your confirmation. The server-side gate stays in force.",
        links: [{ label: "Approval settings", to: "/settings" }],
      },
    ],
    [
      { label: "Automations", to: "/automations" },
      { label: "Settings", to: "/settings" },
    ],
    draft,
  );
}

function fallbackReply(ctx: AssistantContext, facts: LiveFacts | null): AssistantReply {
  const verifiedCount = ctx.devices.filter((device) => verified(device)).length;
  const replyText = verifiedCount
    ? `I can explain verified status for your ${verifiedCount} verified device${verifiedCount === 1 ? "" : "s"}, their supported capabilities, Auto-Pilot eligibility and the local rules/usage reported by ${facts && !facts.errors.length ? "the backend" : "local reads"}. I only draft plans: no command, scene run or rule change happens from this chat.`
    : "No device is verified by a fresh read right now. I can still describe the catalogue and its declared capabilities, but I won't report a device value or draft an action until status is verified. I never send commands from this chat.";
  return makeReply(
    replyText,
    [
      {
        tone: "info",
        title: "Try asking",
        body: "Which devices are verified right now? · What modes does my AC support? · Can a water pump have a duration rule? · What does today's usage show?",
      },
    ],
    [
      { label: "Devices", to: "/devices" },
      { label: "Automations", to: "/automations" },
    ],
  );
}

/**
 * Deterministic responder. `input` is classified into one of a small set of
 * intents; every value printed comes from `context` or `facts`.
 */
export function respond(
  input: string,
  context: AssistantContext,
  facts: LiveFacts | null = null,
): AssistantReply {
  const query = input.toLowerCase();
  const now = context.now ?? new Date();
  const targets = matchedDevices(context, query);

  if (/(critical|approval|approve|risk|safety|permission|confirm)/.test(query)) {
    return safetyReply(context, targets);
  }
  if (/(autopilot|auto-pilot|auto pilot|rule|automat|schedule|timer|duration|eligib)/.test(query)) {
    return autoPilotReply(context, targets, facts, now);
  }
  if (/(support|capab|spec|modes?|fan|feature|what can)/.test(query)) {
    return capabilityReply(context, targets);
  }
  if (/(usage|energy|meter|kwh|bill|consumption|power draw)/.test(query)) {
    return usageReply(context, targets, facts);
  }
  if (/(status|online|verified|which device|list|offline|stale|reading|fresh)/.test(query)) {
    return statusReply(context, now);
  }
  if (/(geyser|water heater|hot water|heater)/.test(query)) {
    return geyserReply(context, targets, now);
  }
  if (/(tank|water|bore|motor|pump|fill)/.test(query)) {
    return waterReply(context, targets, now);
  }
  if (/(cool|thand|garmi|hot|ac\b|temperature|temp\b|climate|pro\b|t3)/.test(query)) {
    return coolingReply(context, targets, now);
  }
  return fallbackReply(context, facts);
}

/** Suggestions are generated from the live catalogue; no fixed demo prompts. */
export function buildSuggestions(
  context: AssistantContext,
  facts: LiveFacts | null = null,
): string[] {
  const out: string[] = ["Which devices are verified right now?"];
  const verifiedDevices = context.devices.filter((device) => verified(device));

  if (verifiedDevices.length === 0) {
    out.push("What can Auto-Pilot control here?");
    out.push("Why do critical devices need approval?");
    out.push("How do I check local rules safely?");
    return [...new Set(out)].slice(0, 5);
  }

  const ac = verifiedDevices.find(isAc);
  if (ac) out.push(`What modes does ${ac.name} support?`);

  const pump = verifiedDevices.find(
    (device) => isSwitch(device) && device.kind === "water_pump" && switchPoints(context, device.id).length > 0,
  );
  if (pump) out.push(`Can ${pump.name} have a duration rule?`);

  const metered =
    verifiedDevices.find((device) => isSwitch(device) && device.kind === "breaker" && hasMetering(device, context)) ??
    verifiedDevices.find((device) => hasMetering(device, context));
  if (metered) out.push(`How can I watch ${metered.name} usage?`);

  const manual = verifiedDevices.find((device) => isAc(device) && controlMode(context, device.id) === "manual");
  if (manual) out.push(`${manual.name} is in Manual — what does Auto-Pilot skip?`);

  const critical = verifiedDevices.find((device) => device.requiresApproval);
  if (critical) out.push(`Why does ${critical.name} need approval?`);

  if (facts?.rules.total !== null && facts?.rules.total !== undefined && facts.rules.total > 0) {
    out.push("Which rules are already enabled?");
  }
  if (facts?.usage.available) out.push("What does today's usage show?");

  return [...new Set(out)].slice(0, 5);
}
