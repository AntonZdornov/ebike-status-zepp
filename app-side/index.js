import { BaseSideService } from '@zeppos/zml/base-side'
import { SETTINGS_KEYS, normalizeConfig } from '../utils/config'

AppSideService(
  BaseSideService({
    onInit() {},
    onRun() {},
    onDestroy() {},

    readConfig() {
      return normalizeConfig({
        mac: this.settings.getItem(SETTINGS_KEYS.mac),
        serviceUuid: this.settings.getItem(SETTINGS_KEYS.serviceUuid),
        charUuid: this.settings.getItem(SETTINGS_KEYS.charUuid),
        lowThreshold: this.settings.getItem(SETTINGS_KEYS.lowThreshold),
      })
    },

    // The watch requests the config when the widget starts
    onRequest(req, res) {
      if (req.method === 'config.get') {
        res(null, { config: this.readConfig() })
        return
      }
      res({ message: `unknown method: ${req.method}` })
    },

    // The user changed a setting — push it to the watch right away
    onSettingsChange() {
      this.call({ method: 'config.changed', params: this.readConfig() })
    },
  }),
)
