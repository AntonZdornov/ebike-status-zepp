import { createWidget, widget, align, prop, text_style } from '@zos/ui'
import { px } from '@zos/utils'
import { LocalStorage } from '@zos/storage'
import { Vibrator, VIBRATOR_SCENE_STRONG_REMINDER } from '@zos/sensor'
import { BasePage } from '@zeppos/zml/base-page'
import { BLEMaster } from '@silver-zepp/easy-ble'
import {
  DEFAULT_CONFIG,
  LOCAL_CONFIG_KEY,
  normalizeConfig,
  sameConfig,
  uuidEquals,
} from '../../utils/config'

// easy-ble 1.7.8 bug: BLEMaster.connect() ends with
//   this.#initiateConnection(dev_addr, response_callback, attempt, max_attempts, timeout_duration)
// but those last three identifiers are declared nowhere, so every connect() throws
// "ReferenceError: attempt is not defined" before mstConnect is ever called.
// #initiateConnection ignores the extra arguments, so defining them as globals is enough.
try {
  globalThis.attempt = 0
  globalThis.max_attempts = 0
  globalThis.timeout_duration = 0
} catch (e) {
  console.log('BLE: could not install easy-ble connect() shim')
}

const SCAN_DURATION_MS = 15000
const SCAN_GRACE_MS = 5000 // watchdog margin on top of the library's own scan duration
const CONNECT_TIMEOUT_MS = 20000
const POLL_INTERVAL_MS = 30000 // fallback read in case notifications don't arrive
const RETRY_MIN_MS = 3000
const RETRY_MAX_MS = 30000
const MAX_ATTEMPTS = 5 // after this many failures we stop retrying and wait for the user
const LOW_HYSTERESIS = 3 // avoids repeated vibration when the level flickers 19/20/19

const COLOR = {
  ok: 0x2ecc71,
  mid: 0xf1c40f,
  low: 0xe74c3c,
  muted: 0x8a8a8a,
  track: 0x2a2a2a,
  white: 0xffffff,
}

const STATUS = {
  searching: { text: 'Searching for bike...', color: COLOR.mid },
  connecting: { text: 'Connecting...', color: COLOR.mid },
  connected: { text: 'Connected', color: COLOR.ok },
  lost: { text: 'Connection lost', color: COLOR.low },
  error: { text: 'BLE error', color: COLOR.low },
  failed: { text: 'Bike not found', color: COLOR.low },
}

function formatEnergy(leftWh) {
  return `${Math.round(leftWh)} Wh left`
}

// Layout in designWidth = 480 coordinates
const BAR = { x: 60, y: 256, w: 360, h: 36 }
const DOT = { cx: 240, cy: 30, r: 12 }
const BTN = { x: 120, y: 406, w: 240, h: 64 }

