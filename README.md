# E-Bike Battery — Zepp OS data widget

Workout data widget for **Amazfit** watches running **Zepp OS 3.6+** (`app.json`: `apiVersion.minVersion` `3.6`, `appId` 23010, `extType: workout`).
During a cycling workout the watch connects to the e-bike over BLE and shows its battery level.

## What it does

- Connects to the e-bike directly from the watch over BLE (the phone is not needed while riding).
- Shows battery level as a big number, a progress bar and a status dot (searching / connecting / connected / lost / error).
- Marks the low-battery threshold on the bar; below it the number turns red and the watch vibrates once
  (with 3 % hysteresis so a flickering level doesn't buzz repeatedly).
- Falls back to a cached config when the phone is unreachable.

## How it works

| Part | File | Role |
|---|---|---|
| App entry | `app.js` | `BaseApp` from `@zeppos/zml` — opens the messaging channel to the phone |
| Widget | `data-widget/common/index.js` | UI + the whole BLE state machine, runs on the watch |
| Side service | `app-side/index.js` | Reads settings in the Zepp phone app, answers `config.get`, pushes `config.changed` |
| Settings page | `setting/index.js` | MAC, service/characteristic UUID, low-battery threshold |
| Shared helpers | `utils/config.js` | Settings keys, normalization (MAC / UUID / threshold), 16↔128-bit UUID comparison |

BLE flow (via [`@silver-zepp/easy-ble`](https://www.npmjs.com/package/@silver-zepp/easy-ble)):

1. **Always scan first** — `mstConnect` takes only the 6-byte MAC without the address type; the stack learns
   the type from scan results, so a blind connect can hang. Matching is by MAC if configured, otherwise by
   the service UUID in the advertisement (`allow_duplicates: true`, 15 s).
2. **Connect** with a 20 s timeout; `status: 'in progress'` responses are ignored until the real result lands.
3. **Subscribe** — a profile object for `serviceUuid → charUuid → 2902` (CCCD). If the listener fails, the app
   assumes there is no CCCD, drops to read-only mode and reconnects.
4. **Read** — notifications plus a 60 s polling read as a fallback. The payload is one `uint8` byte, 0–100
   (standard Battery Service `0x180F` / `0x2A19`).
5. **Recover** — every failure bumps a `session` counter (stale callbacks are dropped), recreates `BLEMaster`
   (easy-ble keeps a stuck "in progress" flag otherwise) and retries with exponential backoff, 3 s → 30 s.

## Settings (Zepp app → the app's settings page)

| Setting | Default | Notes |
|---|---|---|
| Bike MAC address | empty | Empty = find the bike by service UUID |
| Service UUID | `180F` | 16-bit or full 128-bit |
| Characteristic UUID | `2A19` | Must be readable/notifiable and return 1 byte, 0–100 |
| Low battery threshold | 20 % | 5–50 %, step 5 |

Changes are pushed to the watch immediately and cached on it under `bike_config_v1` (`device:os.local_storage`).

## Build

```bash
npm install
zeus dev      # run on a connected watch / simulator
zeus build    # produces dist/*.zab
```

Requires the [Zeus CLI](https://docs.zepp.com/docs/guides/tools/zeus-cli/).
UI coordinates are in `designWidth: 480`; target platform is `st: "r"` (round screens).

## Debugging

`data-widget/common/index.js` sets `BLEMaster.SetDebugLevel(3)` — verbose easy-ble logs with every discovered
device, its RSSI and advertised UUIDs. Set it to `1` for release builds.
