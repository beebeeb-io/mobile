/**
 * GlassGalleryScreen — `__DEV__`-only reference for the iOS 26 foundation
 * (task 1311).
 *
 * Renders every glass primitive over both a busy photo-grid backdrop and a
 * plain opaque surface, in either colour scheme, alongside the type scale and
 * the grouped-content surfaces. Two jobs:
 *
 *   1. judgement — the material can be looked at and argued about before any
 *      real screen is converted (phases 1312–1315);
 *   2. regression — one screen shows every primitive, so a screenshot diff
 *      catches a change to `glass-recipe.ts` that nothing else would reveal.
 *
 * Reachable from Settings → Advanced → Diagnostics in a dev build. It is NOT
 * in the tab bar and is not registered in a production build.
 *
 * The photo backdrop is a SYNTHETIC grid of saturated tiles, not a bundled
 * JPEG. It stands in for the camera-roll thumbnails the canvas floats its
 * chrome over (see the Photos artboard, "grid bleeds edge-to-edge under
 * everything") while staying byte-identical between runs, so screenshots are
 * comparable. The thin stripe tiles make the blur radius directly readable.
 */

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../App';
import {
  GLASS_CIRCLE_SIZES,
  GLASS_RADII,
  GlassCapsule,
  GlassCircle,
  GlassSegment,
  GlassSheet,
  ScrollEdgeBlur,
  glassMaterial,
  type GlassMaterial,
  type GlassScheme,
} from '../components/glass';
import {
  colors,
  darkColors,
  fonts,
  shadows,
  surfacesFor,
  typeScale,
  type Colors,
  type TypeStyleName,
} from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Backdrop = 'photos' | 'plain';

// ---------------------------------------------------------------------------
// Synthetic photo-grid backdrop
// ---------------------------------------------------------------------------

const TILE_COLUMNS = 5;
const TILE_ROWS = 11;

/** Saturated hues, so the material's effect on colour is visible at a glance. */
const TILE_PALETTE = [
  '#e8442f', '#f5820b', '#f5b800', '#7cb518', '#159947',
  '#0f9b8e', '#1a7fd4', '#3d4fc7', '#7b3fc4', '#c72f8e',
  '#d81b60', '#00838f',
];

