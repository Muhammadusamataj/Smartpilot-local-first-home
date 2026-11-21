# Home Assistant custom integration

The add-on gives you the devices-first web UI. This optional integration exposes the
same saved Tuya devices as normal Home Assistant **entities**, so they can be used in
automations, scripts, dashboards, voice assistants, and the HA mobile app.

No Tuya cloud request is made by the integration: it reads and commands the devices
through the running add-on over Supervisor's internal network.

## Install

1. Download this repository: <https://github.com/Muhammadusamataj/MYlocal-devices-tuya>
2. Copy the folder `custom_components/mylocal_devices` into your Home Assistant
   config directory, so you end up with:

   ```text
   /config/custom_components/mylocal_devices/
   ```

3. Restart Home Assistant.
4. Go to **Settings → Devices & Services → Add Integration** and search for
   **MY Local Devices Tuya**.
5. Leave all fields blank and submit. The add-on URL is detected automatically.
   Only enter a URL or username/password if you run the web app outside Home
   Assistant or enabled Basic Auth in the add-on.

HACS is not required. If you prefer HACS, add this repository as a custom
repository of type *Integration*, but copying the folder is enough.

## Entities

- `switch.*` — the real ON/OFF DP (`switch`, `switch_1`, `power`, etc.). The main
  toggle is named after the device; other boolean DPs use `Device <dp code>`.
- `sensor.*` — numeric/string DPs such as power, current, energy, and enums. DPs that
  appear only in the live LAN read are added as `sensor.<device> DP <number>` entities,
  so readings are not lost when the cached Tuya DP spec is incomplete.

Entity state refreshes every 20 seconds from the add-on's local LAN cache. Commands
are sent immediately to the device over LAN.

## Automation example

```yaml
alias: Bore motor auto off
trigger:
  - platform: state
    entity_id: switch.bore_motor
    to: "on"
    for: "01:00:00"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.bore_motor
mode: single
```

You can also use any entity in a dashboard:

```yaml
type: entities
entities:
  - switch.bore_motor
  - sensor.water_tank_power
```

## Troubleshooting

- **Add-on not found** — install and start **MY Local Devices Tuya** first, and make
  sure keys/IPs are saved in its Devices screen.
- **Cannot connect** — check the add-on logs. If you set `AUTH_USERNAME` and
  `AUTH_PASSWORD` in the add-on, enter the same values in the integration setup.
- **Entities are unavailable** — the add-on could not reach the device on LAN port
  6668. Check `LAN_SUBNET` and run **Auto scan** in the add-on once.
