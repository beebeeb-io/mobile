// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
import { describe, expect, mock, test } from 'bun:test';

// `api.ts` pulls in every native module; this file only needs the error type
// and friendlyError's documented plain-Error behaviour (return the message).
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
mock.module('./api', () => ({
  ApiError,
  friendlyError: (err: unknown) =>
    err instanceof ApiError && err.status === 409
      ? err.message || 'A resource with that name already exists.'
      : err instanceof Error
        ? err.message || 'Something went wrong. Please try again.'
        : 'Something went wrong. Please try again.',
}));

const {
  STILL_UPLOADING_MESSAGE,
  isStillUploadingError,
  previewLoadErrorMessage,
  stripNativeExceptionNoise,
} = await import('./preview-load-error');

// The exact text on screen in _qa-evidence/222/r4-01-open-stuck.png.
const NATIVE_409 = new Error(
  'UnexpectedException: Download failed with HTTP 409 (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)',
);

describe('previewLoadErrorMessage (task 1592 item 3)', () => {
  test('the native 409 of a file still marked uploading → the honest message', () => {
    expect(isStillUploadingError(NATIVE_409)).toBe(true);
    expect(previewLoadErrorMessage(NATIVE_409)).toBe(STILL_UPLOADING_MESSAGE);
    expect(previewLoadErrorMessage(NATIVE_409)).not.toContain('Exception');
  });

  test("the JS download path's 409 ApiError (\"upload is still in progress\") → the same message", () => {
    const err = new ApiError(409, 'upload is still in progress');
    expect(previewLoadErrorMessage(err)).toBe(STILL_UPLOADING_MESSAGE);
  });

  test('a different 409 (a name conflict) is NOT called uploading', () => {
    const err = new ApiError(409, 'A file with that name already exists');
    expect(isStillUploadingError(err)).toBe(false);
    expect(previewLoadErrorMessage(err)).toBe('A file with that name already exists');
  });

  test('other native errors keep their message, without the bridge wrapping', () => {
    const err = new Error('UnexpectedException: Download failed with HTTP 500 (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)');
    expect(isStillUploadingError(err)).toBe(false);
    expect(previewLoadErrorMessage(err)).toBe('Download failed with HTTP 500');
    expect(stripNativeExceptionNoise('Not available offline')).toBe('Not available offline');
  });
});
