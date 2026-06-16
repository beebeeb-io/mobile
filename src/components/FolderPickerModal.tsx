/**
 * FolderPickerModal — native-feeling nested folder picker (task 0796).
 *
 * Replaces the old flat, root-only "Move to" action sheet. Presents the FULL
 * vault folder tree (sourced by the caller from the cached sync index /
 * `sync.allNodes()`), lets the user drill into any subfolder with a tappable
 * breadcrumb, and commits the move into the currently-open folder — mirroring
 * the iOS Files app "Move" sheet.
 *
 * The caller supplies the flat list of selectable folders (already decrypted
 * and already filtered to exclude the items being moved and their descendants,
 * so a folder can never be moved into itself or its own subtree). This keeps
 * the component pure: it only walks `parentId` links and renders.
 */

import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';

export interface PickerFolder {
  id: string;
  name: string;
  parentId: string | null;
}

interface Crumb {
  id: string | null;
  name: string;
}

interface FolderPickerModalProps {
  visible: boolean;
  /** Header label, e.g. "Move" or "Move 3 items". */
  title: string;
  /** Every selectable folder in the vault (decrypted, subtree-of-moved excluded). */
  folders: PickerFolder[];
  /** Where the items live now — disables "Move here" when the destination matches. */
  currentParentId: string | null;
  /** True while the move request is in flight. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (targetId: string | null) => void;
}

const ROOT_NAME = 'Drive';

export default function FolderPickerModal({
  visible,
  title,
  folders,
  currentParentId,
  busy = false,
  onCancel,
  onConfirm,
}: FolderPickerModalProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();

  // Navigation stack within the picker. Starts at the vault root.
  const [stack, setStack] = useState<Crumb[]>([{ id: null, name: ROOT_NAME }]);
  const current = stack[stack.length - 1];

  // Children of every folder, grouped by parent id, sorted by name. Recomputed
  // only when the folder set changes — drilling is then a cheap lookup.
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, PickerFolder[]>();
    for (const f of folders) {
      const list = map.get(f.parentId) ?? [];
      list.push(f);
      map.set(f.parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }
    return map;
  }, [folders]);

  const visibleFolders = childrenByParent.get(current.id) ?? [];
  const hasChildren = (id: string) => (childrenByParent.get(id)?.length ?? 0) > 0;

  const resetAndCancel = () => {
    setStack([{ id: null, name: ROOT_NAME }]);
    onCancel();
  };

  const drillInto = (folder: PickerFolder) => {
    setStack((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const popTo = (index: number) => {
    setStack((prev) => prev.slice(0, index + 1));
  };

  const confirm = () => {
    onConfirm(current.id);
    setStack([{ id: null, name: ROOT_NAME }]);
  };

  const alreadyHere = current.id === currentParentId;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={resetAndCancel}
    >
      <View style={[styles.root, { backgroundColor: c.paper, paddingTop: Platform.OS === 'android' ? insets.top : 0 }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: c.line }]}>
          <TouchableOpacity
            onPress={resetAndCancel}
            disabled={busy}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Cancel move"
          >
            <Text style={[styles.headerAction, { color: busy ? c.ink4 : c.amberDeep }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: c.ink }]} numberOfLines={1}>
            {title}
          </Text>
          {/* Spacer to balance the Cancel button so the title stays centered. */}
          <View style={styles.headerSpacer} />
        </View>

        {/* Breadcrumb */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.breadcrumbBar, { borderBottomColor: c.line }]}
          contentContainerStyle={styles.breadcrumbContent}
        >
          {stack.map((crumb, index) => {
            const isLast = index === stack.length - 1;
            return (
              <View key={`${crumb.id ?? 'root'}-${index}`} style={styles.crumbWrap}>
                {index > 0 && (
                  <Ionicons name="chevron-forward" size={13} color={c.ink4} style={styles.crumbChevron} />
                )}
                <TouchableOpacity
                  disabled={isLast || busy}
                  onPress={() => popTo(index)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Go to ${crumb.name}`}
                >
                  <Text
                    style={[styles.crumbText, { color: isLast ? c.ink : c.amberDeep }]}
                    numberOfLines={1}
                  >
                    {crumb.name}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>

        {/* Folder list at the current level */}
        <FlatList
          data={visibleFolders}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.row, { borderBottomColor: c.line }]}
              onPress={() => drillInto(item)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
            >
              <Ionicons name="folder" size={22} color={c.amber} style={styles.rowIcon} />
              <Text style={[styles.rowName, { color: c.ink }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={c.ink4} />
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="folder-open-outline" size={34} color={c.ink4} />
              <Text style={[styles.emptyText, { color: c.ink3 }]}>No subfolders here</Text>
            </View>
          }
          contentContainerStyle={visibleFolders.length === 0 ? styles.emptyContainer : undefined}
        />

        {/* Footer — commit into the currently-open folder */}
        <View style={[styles.footer, { borderTopColor: c.line, paddingBottom: insets.bottom + 12 }]}>
          {alreadyHere && (
            <Text style={[styles.footerHint, { color: c.ink3 }]}>
              {`Already in “${current.name}”.`}
            </Text>
          )}
          <TouchableOpacity
            style={[styles.moveButton, { backgroundColor: c.amber, opacity: alreadyHere || busy ? 0.5 : 1 }]}
            onPress={confirm}
            disabled={alreadyHere || busy}
            accessibilityRole="button"
            accessibilityLabel={`Move to ${current.name}`}
          >
            {busy ? (
              <ActivityIndicator color={c.ink} />
            ) : (
              <Text style={[styles.moveButtonText, { color: c.ink }]} numberOfLines={1}>
                {`Move to “${current.name}”`}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerAction: { fontSize: 16, fontWeight: '500', minWidth: 56 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  headerSpacer: { minWidth: 56 },
  breadcrumbBar: {
    maxHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  breadcrumbContent: { alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center' },
  crumbChevron: { marginHorizontal: 4 },
  crumbText: { fontSize: 14, fontWeight: '600', maxWidth: 180 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: { marginRight: 14 },
  rowName: { flex: 1, fontSize: 16, fontWeight: '500' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 10 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { fontSize: 14 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerHint: { fontSize: 13, textAlign: 'center', marginBottom: 10 },
  moveButton: {
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveButtonText: { fontSize: 16, fontWeight: '700' },
});
