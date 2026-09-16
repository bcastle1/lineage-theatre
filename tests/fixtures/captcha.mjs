// Only for tests of unrelated controls. CAPTCHA boundary tests use the real service.
export const captchaStub = {
  configuration: () => ({ required: true, available: false }),
  verify: async () => {},
  consumeCheckout: async () => {},
};
