import { BaseApp } from '@zeppos/zml/base-app'

// BaseApp sets up the messaging channel with the phone — DataWidget needs it to receive settings
App(
  BaseApp({
    globalData: {},
    onCreate() {},
    onDestroy() {},
  }),
)