function PhotoGridBackdrop() {
  const tiles = useMemo(() => {
    const rows: { color: string; striped: boolean }[][] = [];
    for (let r = 0; r < TILE_ROWS; r += 1) {
      const row: { color: string; striped: boolean }[] = [];
      for (let c = 0; c < TILE_COLUMNS; c += 1) {
        // The +2r shift stops the palette lining up into vertical bands.
        const index = (r * TILE_COLUMNS + c + r * 2) % TILE_PALETTE.length;
        row.push({ color: TILE_PALETTE[index], striped: (r * TILE_COLUMNS + c) % 7 === 3 });
      }
      rows.push(row);
    }
    return rows;
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {tiles.map((row, r) => (
        <View key={r} style={styles.tileRow}>
          {row.map((tile, c) => (
            <View key={c} style={[styles.tile, { backgroundColor: tile.color }]}>
              {tile.striped ? (
                <View style={styles.stripes}>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <View
                      key={i}
                      style={[
                        styles.stripe,
                        { backgroundColor: i % 2 === 0 ? '#ffffff' : '#111111' },
                      ]}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Section scaffolding
// ---------------------------------------------------------------------------

function SectionLabel({ text, color }: { text: string; color: string }) {
  return <Text style={[styles.sectionLabel, { color }]}>{text}</Text>;
}

/**
 * The share-sheet contents, rendered identically on either material so the
 * ONLY difference between the two specimens below is the fill. Each variant
 * passes the colour system it would really use: the opaque card reads from
 * the theme (`c.ink` / `c.line`), the glass sheet from the recipe material.
 */
function SheetSpecimenBody({
  ink,
  inkMuted,
  chipBorder,
  chipActiveFill,
}: {
  ink: string;
  inkMuted: string;
  chipBorder: string;
  chipActiveFill: string;
}) {
  return (
    <>
      <Text style={[typeScale.title3, { color: ink }]}>Share link</Text>
      <Text style={[typeScale.footnote, { color: inkMuted }]}>
        The key stays in the fragment. We never receive it.
      </Text>
      <View style={styles.sheetRow}>
        {['24 hours', '7 days', 'Never'].map((label, i) => (
          <View
            key={label}
            style={[
              styles.expiry,
              {
                backgroundColor: i === 1 ? chipActiveFill : 'transparent',
                borderColor: chipBorder,
              },
            ]}
          >
            <Text style={[typeScale.footnote, { color: i === 1 ? ink : inkMuted }]}>{label}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

/**
 * RULING #1 visual aid — the ShareSheet material question, side by side.
 *
 * `canvas.json` (`wave2`) calls the share sheet "a floating 38px-radius GLASS
 * sheet", while `ShareSheet.dc.html:83` fills it `rgba(28,28,33,0.86)` — far
 * from the 0.46 the same canvas uses for real glass, i.e. near-opaque. Task
 * 1315 read that as a content surface and shipped it opaque. Rather than
 * re-argue it in prose, both are rendered here at the same radius over the
 * same backdrop, in whichever scheme the toggle is on, so the call can be
 * made by looking. Recorded as RULING OPEN #1 in
 * `design/ios26-canvas/DEVIATIONS.md`; nothing in ShareSheetScreen changes
 * until it is made.
 */
function SheetMaterialComparison({
  scheme,
  c,
  material,
}: {
  scheme: GlassScheme;
  c: Colors;
  material: GlassMaterial;
}) {
  return (
    <>
      <Text style={[typeScale.caption2, styles.mono, styles.variantLabel, { color: material.labelMuted }]}>
        {`A · opaque c.paper ${c.paper} — as ShareSheetScreen ships it`}
      </Text>
      <View style={[styles.opaqueSheet, { backgroundColor: c.paper }]}>
        <View style={[styles.opaqueHandle, { backgroundColor: c.line2 }]} />
        <SheetSpecimenBody
          ink={c.ink}
          inkMuted={c.ink3}
          chipBorder={c.line}
          chipActiveFill={c.paper2}
        />
      </View>

      <Text style={[typeScale.caption2, styles.mono, styles.variantLabel, { color: material.labelMuted }]}>
        {`B · recipe glass fill ${material.fill} — canvas.json "glass sheet"`}
      </Text>
      <GlassSheet scheme={scheme} style={styles.glassSheetSpecimen} contentStyle={styles.sheetBody}>
        <SheetSpecimenBody
          ink={material.label}
          inkMuted={material.labelMuted}
          chipBorder={material.rimSide}
          chipActiveFill={material.bubbleFill}
        />
      </GlassSheet>
    </>
  );
}

// ---------------------------------------------------------------------------

export default function GlassGalleryScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [scheme, setScheme] = useState<GlassScheme>('dark');
  const [backdrop, setBackdrop] = useState<Backdrop>('photos');

  const material = glassMaterial(scheme);
  const surfaces = surfacesFor(scheme);
  const c = scheme === 'dark' ? darkColors : colors;

  const typeNames = Object.keys(typeScale) as TypeStyleName[];

  return (
    <View style={[styles.root, { backgroundColor: surfaces.groupedBg }]}>
      {backdrop === 'photos' ? <PhotoGridBackdrop /> : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingTop: insets.top + 100,
          paddingBottom: insets.bottom + 140,
          paddingHorizontal: surfaces.groupInset,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Controls — themselves glass, so they are part of the specimen. */}
        <GlassSegment
          scheme={scheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
          value={scheme}
          onChange={setScheme}
          accessibilityLabel="Colour scheme"
          style={styles.control}
        />
        <GlassSegment
          scheme={scheme}
          options={[
            { value: 'photos', label: 'Photo grid' },
            { value: 'plain', label: 'Plain surface' },
          ]}
          value={backdrop}
          onChange={setBackdrop}
          accessibilityLabel="Backdrop"
          style={styles.control}
        />

        <SectionLabel text="Capsule" color={material.labelMuted} />
        <GlassCapsule scheme={scheme} contentStyle={styles.capsuleBody} style={styles.control}>
          <Ionicons name="lock-closed" size={17} color={colors.amber} />
          <Text style={[typeScale.subhead, { color: material.label, flex: 1 }]}>
            End-to-end encrypted
          </Text>
          <Text style={[typeScale.caption2, styles.mono, { color: material.labelMuted }]}>
            103 MB / 5 GB
          </Text>
        </GlassCapsule>

        <SectionLabel text="Circle" color={material.labelMuted} />
        <View style={[styles.row, styles.control]}>
          <GlassCircle scheme={scheme} size={GLASS_CIRCLE_SIZES.action}>
            <Ionicons name="add" size={19} color={colors.amber} />
          </GlassCircle>
          <GlassCircle scheme={scheme} size={GLASS_CIRCLE_SIZES.search}>
            <Ionicons name="search" size={22} color={material.label} />
          </GlassCircle>
          <GlassCircle scheme={scheme} size={GLASS_CIRCLE_SIZES.action} elevated={false}>
            <Ionicons name="ellipsis-horizontal" size={19} color={material.label} />
          </GlassCircle>
        </View>

        <SectionLabel text="Segment" color={material.labelMuted} />
        <GlassSegment
          scheme={scheme}
          options={[
            { value: 'by-me', label: 'By me' },
            { value: 'with-me', label: 'With me' },
            { value: 'requests', label: 'Requests' },
          ]}
          value="by-me"
          onChange={() => {}}
          accessibilityLabel="Segment specimen"
          style={styles.control}
        />

        <SectionLabel text="Sheet — radius 38" color={material.labelMuted} />
        <GlassSheet scheme={scheme} style={styles.control} contentStyle={styles.sheetBody}>
          <Text style={[typeScale.title3, { color: material.label }]}>Share link</Text>
          <Text style={[typeScale.footnote, { color: material.labelMuted }]}>
            The key stays in the fragment. We never receive it.
          </Text>
          <View style={styles.sheetRow}>
            {['24 hours', '7 days', 'Never'].map((label, i) => (
              <View
                key={label}
                style={[
                  styles.expiry,
                  {
                    backgroundColor: i === 1 ? material.bubbleFill : 'transparent',
                    borderColor: material.rimSide,
                  },
                ]}
              >
                <Text
                  style={[
                    typeScale.footnote,
                    { color: i === 1 ? material.label : material.labelMuted },
                  ]}
                >
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </GlassSheet>

        <SectionLabel
          text="Opaque card at 38 vs glass-sheet fill variant"
          color={material.labelMuted}
        />
        <SheetMaterialComparison scheme={scheme} c={c} material={material} />

        <SectionLabel text="Type scale" color={material.labelMuted} />
        <View
          style={[
            styles.group,
            { backgroundColor: surfaces.groupedCell, borderRadius: surfaces.groupRadius },
          ]}
        >
          {typeNames.map((name, i) => {
            const token = typeScale[name];
            return (
              <View
                key={name}
                style={[
                  styles.typeRow,
                  i < typeNames.length - 1
                    ? {
                        borderBottomWidth: surfaces.separatorWidth,
                        borderBottomColor: surfaces.separator,
                      }
                    : null,
                ]}
              >
                <Text style={[token, { color: c.ink, flex: 1 }]} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={[typeScale.caption2, styles.mono, { color: c.ink3 }]}>
                  {`${token.fontSize}/${token.lineHeight} ${token.fontWeight}`}
                </Text>
              </View>
            );
          })}
        </View>

        <SectionLabel text="Grouped surfaces" color={material.labelMuted} />
        <View
          style={[
            styles.group,
            { backgroundColor: surfaces.groupedCell, borderRadius: surfaces.groupRadius },
          ]}
        >
          {[
            { icon: 'folder', label: 'Backups', meta: '128 items · Jun 17', accent: true },
            { icon: 'image', label: '7832A016-408B.jpg', meta: '2 MB · yesterday', accent: false },
            { icon: 'document', label: 'Scaniverse.stl', meta: '12 MB · Jun 30', accent: false },
          ].map((row, i, all) => (
            <View key={row.label} style={styles.cellRow}>
              <View
                style={[
                  styles.tileIcon,
                  {
                    borderRadius: surfaces.tileRadius,
                    backgroundColor: row.accent ? surfaces.tileAccentBg : surfaces.tileNeutralBg,
                  },
                ]}
              >
                <Ionicons
                  name={row.icon as keyof typeof Ionicons.glyphMap}
                  size={20}
                  color={row.accent ? colors.amber : c.ink2}
                />
              </View>
              <View
                style={[
                  styles.cellBody,
                  i < all.length - 1
                    ? {
                        borderBottomWidth: surfaces.separatorWidth,
                        borderBottomColor: surfaces.separator,
                      }
                    : null,
                ]}
              >
                <View style={styles.cellText}>
                  <Text style={[typeScale.body, { color: c.ink }]} numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Text style={[typeScale.footnote, { color: c.ink3 }]}>{row.meta}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={c.ink4} />
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Top chrome: the progressive scroll-edge blur plus a large title. */}
      <ScrollEdgeBlur scheme={scheme} height={insets.top + 84} />
      <View style={[styles.topChrome, { top: insets.top + 6 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text style={[typeScale.largeTitle, { color: material.label }]}>Glass</Text>
        </TouchableOpacity>
        <GlassCircle scheme={scheme}>
          <Ionicons name="add" size={19} color={colors.amber} />
        </GlassCircle>
      </View>

      {/* Bottom chrome: the canvas tab bar — capsule plus a separate circle. */}
      <View style={[styles.tabBar, { bottom: insets.bottom + 22 }]}>
        <GlassCapsule scheme={scheme} contentStyle={styles.tabTrack} style={styles.tabCapsule}>
          {[
            { icon: 'folder', label: 'Files', active: true },
            { icon: 'git-network', label: 'Shared', active: false },
            { icon: 'image', label: 'Photos', active: false },
            { icon: 'settings', label: 'Settings', active: false },
          ].map((tab) => (
            <View
              key={tab.label}
              style={[
                styles.tabItem,
                tab.active
                  ? [material.bubbleShadow, { backgroundColor: material.bubbleFill }]
                  : null,
              ]}
            >
              <Ionicons
                name={tab.icon as keyof typeof Ionicons.glyphMap}
                size={23}
                color={tab.active ? colors.amber : material.labelMuted}
              />
              <Text
                style={[
                  styles.tabLabel,
                  {
                    color: tab.active ? colors.amber : material.labelMuted,
                    fontWeight: tab.active ? '600' : '500',
                  },
                ]}
              >
                {tab.label}
              </Text>
            </View>
          ))}
        </GlassCapsule>
        <GlassCircle scheme={scheme} size={GLASS_CIRCLE_SIZES.search}>
          <Ionicons name="search" size={22} color={material.label} />
        </GlassCircle>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },

  tileRow: { flex: 1, flexDirection: 'row' },
  tile: { flex: 1, margin: 1, overflow: 'hidden' },
  stripes: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  stripe: { flex: 1 },

  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },
  control: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },

  capsuleBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  sheetBody: { padding: 20, gap: 8 },
  variantLabel: { marginBottom: 6, marginLeft: 4 },
  // Geometry lifted from ShareSheetScreen.tsx as shipped: radius 38, inset 10,
  // shadows.lg. Only the fill differs between this and the GlassSheet below.
  opaqueSheet: {
    borderRadius: GLASS_RADII.sheet,
    marginHorizontal: 10,
    padding: 20,
    gap: 8,
    marginBottom: 14,
    ...shadows.lg,
  },
  opaqueHandle: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 6 },
  glassSheetSpecimen: { marginHorizontal: 10, marginBottom: 10 },
  sheetRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  expiry: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },

  group: { overflow: 'hidden' },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },

  cellRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16 },
  tileIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  cellBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 13,
    minHeight: 46,
  },
  cellText: { flex: 1, minWidth: 0 },

  topChrome: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  tabBar: {
    position: 'absolute',
    left: 18,
    right: 18,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  tabCapsule: { flex: 1 },
  tabTrack: { flexDirection: 'row', padding: 5, gap: 2 },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingTop: 7,
    paddingBottom: 5,
    borderRadius: 999,
  },
  tabLabel: { fontSize: 10 },

  mono: { fontFamily: fonts.mono },
});
