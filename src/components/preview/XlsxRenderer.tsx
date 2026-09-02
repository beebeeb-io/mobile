/**
 * XlsxRenderer — preview for XLSX / XLS / CSV / TSV spreadsheets.
 *
 * Owns the SheetJS (`xlsx`) import so the ~3 MB library only enters Hermes
 * when the user actually opens a spreadsheet. Renders the first sheet as a
 * horizontally-scrollable table.
 */

import React, { useMemo } from 'react';
import {
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as XLSX from '@e965/xlsx';
// 1346 — the static `colors` (light-only) import that used to live here was
// removed: it was shadowing the `c` prop (`colors: c` below, the real
// scheme-aware palette) and got read by mistake in two error states.
import { radii } from '../../theme';
import type { Colors } from '../../theme';

interface SpreadsheetData {
  sheetName: string;
  sheetNames: string[];
  rows: string[][];
  columnCount: number;
}

interface XlsxRendererProps {
  data: ArrayBuffer;
  colors: Colors;
}

const COL_WIDTH = 140;
const ROW_HEIGHT = 36;
const MAX_PREVIEW_ROWS = 1000;

function parseSpreadsheet(arrayBuffer: ArrayBuffer): SpreadsheetData {
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheetNames = workbook.SheetNames;
  const sheetName = sheetNames[0] ?? '';
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;

  if (!sheet) {
    return { sheetName, sheetNames, rows: [], columnCount: 0 };
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  const rows = aoa.map((r) => r.map((cell) => (cell == null ? '' : String(cell))));
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const padded = rows.map((r) =>
    r.length === columnCount ? r : [...r, ...Array(columnCount - r.length).fill('')],
  );

  return { sheetName, sheetNames, rows: padded, columnCount };
}

export function XlsxRenderer({ data, colors: c }: XlsxRendererProps) {
  const parsed = useMemo(() => {
    try {
      return parseSpreadsheet(data);
    } catch {
      return null;
    }
  }, [data]);

  if (!parsed) {
    // 1346 review finding — `colors` was the module-level STATIC import
    // (light-only), shadowing the `c` prop below (`colors: c`, the real
    // scheme-aware palette). White-on-PreviewScreen's-doc-root (now
    // c.paper) was invisible in light mode. Fixed to `c`'s ink tokens,
    // matching every other colour in this file.
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: c.ink }]}>
          Couldn't open spreadsheet
        </Text>
        <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>The file appears to be corrupted.</Text>
      </View>
    );
  }

  const { rows, columnCount, sheetName, sheetNames } = parsed;
  const headerRow = rows[0] ?? [];
  const bodyRows = rows.slice(1, MAX_PREVIEW_ROWS + 1);
  const truncated = rows.length - 1 > MAX_PREVIEW_ROWS;

  if (rows.length === 0) {
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: c.ink }]}>
          Empty spreadsheet
        </Text>
        <Text style={[styles.imageStatusSub, { color: c.ink3 }]}>
          {sheetName ? `Sheet "${sheetName}" has no data.` : 'This file has no data.'}
        </Text>
      </View>
    );
  }

  const totalWidth = Math.max(COL_WIDTH * columnCount, 1);

  const renderRow = ({ item, index }: { item: string[]; index: number }) => {
    const stripe = index % 2 === 0;
    return (
      <View
        style={[
          styles.sheetRow,
          {
            backgroundColor: stripe ? c.paper : c.paper2,
            width: totalWidth,
            borderBottomColor: c.line,
          },
        ]}
      >
        {Array.from({ length: columnCount }).map((_, ci) => (
          <View
            key={ci}
            style={[styles.sheetCell, { width: COL_WIDTH, borderRightColor: c.line }]}
          >
            <Text
              style={[styles.sheetCellText, { color: c.ink }]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item[ci] ?? ''}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.sheetContainer, { backgroundColor: c.paper }]}>
      {sheetNames.length > 1 ? (
        <View style={[styles.sheetTabs, { borderBottomColor: c.line }]}>
          <Text style={[styles.sheetTabsText, { color: c.ink3 }]} numberOfLines={1}>
            Showing: {sheetName}  ·  {sheetNames.length} sheets in file
          </Text>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={{ flexGrow: 1 }}
      >
        <View>
          <View
            style={[
              styles.sheetRow,
              styles.sheetHeaderRow,
              {
                backgroundColor: c.paper2,
                borderBottomColor: c.line,
                width: totalWidth,
              },
            ]}
          >
            {Array.from({ length: columnCount }).map((_, ci) => (
              <View
                key={ci}
                style={[styles.sheetCell, { width: COL_WIDTH, borderRightColor: c.line }]}
              >
                <Text
                  style={[styles.sheetHeaderText, { color: c.ink }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {headerRow[ci] ?? ''}
                </Text>
              </View>
            ))}
          </View>

          <FlatList
            data={bodyRows}
            keyExtractor={(_, i) => `row-${i}`}
            renderItem={renderRow}
            getItemLayout={(_, index) => ({
              length: ROW_HEIGHT,
              offset: ROW_HEIGHT * index,
              index,
            })}
            initialNumToRender={30}
            windowSize={11}
            removeClippedSubviews
          />
        </View>
      </ScrollView>

      {truncated ? (
        <View style={[styles.sheetFooter, { borderTopColor: c.line }]}>
          <Text style={[styles.sheetFooterText, { color: c.ink3 }]}>
            Showing first {MAX_PREVIEW_ROWS} rows of {rows.length - 1}. Download to see the full file.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheetContainer: {
    flex: 1,
    width: '100%',
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  sheetTabs: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTabsText: {
    fontSize: 11,
    fontWeight: '500',
  },
  sheetRow: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetHeaderRow: {
    borderBottomWidth: 1,
  },
  sheetCell: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  sheetCellText: {
    fontSize: 12,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  sheetHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  sheetFooter: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetFooterText: {
    fontSize: 11,
    fontStyle: 'italic',
  },
  imageStatus: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: { fontSize: 12, opacity: 0.85, textAlign: 'center' },
});
