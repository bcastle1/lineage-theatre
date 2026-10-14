import { readRecord, writeRecord } from './auth.mjs';
import { createMagicLightLiveTestService, MAGICLIGHT_LIVE_TEST_PATH } from './magiclight-live-test.mjs';

export const MAGICLIGHT_ACTIVATION_TEST_PATH = 'integrations/magiclight/paid-activation-test-2026-10-08.json';

// The historical activation claim is separate from the original operator test.
// Expose only observation: there is no submission method or caller-selected path.
export function createMagicLightActivationStatus({ read = readRecord, write = writeRecord, ...dependencies } = {}) {
  const pathFor = path => path === MAGICLIGHT_LIVE_TEST_PATH ? MAGICLIGHT_ACTIVATION_TEST_PATH : path;
  const service = createMagicLightLiveTestService({ ...dependencies,
    read: path => read(pathFor(path)), write: (path, value, etag) => write(pathFor(path), value, etag),
  });
  function present(value) {
    const test = value.test;
    return { generationSubmitted: false, productionReady: false, test: test ? {
      status: test.status, submittedAt: test.createdAt, checkedAt: test.checkedAt,
      providerCode: test.providerCode, taskStatus: test.taskStatus, code: test.code,
      finishedVideoAvailable: test.status === 'completed',
    } : null };
  }
  return Object.freeze({
    status: async actor => present(await service.status(actor)),
    check: async actor => present(await service.check(actor)),
  });
}
