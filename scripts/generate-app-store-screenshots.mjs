#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT_DIR = resolve('marketing/app-store');
const IPHONE_17_PRO_MAX_BEZEL = resolve('marketing/assets/apple-bezels/iphone-17-pro-max-silver-portrait.png');
const BRAND_LOGO = resolve('marketing/assets/brand/beebeeb-logo.png');
const REAL_SCREENSHOT_DIR = resolve('screenshots/app-store-raw-real-2026-05-20');

const TARGETS = [
  { key: 'iphone-6.9', label: '6.9 inch', width: 1320, height: 2868, phoneW: 925, phoneY: 776, frame: 'iphone-17-pro-max' },
  { key: 'iphone-6.7', label: '6.7 inch', width: 1290, height: 2796, phoneW: 875, phoneY: 824, frame: 'iphone-17-pro-max' },
  { key: 'iphone-5.5', label: '5.5 inch', width: 1242, height: 2208, phoneW: 675, phoneY: 658, frame: 'iphone-17-pro-max' },
  { key: 'ipad-13', label: '13 inch iPad', width: 2064, height: 2752, phoneW: 1420, phoneY: 772, frame: 'ipad-13' },
];

const SLIDES = [
  {
    id: 'files-encrypted',
    eyebrow: 'End-to-end encrypted',
    headline: ['Your files,', 'encrypted'],
    accentLine: 1,
    subhead: 'Documents, photos, work files, and contracts stay private before upload.',
    screen: realScreen('01-files/008-projects-photo-grid.png'),
  },
  {
    id: 'share-without-compromising',
    eyebrow: 'Double-encrypted links',
    headline: ['Share without', 'compromising'],
    accentLine: 1,
    subhead: 'A second client-side key protects shared files. The fragment never reaches the server.',
    screen: realScreen('05-preview/003-share-link-create.jpg'),
  },
  {
    id: 'back-up-memories',
    eyebrow: 'Camera roll backup',
    headline: ['Back up your', 'memories'],
    accentLine: 1,
    subhead: 'Photos are encrypted on device and backed up automatically while you keep using your phone.',
    screen: realScreen('03-photos/001-photos-grid-backed-up.png'),
  },
  {
    id: 'zero-knowledge',
    eyebrow: 'Zero-knowledge by design',
    headline: ['Decrypted on', 'your device'],
    accentLine: 1,
    subhead: 'Preview opens locally so the plaintext never needs to touch our servers.',
    screen: realScreen('05-preview/004-encryption-details.jpg'),
  },
  {
    id: 'built-in-speedtest',
    eyebrow: 'Built-in diagnostics',
    headline: ['Know before', 'you upload'],
    accentLine: 1,
    subhead: 'Measure your route, transfer speed, and on-device encryption before large backups.',
    screen: realScreen('04-settings/010-speedtest-running-filled.jpg'),
  },
  {
    id: 'made-in-europe',
    eyebrow: 'European storage',
    headline: ['Made in', 'Europe'],
    accentLine: 1,
    subhead: 'Built by Initlabs B.V. Stored in Falkenstein, Germany',
    screen: realScreen('04-settings/001-settings-top.png'),
  },
];

const C = {
  amber: '#F5B800',
  amberDeep: '#B8860B',
  amberSoft: '#FDE8A8',
  amberBg: '#FEF4CF',
  dark: '#1A1714',
  dark2: '#2A2520',
  screen: '#1B191E',
  screen2: '#211F25',
  screen3: '#28252C',
  screenLine: '#34303A',
  paper: '#FAF8F5',
  paper2: '#F2EDE5',
  line: '#E6E0D6',
  line2: '#D4C8B7',
  ink: '#2A2520',
  ink2: '#5C564E',
  ink3: '#7D7770',
  ink4: '#A8A29C',
  green: '#31A24C',
  red: '#D84040',
  blue: '#1F6FEB',
};

const STOCK_PHOTOS = [
  'photo-01.jpg',
  'photo-02.jpg',
  'photo-03.jpg',
  'photo-04.jpg',
  'photo-05.jpg',
  'photo-06.jpg',
  'photo-07.jpg',
  'photo-08.jpg',
];

