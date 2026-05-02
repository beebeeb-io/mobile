/**
 * Short Authenticated String (SAS) wordlist + helpers.
 *
 * Both sides of a Constellation transfer derive 4 words from the shared
 * secret + session_id. If the words match on both screens, the channel is
 * authentic — a MITM substituting keys would produce different words.
 *
 * v1 uses a simple deterministic mixing function over `session_id || sender_pk
 * || receiver_pk`. Both sides hold all three values after the join step, so
 * they derive identical words. When UniFFI exposes the core's HKDF-SHA256 we'll
 * swap this for the canonical `info = "beebeeb-sas-v1"` derivation in the spec.
 */

/**
 * 256-word SAS wordlist (one byte = one word). Short, distinct, unambiguous.
 * Words are 3–8 letters, lowercase, no homophones, no offensive terms.
 */
export const SAS_WORDS: readonly string[] = [
  'acorn', 'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'aura',
  'badge', 'banjo', 'basin', 'beach', 'beam', 'bear', 'birch', 'blaze',
  'bloom', 'blue', 'boat', 'bolt', 'bone', 'book', 'boost', 'brave',
  'bread', 'brick', 'brisk', 'broom', 'brush', 'cabin', 'cable', 'cactus',
  'camel', 'candle', 'canoe', 'canyon', 'cargo', 'castle', 'cedar', 'chalk',
  'cherry', 'chest', 'chime', 'chord', 'cider', 'cinder', 'circle', 'cliff',
  'cloud', 'clover', 'cobalt', 'cocoa', 'comet', 'compass', 'copper', 'coral',
  'cosmos', 'cotton', 'cove', 'crane', 'crisp', 'crown', 'crystal', 'cyan',
  'daisy', 'dawn', 'delta', 'desert', 'diamond', 'dock', 'dragon', 'drift',
  'drum', 'dune', 'dusk', 'eagle', 'east', 'ember', 'engine', 'epic',
  'falcon', 'fern', 'field', 'finch', 'fjord', 'flag', 'flame', 'flint',
  'flock', 'flora', 'flute', 'forest', 'fox', 'frost', 'galaxy', 'garden',
  'garnet', 'gem', 'ghost', 'glacier', 'glade', 'glass', 'glow', 'grain',
  'granite', 'grape', 'grass', 'gravel', 'great', 'green', 'grove', 'gull',
  'harbor', 'harvest', 'haven', 'hawk', 'hazel', 'helm', 'henna', 'heron',
  'hive', 'honey', 'horizon', 'horn', 'iris', 'iron', 'island', 'ivy',
  'jade', 'jasper', 'jewel', 'jolly', 'jungle', 'juniper', 'kettle', 'kiln',
  'kite', 'koala', 'lake', 'lantern', 'lark', 'laurel', 'lavender', 'leaf',
  'lemon', 'lens', 'lily', 'linen', 'lion', 'lobby', 'lotus', 'lunar',
  'lynx', 'maple', 'marble', 'marsh', 'meadow', 'medal', 'melon', 'mesa',
  'metal', 'mint', 'mirror', 'mist', 'moon', 'moss', 'mountain', 'nectar',
  'needle', 'nest', 'nickel', 'noble', 'north', 'oak', 'oasis', 'ocean',
  'olive', 'onyx', 'opal', 'orbit', 'orchid', 'otter', 'oxide', 'pacific',
  'panda', 'paper', 'pearl', 'pebble', 'peony', 'pepper', 'pier', 'pine',
  'pioneer', 'plain', 'planet', 'plume', 'polar', 'pollen', 'pond', 'poppy',
  'porch', 'prairie', 'prism', 'puma', 'quartz', 'quill', 'quiver', 'rabbit',
  'radar', 'raft', 'rain', 'raven', 'reef', 'relic', 'ribbon', 'ridge',
  'river', 'robin', 'rocket', 'rose', 'rowan', 'ruby', 'rune', 'sable',
  'saffron', 'sage', 'sail', 'sand', 'sapphire', 'satin', 'scarab', 'shell',
  'shore', 'silk', 'silver', 'sky', 'slate', 'snow', 'sonic', 'spark',
  'spire', 'spruce', 'stag', 'star', 'stone', 'storm', 'summit', 'sunset',
  'swallow', 'swan', 'tide', 'tiger', 'topaz', 'torch', 'tower', 'trail',
  'tulip', 'tundra', 'valley', 'velvet', 'vine', 'violet', 'vista', 'volcano',
  'walnut', 'water', 'wave', 'whale', 'wheat', 'wild', 'willow', 'wolf',
];

if (SAS_WORDS.length !== 256) {
  // Wordlist length is a runtime-checked invariant — 256 entries map exactly
  // one byte to one word. Fail loudly at boot rather than silently drift.
  throw new Error(`SAS_WORDS must contain 256 entries, got ${SAS_WORDS.length}`);
}

/**
 * FNV-1a 32-bit hash over a UTF-8 string. Used as a deterministic byte
 * source for v1 SAS derivation. Both sides compute the same digest.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive 4 SAS words from the transfer context. Each word index uses an
 * independently-tagged FNV-1a digest so the four bytes are uncorrelated.
 *
 * The context is `session_id || sender_pk || receiver_pk` — both sides have
 * all three values after the join step. If the server tampered with either
 * public key during relay, the words diverge and the user catches it.
 */
export function deriveSasWords(
  sessionId: string,
  senderPk: string,
  receiverPk: string,
): string[] {
  const base = `beebeeb-sas-v1|${sessionId}|${senderPk}|${receiverPk}`;
  const words: string[] = [];
  for (let i = 0; i < 4; i++) {
    const h = fnv1a(`${i}|${base}`);
    words.push(SAS_WORDS[h & 0xff]!);
  }
  return words;
}
