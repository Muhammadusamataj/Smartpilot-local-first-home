# Troubleshooting

- Terminal QR will not scan: open the saved `tuya-login-qr.png` instead.
- Login timed out or QR expired: start the login again and scan promptly.
- `session_invalid` or redirected back to login: the cached login expired. Scan the QR code again.
- No devices found: confirm the devices are paired in the Smart Life app under the same account.
- Local key shows `-`: the device is Bluetooth-only. See [Bluetooth Devices](usage.md#bluetooth-devices).
- A device stopped working with a local integration: its local key may have rotated. Click Refresh and read the change summary. See [Change Detection](caching-and-changes.md#change-detection).
- Local connection fails: use **Local network > Fix connection** in the device panel.
- "Not on the devices' network": the phone is on a different subnet from the saved addresses (for example `192.168.10.x` instead of `192.168.100.x`). Join the devices' 2.4 GHz Wi-Fi, turn off mobile data if it is taking over, then scan again. A refused address in that state is usually the phone/router, not a Tuya device.
- Offline Android app reachable only inside the phone: open **Remote access** in the header, turn on **Direct access over Tailscale**, set credentials, tap **Apply**, then reopen the panel to copy the displayed `http://<phone-tailscale-ip>:8000/local` URL from another tailnet device. This exposes the UI only; device control still needs the phone on the devices' Wi-Fi subnet. Home Assistant ingress remains the recommended route for remote device control.
- "Could not reach Tuya" with the list still shown: that is the saved snapshot. Try Refresh again.
- Reporting a device issue: attach a [support report](usage.md#download-a-support-report) to your bug report.
