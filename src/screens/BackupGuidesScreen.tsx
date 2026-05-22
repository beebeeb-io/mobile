import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii, spacing } from '../theme';
import type { Colors } from '../theme';
import { useTheme } from '../lib/theme-context';
import { guides as initialGuides, type BackupGuide } from '../lib/backup-guides';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const DIFFICULTY_LABEL: Record<BackupGuide['difficulty'], string> = {
  easy: 'Easy',
  medium: 'Medium',
  manual: 'Manual',
};

function difficultyTheme(c: Colors, dark: boolean): Record<BackupGuide['difficulty'], { bg: string; text: string }> {
  return dark
    ? {
        easy: { bg: 'rgba(74,190,74,0.12)', text: c.green },
        medium: { bg: '#302808', text: '#f5b800' },
        manual: { bg: '#27272c', text: '#8a867f' },
      }
    : {
        easy: { bg: '#e8f9e8', text: c.green },
        medium: { bg: c.amberBg, text: c.amberDeep },
        manual: { bg: c.paper2, text: c.ink3 },
      };
}

// Deterministic background color per initials so each app has a consistent tint
const INITIALS_BG = [
  '#e8f0fe',
  '#fce8e6',
  '#e6f4ea',
  '#fff3e0',
  '#f3e8fd',
  '#e8f4f9',
];

function initialsColor(index: number): string {
  return INITIALS_BG[index % INITIALS_BG.length] ?? '#f0eeeb';
}

// ---------------------------------------------------------------------------
// Guide card
// ---------------------------------------------------------------------------

function DifficultyBadge({ difficulty }: { difficulty: BackupGuide['difficulty'] }) {
  const { resolved, colors: c } = useTheme();
  const dc = difficultyTheme(c, resolved === 'dark')[difficulty];
  return (
    <View style={[styles.badge, { backgroundColor: dc.bg }]}>
      <Text style={[styles.badgeText, { color: dc.text }]}>{DIFFICULTY_LABEL[difficulty]}</Text>
    </View>
  );
}

