import { Platform } from 'react-native';
import * as BeebeebCrypto from '../../modules/beebeeb-crypto';
import type { FileProviderDomainRegistrationResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto.types';
import { getApiUrl, getToken } from './api';
import { requestDeviceOwnerAuth } from './device-owner-auth';
import { wasRecentlyUnlocked } from './lock-state';

export async function mountTrustedFileProvider(): Promise<FileProviderDomainRegistrationResult> {
  if (Platform.OS !== 'ios') {
    return {
      supported: false,
      identifier: 'io.beebeeb.files',
      displayName: 'Beebeeb',
      registered: false,
      added: false,
      removedBeforeAdd: false,
      domainCount: 0,
      rootEnumerationSignaled: false,
      workingSetEnumerationSignaled: false,
    };
  }

  // Skip the device-owner auth prompt if the user just authenticated via
  // BiometricLockScreen. Without this guard, returning from background could
  // trigger a second Face ID prompt when the File Provider mount runs.
  if (!wasRecentlyUnlocked()) {
    const auth = await requestDeviceOwnerAuth('Mount Beebeeb in Files', {
      unavailable: 'Set up Face ID or an iPhone passcode before mounting Beebeeb in Files.',
      cancelled: 'Authentication cancelled. Beebeeb was not mounted in Files.',
      failed: 'Authentication failed. Beebeeb was not mounted in Files.',
    });
    if (!auth.ok) {
      throw new Error(auth.message);
    }
  }

  const token = await getToken();
  if (!token) {
    throw new Error('Sign in before mounting Beebeeb in Files.');
  }

  await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl());
  return BeebeebCrypto.mountFileProviderAccess();
}

export async function removeTrustedFileProvider(): Promise<FileProviderDomainRegistrationResult> {
  return BeebeebCrypto.removeFileProviderAccess();
}
