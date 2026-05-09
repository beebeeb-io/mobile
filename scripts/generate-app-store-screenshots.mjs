#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const OUT_DIR = resolve('marketing/app-store');

const TARGETS = [
  { key: 'iphone-6.7', label: '6.7 inch', width: 1290, height: 2796, phoneW: 820, phoneH: 1780, phoneY: 860 },
  { key: 'iphone-5.5', label: '5.5 inch', width: 1242, height: 2208, phoneW: 620, phoneH: 1346, phoneY: 690 },
];

const SLIDES = [
  {
    id: 'files-encrypted',
    eyebrow: 'End-to-end encrypted',
    headline: ['Your files,', 'encrypted'],
    accentLine: 1,
    subhead: 'Mock vault data. Documents, photos, work files, and contracts stay private before upload.',
    screen: filesScreen,
  },
  {
    id: 'share-without-compromising',
    eyebrow: 'Double-encrypted links',
    headline: ['Share without', 'compromising'],
    accentLine: 1,
    subhead: 'A second client-side key protects shared files. The fragment never reaches the server.',
    screen: shareScreen,
  },
  {
    id: 'back-up-memories',
    eyebrow: 'Camera roll backup',
    headline: ['Back up your', 'memories'],
    accentLine: 1,
    subhead: 'Photos are encrypted on device and backed up automatically, with no real user data shown here.',
    screen: photosScreen,
  },
  {
    id: 'zero-knowledge',
    eyebrow: 'Zero-knowledge by design',
    headline: ['Decrypted in', 'your browser'],
    accentLine: 1,
    subhead: 'Glassbox share preview shows exactly what decrypts locally, including a visible hex dump mode.',
    screen: glassboxScreen,
  },
  {
    id: 'works-everywhere',
    eyebrow: 'One encrypted vault',
    headline: ['Works', 'everywhere'],
    accentLine: 1,
    subhead: 'Web, mobile, and CLI all point at the same encrypted files and folders.',
    screen: everywhereScreen,
  },
  {
    id: 'made-in-europe',
    eyebrow: 'European storage',
    headline: ['Made in', 'Europe'],
    accentLine: 1,
    subhead: 'Built by Initlabs B.V. Stored in Falkenstein, Germany',
    screen: europeScreen,
  },
];

const C = {
  amber: '#F5B800',
  amberDeep: '#B8860B',
  amberSoft: '#FDE8A8',
  amberBg: '#FEF4CF',
  dark: '#1A1714',
  dark2: '#2A2520',
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
  const headSize = isSmall ? 104 : 138;
  const subSize = isSmall ? 34 : 42;
  const eyebrowSize = isSmall ? 24 : 28;
  const contentY = isSmall ? 108 : 150;
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
    <circle cx="${w * 0.86}" cy="${h * 0.08}" r="${w * 0.26}" fill="${C.amber}" opacity="0.09"/>
    <circle cx="${w * 0.1}" cy="${h * 0.88}" r="${w * 0.22}" fill="${C.amber}" opacity="0.07"/>

    ${pill(w / 2, contentY, slide.eyebrow, eyebrowSize)}
    ${headline(w / 2, contentY + (isSmall ? 104 : 126), slide.headline, headSize, slide.accentLine)}
    ${paragraph(w / 2, contentY + (isSmall ? 338 : 436), slide.subhead, subSize, isSmall ? 980 : 1040, '#EDE5D8')}

    ${phoneFrame(phoneX, phoneY, target.phoneW, target.phoneH, slide.screen)}
    ${brandMark(w / 2, h - (isSmall ? 58 : 70), isSmall)}
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
  const width = Math.max(410, label.length * size * 0.66);
  return `
    <rect x="${cx - width / 2}" y="${y}" width="${width}" height="${size * 2.05}" rx="${size}" fill="${C.amber}" opacity="0.16" stroke="${C.amber}" stroke-opacity="0.54" stroke-width="2"/>
    <text class="font" x="${cx}" y="${y + size * 0.48}" text-anchor="middle" font-size="${size}" font-weight="800" fill="${C.amber}" letter-spacing="2">${esc(label.toUpperCase())}</text>
  `;
}

function headline(cx, y, lines, size, accentLine) {
  return lines.map((line, index) => `
    <text class="font" x="${cx}" y="${y + index * size * 0.98}" text-anchor="middle" font-size="${size}" font-weight="900" fill="${index === accentLine ? C.amber : C.paper}" letter-spacing="-3">${esc(line)}</text>
  `).join('');
}