function GuideCard({
  guide,
  index,
  expanded,
  onToggle,
  c,
}: {
  guide: BackupGuide;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  c: Colors;
}) {
  const bg = initialsColor(index);

  return (
    <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
      <TouchableOpacity
        style={styles.cardHeader}
        activeOpacity={0.7}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${guide.appName} backup guide, ${DIFFICULTY_LABEL[guide.difficulty]}`}
      >
        <View style={[styles.appIcon, { backgroundColor: bg }]}>
          <Text style={[styles.appIconText, { color: c.ink2 }]}>{guide.appInitials}</Text>
        </View>

        <View style={styles.cardHeaderInfo}>
          <Text style={[styles.appName, { color: c.ink }]}>{guide.appName}</Text>
          <View style={styles.cardMeta}>
            <DifficultyBadge difficulty={guide.difficulty} />
            <Text style={[styles.stepCount, { color: c.ink3 }]}>{guide.steps.length} steps</Text>
          </View>
        </View>

        <View style={styles.cardHeaderRight}>
          <Text style={[styles.chevron, expanded && styles.chevronOpen, { color: c.ink4 }]}>{'›'}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.cardBody}>
          <View style={[styles.divider, { backgroundColor: c.line }]} />
          {guide.steps.map((step, i) => (
            <View key={i} style={styles.step}>
              <View style={[styles.stepNumber, { backgroundColor: c.amberBg }]}>
                <Text style={[styles.stepNumberText, { color: c.amberDeep }]}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepText, { color: c.ink2 }]}>{step}</Text>
            </View>
          ))}
          {guide.note && (
            <View style={[styles.noteBox, { backgroundColor: c.paper2 }]}>
              <Text style={[styles.noteText, { color: c.ink3 }]}>{guide.note}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function BackupGuidesScreen() {
  const navigation = useNavigation<Nav>();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const guideList = initialGuides;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [requestApp, setRequestApp] = useState('');

  const handleToggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  const handleRequest = useCallback(() => {
    const trimmed = requestApp.trim();
    if (!trimmed) return;
    // Placeholder — will wire to POST /api/v1/feedback/app-request
    setRequestApp('');
  }, [requestApp]);

  const handleRoadmap = useCallback(() => {
    Linking.openURL('https://beebeeb.io/roadmap');
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.paper2 }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 8, 18) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={[styles.backBtnText, { color: c.ink }]}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.ink }]}>Back up your apps</Text>
      </View>

      <FlatList
        data={guideList}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Text style={[styles.subtitle, { color: c.ink3 }]}>
            Step-by-step guides to save your data from other apps to Beebeeb.
          </Text>
        }
        renderItem={({ item, index }) => (
          <GuideCard
            guide={item}
            index={index}
            expanded={expandedId === item.id}
            onToggle={() => handleToggle(item.id)}
            c={c}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListFooterComponent={
          <View>
            {/* Request section */}
            <View style={[styles.requestSection, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={[styles.requestHeading, { color: c.ink }]}>Don't see your app?</Text>
              <Text style={[styles.requestSub, { color: c.ink3 }]}>
                Request a guide and we will add it to the backup library.
              </Text>
              <View style={styles.requestRow}>
                <TextInput
                  style={[styles.requestInput, { backgroundColor: c.paper2, borderColor: c.line, color: c.ink }]}
                  placeholder="App name"
                  placeholderTextColor={c.ink4}
                  value={requestApp}
                  onChangeText={setRequestApp}
                  returnKeyType="send"
                  onSubmitEditing={handleRequest}
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.requestSubmit,
                    { backgroundColor: c.ink },
                    pressed && styles.requestSubmitPressed,
                  ]}
                  onPress={handleRequest}
                  accessibilityRole="button"
                  accessibilityLabel="Submit app request"
                >
                  <Text style={[styles.requestSubmitText, { color: c.paper }]}>Request</Text>
                </Pressable>
              </View>
            </View>

            {/* Roadmap link */}
            <TouchableOpacity
              style={styles.roadmapLink}
              onPress={handleRoadmap}
              activeOpacity={0.7}
              accessibilityRole="link"
              accessibilityLabel="View full roadmap"
            >
              <Text style={[styles.roadmapLinkText, { color: c.amberDeep }]}>View full roadmap</Text>
              <Text style={[styles.roadmapLinkArrow, { color: c.amberDeep }]}>{'›'}</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: 8,
    gap: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: {
    fontSize: 28,
    lineHeight: 30,
  },
  title: {
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },

  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 2,
    marginBottom: spacing.lg,
  },

  listContent: {
    paddingHorizontal: 14,
    paddingTop: spacing.sm,
    paddingBottom: 48,
  },

  separator: { height: 8 },

  // Card
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  appIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appIconText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  cardHeaderInfo: { flex: 1, gap: 4 },
  appName: {
    fontSize: 14,
    fontWeight: '600',
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepCount: {
    fontSize: 11,
  },
  cardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  // Badge
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
  },

  chevron: {
    fontSize: 20,
    transform: [{ rotate: '0deg' }],
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },

  // Card body (expanded)
  cardBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  divider: {
    height: 1,
    marginBottom: 12,
  },
  step: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  stepNumber: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  stepNumberText: {
    fontSize: 10,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  noteBox: {
    borderRadius: radii.sm,
    padding: 10,
    marginTop: 4,
  },
  noteText: {
    fontSize: 12,
    lineHeight: 17,
  },

  // Request section
  requestSection: {
    marginTop: 24,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 14,
  },
  requestHeading: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  requestSub: {
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 17,
  },
  requestRow: {
    flexDirection: 'row',
    gap: 8,
  },
  requestInput: {
    flex: 1,
    height: 38,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  requestSubmit: {
    height: 38,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestSubmitPressed: {
    opacity: 0.75,
  },
  requestSubmitText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // Roadmap link
  roadmapLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    gap: 4,
    paddingVertical: 8,
  },
  roadmapLinkText: {
    fontSize: 13,
    fontWeight: '500',
  },
  roadmapLinkArrow: {
    fontSize: 16,
  },
});
