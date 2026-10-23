// Shared settings keys and normalization. Used both on the watch and in the side service.

export const SETTINGS_KEYS = {
  mac: 'bike_mac_address',
  serviceUuid: 'bike_service_uuid',
  charUuid: 'bike_char_uuid',
  lowThreshold: 'bike_low_threshold',
  capacityWh: 'bike_capacity_wh',
}

// Standard BLE Battery Service / Battery Level
export const DEFAULT_CONFIG = {
  mac: '',
  serviceUuid: '180F',
  charUuid: '2A19',
  lowThreshold: 20,
  capacityWh: 0, // 0 = not configured, the energy counter stays hidden
}

// Key under which the watch caches the last received config
export const LOCAL_CONFIG_KEY = 'bike_config_v1'

const BLE_BASE_UUID_TAIL = '00001000800000805f9b34fb'

// settingsStorage keeps values as strings (often JSON strings) — strip the quotes
function unwrap(value) {
  if (value === undefined || value === null) return ''
  let v = String(value).trim()
  try {
    const parsed = JSON.parse(v)
    if (typeof parsed === 'string' || typeof parsed === 'number') v = String(parsed).trim()
  } catch (e) {}
  return v
}

// "AA-BB-CC-DD-EE-FF" / "aabbccddeeff" / "AA:BB:..." -> "aa:bb:cc:dd:ee:ff" or ''
export function normalizeMac(value) {
  const hex = unwrap(value).replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (hex.length !== 12) return ''
  return hex.match(/.{2}/g).join(':')
}

// "0x180f" -> "180F"; a full 128-bit UUID is kept uppercase with dashes
export function normalizeUuid(value, fallback) {
  const v = unwrap(value).replace(/^0x/i, '').replace(/\s/g, '').toUpperCase()
  if (/^[0-9A-F]{4}$/.test(v)) return v
  if (/^[0-9A-F]{8}-?[0-9A-F]{4}-?[0-9A-F]{4}-?[0-9A-F]{4}-?[0-9A-F]{12}$/.test(v)) {
    const h = v.replace(/-/g, '')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return fallback
}

export function normalizeThreshold(value) {
  const n = parseInt(unwrap(value), 10)
  if (isNaN(n)) return DEFAULT_CONFIG.lowThreshold
  return Math.min(50, Math.max(5, n))
}

// Pack capacity in watt-hours; 0 means "not set"
export function normalizeCapacityWh(value) {
  const n = parseInt(unwrap(value), 10)
  if (isNaN(n) || n < 0) return DEFAULT_CONFIG.capacityWh
  return Math.min(5000, n)
}

export function normalizeConfig(raw = {}) {
  return {
    mac: normalizeMac(raw.mac),
    serviceUuid: normalizeUuid(raw.serviceUuid, DEFAULT_CONFIG.serviceUuid),
    charUuid: normalizeUuid(raw.charUuid, DEFAULT_CONFIG.charUuid),
    lowThreshold: normalizeThreshold(raw.lowThreshold),
    capacityWh: normalizeCapacityWh(raw.capacityWh),
  }
}

export function sameConfig(a, b) {
  return (
    a.mac === b.mac &&
    a.serviceUuid === b.serviceUuid &&
    a.charUuid === b.charUuid &&
    a.lowThreshold === b.lowThreshold &&
    a.capacityWh === b.capacityWh
  )
}

// Compare an advertised UUID with the configured one: "180f" == "0000180F-0000-1000-8000-00805F9B34FB"
function toFullUuid(uuid) {
  const h = String(uuid).replace(/^0x/i, '').replace(/-/g, '').toLowerCase()
  if (h.length === 4) return `0000${h}${BLE_BASE_UUID_TAIL}`
  if (h.length === 8) return `${h}${BLE_BASE_UUID_TAIL}`
  return h
}

export function uuidEquals(a, b) {
  if (!a || !b) return false
  return toFullUuid(a) === toFullUuid(b)
}
