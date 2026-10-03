/**
 * Task 1683g sweep — platform-correct device wording for user-facing strings.
 *
 * Several screens shipped with hardcoded "iPhone" wording (preview decrypt
 * banner, delete confirmations, backup insights). Guus hit it on Android:
 * "at decrypting it shows 'iphone', this is android. sweep all txts."
 * Every user-facing device noun goes through this module so the wording is
 * correct per platform. Source-device copy (e.g. backup guides describing an
 * iPhone WhatsApp backup) stays literal — it describes where the data lives.
 */
import { Platform } from 'react-native';

/** The noun for THIS device: 'iPhone' on iOS, 'Android' elsewhere. */
export const deviceNoun = (): string => (Platform.OS === 'ios' ? 'iPhone' : 'Android');

/** The system photo library noun (delete confirmations): iOS keeps the
 * literal "iPhone Photos"; Android says the phone's gallery. */
export const photosNoun = (): string =>
  Platform.OS === 'ios' ? 'iPhone Photos' : "your phone's gallery";

/** The camera-roll noun (same contract, camera-roll phrasing). */
export const cameraRollNoun = (): string =>
  Platform.OS === 'ios' ? 'your iPhone camera roll' : "your phone's gallery";
