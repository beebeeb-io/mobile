import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, radii, spacing } from '../theme';

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

    return (
      <View style={styles.root}>
        <View style={styles.card}>
          {/* Logo */}
          <View style={styles.logo}>
            <Text style={styles.logoText}>bb</Text>
          </View>

          <Text style={styles.heading}>Something went wrong</Text>
          <Text style={styles.subheading}>
            An unexpected error occurred. Tap Restart to try again.
          </Text>

          <View style={styles.errorBox}>
            <Text style={styles.errorMessage}>{message}</Text>
            {!!stack && (
              <Text style={styles.errorStack} numberOfLines={8}>
                {stack}
              </Text>
            )}
          </View>

          <TouchableOpacity
            style={styles.restartButton}
            onPress={this.handleRestart}
            activeOpacity={0.8}
          >
            <Text style={styles.restartButtonText}>Restart</Text>
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
