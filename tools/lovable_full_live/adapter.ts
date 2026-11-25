import { DEVICES } from "./devices";
import { adapter as liveAdapter } from "./local-backend-adapter";
import type { CommandResult, Device, DeviceAdapter, DeviceCommand } from "./types";

export const PREVIEW_MESSAGE = "Preview only — Not sent to device.";

/** Kept for source-level tests: a harmless adapter that never touches hardware. */
export class PreviewAdapter implements DeviceAdapter {
  readonly id = "preview";
  readonly label = "Offline preview (no hardware)";
  readonly isLive = false;

  async listDevices(): Promise<Device[]> {
    return DEVICES.map((d) => ({ ...d }));
  }

  async getStatus(deviceId: string) {
    const d = DEVICES.find((x) => x.id === deviceId);
    return {
      connection: d ? d.connection : ("unknown" as const),
      lastSeen: { known: false } as const,
      power: { known: false } as const,
    };
  }

  async sendCommand(_deviceId: string, _command: DeviceCommand): Promise<CommandResult> {
    return { delivered: false, mode: "preview", message: PREVIEW_MESSAGE };
  }
}

/** The WebView build uses the real local adapter; PreviewAdapter remains test-only. */
export const adapter: DeviceAdapter = liveAdapter;