function paragraph(cx, y, copy, size, maxWidth, fill) {
  const lines = wrap(copy, Math.floor(maxWidth / (size * 0.54)));
  return lines.map((line, index) => `
    <text class="font" x="${cx}" y="${y + index * size * 1.28}" text-anchor="middle" font-size="${size}" font-weight="500" fill="${fill}" opacity="0.84">${esc(line)}</text>
  `).join('');
}

function phoneFrame(x, y, w, h, screenFn) {
  const bezel = w * 0.028;
  const rx = w * 0.12;
  const sx = x + bezel;
  const sy = y + bezel;
  const sw = w - bezel * 2;
  const sh = h - bezel * 2;
  const scaleX = sw / 430;
  const scaleY = sh / 932;
  const clipId = `screenClip${Math.round(x)}${Math.round(y)}${Math.round(w)}`;
  return `
    <g filter="url(#shadow)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="#050505"/>
      <rect x="${x + w * 0.012}" y="${y + w * 0.012}" width="${w - w * 0.024}" height="${h - w * 0.024}" rx="${rx * 0.92}" fill="#1F1F20"/>
      <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.76}" fill="${C.paper}"/>
      <clipPath id="${clipId}">
        <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${rx * 0.76}"/>
      </clipPath>
      <g clip-path="url(#${clipId})">
        <g transform="translate(${sx} ${sy}) scale(${scaleX} ${scaleY})">
          ${screenFn()}
        </g>
      </g>
      <rect x="${x + w * 0.35}" y="${y + w * 0.052}" width="${w * 0.3}" height="${w * 0.085}" rx="${w * 0.043}" fill="#000"/>
      <rect x="${x + w * 0.35}" y="${y + h - w * 0.062}" width="${w * 0.3}" height="${w * 0.012}" rx="${w * 0.006}" fill="#000" opacity="0.74"/>
    </g>
  `;
}

