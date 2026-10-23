// Settings page in the Zepp phone app.
// Keys must match SETTINGS_KEYS in utils/config.js.
const KEYS = {
  mac: 'bike_mac_address',
  serviceUuid: 'bike_service_uuid',
  charUuid: 'bike_char_uuid',
  lowThreshold: 'bike_low_threshold',
  capacityWh: 'bike_capacity_wh',
}

const PRESETS = [
  { name: 'Battery Service (0x180F / 0x2A19)', value: 'battery' },
  { name: 'Custom UUID', value: 'custom' },
]

function read(storage, key, fallback) {
  const v = storage.getItem(key)
  if (v === undefined || v === null || v === '') return fallback
  try {
    return JSON.parse(v)
  } catch (e) {
    return v
  }
}

function hint(text) {
  return Text({ paragraph: true, style: { fontSize: '12px', color: '#888', marginTop: '4px' } }, text)
}

AppSettingsPage({
  build({ settingsStorage }) {
    const mac = read(settingsStorage, KEYS.mac, '')
    const serviceUuid = read(settingsStorage, KEYS.serviceUuid, '180F')
    const charUuid = read(settingsStorage, KEYS.charUuid, '2A19')
    const threshold = Number(read(settingsStorage, KEYS.lowThreshold, 20))
    const capacityWh = Number(read(settingsStorage, KEYS.capacityWh, 0))
    const isBattery = String(serviceUuid).toUpperCase() === '180F' && String(charUuid).toUpperCase() === '2A19'

    const set = (key, value) => settingsStorage.setItem(key, JSON.stringify(value))

    return View({ style: { padding: '12px 20px' } }, [
      Section({ title: 'Bike connection' }, [
        TextInput({
          label: 'Bike MAC address',
          placeholder: 'AA:BB:CC:DD:EE:FF',
          value: mac,
          maxLength: 17,
          onChange: (v) => set(KEYS.mac, String(v).trim().toUpperCase()),
        }),
        hint('Leave empty to let the watch find the bike by service UUID.'),
      ]),

      Section({ title: 'BLE profile' }, [
        Select({
          title: 'Profile',
          options: PRESETS,
          value: isBattery ? 'battery' : 'custom',
          onChange: (v) => {
            if (v === 'battery') {
              set(KEYS.serviceUuid, '180F')
              set(KEYS.charUuid, '2A19')
            }
          },
        }),
        TextInput({
          label: 'Service UUID',
          placeholder: '180F or 128-bit UUID',
          value: serviceUuid,
          onChange: (v) => set(KEYS.serviceUuid, String(v).trim()),
        }),
        TextInput({
          label: 'Characteristic UUID (Read/Notify)',
          placeholder: '2A19',
          value: charUuid,
          onChange: (v) => set(KEYS.charUuid, String(v).trim()),
        }),
        hint('The characteristic must return 1 byte: battery level 0–100.'),
      ]),

      Section({ title: 'Low battery alert' }, [
        Slider({
          label: `Low battery threshold: ${threshold}%`,
          min: 5,
          max: 50,
          step: 5,
          value: threshold,
          onChange: (v) => set(KEYS.lowThreshold, Number(v)),
        }),
        hint('Below the threshold the indicator turns red and the watch vibrates once.'),
      ]),

      Section({ title: 'Energy counter' }, [
        TextInput({
          label: 'Battery capacity (Wh)',
          placeholder: '500',
          value: capacityWh ? String(capacityWh) : '',
          onChange: (v) => set(KEYS.capacityWh, Number(v) || 0),
        }),
        hint('Printed on the pack, or volts x amp-hours: 36V x 14Ah = 504 Wh. The widget converts the battery percentage into Wh left. Leave empty to hide it.'),
      ]),
    ])
  },
})
