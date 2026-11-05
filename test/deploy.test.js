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
  });
});

test('the kiosk starts Chromium in German and the installer installs the policy', async () => {
  assert.match(await read('deploy/chromium-kiosk.sh'), /--lang=de/);
  assert.match(await read('deploy/install.sh'), /\/etc\/chromium\/policies\/managed\/pi-anzeige\.json/);
});
