// Export only the server's allowlisted diagnostics, never the raw device record.
import { api } from "../shared/api.js";
import { $ } from "../shared/dom.js";
import { appState } from "../shared/state.js";

let renderPanel;
let pending = null, notice = null;

function resetSupport() {
  pending = null; notice = null;
}

function reportState(d) {
  const sameSnapshot = item => item && item.account === appState.accountId && item.generation === appState.accountGeneration &&
    item.devices === appState.deviceLoadGeneration;
  return {
    busy: !!sameSnapshot(pending) && pending.deviceId === d.id,
    notice: sameSnapshot(notice) && notice.deviceId === d.id ? notice : null,
  };
}

function repaint(id) {
  if (appState.selectedId === id && appState.panelView === "menu") renderPanel();
}

async function downloadReport(d) {
  if (reportState(d).busy) return;
  const operation = { deviceId: d.id, account: appState.accountId, generation: appState.accountGeneration,
    devices: appState.deviceLoadGeneration };
  pending = operation; notice = null; repaint(d.id);
  const response = await api("/api/support-report", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: d.id, account_id: operation.account }),
  });
  if (pending !== operation) return;
  pending = null;
  if (operation.account !== appState.accountId || operation.generation !== appState.accountGeneration ||
      operation.devices !== appState.deviceLoadGeneration || appState.selectedId !== d.id) { repaint(d.id); return; }
  const { ok } = response;
  const body = response.body && typeof response.body === "object" ? response.body : {};
  const errors = {
    not_logged_in: "Log in again, then download the report.",
    account_changed: "Your account changed. Refresh the device list, then try again.",
    no_devices: "Refresh the device list, then try again.",
    unknown_device: "This device is no longer in the saved list. Refresh, then try again.",
  };
  let message = errors[body.error] || "Could not download the report. Try again.", failed = true;
  if (ok && body.account_id === operation.account && body.report && body.report.schema_version === 1) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `tuya-local-key-support-${stamp}.json`;
    const text = JSON.stringify(body.report, null, 2) + "\n";
    try {
      if (window.PilotNative && typeof window.PilotNative.saveDownload === "function") {
        // Android WebView cannot save a blob: URL; let the app write to Downloads.
        window.PilotNative.saveDownload(name, btoa(unescape(encodeURIComponent(text))), "application/json");
      } else {
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = name;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      message = "Support report saved to Downloads/SmartPilot."; failed = false;
    } catch (error) { /* Keep a recoverable message if the browser cannot save. */ }
  }
  notice = { ...operation, message, failed };
  repaint(d.id);
}

let initialized = false;
function initSupport(actions) {
  if (initialized) return;
  initialized = true;
  ({ renderPanel } = actions);
  $("menuBody").addEventListener("click", e => {
    if (!e.target.closest("[data-support-report]")) return;
    const device = appState.deviceData.find(d => d.id === appState.selectedId);
    if (device) downloadReport(device);
  });
}

export { initSupport, reportState, resetSupport };