DataWidget(
  BasePage({
    state: {
      config: DEFAULT_CONFIG,
      level: null,
      lowAlerted: false,
      foundMac: '',
      retryDelay: RETRY_MIN_MS,
      attempts: 0,
      notifySupported: true,
      session: 0, // bumped on every BLE restart — filters out stale callbacks
    },

    onInit() {
      this.storage = new LocalStorage()
      this.vibrator = new Vibrator()
      BLEMaster.SetDebugLevel(3) // verbose easy-ble logs; set to 1 for release
      this.ble = new BLEMaster()
      this.seenDevices = {}
      this.timers = {}
      this.state.config = this.loadCachedConfig()
    },

    build() {
      this.drawUi()
      this.startBle()
      this.syncConfigFromPhone()
    },

    onDestroy() {
      this.stopBle()
      this.vibrator.stop()
    },

    // ---------- Settings ----------

    loadCachedConfig() {
      try {
        const raw = this.storage.getItem(LOCAL_CONFIG_KEY, '')
        return raw ? normalizeConfig(JSON.parse(raw)) : DEFAULT_CONFIG
      } catch (e) {
        return DEFAULT_CONFIG
      }
    },

    syncConfigFromPhone() {
      // The phone may be unreachable during a ride — fall back to the cached config
      this.request({ method: 'config.get' })
        .then((res) => res && res.config && this.applyConfig(res.config))
        .catch(() => {})
    },

    // Push from the side service when settings change in the Zepp app
    onCall(req) {
      if (req && req.method === 'config.changed') this.applyConfig(req.params)
    },

    applyConfig(raw) {
      const next = normalizeConfig(raw)
      const prev = this.state.config
      if (sameConfig(prev, next)) return

      this.storage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(next))
      this.state.config = next
      this.drawThresholdMarker()
      this.renderEnergy()
      if (this.state.level !== null) this.renderLevel(this.state.level)

      const bleChanged =
        prev.mac !== next.mac || prev.serviceUuid !== next.serviceUuid || prev.charUuid !== next.charUuid
      if (bleChanged) {
        this.state.foundMac = ''
        this.state.notifySupported = true
        this.restartBle()
      }
    },

    // ---------- BLE ----------

    // Always scan first: mstConnect takes only the 6-byte MAC without the address type (public/random),
    // and the watch BLE stack learns the type from scan results. A "blind" connect may hang with no response.
    startBle() {
      this.showRetryButton(false)
      this.scan(++this.state.session)
    },

    // Must never throw: fail() tears down before it schedules the retry, so an exception here
    // would kill the retry loop and freeze the UI on whatever status was last shown.
    stopBle() {
      this.state.session++
      Object.keys(this.timers).forEach((k) => this.clearTimer(k))
      try {
        this.ble.stopScan()
        // easy-ble creates `off` only once startListener has succeeded — it is undefined on a
        // fresh instance, and `this.ble.off.deregisterAll()` then throws a TypeError
        if (this.ble.off) this.ble.off.deregisterAll()
        if (this.ble.get.isConnected()) this.ble.quit()
      } catch (e) {
        console.log('BLE: teardown error (ignored):', e && e.message)
      }
    },

    // A fresh BLEMaster on every restart, for two reasons:
    //  - easy-ble clears its "connection in progress" flag only when mstConnect responds. If it
    //    never did, every later connect() returns 'in progress'.
    //  - the library's scan-duration timer is a plain setTimeout it never cancels. Reusing the
    //    instance lets that orphan timer call stopScan() — which is the global mstStopScan() —
    //    and silently kill the scan we just started.
    resetBle() {
      this.stopBle()
      this.ble = new BLEMaster()
    },

    restartBle() {
      this.resetBle()
      this.state.retryDelay = RETRY_MIN_MS
      this.state.attempts = 0
      this.startBle()
    },

    // Manual restart from the "Search again" button after MAX_ATTEMPTS failures
    retryNow() {
      console.log('BLE: Manual retry requested')
      this.seenDevices = {}
      this.state.foundMac = ''
      this.state.notifySupported = true
      this.restartBle()
    },

    scan(session) {
      const { mac, serviceUuid } = this.state.config
      // If a MAC is set, match by it; otherwise match by the service UUID in the advertisement
      const target = mac || this.state.foundMac
      let found = false

      this.setStatus(STATUS.searching)
      console.log('BLE: Scanning for', target ? `MAC ${target}` : `service ${serviceUuid}`)

      // on_duration below is a plain setTimeout inside easy-ble and the only thing that would
      // otherwise end a scan that never reports anything — back it with our own watchdog
      this.setTimer('scan', SCAN_DURATION_MS + SCAN_GRACE_MS, () => {
        if (!found && session === this.state.session) {
          this.state.foundMac = ''
          this.fail(STATUS.searching, 'Scan watchdog timeout', session)
        }
      })

      const ok = this.ble.startScan(
        (dev) => {
          if (found || session !== this.state.session) return
          const uuids = dev.service_uuid_array || []
          if (!this.seenDevices[dev.dev_addr]) {
            this.seenDevices[dev.dev_addr] = true
            console.log('BLE: Device found:', dev.dev_name, dev.dev_addr, 'RSSI', dev.rssi, 'UUID', JSON.stringify(uuids))
          }
          const match = target ? dev.dev_addr === target : uuids.some((u) => uuidEquals(u, serviceUuid))
          if (!match) return

          found = true
          this.clearTimer('scan')
          this.ble.stopScan()
          if (!mac) this.state.foundMac = dev.dev_addr
          this.connectTo(dev.dev_addr, session)
        },
        {
          duration: SCAN_DURATION_MS,
          allow_duplicates: true, // otherwise easy-ble won't report an already-seen bike after a reconnect
          throttle_interval: 500,
          on_duration: () => {
            this.clearTimer('scan')
            if (!found && session === this.state.session) {
              this.state.foundMac = '' // the address may have changed (random address) — search by UUID next time
              this.fail(STATUS.searching, target ? 'No bike with this MAC in range' : 'Bike not found', session)
            }
          },
        },
      )
      if (!ok) this.fail(STATUS.error, 'Scan failed to start', session)
    },

    connectTo(mac, session) {
      console.log('BLE: Connecting to MAC:', mac)
      this.setStatus(STATUS.connecting)

      this.setTimer('connect', CONNECT_TIMEOUT_MS, () => {
        if (session === this.state.session) this.fail(STATUS.error, 'Connection timeout', session)
      })

      this.ble.connect(mac, (res) => {
        if (session !== this.state.session) return
        if (res.status === 'in progress') return // a previous attempt is still running — wait for its result
        this.clearTimer('connect')

        if (res.connected) {
          console.log('BLE: Connected successfully!')
          this.onConnected(session)
        } else if (res.status === 'disconnected') {
          this.fail(STATUS.lost, '', session)
        } else {
          this.fail(STATUS.error, res.status === 'invalid mac' ? 'Invalid MAC' : 'Connection failed', session)
        }
      })
    },

    onConnected(session) {
      const { serviceUuid, charUuid } = this.state.config
      const notify = this.state.notifySupported

      // 2902 is the CCCD descriptor, required to subscribe to notifications
      const profile = this.ble.generateProfileObject({
        [serviceUuid]: { [charUuid]: notify ? ['2902'] : [] },
      })
      if (!profile) {
        this.fail(STATUS.error, 'Failed to create profile', session)
        return
      }

      this.ble.startListener(profile, (resp) => {
        if (session !== this.state.session) return

        if (!resp.success) {
          console.log('BLE error:', JSON.stringify(resp))
          if (notify) {
            // Most likely the characteristic has no CCCD — reconnect in read-only mode
            this.state.notifySupported = false
            this.restartBle()
          } else {
            this.fail(STATUS.error, `Service ${serviceUuid} not found`, session)
          }
          return
        }

        this.state.retryDelay = RETRY_MIN_MS
        this.state.attempts = 0
        this.setStatus(STATUS.connected)

        const onData = (_uuid, data) => this.handleBatteryData(data)
        this.ble.on.charaValueArrived(onData)
        this.ble.on.charaNotification(onData)

        if (notify) this.ble.write.enableCharaNotifications(charUuid, true)
        this.ble.read.characteristic(charUuid)

        this.setInterval('poll', POLL_INTERVAL_MS, () => {
          if (this.ble.get.isConnected()) this.ble.read.characteristic(charUuid)
        })
      })
    },

    fail(status, detail, session) {
      if (session !== this.state.session) return
      console.log('BLE error:', JSON.stringify({ status: status.text, detail }))
      // resetBle() closes the session, so the 'disconnected' callback from quit() won't land here
      this.resetBle()

      this.state.attempts++
      const attempt = `${this.state.attempts}/${MAX_ATTEMPTS}`

      if (this.state.attempts >= MAX_ATTEMPTS) {
        this.setStatus(STATUS.failed, `${detail ? detail + ' · ' : ''}${MAX_ATTEMPTS} attempts failed`)
        this.showRetryButton(true)
        return
      }

      const delay = this.state.retryDelay
      this.state.retryDelay = Math.min(delay * 2, RETRY_MAX_MS)
      this.setStatus(status, `${detail ? detail + ' · ' : ''}${attempt} · retry in ${Math.round(delay / 1000)}s`)

      this.setTimer('retry', delay, () => this.startBle())
    },

    // Battery Level (0x2A19) is a single uint8 byte, 0..100
    handleBatteryData(data) {
      if (!data) return
      const bytes = new Uint8Array(data)
      if (!bytes.length || bytes[0] > 100) return
      this.renderLevel(bytes[0])
    },

    // ---------- Timers ----------

    setTimer(name, ms, fn) {
      this.clearTimer(name)
      this.timers[name] = { id: setTimeout(fn, ms), interval: false }
    },

    setInterval(name, ms, fn) {
      this.clearTimer(name)
      this.timers[name] = { id: setInterval(fn, ms), interval: true }
    },

    clearTimer(name) {
      const t = this.timers[name]
      if (!t) return
      t.interval ? clearInterval(t.id) : clearTimeout(t.id)
      delete this.timers[name]
    },

    // ---------- UI ----------

    drawUi() {
      this.statusDot = createWidget(widget.CIRCLE, {
        center_x: px(DOT.cx),
        center_y: px(DOT.cy),
        radius: px(DOT.r),
        color: COLOR.mid,
      })

      createWidget(widget.TEXT, {
        x: 0,
        y: px(62),
        w: px(480),
        h: px(36),
        text: 'BIKE BATTERY',
        text_size: px(26),
        color: COLOR.muted,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.levelText = createWidget(widget.TEXT, {
        x: 0,
        y: px(100),
        w: px(480),
        h: px(140),
        text: '--%',
        text_size: px(120),
        color: COLOR.white,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      createWidget(widget.FILL_RECT, {
        x: px(BAR.x),
        y: px(BAR.y),
        w: px(BAR.w),
        h: px(BAR.h),
        radius: px(BAR.h / 2),
        color: COLOR.track,
      })

      this.barFill = createWidget(widget.FILL_RECT, {
        x: px(BAR.x),
        y: px(BAR.y),
        w: px(BAR.h),
        h: px(BAR.h),
        radius: px(BAR.h / 2),
        color: COLOR.ok,
      })
      this.barFill.setProperty(prop.VISIBLE, false)

      this.thresholdMarker = createWidget(widget.FILL_RECT, {
        x: px(BAR.x),
        y: px(BAR.y - 8),
        w: px(4),
        h: px(BAR.h + 16),
        color: COLOR.white,
      })
      this.drawThresholdMarker()

      this.energyText = createWidget(widget.TEXT, {
        x: px(60),
        y: px(302),
        w: px(360),
        h: px(36),
        text: '',
        text_size: px(28),
        color: COLOR.muted,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })
      this.energyText.setProperty(prop.VISIBLE, false)

      this.statusText = createWidget(widget.TEXT, {
        x: px(40),
        y: px(342),
        w: px(400),
        h: px(36),
        text: '',
        text_size: px(30),
        color: COLOR.mid,
        align_h: align.CENTER_H,
        align_v: align.CENTER_V,
      })

      this.detailText = createWidget(widget.TEXT, {
        x: px(60),
        y: px(380),
        w: px(360),
        h: px(60),
        text: '',
        text_size: px(22),
        color: COLOR.muted,
        align_h: align.CENTER_H,
        align_v: align.TOP,
        text_style: text_style.WRAP,
      })

      this.retryButton = createWidget(widget.BUTTON, {
        x: px(BTN.x),
        y: px(BTN.y),
        w: px(BTN.w),
        h: px(BTN.h),
        radius: px(BTN.h / 2),
        text: 'Restart',
        text_size: px(26),
        color: COLOR.white,
        normal_color: COLOR.track,
        press_color: COLOR.muted,
        click_func: () => this.retryNow(),
      })
      this.retryButton.setProperty(prop.VISIBLE, false)
    },

    // Shown only after MAX_ATTEMPTS failures; the detail line shrinks to one row to make space
    showRetryButton(visible) {
      if (!this.retryButton) return
      this.retryButton.setProperty(prop.VISIBLE, visible)
      this.detailText.setProperty(prop.MORE, {
        x: px(60),
        y: px(380),
        w: px(360),
        h: px(visible ? 26 : 60),
      })
    },

    drawThresholdMarker() {
      if (!this.thresholdMarker) return
      const x = BAR.x + (BAR.w * this.state.config.lowThreshold) / 100
      this.thresholdMarker.setProperty(prop.MORE, {
        x: px(x - 2),
        y: px(BAR.y - 8),
        w: px(4),
        h: px(BAR.h + 16),
      })
    },

    setStatus(status, detail = '') {
      if (!this.statusText) return
      this.statusText.setProperty(prop.MORE, { text: status.text, color: status.color })
      this.detailText.setProperty(prop.TEXT, detail)
      this.statusDot.setProperty(prop.MORE, {
        center_x: px(DOT.cx),
        center_y: px(DOT.cy),
        radius: px(DOT.r),
        color: status.color,
      })
    },

    renderLevel(level) {
      this.state.level = level
      const { lowThreshold } = this.state.config
      const isLow = level <= lowThreshold
      const color = isLow ? COLOR.low : level <= lowThreshold * 2 ? COLOR.mid : COLOR.ok

      this.levelText.setProperty(prop.MORE, { text: `${level}%`, color })
      this.renderEnergy()

      if (level === 0) {
        this.barFill.setProperty(prop.VISIBLE, false)
      } else {
        // minimum width = bar height so the rounded corners don't break at low values
        const w = Math.max(BAR.h, (BAR.w * level) / 100)
        this.barFill.setProperty(prop.MORE, { x: px(BAR.x), y: px(BAR.y), w: px(w), h: px(BAR.h), color })
        this.barFill.setProperty(prop.VISIBLE, true)
      }

      // Vibrate once when crossing below the threshold; re-arm after rising above threshold + hysteresis
      if (isLow && !this.state.lowAlerted) {
        this.state.lowAlerted = true
        this.vibrator.start([{ type: VIBRATOR_SCENE_STRONG_REMINDER }])
      } else if (level > lowThreshold + LOW_HYSTERESIS) {
        this.state.lowAlerted = false
      }
    },

    // Energy still in the pack: 90 % of a 500 Wh battery = 450 Wh. The percentage is the
    // bike BMS's own estimate and discharge isn't linear in energy, so this is an approximation.
    renderEnergy() {
      if (!this.energyText) return
      const { capacityWh } = this.state.config
      const { level } = this.state

      if (!capacityWh || level === null) {
        this.energyText.setProperty(prop.VISIBLE, false)
        return
      }

      this.energyText.setProperty(prop.TEXT, formatEnergy((level / 100) * capacityWh))
      this.energyText.setProperty(prop.VISIBLE, true)
    },
  }),
)
