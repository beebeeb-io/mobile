import React from 'react';
import { Appearance, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, darkColors, radii, spacing } from '../theme';

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleRestart = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message ?? 'Unknown error';
    const stack = this.state.error?.stack ?? '';

    // ErrorBoundary sits ABOVE ThemeProvider in the tree, so the theme
    // context isn't reachable here. Read the scheme directly — theme-context
    // mirrors explicit prefs into Appearance.setColorScheme, so this reflects
    // both "system" and an explicitly-chosen light/dark mode.
    const c = Appearance.getColorScheme() === 'dark' ? darkColors : colors;

    return (
      <View style={[styles.root, { backgroundColor: c.paper2 }]}>
        <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
          {/* Logo */}
          <View style={[styles.logo, { backgroundColor: c.ink }]}>
            <Text style={[styles.logoText, { color: c.amber }]}>bb</Text>
          </View>

          <Text style={[styles.heading, { color: c.ink }]}>Something went wrong</Text>
          <Text style={[styles.subheading, { color: c.ink3 }]}>
            An unexpected error occurred. Tap Restart to try again.
          </Text>

          <View style={[styles.errorBox, { backgroundColor: c.paper2, borderColor: c.line }]}>
            <Text style={[styles.errorMessage, { color: c.red }]}>{message}</Text>
            {!!stack && (
              <Text style={[styles.errorStack, { color: c.ink3 }]} numberOfLines={8}>
                {stack}
              </Text>
            )}
          </View>

          <TouchableOpacity
            style={[styles.restartButton, { backgroundColor: c.amber }]}
            onPress={this.handleRestart}
            activeOpacity={0.8}
          >
            <Text style={[styles.restartButtonText, { color: c.ink }]}>Restart</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  logoText: {
    color: colors.amber,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.2,
  },
  subheading: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 18,
  },
  errorBox: {
    width: '100%',
    backgroundColor: colors.paper2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
    gap: 6,
  },
  errorMessage: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: colors.red,
    lineHeight: 17,
  },
  errorStack: {
    fontFamily: 'Courier',
    fontSize: 9,
    color: colors.ink3,
    lineHeight: 14,
  },
  restartButton: {
    width: '100%',
    backgroundColor: colors.amber,
    borderRadius: radii.md,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  restartButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
});
