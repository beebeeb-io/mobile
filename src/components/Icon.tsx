/**
 * Icon — Beebeeb cross-platform icon component for React Native.
 *
 * Uses Feather from @expo/vector-icons. Feather is a stroke-based icon set
 * (same design language as the web's Lucide icons) — the name mapping is
 * almost 1:1 with the web's IconName union.
 *
 * Usage is identical to the web component:
 *   <Icon name="shield" size={20} color={c.amber} />
 *
 * When adding new icons to the web set, add the Feather mapping here too.
 * For icons that have no Feather equivalent, Ionicons is the fallback
 * (e.g. file-spreadsheet, file-presentation).
 */

import React from 'react';
import { Feather, Ionicons } from '@expo/vector-icons';

// ─── Web IconName union (mirrors web/src/components/icons.tsx) ─────────────────

export type IconName =
  | 'shield'
  | 'lock'
  | 'key'
  | 'eye'
  | 'eye-off'
  | 'check'
  | 'chevron-right'
  | 'chevron-down'
  | 'upload'
  | 'folder'
  | 'file'
  | 'file-text'
  | 'file-spreadsheet'
  | 'file-presentation'
  | 'file-code'
  | 'file-archive'
  | 'file-audio'
  | 'file-video'
  | 'file-data'
  | 'users'
  | 'search'
  | 'plus'
  | 'star'
  | 'trash'
  | 'settings'
  | 'share'
  | 'cloud'
  | 'link'
  | 'clock'
  | 'download'
  | 'copy'
  | 'mail'
  | 'x'
  | 'image'
  | 'more'
  | 'arrow-up'
  | 'pause'
  | 'play'
  | 'menu';

// ─── Feather name map (web name → Feather name) ────────────────────────────────
//
// Feather matches the web's Lucide/Feather paths almost 1:1.
// Differences: trash→trash-2, share→share-2, more→more-horizontal.

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const FEATHER_MAP: Partial<Record<IconName, FeatherName>> = {
  shield:             'shield',
  lock:               'lock',
  key:                'key',
  eye:                'eye',
  'eye-off':          'eye-off',
  check:              'check',
  'chevron-right':    'chevron-right',
  'chevron-down':     'chevron-down',
  upload:             'upload',
  folder:             'folder',
  file:               'file',
  'file-text':        'file-text',
  'file-code':        'file',      // Feather has no file-code; fallback to file
  'file-audio':       'music',
  'file-video':       'film',
  users:              'users',
  search:             'search',
  plus:               'plus',
  star:               'star',
  trash:              'trash-2',
  settings:           'settings',
  share:              'share-2',
  cloud:              'cloud',
  link:               'link',
  clock:              'clock',
  download:           'download',
  copy:               'copy',
  mail:               'mail',
  x:                  'x',
  image:              'image',
  more:               'more-horizontal',
  'arrow-up':         'arrow-up',
  pause:              'pause',
  play:               'play',
  menu:               'menu',
};

// Ionicons fallback for icons not in Feather
const IONICONS_MAP: Partial<Record<IconName, IoniconName>> = {
  'file-spreadsheet':   'grid-outline',
  'file-presentation':  'easel-outline',
  'file-archive':       'archive-outline',
  'file-data':          'bar-chart-outline',
};

// ─── Component ────────────────────────────────────────────────────────────────

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  style?: object;
}

export function Icon({ name, size = 24, color = '#2a2520', style }: IconProps): React.ReactElement {
  const featherName = FEATHER_MAP[name];
  if (featherName) {
    return <Feather name={featherName} size={size} color={color} style={style} />;
  }
  const ioniconName = IONICONS_MAP[name];
  if (ioniconName) {
    return <Ionicons name={ioniconName} size={size} color={color} style={style} />;
  }
  // Ultimate fallback: generic file icon
  return <Feather name="file" size={size} color={color} style={style} />;
}
