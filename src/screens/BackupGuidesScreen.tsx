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
import { colors, radii, spacing } from '../theme';
import { guides as initialGuides, type BackupGuide } from '../lib/backup-guides';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const DIFFICULTY_LABEL: Record<BackupGuide['difficulty'], string> = {
  easy: 'Easy',
  medium: 'Medium',
  manual: 'Manual',
};

const DIFFICULTY_COLORS: Record<BackupGuide['difficulty'], { bg: string; text: string }> = {
  easy: { bg: '#e8f9e8', text: colors.green },
  medium: { bg: colors.amberBg, text: colors.amberDeep },
  manual: { bg: '#f0eeeb', text: colors.ink3 },
};

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
  const c = DIFFICULTY_COLORS[difficulty];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.text }]}>{DIFFICULTY_LABEL[difficulty]}</Text>
    </View>
  );
}

function GuideCard({
  guide,
  index,
  expanded,
  onToggle,
  onUpvote,
}: {
  guide: BackupGuide;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onUpvote: () => void;
}) {
  const bg = initialsColor(index);

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardHeader}
        activeOpacity={0.7}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${guide.appName} backup guide, ${DIFFICULTY_LABEL[guide.difficulty]}`}
      >
        <View style={[styles.appIcon, { backgroundColor: bg }]}>
          <Text style={styles.appIconText}>{guide.appInitials}</Text>
        </View>

        <View style={styles.cardHeaderInfo}>
          <Text style={styles.appName}>{guide.appName}</Text>
          <View style={styles.cardMeta}>
            <DifficultyBadge difficulty={guide.difficulty} />
            <Text style={styles.stepCount}>{guide.steps.length} steps</Text>
          </View>
        </View>

        <View style={styles.cardHeaderRight}>
          <TouchableOpacity
            style={styles.upvoteBtn}
            activeOpacity={0.7}
            onPress={onUpvote}
            accessibilityLabel={`Upvote ${guide.appName}`}
          >
            <Text style={styles.upvoteArrow}>^</Text>
            <Text style={styles.upvoteCount}>{guide.upvotes}</Text>
          </TouchableOpacity>
          <Text style={[styles.chevron, expanded && styles.chevronOpen]}>{'›'}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.cardBody}>
          <View style={styles.divider} />
          {guide.steps.map((step, i) => (
            <View key={i} style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
          {guide.note && (
            <View style={styles.noteBox}>
              <Text style={styles.noteText}>{guide.note}</Text>
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
  const [guideList, setGuideList] = useState(initialGuides);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [requestApp, setRequestApp] = useState('');

  const handleToggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  const handleUpvote = useCallback((id: string) => {
    setGuideList(prev =>
      prev.map(g => (g.id === id ? { ...g, upvotes: g.upvotes + 1 } : g)),
    );
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
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityLabel="Go back"
        >
          <Text style={styles.backBtnText}>{'‹'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Back up your apps</Text>
      </View>

      <FlatList
        data={guideList}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Text style={styles.subtitle}>
            Step-by-step guides to save your data from other apps to Beebeeb.
          </Text>
        }
        renderItem={({ item, index }) => (
          <GuideCard
            guide={item}
            index={index}
            expanded={expandedId === item.id}
            onToggle={() => handleToggle(item.id)}
            onUpvote={() => handleUpvote(item.id)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListFooterComponent={
          <View>
            {/* Request section */}
            <View style={styles.requestSection}>
              <Text style={styles.requestHeading}>Don't see your app?</Text>
              <Text style={styles.requestSub}>
                Request a guide and vote for it on the roadmap.
              </Text>
              <View style={styles.requestRow}>
                <TextInput
                  style={styles.requestInput}
                  placeholder="App name"
                  placeholderTextColor={colors.ink4}
                  value={requestApp}
                  onChangeText={setRequestApp}
                  returnKeyType="send"
                  onSubmitEditing={handleRequest}
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.requestSubmit,
                    pressed && styles.requestSubmitPressed,
                  ]}
                  onPress={handleRequest}
                  accessibilityLabel="Submit app request"
                >
                  <Text style={styles.requestSubmitText}>Request</Text>
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
              <Text style={styles.roadmapLinkText}>View full roadmap</Text>
              <Text style={styles.roadmapLinkArrow}>{'›'}</Text>
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
  root: { flex: 1, backgroundColor: colors.paper2 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  backBtn: {
    paddingRight: 8,
    paddingVertical: 4,
  },
  backBtnText: {
    fontSize: 28,
    color: colors.ink,
    lineHeight: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
  },

  subtitle: {
    fontSize: 13,
    color: colors.ink3,
    lineHeight: 19,
    paddingHorizontal: 2,
    marginBottom: spacing.lg,
  },

  listContent: {
    paddingHorizontal: 14,
    paddingTop: spacing.md,
    paddingBottom: 48,
  },

  separator: { height: 8 },

  // Card
  card: {
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
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
    color: colors.ink2,
    letterSpacing: 0.2,
  },
  cardHeaderInfo: { flex: 1, gap: 4 },
  appName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepCount: {
    fontSize: 11,
    color: colors.ink3,
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

  // Upvote
  upvoteBtn: {
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    minWidth: 34,
  },
  upvoteArrow: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.ink3,
    lineHeight: 12,
  },
  upvoteCount: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.ink2,
    lineHeight: 13,
  },

  chevron: {
    fontSize: 20,
    color: colors.ink4,
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
    backgroundColor: colors.line,
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
    backgroundColor: colors.amberBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  stepNumberText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.amberDeep,
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: colors.ink2,
    lineHeight: 19,
  },
  noteBox: {
    backgroundColor: colors.paper2,
    borderRadius: radii.sm,
    padding: 10,
    marginTop: 4,
  },
  noteText: {
    fontSize: 12,
    color: colors.ink3,
    lineHeight: 17,
  },

  // Request section
  requestSection: {
    marginTop: 24,
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
  },
  requestHeading: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    marginBottom: 4,
  },
  requestSub: {
    fontSize: 12,
    color: colors.ink3,
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
    backgroundColor: colors.paper2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 10,
    fontSize: 13,
    color: colors.ink,
  },
  requestSubmit: {
    height: 38,
    paddingHorizontal: 14,
    backgroundColor: colors.ink,
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
    color: colors.paper,
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
    color: colors.amberDeep,
    fontWeight: '500',
  },
  roadmapLinkArrow: {
    fontSize: 16,
    color: colors.amberDeep,
  },
});
