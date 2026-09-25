// Operator command: run only in the application's existing protected runtime.
// Checks the permanent test claim. Never submits generation or exposes secrets,
// task references, signed output URLs, or private owner details.
import { readRecord, userPath } from '../api/_lib/auth.mjs';
import { createMagicLightLiveTestService, MAGICLIGHT_LIVE_TEST_PATH } from '../api/_lib/magiclight-live-test.mjs';

export async function checkSavedMagicLightTest({ read = readRecord, service = createMagicLightLiveTestService(), now = Date.now } = {}) {
  const saved = (await read(MAGICLIGHT_LIVE_TEST_PATH))?.value;
  if (!saved) return { checkedAt: new Date(now()).toISOString(), savedTest: false, generationSubmitted: false };
  const actor = (await read(userPath(saved.ownerEmail)))?.value;
  const result = await service.check(actor);
  const test = result.test;
  return { checkedAt: new Date(now()).toISOString(), savedTest: Boolean(test), generationSubmitted: false,
    productionReady: false, status: test?.status,
    providerCode: test?.providerCode, taskStatus: test?.taskStatus, code: test?.code,
    outputOrigin: test?.outputOrigin, submittedAt: test?.createdAt, providerCheckedAt: test?.checkedAt };
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkSavedMagicLightTest())); }
  catch (error) {
    const code = typeof error?.code === 'string' && /^MAGICLIGHT_[A-Z_]{1,80}$/.test(error.code) ? error.code : 'MAGICLIGHT_SAVED_CHECK_FAILED';
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), code, generationSubmitted: false, productionReady: false }));
    process.exitCode = 1;
  }
}
