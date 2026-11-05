import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the chromium policy silences every browser prompt from the spec', async () => {
  const policy = JSON.parse(await read('deploy/chromium-policy.json'));
  assert.deepEqual(policy, {
    TranslateEnabled: false,
    PasswordManagerEnabled: false,
    AutofillAddressEnabled: false,
    AutofillCreditCardEnabled: false,
    DefaultNotificationsSetting: 2,
    DefaultGeolocationSetting: 2,
    DefaultBrowserSettingEnabled: false,
    BrowserSignin: 0,
    SpellcheckEnabled: false,
    MetricsReportingEnabled: false,
    PromotionalTabsEnabled: false,
    ForcedLanguages: ['de-DE', 'de'],
    AudioCaptureAllowed: false,
    VideoCaptureAllowed: false,
    DefaultClipboardSetting: 2,
    DefaultWebUsbGuardSetting: 2,
    DefaultSerialGuardSetting: 2,
    DefaultWebHidGuardSetting: 2,
    DefaultWebBluetoothGuardSetting: 2,
    DefaultSensorsSetting: 2,
    DefaultLocalFontsSetting: 2,
    DefaultWindowManagementSetting: 2,
    DefaultFileSystemWriteGuardSetting: 2,
    DownloadRestrictions: 3,
  });
});

test('the kiosk starts Chromium in German and the installer installs the policy', async () => {
  const kiosk = await read('deploy/chromium-kiosk.sh');
  // --lang is ignored on Linux; Chromium takes its UI language from the environment.
  assert.match(kiosk, /export LANGUAGE=de/);
  assert.match(kiosk, /export LANG=de_DE\.UTF-8/);
  assert.match(await read('deploy/install.sh'), /\/etc\/chromium\/policies\/managed\/pi-anzeige\.json/);
});
