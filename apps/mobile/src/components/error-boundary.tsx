import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { describeError, logError } from '@/lib/errors';

/**
 * Catches a crash *while rendering* — the one kind of failure a try/catch
 * around a button press can't reach. Without one of these, a single bad value
 * (a null where a number was expected, a missing field on an old receipt row)
 * unmounts the entire React tree: in development that's the red screen, but in
 * a shipped build it's a white screen with no way out but force-quitting.
 *
 * There is one at the root (src/app/_layout.tsx) and one around each tab's
 * content, so a screen that breaks takes only itself down — the tab bar stays
 * up and the other tabs keep working.
 *
 * "Try again" clears the error and re-renders the children. That genuinely
 * fixes the common case (a one-off bad render, a value that has since loaded);
 * if the crash is deterministic it will simply come straight back, which is
 * itself useful information rather than a trap — the other tabs are still
 * reachable.
 *
 * A class component on purpose: `getDerivedStateFromError` / `componentDidCatch`
 * are the only way to catch render errors, and React has no hook equivalent.
 */

type ErrorBoundaryProps = PropsWithChildren<{
  /** Where this boundary sits, e.g. 'Receipts'. Used in the log tag and the message. */
  label: string;
}>;

type ErrorBoundaryState = { error: unknown };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    logError(`render.${this.props.label}`, error);
    // The component stack is the part that actually points at the broken
    // component, and React only ever hands it to componentDidCatch.
    console.error(info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <ErrorFallback label={this.props.label} error={this.state.error} onRetry={this.handleRetry} />;
  }
}

function ErrorFallback({ label, error, onRetry }: { label: string; error: unknown; onRetry: () => void }) {
  return (
    // Plain View with centred content rather than <Screen>: this has to be
    // able to render when something further up is broken, so it depends on as
    // little of the app as possible — no safe-area context, no theme hook.
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{label} hit a problem</Text>
        <Text style={styles.body}>
          Nothing you’ve saved is lost — this screen just couldn’t finish drawing. Try again, and if it keeps
          happening, close the app fully and reopen it.
        </Text>

        <ScrollView style={styles.detailBox} contentContainerStyle={styles.detailContent}>
          <Text style={styles.detail}>{describeError(error)}</Text>
        </ScrollView>

        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { opacity: pressed ? 0.85 : 1 }]}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
    padding: Spacing.four,
  },
  card: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  title: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  body: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  // Capped height: some errors carry a very long message, and it must not push
  // the "Try again" button off the bottom of the screen.
  detailBox: {
    maxHeight: 140,
    backgroundColor: Colors.backgroundElement,
    borderRadius: Spacing.two,
  },
  detailContent: {
    padding: Spacing.three,
  },
  detail: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  buttonLabel: {
    color: Colors.background,
    fontSize: 15,
    fontWeight: '700',
  },
});