function stockPhotoHref(index) {
  const name = STOCK_PHOTOS[index % STOCK_PHOTOS.length];
  const bytes = readFileSync(resolve('marketing/assets/stock', name));
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function appleBezelHref() {
  if (!existsSync(IPHONE_17_PRO_MAX_BEZEL)) return null;
  const bytes = readFileSync(IPHONE_17_PRO_MAX_BEZEL);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function brandLogoHref() {
  if (!existsSync(BRAND_LOGO)) return null;
  const bytes = readFileSync(BRAND_LOGO);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function realScreenHref(relativePath) {
  const path = join(REAL_SCREENSHOT_DIR, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing real app screenshot: ${path}`);
  }
  const bytes = readFileSync(path);
  const mime = relativePath.toLowerCase().endsWith('.jpg') || relativePath.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function realScreen(relativePath) {
  return () => `
    <image x="0" y="0" width="430" height="932" href="${realScreenHref(relativePath)}" preserveAspectRatio="none"/>
  `;
}

function main() {
  ensureRsvg();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const manifest = [];
  for (const target of TARGETS) {
    const targetDir = join(OUT_DIR, target.key);
    mkdirSync(targetDir, { recursive: true });

    for (const [index, slide] of SLIDES.entries()) {
      const svg = renderSlide(slide, target);
      const base = `${String(index + 1).padStart(2, '0')}-${slide.id}`;
      const svgPath = join(targetDir, `${base}.svg`);
      const pngPath = join(targetDir, `${base}.png`);
      writeFileSync(svgPath, svg);

      const result = spawnSync('rsvg-convert', ['-w', String(target.width), '-h', String(target.height), '-o', pngPath, svgPath], {
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }

      manifest.push({
        target: target.key,
        size: `${target.width}x${target.height}`,
        png: pngPath.replace(`${process.cwd()}/`, ''),
        svg: svgPath.replace(`${process.cwd()}/`, ''),
      });
    }
  }

  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'README.md'), readme());
  console.log(`Generated ${manifest.length} App Store screenshots in ${OUT_DIR}`);
}

function ensureRsvg() {
  const result = spawnSync('rsvg-convert', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error('rsvg-convert is required to render PNG screenshots from SVG.');
    process.exit(1);
  }
}

function renderSlide(slide, target) {
  const { width: w, height: h } = target;
  const isSmall = target.key === 'iphone-5.5';
  const isProMax = target.key === 'iphone-6.9';
  const isIpad = target.frame === 'ipad-13';
  const headSize = isIpad ? 168 : isSmall ? 104 : isProMax ? 142 : 138;
  const subSize = isIpad ? 48 : isSmall ? 34 : isProMax ? 43 : 42;
  const eyebrowSize = isIpad ? 34 : isSmall ? 24 : 28;
  const contentY = isIpad ? 118 : isSmall ? 108 : isProMax ? 144 : 150;
  const phoneX = (w - target.phoneW) / 2;
  const phoneY = target.phoneY;

  return svgDoc(w, h, `
    <defs>
      <radialGradient id="bgGlow" cx="50%" cy="12%" r="70%">
        <stop offset="0%" stop-color="${C.amber}" stop-opacity="0.34"/>
        <stop offset="48%" stop-color="${C.amber}" stop-opacity="0.11"/>
        <stop offset="100%" stop-color="${C.dark}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#191511"/>
        <stop offset="58%" stop-color="${C.dark}"/>
        <stop offset="100%" stop-color="#0E0C0A"/>
      </linearGradient>
      <filter id="shadow" x="-30%" y="-20%" width="160%" height="160%">
        <feDropShadow dx="0" dy="48" stdDeviation="52" flood-color="#000" flood-opacity="0.42"/>
      </filter>
      <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000" flood-opacity="0.22"/>
      </filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <rect width="${w}" height="${h}" fill="url(#bgGlow)"/>
    ${pill(w / 2, contentY, slide.eyebrow, eyebrowSize)}
    ${headline(w / 2, contentY + (isSmall ? 104 : 126), slide.headline, headSize, slide.accentLine)}
    ${paragraph(w / 2, contentY + (isIpad ? 458 : isSmall ? 338 : isProMax ? 430 : 436), slide.subhead, subSize, isIpad ? 1370 : isSmall ? 980 : isProMax ? 1080 : 1040, '#EDE5D8')}

    ${phoneFrame(phoneX, phoneY, target.phoneW, target.phoneH, slide.screen, target.frame)}
    ${brandMark(w / 2, h - (isIpad ? 64 : isSmall ? 58 : 70), isSmall)}
  `);
}

function svgDoc(w, h, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <style>
    .font { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", Arial, sans-serif; }
    .mono { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
    text { dominant-baseline: hanging; }
  </style>
  ${body}
</svg>
`;
}

function pill(cx, y, label, size) {
  const width = Math.min(920, Math.max(460, label.length * size * 0.9 + size * 3.6));
  return `
    <rect x="${cx - width / 2}" y="${y}" width="${width}" height="${size * 2.05}" rx="${size}" fill="${C.amber}" opacity="0.16" stroke="${C.amber}" stroke-opacity="0.54" stroke-width="2"/>
    <text class="font" x="${cx}" y="${y + size * 0.48}" text-anchor="middle" font-size="${size}" font-weight="800" fill="${C.amber}" letter-spacing="1.2">${esc(label.toUpperCase())}</text>
  `;
}

function headline(cx, y, lines, size, accentLine) {
  return lines.map((line, index) => `
    <text class="font" x="${cx}" y="${y + index * size * 0.98}" text-anchor="middle" font-size="${size}" font-weight="900" fill="${index === accentLine ? C.amber : C.paper}" letter-spacing="0">${esc(line)}</text>
  `).join('');
}

function paragraph(cx, y, copy, size, maxWidth, fill) {
  const lines = wrap(copy, Math.floor(maxWidth / (size * 0.54)));
  return lines.map((line, index) => `
    <text class="font" x="${cx}" y="${y + index * size * 1.28}" text-anchor="middle" font-size="${size}" font-weight="500" fill="${fill}" opacity="0.84">${esc(line)}</text>
  `).join('');
}

function phoneFrame(x, y, w, h, screenFn, frame = 'iphone-17-pro-max') {
  if (frame === 'ipad-13') {
    return iPadFrame(x, y, w, screenFn);
  }

  const officialBezel = appleBezelHref();
  if (officialBezel) {
    return officialIPhoneFrame(x, y, w, screenFn, officialBezel);
  }

  const fallbackH = h ?? w * (3000 / 1470);
  const rim = w * 0.014;
  const bezel = w * 0.043;
  const rx = w * 0.13;
  const sx = x + bezel;
  const sy = y + bezel;
  const sw = w - bezel * 2;
  const sh = fallbackH - bezel * 2;
  const scaleX = sw / 430;
  const scaleY = sh / 932;
  const clipId = `screenClip${Math.round(x)}${Math.round(y)}${Math.round(w)}`;
  return `
    <g filter="url(#shadow)">
      <rect x="${x - rim}" y="${y - rim}" width="${w + rim * 2}" height="${fallbackH + rim * 2}" rx="${rx + rim}" fill="#6F6A60"/>
      <rect x="${x - rim + 6}" y="${y - rim + 6}" width="${w + rim * 2 - 12}" height="${fallbackH + rim * 2 - 12}" rx="${rx + rim - 6}" fill="#A19B90" opacity="0.45"/>
      <rect x="${x}" y="${y}" width="${w}" height="${fallbackH}" rx="${rx}" fill="#050505"/>
      <rect x="${x + w * 0.012}" y="${y + w * 0.012}" width="${w - w * 0.024}" height="${fallbackH - w * 0.024}" rx="${rx * 0.92}" fill="#141416"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.73}" fill="${C.paper}"/>
      <clipPath id="${clipId}">
        <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.73}"/>
      </clipPath>
      <g clip-path="url(#${clipId})">
        <g transform="translate(${sx} ${sy}) scale(${scaleX} ${scaleY})">
          ${screenFn()}
        </g>
      </g>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.73}" fill="none" stroke="#000" stroke-opacity="0.62" stroke-width="${w * 0.009}"/>
      <rect x="${x + w * 0.34}" y="${y + w * 0.052}" width="${w * 0.32}" height="${w * 0.078}" rx="${w * 0.039}" fill="#000"/>
      <circle cx="${x + w * 0.617}" cy="${y + w * 0.091}" r="${w * 0.013}" fill="#111"/>
      <rect x="${x + w * 0.35}" y="${y + fallbackH - w * 0.058}" width="${w * 0.3}" height="${w * 0.01}" rx="${w * 0.005}" fill="#000" opacity="0.74"/>
      <rect x="${x - rim * 1.8}" y="${y + fallbackH * 0.19}" width="${rim * 1.5}" height="${fallbackH * 0.09}" rx="${rim * 0.6}" fill="#746F65"/>
      <rect x="${x + w + rim * 0.3}" y="${y + fallbackH * 0.25}" width="${rim * 1.5}" height="${fallbackH * 0.12}" rx="${rim * 0.6}" fill="#746F65"/>
    </g>
  `;
}

function officialIPhoneFrame(x, y, w, screenFn, bezelHref) {
  const outerW = 1470;
  const outerH = 3000;
  const screenX = 75;
  const screenY = 66;
  const screenW = 1320;
  const screenH = 2868;
  const scale = w / outerW;
  const h = outerH * scale;
  const sx = x + screenX * scale;
  const sy = y + screenY * scale;
  const sw = screenW * scale;
  const sh = screenH * scale;
  const scaleX = sw / 430;
  const scaleY = sh / 932;
  const rx = 100 * scale;
  const clipId = `officialScreenClip${Math.round(x)}${Math.round(y)}${Math.round(w)}`;
  return `
    <g filter="url(#shadow)">
      <clipPath id="${clipId}">
        <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx}"/>
      </clipPath>
      <g clip-path="url(#${clipId})">
        <g transform="translate(${sx} ${sy}) scale(${scaleX} ${scaleY})">
          ${screenFn()}
        </g>
      </g>
      <image x="${x}" y="${y}" width="${w}" height="${h}" href="${bezelHref}" preserveAspectRatio="none"/>
      <rect x="${x + 548 * scale}" y="${y + 111 * scale}" width="${218 * scale}" height="${74 * scale}" rx="${37 * scale}" fill="#000"/>
      <circle cx="${x + 868 * scale}" cy="${y + 162 * scale}" r="${52 * scale}" fill="#050505"/>
      <circle cx="${x + 868 * scale}" cy="${y + 162 * scale}" r="${18 * scale}" fill="#0D1027"/>
      <circle cx="${x + 868 * scale}" cy="${y + 162 * scale}" r="${9 * scale}" fill="#3421A4" opacity="0.7"/>
    </g>
  `;
}

function iPadFrame(x, y, w, screenFn) {
  const h = w * (2752 / 2064);
  const rim = w * 0.012;
  const bezel = w * 0.05;
  const rx = w * 0.07;
  const sx = x + bezel;
  const sy = y + bezel;
  const sw = w - bezel * 2;
  const sh = h - bezel * 2;
  const contentScale = sh / 932;
  const contentW = 430 * contentScale;
  const contentX = sx + (sw - contentW) / 2;
  const clipId = `ipadScreenClip${Math.round(x)}${Math.round(y)}${Math.round(w)}`;

  return `
    <g filter="url(#shadow)">
      <rect x="${x - rim}" y="${y - rim}" width="${w + rim * 2}" height="${h + rim * 2}" rx="${rx + rim}" fill="#8E8A82"/>
      <rect x="${x - rim + 8}" y="${y - rim + 8}" width="${w + rim * 2 - 16}" height="${h + rim * 2 - 16}" rx="${rx + rim - 8}" fill="#C8C3B8" opacity="0.46"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="#080808"/>
      <rect x="${x + w * 0.012}" y="${y + w * 0.012}" width="${w - w * 0.024}" height="${h - w * 0.024}" rx="${rx * 0.88}" fill="#161619"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.42}" fill="${C.screen}"/>
      <clipPath id="${clipId}">
        <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.42}"/>
      </clipPath>
      <g clip-path="url(#${clipId})">
        <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" fill="${C.screen}"/>
        <g transform="translate(${contentX} ${sy}) scale(${contentScale})">
          ${screenFn()}
          ${iPadStatusOverlay()}
        </g>
      </g>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.42}" fill="none" stroke="#000" stroke-opacity="0.62" stroke-width="${w * 0.006}"/>
      <circle cx="${x + w / 2}" cy="${y + bezel * 0.47}" r="${w * 0.012}" fill="#070707"/>
      <circle cx="${x + w / 2}" cy="${y + bezel * 0.47}" r="${w * 0.004}" fill="#1C2460" opacity="0.55"/>
    </g>
  `;
}

function iPadStatusOverlay() {
  return `
    <rect x="0" y="0" width="430" height="66" fill="${C.screen}"/>
    <text class="font" x="28" y="25" font-size="15" font-weight="700" fill="${C.paper}">9:41</text>
    <g fill="${C.paper}" opacity="0.92">
      <rect x="332" y="27" width="4" height="10" rx="1"/>
      <rect x="339" y="23" width="4" height="14" rx="1"/>
      <rect x="346" y="19" width="4" height="18" rx="1"/>
      <path d="M363 32 q12 -12 24 0 l-4 4 q-8 -8 -16 0z"/>
      <circle cx="375" cy="39" r="3"/>
      <rect x="398" y="24" width="25" height="13" rx="3" fill="none" stroke="${C.paper}" stroke-width="1.5"/>
      <rect x="401" y="27" width="17" height="7" rx="2"/>
      <rect x="425" y="28" width="2.5" height="5" rx="1"/>
    </g>
  `;
}

function brandMark(cx, y, isSmall) {
  const logo = brandLogoHref();
  if (logo) {
    const logoH = isSmall ? 40 : 48;
    const logoW = logoH * (423 / 99);
    const padX = logoH * 0.52;
    const padY = logoH * 0.32;
    return `
      <g opacity="0.96">
        <rect x="${cx - logoW / 2 - padX}" y="${y - padY}" width="${logoW + padX * 2}" height="${logoH + padY * 2}" rx="${logoH * 0.55}" fill="${C.paper}" opacity="0.94"/>
        <image x="${cx - logoW / 2}" y="${y}" width="${logoW}" height="${logoH}" href="${logo}" preserveAspectRatio="xMidYMid meet"/>
      </g>
    `;
  }

  const size = isSmall ? 34 : 42;
  const mark = size * 1.18;
  const totalW = mark + size * 0.55 + size * 5.35;
  const startX = cx - totalW / 2;
  const wordX = startX + mark + size * 0.55;
  return `
    <g opacity="0.94">
      <rect x="${startX}" y="${y - size * 0.08}" width="${mark}" height="${mark}" rx="${mark * 0.2}" fill="${C.amber}"/>
      <text class="font" x="${startX + mark / 2}" y="${y + size * 0.02}" text-anchor="middle" font-size="${size * 0.86}" font-weight="900" fill="${C.dark}" letter-spacing="0">b</text>
      <text class="font" x="${wordX}" y="${y - size * 0.06}" font-size="${size}" font-weight="800" letter-spacing="0">
        <tspan fill="${C.paper}">beebeeb</tspan><tspan fill="${C.amber}">.io</tspan>
      </text>
    </g>
  `;
}

function statusBar(dark = false) {
  const color = dark ? C.paper : C.ink;
  return `
    <rect x="0" y="0" width="430" height="66" fill="transparent"/>
    <text class="font" x="40" y="25" font-size="15" font-weight="700" fill="${color}">9:41</text>
    <g fill="${color}" opacity="0.92">
      <rect x="322" y="27" width="4" height="10" rx="1"/><rect x="329" y="23" width="4" height="14" rx="1"/><rect x="336" y="19" width="4" height="18" rx="1"/>
      <path d="M353 32 q12 -12 24 0 l-4 4 q-8 -8 -16 0z"/><circle cx="365" cy="39" r="3"/>
      <rect x="386" y="24" width="25" height="13" rx="3" fill="none" stroke="${color}" stroke-width="1.5"/><rect x="389" y="27" width="17" height="7" rx="2"/><rect x="413" y="28" width="2.5" height="5" rx="1"/>
    </g>
  `;
}

function appHeader(title, right = '', dark = false) {
  const fill = dark ? C.paper : C.ink;
  return `
    <g>
      <text class="font" x="18" y="77" font-size="30" font-weight="850" fill="${fill}">${esc(title)}</text>
      ${right}
    </g>
  `;
}

function tabBar(active) {
  const tabs = [
    ['Files', 'M10 15 h28 v22 h-28z M14 12 h11 l4 5 h9'],
    ['Shared', 'M14 22 a6 6 0 1 0 0.1 0 M29 22 a6 6 0 1 0 0.1 0 M8 39 q16 -13 32 0'],
    ['Photos', 'M10 12 h28 v26 h-28z M15 32 l8 -9 6 6 4 -5 5 8'],
    ['Settings', 'M24 18 a6 6 0 1 0 0.1 0 M24 8 v5 M24 35 v5 M8 24 h5 M35 24 h5'],
  ];
  return `
    <rect x="0" y="840" width="430" height="92" fill="${C.screen}" stroke="${C.screenLine}"/>
    ${tabs.map(([label, path], i) => {
      const x = 54 + i * 107.5;
      const isActive = label === active;
      return `
        <g transform="translate(${x - 24} 852)" fill="none" stroke="${isActive ? C.amber : '#6F6974'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="${path}"/>
        </g>
        <text class="font" x="${x}" y="896" text-anchor="middle" font-size="11" font-weight="${isActive ? 800 : 600}" fill="${isActive ? C.amber : '#6F6974'}">${label}</text>
      `;
    }).join('')}
  `;
}

function filesScreen() {
  const rows = [
    ['folder', 'Backups', 'iPhone 17 Pro Max · 54 ago'],
    ['image', 'IMG_0042.HEIC', '3.1 MB · 14 ago'],
    ['pdf', 'Q2 invoice.pdf', '428 KB · yesterday'],
    ['zip', 'Design archive.zip', '247 MB · 2 days ago'],
    ['image', 'Weekend garden.jpg', '2.4 MB · Apr 28'],
    ['pdf', 'Signed contract.pdf', '1.8 MB · AES-256-GCM'],
    ['folder', 'Receipts', '18 items · encrypted'],
    ['video', 'Birthday.mov', '86 MB · backed up'],
    ['folder', 'Work', '16 items · synced'],
  ];
  const recent = [
    ['IMG_0042.HEIC', 0],
    ['Signed contract.pdf', 1],
    ['Weekend garden.jpg', 2],
  ];
  return `
    <rect width="430" height="932" fill="${C.screen}"/>
    ${statusBar(true)}
    ${appHeader('Drive', headerButtons(), true)}
    <text class="font" x="18" y="123" font-size="10" font-weight="850" fill="#8E8793" letter-spacing="1">RECENT</text>
    <g transform="translate(18 140)">
      ${recent.map(([name, photoIndex], i) => `
        <rect x="${i * 126}" y="0" width="116" height="88" rx="7" fill="${C.screen3}" stroke="${C.screenLine}"/>
        <clipPath id="recentClip${i}"><rect x="${i * 126 + 9}" y="10" width="35" height="35" rx="4"/></clipPath>
        <image x="${i * 126 + 9}" y="10" width="35" height="35" href="${stockPhotoHref(photoIndex)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#recentClip${i})"/>
        <text class="font" x="${i * 126 + 9}" y="56" font-size="10" font-weight="800" fill="${C.paper}">${esc(name)}</text>
        <text class="font" x="${i * 126 + 9}" y="72" font-size="8" font-weight="700" fill="#8E8793">just now</text>
      `).join('')}
    </g>
    <g transform="translate(18 258)">
      ${rows.slice(0, 9).map((row, i) => driveCard((i % 3) * 126, Math.floor(i / 3) * 136, row[0], row[1], row[2], i)).join('')}
    </g>
    <circle cx="380" cy="806" r="28" fill="${C.amber}" filter="url(#softShadow)"/>
    <path d="M380 793 v26 M367 806 h26" stroke="${C.ink}" stroke-width="4" stroke-linecap="round"/>
    ${tabBar('Files')}
  `;
}

function shareScreen() {
  return `
    <rect width="430" height="932" fill="${C.screen}"/>
    ${statusBar(true)}
    ${appHeader('Drive', headerButtons(1), true)}
    ${fileRow(18, 138, 'folder', 'Client documents', '12 items · encrypted', 0.55, 394, true)}
    ${fileRow(18, 200, 'pdf', 'Signed contract.pdf', '1.8 MB · selected', 0.55, 394, true)}
    ${fileRow(18, 262, 'zip', 'Design archive.zip', '247 MB · encrypted', 0.42, 394, true)}
    <rect x="0" y="0" width="430" height="932" fill="#000" opacity="0.32"/>
    <rect x="0" y="342" width="430" height="590" rx="30" fill="${C.screen2}" filter="url(#softShadow)"/>
    <rect x="184" y="358" width="62" height="5" rx="3" fill="${C.screenLine}"/>
    <text class="font" x="24" y="392" font-size="26" font-weight="850" fill="${C.paper}">Share encrypted link</text>
    <text class="font" x="24" y="430" font-size="13" font-weight="650" fill="#9B949F">Signed contract.pdf · 1.8 MB</text>
    ${settingRow(24, 480, 'Expires', 'In 7 days', 'Link stops working automatically', true)}
    ${toggleRow(24, 556, 'Double encrypted', 'On', 'Recipient key stays in the URL fragment', true, true)}
    ${settingRow(24, 642, 'Download limit', '5 opens', 'Revokes after the fifth download', true)}
    <rect x="24" y="730" width="382" height="58" rx="16" fill="${C.screen3}" stroke="${C.screenLine}"/>
    <text class="mono" x="44" y="751" font-size="11" font-weight="700" fill="#BDB5C1">beebeeb.io/s/9f3a7c2e#key=qY2...</text>
    <rect x="328" y="744" width="58" height="30" rx="10" fill="${C.amber}"/>
    <text class="font" x="357" y="751" text-anchor="middle" font-size="12" font-weight="900" fill="${C.ink}">Copy</text>
    <rect x="24" y="814" width="382" height="52" rx="16" fill="${C.amber}"/>
    <text class="font" x="215" y="829" text-anchor="middle" font-size="15" font-weight="900" fill="${C.ink}">Create secure link</text>
  `;
}

function photosScreen() {
  const thumbs = Array.from({ length: 12 }, (_, i) => {
    const x = (i % 4) * 107.5;
    const y = 174 + Math.floor(i / 4) * 107.5;
    const clipId = `stockPhoto${i}`;
    return `
      <clipPath id="${clipId}">
        <rect x="${x}" y="${y}" width="105.5" height="105.5" rx="0"/>
      </clipPath>
      <image x="${x}" y="${y}" width="105.5" height="105.5" href="${stockPhotoHref(i)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>
      <rect x="${x}" y="${y + 86}" width="105.5" height="20" fill="#000" opacity="0.28"/>
      <text class="font" x="${x + 5}" y="${y + 91}" font-size="7" font-weight="800" fill="${C.paper}">IMG_${String(i + 1).padStart(4, '0')}.JPG</text>
    `;
  }).join('');
  return `
    <rect width="430" height="932" fill="${C.screen}"/>
    ${statusBar(true)}
    ${appHeader('Photos', '', true)}
    <rect x="18" y="126" width="394" height="32" rx="5" fill="${C.screen3}" stroke="${C.screenLine}"/>
    <text class="font" x="38" y="136" font-size="11" font-weight="650" fill="#9B949F">8 photos, 1 video on device</text>
    <text class="font" x="342" y="136" text-anchor="end" font-size="11" font-weight="800" fill="#9B949F">9 backed up</text>
    <text class="font" x="18" y="164" font-size="14" font-weight="850" fill="${C.paper}">May 2026</text>
    <text class="font" x="78" y="165" font-size="10" font-weight="750" fill="#8E8793">8 items</text>
    ${thumbs}
    <rect x="0" y="804" width="430" height="36" fill="#3A3204" stroke="#6B5700"/>
    <circle cx="21" cy="821" r="3" fill="${C.green}"/>
    <text class="font" x="34" y="815" font-size="11" font-weight="800" fill="${C.paper}">All photos backed up</text>
    ${tabBar('Photos')}
  `;
}

function glassboxScreen() {
  return `
    <rect width="430" height="932" fill="#101010"/>
    ${statusBar(true)}
    <rect x="24" y="86" width="382" height="760" rx="26" fill="#171412" stroke="#2E2923"/>
    <rect x="44" y="112" width="342" height="58" rx="18" fill="${C.amberBg}" stroke="${C.amber}"/>
    <circle cx="70" cy="141" r="10" fill="${C.green}"/><path d="M64 141 l5 5 l10 -13" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text class="font" x="92" y="126" font-size="14" font-weight="900" fill="${C.ink}">Decrypted on your device</text>
    <text class="font" x="92" y="149" font-size="11" font-weight="750" fill="${C.ink2}">Key fragment never touched our server</text>
    <text class="font" x="44" y="202" font-size="28" font-weight="900" fill="${C.paper}">Signed contract.pdf</text>
    <text class="font" x="44" y="240" font-size="13" font-weight="700" fill="${C.ink4}">1.8 MB · shared by Ava Demo · expires in 7 days</text>
    <rect x="44" y="292" width="342" height="162" rx="18" fill="${C.paper}"/>
    <text class="font" x="70" y="320" font-size="16" font-weight="900" fill="${C.ink}">Preview</text>
    <rect x="70" y="354" width="210" height="8" rx="4" fill="${C.line2}"/>
    <rect x="70" y="378" width="260" height="8" rx="4" fill="${C.line}"/>
    <rect x="70" y="402" width="188" height="8" rx="4" fill="${C.line}"/>
    <rect x="70" y="432" width="92" height="7" rx="4" fill="${C.amber}"/>
    <text class="font" x="44" y="498" font-size="12" font-weight="900" fill="${C.amber}" letter-spacing="1">GLASSBOX</text>
    <rect x="44" y="530" width="342" height="190" rx="18" fill="#0A0A0A" stroke="#35302A"/>
    <text class="mono" x="62" y="550" font-size="11" font-weight="700" fill="${C.amberSoft}">00000000  25 50 44 46 2d 31 2e 37  0a 25 e2 e3 cf d3 0a 31</text>
    <text class="mono" x="62" y="576" font-size="11" font-weight="700" fill="#B8B0A4">00000010  20 30 20 6f 62 6a 0a 3c  3c 2f 54 79 70 65 2f 43</text>
    <text class="mono" x="62" y="602" font-size="11" font-weight="700" fill="#B8B0A4">00000020  61 74 61 6c 6f 67 2f 50  61 67 65 73 20 32 20 30</text>
    <text class="mono" x="62" y="628" font-size="11" font-weight="700" fill="#B8B0A4">00000030  20 52 3e 3e 0a 65 6e 64  6f 62 6a 0a 32 20 30 20</text>
    <rect x="278" y="674" width="86" height="28" rx="14" fill="${C.amber}"/>
    <circle cx="348" cy="688" r="11" fill="${C.ink}"/>
    <text class="font" x="238" y="681" text-anchor="end" font-size="12" font-weight="850" fill="${C.paper}">Hex dump</text>
    <rect x="44" y="752" width="342" height="52" rx="16" fill="${C.amber}"/>
    <text class="font" x="215" y="767" text-anchor="middle" font-size="15" font-weight="900" fill="${C.ink}">Save decrypted file</text>
  `;
}

function everywhereScreen() {
  return `
    <rect width="430" height="932" fill="${C.screen}"/>
    ${statusBar(true)}
    <text class="font" x="18" y="78" font-size="29" font-weight="900" fill="${C.paper}">Same vault</text>
    <rect x="18" y="128" width="394" height="190" rx="18" fill="${C.screen2}" stroke="${C.screenLine}" filter="url(#softShadow)"/>
    <text class="font" x="42" y="154" font-size="12" font-weight="900" fill="${C.amber}" letter-spacing="1">WEB</text>
    <text class="font" x="42" y="183" font-size="22" font-weight="900" fill="${C.paper}">app.beebeeb.io</text>
    ${miniFile(42, 232, 'Backups', '9 items', true)}
    ${miniFile(216, 232, 'Q2 invoice.pdf', '428 KB', true)}
    <rect x="18" y="344" width="394" height="226" rx="18" fill="${C.screen2}" stroke="${C.screenLine}" filter="url(#softShadow)"/>
    <text class="font" x="42" y="370" font-size="12" font-weight="900" fill="${C.amber}" letter-spacing="1">IPHONE</text>
    ${fileRow(42, 414, 'folder', 'Backups', 'iPhone 17 Pro Max · synced', 1, 346, true)}
    ${fileRow(42, 472, 'image', 'IMG_0042.HEIC', '3.1 MB · backed up', 1, 346, true)}
    <rect x="18" y="596" width="394" height="204" rx="18" fill="#0B0B0B" stroke="${C.screenLine}" filter="url(#softShadow)"/>
    <text class="font" x="42" y="622" font-size="12" font-weight="900" fill="${C.amber}" letter-spacing="1">CLI</text>
    <text class="mono" x="42" y="660" font-size="13" font-weight="800" fill="${C.paper}">$ beebeeb ls Backups</text>
    <text class="mono" x="42" y="692" font-size="12" font-weight="700" fill="${C.amberSoft}">drwx  iPhone 17 Pro Max/</text>
    <text class="mono" x="42" y="722" font-size="12" font-weight="700" fill="${C.amberSoft}">-rw-  Q2 invoice.pdf</text>
    <text class="mono" x="42" y="752" font-size="12" font-weight="700" fill="#B8B0A4">-rw-  IMG_0042.HEIC</text>
    ${tabBar('Files')}
  `;
}

function europeScreen() {
  return `
    <rect width="430" height="932" fill="${C.screen}"/>
    ${statusBar(true)}
    ${appHeader('Settings', '', true)}
    <text class="font" x="18" y="126" font-size="10" font-weight="750" fill="#8E8793">New uploads go to your selected region. Existing files stay where they are.</text>
    <text class="font" x="18" y="174" font-size="11" font-weight="900" fill="#8E8793" letter-spacing="1">SECURITY</text>
    <rect x="18" y="196" width="394" height="126" rx="10" fill="${C.screen2}" stroke="${C.screenLine}"/>
    <text class="font" x="42" y="216" font-size="14" font-weight="850" fill="${C.paper}">Mount Beebeeb in Files</text>
    <text class="font" x="42" y="239" font-size="11" font-weight="600" fill="#9B949F">Access your vault from the iOS Files app.</text>
    <rect x="348" y="214" width="44" height="28" rx="14" fill="${C.amber}"/><circle cx="378" cy="228" r="12" fill="#fff"/>
    <line x1="18" y1="262" x2="412" y2="262" stroke="${C.screenLine}"/>
    <text class="font" x="42" y="283" font-size="14" font-weight="750" fill="${C.paper}">Two-Factor Authentication</text>
    <text class="font" x="386" y="283" text-anchor="middle" font-size="20" fill="#8E8793">›</text>
    <text class="font" x="18" y="350" font-size="11" font-weight="900" fill="#8E8793" letter-spacing="1">STORAGE REGION</text>
    <rect x="18" y="372" width="394" height="124" rx="12" fill="${C.screen2}" stroke="${C.screenLine}"/>
    <rect x="42" y="396" width="56" height="40" rx="8" fill="${C.blue}"/>
    ${Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return `<circle cx="${70 + Math.cos(a) * 17}" cy="${416 + Math.sin(a) * 12}" r="1.8" fill="${C.amber}"/>`;
    }).join('')}
    <text class="font" x="116" y="398" font-size="17" font-weight="900" fill="${C.paper}">European storage</text>
    <text class="font" x="116" y="427" font-size="12" font-weight="700" fill="#B8B0A4">Falkenstein, Germany</text>
    <text class="font" x="116" y="454" font-size="12" font-weight="850" fill="${C.amber}">Active region</text>
    <text class="font" x="18" y="528" font-size="11" font-weight="900" fill="#8E8793" letter-spacing="1">ACCOUNT</text>
    <rect x="18" y="550" width="394" height="206" rx="12" fill="${C.screen2}" stroke="${C.screenLine}"/>
    ${aboutRow(42, 578, 'Operator', 'Initlabs B.V.', true)}
    ${aboutRow(42, 636, 'Location', 'Wijchen, NL', true)}
    ${aboutRow(42, 694, 'Encryption', 'Client-side', true)}
    ${tabBar('Settings')}
  `;
}

function headerButtons(count = 3) {
  return Array.from({ length: count }, (_, i) => `
    <circle cx="${382 - i * 42}" cy="92" r="15" fill="transparent" stroke="transparent"/>
    <text class="font" x="${382 - i * 42}" y="82" text-anchor="middle" font-size="18" font-weight="800" fill="${i === 0 ? C.paper : '#A9A2AD'}">${['⌕', '⇅', '≡'][i] ?? '·'}</text>
  `).join('');
}

function fileRow(x, y, type, name, meta, opacity = 1, width = 378, dark = false) {
  const rowFill = dark ? C.screen3 : '#FFFFFF';
  const text = dark ? C.paper : C.ink;
  const muted = dark ? '#B8B0A4' : C.ink3;
  return `
    <g opacity="${opacity}">
      <rect x="${x}" y="${y}" width="${width}" height="52" rx="16" fill="${rowFill}" stroke="${dark ? '#3A342C' : C.line}"/>
      ${fileIcon(x + 14, y + 10, type)}
      <text class="font" x="${x + 58}" y="${y + 11}" font-size="14" font-weight="850" fill="${text}">${esc(name)}</text>
      <text class="font" x="${x + 58}" y="${y + 31}" font-size="11" font-weight="650" fill="${muted}">${esc(meta)}</text>
      <text class="font" x="${x + width - 24}" y="${y + 15}" text-anchor="middle" font-size="24" font-weight="500" fill="${muted}">›</text>
    </g>
  `;
}

function driveCard(x, y, type, name, meta, index) {
  const isFolder = type === 'folder';
  const isImage = type === 'image';
  const isVideo = type === 'video';
  const clipId = `driveCardPhoto${index}`;
  const icon = isImage || isVideo
    ? `<clipPath id="${clipId}"><rect x="${x + 28}" y="${y + 19}" width="44" height="44" rx="7"/></clipPath>
       <image x="${x + 28}" y="${y + 19}" width="44" height="44" href="${stockPhotoHref(index)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    : fileIcon(x + 35, y + 18, type);
  return `
    <rect x="${x}" y="${y}" width="116" height="126" rx="8" fill="${isFolder ? '#403300' : C.screen2}" stroke="${C.screenLine}"/>
    <text class="font" x="${x + 11}" y="${y + 13}" font-size="12" font-weight="850" fill="${C.amber}">⌘</text>
    ${icon}
    <text class="font" x="${x + 10}" y="${y + 76}" font-size="10" font-weight="850" fill="${C.paper}">${esc(truncate(name, 18))}</text>
    <text class="font" x="${x + 10}" y="${y + 94}" font-size="8" font-weight="650" fill="#8E8793">${esc(truncate(meta, 20))}</text>
    <text class="font" x="${x + 10}" y="${y + 109}" font-size="7" font-weight="650" fill="#6F6974">AES-256-GCM</text>
  `;
}

function miniFile(x, y, name, meta, dark = false) {
  const fill = dark ? C.screen3 : C.paper2;
  const stroke = dark ? C.screenLine : C.line;
  const text = dark ? C.paper : C.ink;
  const muted = dark ? '#9B949F' : C.ink3;
  return `
    <rect x="${x}" y="${y}" width="144" height="58" rx="15" fill="${fill}" stroke="${stroke}"/>
    ${folderIcon(x + 14, y + 14, 22, C.amberDeep)}
    <text class="font" x="${x + 44}" y="${y + 12}" font-size="12" font-weight="850" fill="${text}">${esc(name)}</text>
    <text class="font" x="${x + 44}" y="${y + 32}" font-size="10" font-weight="650" fill="${muted}">${esc(meta)}</text>
  `;
}

function fileIcon(x, y, type) {
  const map = {
    folder: [C.amberDeep, folderIcon(x + 8, y + 10, 22, '#fff')],
    pdf: [C.red, docGlyph(x + 11, y + 8, 'PDF')],
    image: [C.amber, imageGlyph(x + 10, y + 9)],
    video: [C.ink2, docGlyph(x + 11, y + 8, 'MOV')],
    zip: [C.ink2, docGlyph(x + 11, y + 8, 'ZIP')],
  };
  const [bg, icon] = map[type] ?? map.pdf;
  return `<rect x="${x}" y="${y}" width="34" height="34" rx="10" fill="${bg}"/>${icon}`;
}

function folderIcon(x, y, size, fill) {
  return `<path d="M${x} ${y + size * 0.32} h${size * 0.36} l${size * 0.12} ${size * 0.14} h${size * 0.52} v${size * 0.44} a${size * 0.09} ${size * 0.09} 0 0 1 -${size * 0.09} ${size * 0.09} h-${size * 0.82} a${size * 0.09} ${size * 0.09} 0 0 1 -${size * 0.09} -${size * 0.09} z" fill="${fill}"/>`;
}

function docGlyph(x, y, label) {
  return `<rect x="${x}" y="${y}" width="14" height="18" rx="2" fill="#fff"/><text class="font" x="${x + 7}" y="${y + 20}" text-anchor="middle" font-size="6" font-weight="900" fill="#fff">${label}</text>`;
}

function imageGlyph(x, y) {
  return `<rect x="${x}" y="${y}" width="16" height="14" rx="2" fill="${C.ink}"/><circle cx="${x + 12}" cy="${y + 4}" r="2" fill="${C.amber}"/><path d="M${x + 2} ${y + 12} l5 -5 l3 3 l3 -4 l4 6z" fill="${C.amber}"/>`;
}

function settingRow(x, y, label, value, meta, dark = false) {
  const fill = dark ? C.screen3 : '#FFFFFF';
  const stroke = dark ? C.screenLine : C.line;
  const text = dark ? C.paper : C.ink;
  const muted = dark ? '#9B949F' : C.ink3;
  return `
    <rect x="${x}" y="${y}" width="382" height="62" rx="16" fill="${fill}" stroke="${stroke}"/>
    <text class="font" x="${x + 18}" y="${y + 12}" font-size="14" font-weight="850" fill="${text}">${esc(label)}</text>
    <text class="font" x="${x + 18}" y="${y + 34}" font-size="11" font-weight="650" fill="${muted}">${esc(meta)}</text>
    <text class="font" x="${x + 352}" y="${y + 22}" text-anchor="end" font-size="13" font-weight="850" fill="${C.amberDeep}">${esc(value)}</text>
  `;
}

function toggleRow(x, y, label, value, meta, on, dark = false) {
  const fill = dark ? C.screen3 : '#FFFFFF';
  const stroke = dark ? C.screenLine : C.line;
  const text = dark ? C.paper : C.ink;
  const muted = dark ? '#9B949F' : C.ink3;
  return `
    <rect x="${x}" y="${y}" width="382" height="72" rx="16" fill="${fill}" stroke="${stroke}"/>
    <text class="font" x="${x + 18}" y="${y + 13}" font-size="14" font-weight="850" fill="${text}">${esc(label)}</text>
    <text class="font" x="${x + 18}" y="${y + 36}" font-size="11" font-weight="650" fill="${muted}">${esc(meta)}</text>
    <rect x="${x + 312}" y="${y + 18}" width="50" height="30" rx="15" fill="${on ? C.amber : C.line2}"/>
    <circle cx="${x + (on ? 347 : 327)}" cy="${y + 33}" r="12" fill="${on ? C.ink : '#fff'}"/>
    <text class="font" x="${x + 288}" y="${y + 25}" text-anchor="end" font-size="12" font-weight="900" fill="${C.amberDeep}">${esc(value)}</text>
  `;
}

function regionRow(x, y, city, meta, active) {
  return `
    <circle cx="${x + 13}" cy="${y + 20}" r="10" fill="${active ? C.amber : '#fff'}" stroke="${active ? C.amber : C.line2}" stroke-width="3"/>
    <text class="font" x="${x + 42}" y="${y}" font-size="15" font-weight="900" fill="${C.ink}">${esc(city)}</text>
    <text class="font" x="${x + 42}" y="${y + 24}" font-size="12" font-weight="650" fill="${C.ink3}">${esc(meta)}</text>
    ${active ? `<text class="font" x="360" y="${y + 12}" text-anchor="end" font-size="12" font-weight="900" fill="${C.amberDeep}">Active</text>` : ''}
  `;
}

function aboutRow(x, y, label, value, dark = false) {
  const text = dark ? C.paper : C.ink;
  const muted = dark ? '#9B949F' : C.ink3;
  const line = dark ? C.screenLine : C.line;
  return `
    <text class="font" x="${x}" y="${y}" font-size="13" font-weight="700" fill="${muted}">${esc(label)}</text>
    <text class="font" x="386" y="${y}" text-anchor="end" font-size="13" font-weight="900" fill="${text}">${esc(value)}</text>
    <line x1="${x}" y1="${y + 34}" x2="386" y2="${y + 34}" stroke="${line}"/>
  `;
}

function truncate(value, max) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function wrap(copy, maxChars) {
  const words = copy.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readme() {
  return `# App Store screenshots

Generated marketing screenshots for task 0044.

Run:

\`\`\`sh
node scripts/generate-app-store-screenshots.mjs
\`\`\`

The generator writes both editable SVGs and App Store-ready PNGs for:

- \`iphone-6.9\`: 1320 x 2868
- \`iphone-6.7\`: 1290 x 2796
- \`iphone-5.5\`: 1242 x 2208
- \`ipad-13\`: 2064 x 2752

These are high-fidelity deterministic mockups built from real simulator screenshots in \`screenshots/app-store-raw-real-2026-05-20/\`, captured from the seeded \`demo+ios@beebeeb.io\` account. They do not claim App Store Connect, TestFlight tester groups, privacy questionnaire, or reviewer account setup is complete.

The iPhone 17 Pro Max shell is based on Apple's official Product Bezel design resource. The iPad set uses a deterministic SVG iPad-style shell sized for Apple's 13-inch iPad screenshot slot. Both are only used to depict Beebeeb's iOS interface in App Store screenshot mockups.
`;
}

main();
