import React, { useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { spacing } from '../theme';

// ---------------------------------------------------------------------------
// Slide data
// ---------------------------------------------------------------------------

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface Slide {
  key: string;
  icon: IoniconName;
  title: string;
  body: string;
}

const SLIDES: Slide[] = [
  {
    key: '1',
    icon: 'lock-closed',
    title: 'Your files, encrypted',
    body: 'Everything is encrypted before it leaves your device. We can never see your data.',
  },
  {
    key: '2',
    icon: 'cloud-upload',
    title: 'Back up everything',
    body: 'Photos, contacts, calendars — all backed up with zero-knowledge encryption.',
  },
  {
    key: '3',
    icon: 'shield-checkmark',
    title: 'Made in Europe',
    body: 'Operated by Beebeeb.io from the Netherlands. Your data stays in Europe.',
  },
];

const SCREEN_WIDTH = Dimensions.get('window').width;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function OnboardingScreen({ onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const [activeIndex, setActiveIndex] = useState(0);
  const flatListRef = useRef<FlatList<Slide>>(null);

  const handleViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      const first = viewableItems[0];
      if (first && first.index != null) setActiveIndex(first.index);
    },
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const renderSlide = ({ item }: { item: Slide }) => (
    <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
      <View style={[styles.iconCircle, { backgroundColor: c.amberBg }]}>
        <Ionicons name={item.icon} size={64} color={c.amber} />
      </View>
      <Text style={[styles.slideTitle, { color: c.ink }]}>{item.title}</Text>
      <Text style={[styles.slideBody, { color: c.ink3 }]}>{item.body}</Text>
    </View>
  );

  const isLast = activeIndex === SLIDES.length - 1;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* Top bar: Skip */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={onComplete}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 8 }}
          accessibilityLabel="Skip onboarding"
          accessibilityRole="button"
        >
          <Text style={[styles.skipText, { color: c.ink3 }]}>Skip</Text>
        </TouchableOpacity>
      </View>

      {/* Slides */}
      <FlatList
        ref={flatListRef}
        data={SLIDES}
        keyExtractor={(s) => s.key}
        renderItem={renderSlide}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={handleViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        style={styles.flatList}
        bounces={false}
      />

      {/* Bottom: pagination dots + CTA */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 24 }]}>
        {/* Dots */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <TouchableOpacity
              key={i}
              onPress={() =>
                flatListRef.current?.scrollToIndex({ index: i, animated: true })
              }
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              accessibilityLabel={`Go to slide ${i + 1}`}
            >
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === activeIndex ? c.amber : c.line2,
                    width: i === activeIndex ? 20 : 6,
                  },
                ]}
              />
            </TouchableOpacity>
          ))}
        </View>

        {/* Get started — only on last slide */}
        {isLast ? (
          <TouchableOpacity
            style={[styles.cta, { backgroundColor: c.amber }]}
            onPress={onComplete}
            activeOpacity={0.8}
            accessibilityLabel="Get started"
            accessibilityRole="button"
          >
            <Text style={[styles.ctaText, { color: c.ink }]}>Get started</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.cta, { backgroundColor: c.paper2, borderWidth: 1, borderColor: c.line }]}
            onPress={() =>
              flatListRef.current?.scrollToIndex({ index: activeIndex + 1, animated: true })
            }
            activeOpacity={0.8}
            accessibilityLabel="Next slide"
            accessibilityRole="button"
          >
            <Text style={[styles.ctaText, { color: c.ink2 }]}>Next</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: 8,
  },
  skipText: { fontSize: 15, fontWeight: '500' },

  flatList: { flex: 1 },

  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 20,
  },

  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },

  slideTitle: {
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  slideBody: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },

  bottom: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: 24,
  },

  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },

  cta: {
    width: '100%',
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
