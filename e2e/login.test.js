describe('Login', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  it('should show login screen with brand logo', async () => {
    await expect(element(by.text('Sign in'))).toBeVisible();
    await expect(element(by.text('End-to-end encrypted cloud storage.'))).toBeVisible();
  });

  it('should login with demo account', async () => {
    await element(by.text('you@example.com')).tap();
    await element(by.text('you@example.com')).typeText('demo@beebeeb.io');

    await element(by.text('Your password')).tap();
    await element(by.text('Your password')).typeText('demodemo12345678');

    await element(by.text('Sign in')).tap();

    // Should navigate to main app — Files tab visible
    await waitFor(element(by.text('Files')))
      .toBeVisible()
      .withTimeout(10000);
  });

  it('should show all tabs after login', async () => {
    await expect(element(by.text('Files'))).toBeVisible();
    await expect(element(by.text('Shared'))).toBeVisible();
    await expect(element(by.text('Photos'))).toBeVisible();
    await expect(element(by.text('Settings'))).toBeVisible();
  });

  it('should navigate to Settings', async () => {
    await element(by.text('Settings')).tap();
    await expect(element(by.text('Storage'))).toBeVisible();
  });

  it('should navigate to Photos', async () => {
    await element(by.text('Photos')).tap();
    await expect(element(by.text('Photos'))).toBeVisible();
  });

  it('should navigate to Shared', async () => {
    await element(by.text('Shared')).tap();
    await expect(element(by.text('Shared'))).toBeVisible();
  });
});