function brandMark(cx, y, isSmall) {
  const size = isSmall ? 24 : 28;
  return `
    <circle cx="${cx - size * 3.7}" cy="${y + size * 0.5}" r="${size * 0.42}" fill="${C.amber}"/>
    <text class="mono" x="${cx - size * 2.8}" y="${y}" font-size="${size}" font-weight="700" fill="${C.paper}" opacity="0.72">beebeeb</text>
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

function appHeader(title, right = '') {
  return `
    <g>
      <text class="font" x="26" y="78" font-size="30" font-weight="850" fill="${C.ink}">${esc(title)}</text>
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
    <rect x="0" y="840" width="430" height="92" fill="${C.paper}" stroke="${C.line}"/>
    ${tabs.map(([label, path], i) => {
      const x = 54 + i * 107.5;
      const isActive = label === active;
      return `
        <g transform="translate(${x - 24} 852)" fill="none" stroke="${isActive ? C.ink : C.ink4}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="${path}"/>
        </g>
        <text class="font" x="${x}" y="896" text-anchor="middle" font-size="11" font-weight="${isActive ? 800 : 600}" fill="${isActive ? C.ink : C.ink4}">${label}</text>
      `;
    }).join('')}
  `;
}

function filesScreen() {
  const rows = [
    ['folder', 'Documents', '42 items · encrypted · 3 days ago'],
    ['folder', 'Photos', '4,210 photos · all caught up'],
    ['folder', 'Work', '16 items · yesterday'],
    ['pdf', 'Contract_2026.pdf', '1.8 MB · AES-256-GCM'],
    ['folder', 'Vacation', '238 items · backed up'],
    ['folder', 'Tax_returns', '6 files · locked'],
    ['image', 'family-photo-042.heic', '3.1 MB · Apr 28'],
  ];
  return `
    <rect width="430" height="932" fill="${C.paper}"/>
    ${statusBar(false)}
    ${appHeader('Drive', headerButtons())}
    <rect x="26" y="126" width="378" height="92" rx="22" fill="${C.ink}"/>
    <text class="font" x="48" y="148" font-size="15" font-weight="750" fill="${C.paper}">Encrypted storage</text>
    <text class="font" x="48" y="176" font-size="28" font-weight="850" fill="${C.amber}">23.4 GB</text>
    <text class="font" x="158" y="184" font-size="13" font-weight="650" fill="${C.paper}" opacity="0.72">of 200 GB used</text>
    <rect x="48" y="204" width="238" height="5" rx="3" fill="${C.paper}" opacity="0.22"/><rect x="48" y="204" width="92" height="5" rx="3" fill="${C.amber}"/>
    <text class="font" x="26" y="246" font-size="12" font-weight="850" fill="${C.ink3}" letter-spacing="1">PINNED</text>
    <g transform="translate(26 272)">
      ${['Documents', 'Photos', 'Work'].map((name, i) => `
        <rect x="${i * 128}" y="0" width="116" height="74" rx="18" fill="${C.amberBg}" stroke="${C.amberSoft}"/>
        ${folderIcon(i * 128 + 16, 14, 22, C.amberDeep)}
        <text class="font" x="${i * 128 + 16}" y="44" font-size="13" font-weight="800" fill="${C.ink}">${name}</text>
      `).join('')}
    </g>
    <text class="font" x="26" y="376" font-size="12" font-weight="850" fill="${C.ink3}" letter-spacing="1">RECENT FILES</text>
    ${rows.map((row, i) => fileRow(26, 406 + i * 58, row[0], row[1], row[2])).join('')}
    <circle cx="370" cy="784" r="28" fill="${C.amber}" filter="url(#softShadow)"/>
    <path d="M370 771 v26 M357 784 h26" stroke="${C.ink}" stroke-width="4" stroke-linecap="round"/>
    ${tabBar('Files')}
  `;
}

function shareScreen() {
  return `
    <rect width="430" height="932" fill="${C.paper}"/>
    ${statusBar(false)}
    ${appHeader('Drive', headerButtons(1))}
    ${fileRow(26, 138, 'folder', 'Vacation', '238 items · backed up', 0.45)}
    ${fileRow(26, 196, 'zip', 'vacation-photos.zip', '247 MB · selected', 0.45)}
    ${fileRow(26, 254, 'pdf', 'Contract_2026.pdf', '1.8 MB · encrypted', 0.35)}
    <rect x="0" y="0" width="430" height="932" fill="#000" opacity="0.32"/>
    <rect x="0" y="328" width="430" height="604" rx="30" fill="${C.paper}" filter="url(#softShadow)"/>
    <rect x="184" y="344" width="62" height="5" rx="3" fill="${C.line2}"/>
    <text class="font" x="26" y="374" font-size="25" font-weight="850" fill="${C.ink}">Share encrypted link</text>
    <text class="font" x="26" y="411" font-size="13" font-weight="650" fill="${C.ink3}">Contract_2026.pdf · 1.8 MB</text>
    ${settingRow(26, 456, 'Expires', 'In 7 days', 'Link stops working automatically')}
    ${toggleRow(26, 532, 'Double encrypted', 'On', 'Recipient key stays in the URL fragment', true)}
    ${settingRow(26, 618, 'Download limit', '5 opens', 'Revokes after the fifth download')}
    <rect x="26" y="706" width="378" height="62" rx="18" fill="${C.paper2}" stroke="${C.line}"/>
    <text class="mono" x="46" y="729" font-size="12" font-weight="700" fill="${C.ink2}">https://beebeeb.io/s/9f3a7c2e#key=qY2...</text>
    <rect x="322" y="720" width="66" height="34" rx="11" fill="${C.ink}"/>
    <text class="font" x="355" y="729" text-anchor="middle" font-size="13" font-weight="800" fill="${C.amber}">Copy</text>
    <rect x="26" y="792" width="378" height="52" rx="16" fill="${C.amber}"/>
    <text class="font" x="215" y="807" text-anchor="middle" font-size="15" font-weight="900" fill="${C.ink}">Generating secure link...</text>
    <rect x="34" y="856" width="362" height="28" rx="14" fill="${C.amberBg}" stroke="${C.amberSoft}"/>
    <text class="font" x="215" y="863" text-anchor="middle" font-size="12" font-weight="800" fill="${C.amberDeep}">Server never receives the decryption fragment</text>
  `;
}

function photosScreen() {
  const thumbs = Array.from({ length: 32 }, (_, i) => {
    const colors = ['#F1C783', '#9F7A55', '#D8B08A', '#6F5F4D', '#E2D4B8', '#C99050', '#AD8A68', '#594538'];
    return `<rect x="${26 + (i % 4) * 95}" y="${220 + Math.floor(i / 4) * 95}" width="91" height="91" rx="8" fill="${colors[i % colors.length]}"/><path d="M${30 + (i % 4) * 95} ${286 + Math.floor(i / 4) * 95} q28 -34 57 0" stroke="#fff" stroke-opacity="0.16" stroke-width="18" fill="none"/>`;
  }).join('');
  return `
    <rect width="430" height="932" fill="${C.paper}"/>
    ${statusBar(false)}
    ${appHeader('Photos', headerButtons(2))}
    <rect x="26" y="126" width="378" height="66" rx="22" fill="${C.amberBg}" stroke="${C.amberSoft}"/>
    <circle cx="58" cy="159" r="10" fill="${C.green}"/><path d="M52 159 l5 5 l10 -13" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text class="font" x="82" y="143" font-size="14" font-weight="850" fill="${C.ink}">4,210 photos backed up</text>
    <text class="font" x="82" y="165" font-size="12" font-weight="700" fill="${C.amberDeep}">All caught up · encrypted on device</text>
    ${['All', 'Years', 'Months', 'Days'].map((label, i) => `
      <rect x="${26 + i * 72}" y="204" width="62" height="30" rx="15" fill="${i === 0 ? C.ink : C.paper2}" stroke="${i === 0 ? C.ink : C.line}"/>
      <text class="font" x="${57 + i * 72}" y="212" text-anchor="middle" font-size="12" font-weight="800" fill="${i === 0 ? C.paper : C.ink3}">${label}</text>
    `).join('')}
    <text class="font" x="26" y="252" font-size="14" font-weight="850" fill="${C.ink}">May 2026</text>
    ${thumbs}
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
    <text class="font" x="92" y="126" font-size="14" font-weight="900" fill="${C.ink}">Decrypted in your browser</text>
    <text class="font" x="92" y="149" font-size="11" font-weight="750" fill="${C.ink2}">Key fragment never touched our server</text>
    <text class="font" x="44" y="202" font-size="28" font-weight="900" fill="${C.paper}">Contract_2026.pdf</text>
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
    <rect width="430" height="932" fill="${C.paper}"/>
    ${statusBar(false)}
    <text class="font" x="26" y="78" font-size="29" font-weight="900" fill="${C.ink}">Same vault</text>
    <rect x="26" y="128" width="378" height="190" rx="24" fill="#FFFFFF" stroke="${C.line}" filter="url(#softShadow)"/>
    <text class="font" x="50" y="154" font-size="13" font-weight="900" fill="${C.amberDeep}" letter-spacing="1">WEB</text>
    <text class="font" x="50" y="184" font-size="22" font-weight="900" fill="${C.ink}">app.beebeeb.io</text>
    ${miniFile(50, 232, 'Documents', '42 items')}
    ${miniFile(216, 232, 'Contract_2026.pdf', '1.8 MB')}
    <rect x="26" y="344" width="378" height="226" rx="24" fill="${C.ink}" filter="url(#softShadow)"/>
    <text class="font" x="50" y="370" font-size="13" font-weight="900" fill="${C.amber}" letter-spacing="1">MOBILE</text>
    ${fileRow(50, 414, 'folder', 'Documents', '42 items · encrypted', 1, 330, true)}
    ${fileRow(50, 472, 'pdf', 'Contract_2026.pdf', '1.8 MB · encrypted', 1, 330, true)}
    <rect x="26" y="596" width="378" height="204" rx="24" fill="#0B0B0B" filter="url(#softShadow)"/>
    <text class="font" x="50" y="622" font-size="13" font-weight="900" fill="${C.amber}" letter-spacing="1">CLI</text>
    <text class="mono" x="50" y="660" font-size="13" font-weight="800" fill="${C.paper}">$ beebeeb ls</text>
    <text class="mono" x="50" y="692" font-size="12" font-weight="700" fill="${C.amberSoft}">drwx  Documents/        42 items</text>
    <text class="mono" x="50" y="722" font-size="12" font-weight="700" fill="${C.amberSoft}">-rw-  Contract_2026.pdf  1.8 MB</text>
    <text class="mono" x="50" y="752" font-size="12" font-weight="700" fill="#B8B0A4">-rw-  family-photo.heic  3.1 MB</text>
    ${tabBar('Files')}
  `;
}

function europeScreen() {
  return `
    <rect width="430" height="932" fill="${C.paper}"/>
    ${statusBar(false)}
    ${appHeader('Settings')}
    <rect x="26" y="132" width="378" height="120" rx="26" fill="${C.ink}"/>
    <rect x="50" y="158" width="56" height="40" rx="8" fill="${C.blue}"/>
    ${Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return `<circle cx="${78 + Math.cos(a) * 17}" cy="${178 + Math.sin(a) * 12}" r="1.8" fill="${C.amber}"/>`;
    }).join('')}
    <text class="font" x="124" y="154" font-size="18" font-weight="900" fill="${C.paper}">European storage</text>
    <text class="font" x="124" y="185" font-size="13" font-weight="700" fill="${C.paper}" opacity="0.76">Falkenstein, Germany</text>
    <text class="font" x="124" y="214" font-size="12" font-weight="800" fill="${C.amber}">EU jurisdiction context</text>
    <text class="font" x="26" y="286" font-size="12" font-weight="900" fill="${C.ink3}" letter-spacing="1">DATA RESIDENCY</text>
    <rect x="26" y="318" width="378" height="216" rx="22" fill="#fff" stroke="${C.line}"/>
    ${regionRow(48, 344, 'Falkenstein', 'Germany', true)}
    ${regionRow(48, 410, 'Helsinki', 'Finland', false)}
    ${regionRow(48, 476, 'Frankfurt', 'Germany · reserve pool', false)}
    <text class="font" x="26" y="570" font-size="12" font-weight="900" fill="${C.ink3}" letter-spacing="1">ACCOUNT</text>
    <rect x="26" y="602" width="378" height="184" rx="22" fill="#fff" stroke="${C.line}"/>
    ${aboutRow(50, 628, 'Operator', 'Initlabs B.V.')}
    ${aboutRow(50, 684, 'Location', 'Wijchen, NL')}
    ${aboutRow(50, 740, 'Encryption', 'Client-side')}
    ${tabBar('Settings')}
  `;
}

function headerButtons(count = 3) {
  return Array.from({ length: count }, (_, i) => `
    <circle cx="${382 - i * 42}" cy="92" r="15" fill="${i === 0 ? C.amber : C.paper2}" stroke="${i === 0 ? C.amber : C.line}"/>
  `).join('');
}

function fileRow(x, y, type, name, meta, opacity = 1, width = 378, dark = false) {
  const rowFill = dark ? 'rgba(255,255,255,0.05)' : '#FFFFFF';
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

function miniFile(x, y, name, meta) {
  return `
    <rect x="${x}" y="${y}" width="144" height="58" rx="15" fill="${C.paper2}" stroke="${C.line}"/>
    ${folderIcon(x + 14, y + 14, 22, C.amberDeep)}
    <text class="font" x="${x + 44}" y="${y + 12}" font-size="12" font-weight="850" fill="${C.ink}">${esc(name)}</text>
    <text class="font" x="${x + 44}" y="${y + 32}" font-size="10" font-weight="650" fill="${C.ink3}">${esc(meta)}</text>
  `;
}

function fileIcon(x, y, type) {
  const map = {
    folder: [C.amberDeep, folderIcon(x + 8, y + 10, 22, '#fff')],
    pdf: [C.red, docGlyph(x + 11, y + 8, 'PDF')],
    image: [C.amber, imageGlyph(x + 10, y + 9)],
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

function settingRow(x, y, label, value, meta) {
  return `
    <rect x="${x}" y="${y}" width="378" height="62" rx="18" fill="#FFFFFF" stroke="${C.line}"/>
    <text class="font" x="${x + 18}" y="${y + 12}" font-size="14" font-weight="850" fill="${C.ink}">${esc(label)}</text>
    <text class="font" x="${x + 18}" y="${y + 34}" font-size="11" font-weight="650" fill="${C.ink3}">${esc(meta)}</text>
    <text class="font" x="${x + 352}" y="${y + 22}" text-anchor="end" font-size="13" font-weight="850" fill="${C.amberDeep}">${esc(value)}</text>
  `;
}

function toggleRow(x, y, label, value, meta, on) {
  return `
    <rect x="${x}" y="${y}" width="378" height="72" rx="18" fill="#FFFFFF" stroke="${C.line}"/>
    <text class="font" x="${x + 18}" y="${y + 13}" font-size="14" font-weight="850" fill="${C.ink}">${esc(label)}</text>
    <text class="font" x="${x + 18}" y="${y + 36}" font-size="11" font-weight="650" fill="${C.ink3}">${esc(meta)}</text>
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

function aboutRow(x, y, label, value) {
  return `
    <text class="font" x="${x}" y="${y}" font-size="13" font-weight="700" fill="${C.ink3}">${esc(label)}</text>
    <text class="font" x="380" y="${y}" text-anchor="end" font-size="13" font-weight="900" fill="${C.ink}">${esc(value)}</text>
    <line x1="${x}" y1="${y + 34}" x2="380" y2="${y + 34}" stroke="${C.line}"/>
  `;
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

- \`iphone-6.7\`: 1290 x 2796
- \`iphone-5.5\`: 1242 x 2208

These are high-fidelity deterministic mockups using Beebeeb mobile UI tokens and mock data only. They do not claim App Store Connect, TestFlight tester groups, privacy questionnaire, or reviewer account setup is complete.
`;
}

main();
