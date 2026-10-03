import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { useBusinessSettings } from '@/context/business-settings';
import { usePrinter } from '@/context/printer';
import { useTheme } from '@/hooks/use-theme';
import { RECEIPT_COLUMNS, buildReceiptPrintLines } from '@/lib/receipt-print';
import type { ReceiptDetail } from '@/lib/receipt-types';

// Monospace glyphs are about 0.6em wide; 0.62 leaves a sliver of slack so a
// full 32-character line can never spill over the edge of the paper.
const MONO_ADVANCE_RATIO = 0.62;
const MIN_FONT_SIZE = 7;
const MAX_FONT_SIZE = 15;

type ReceiptPrintPreviewModalProps = {
  /** Present to show the preview; null closes it. */
  detail: ReceiptDetail | null;
  onClose: () => void;
};

export function ReceiptPrintPreviewModal({ detail, onClose }: ReceiptPrintPreviewModalProps) {
  return (
    <Modal visible={!!detail} transparent animationType="fade" onRequestClose={onClose}>
      {/* Mounted fresh each time, so the print status from a previous receipt
          never carries over to a different one. */}
      {detail && <PreviewBody detail={detail} onClose={onClose} />}
    </Modal>
  );
}

function PreviewBody({ detail, onClose }: { detail: ReceiptDetail; onClose: () => void }) {
  const theme = useTheme();
  const printer = usePrinter();
  const { businessSettings } = useBusinessSettings();
  const [paperWidth, setPaperWidth] = useState(0);
  const [printing, setPrinting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo(() => buildReceiptPrintLines(detail, businessSettings), [detail, businessSettings]);

  // The preview is the printer's own output rendered in a monospace font, so
  // the type size is derived from the paper width rather than picked: whatever
  // the screen is, exactly RECEIPT_COLUMNS characters fit across it, and the
  // columns line up on screen exactly as they will on paper.
  const fontSize = paperWidth
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, paperWidth / RECEIPT_COLUMNS / MONO_ADVANCE_RATIO))
    : MIN_FONT_SIZE;

  function handlePaperLayout(event: LayoutChangeEvent) {
    setPaperWidth(event.nativeEvent.layout.width);
  }

  // The detail modal never opens this for a voided receipt; this is the
  // backstop, so nothing that opens it later can print one.
  const voided = detail.voidedAt !== null;
  const canPrint = !voided && Platform.OS === 'android' && printer.status === 'connected';
  const unavailableReason = voided
    ? 'This receipt was voided, so it can’t be printed.'
    : Platform.OS !== 'android'
      ? 'Printing needs the Android app with a Bluetooth receipt printer.'
      : printer.status === 'connected'
        ? null
        : 'No printer connected. Connect one from the Home tab, then come back.';

  async function handlePrint() {
    if (voided) return;
    setError(null);
    setSent(false);
    setPrinting(true);
    try {
      await printer.printReceipt(lines);
      setSent(true);
    } catch {
      setError('Could not send the receipt. Check that the printer is on and still in range.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.wrapper}>
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            <ThemedText type="subtitle" style={styles.title}>
              Receipt Preview
            </ThemedText>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={Spacing.two}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} tintColor={theme.text} size={24} />
            </Pressable>
          </View>

          <View style={[styles.paperFrame, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
            <ScrollView contentContainerStyle={styles.paperScroll}>
              <View style={styles.paper}>
                <View onLayout={handlePaperLayout}>
                  {lines.map((line, index) => (
                    <Text
                      // Lines have no id of their own and the list is rebuilt
                      // wholesale whenever the receipt changes, so the index is
                      // a stable key here.
                      key={index}
                      numberOfLines={1}
                      // Fixed at the size computed above: a phone set to large
                      // system text would otherwise blow the columns apart and
                      // stop the preview matching the printout.
                      allowFontScaling={false}
                      style={[
                        styles.paperLine,
                        {
                          fontSize: line.double ? fontSize * 2 : fontSize,
                          lineHeight: (line.double ? fontSize * 2 : fontSize) * 1.35,
                          fontWeight: line.bold ? '700' : '400',
                          textAlign: line.align,
                        },
                      ]}>
                      {line.text || ' '}
                    </Text>
                  ))}
                </View>
              </View>
            </ScrollView>
          </View>

          {!!unavailableReason && (
            <ThemedText type="small" themeColor="textSecondary">
              {unavailableReason}
            </ThemedText>
          )}
          {!!error && (
            <ThemedText type="small" style={styles.error}>
              {error}
            </ThemedText>
          )}
          {sent && !error && (
            <ThemedText type="small" style={{ color: theme.success }}>
              Sent to {printer.connectedDevice?.name ?? 'the printer'}.
            </ThemedText>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.button,
                styles.buttonFlex,
                { borderColor: theme.textSecondary, opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText type="smallBold">Close</ThemedText>
            </Pressable>
            <Pressable
              onPress={handlePrint}
              disabled={!canPrint || printing}
              style={({ pressed }) => [
                styles.button,
                styles.buttonFlex,
                {
                  backgroundColor: theme.accent,
                  borderColor: theme.accent,
                  opacity: !canPrint ? 0.4 : pressed || printing ? 0.7 : 1,
                },
              ]}>
              {printing ? (
                <ActivityIndicator size="small" color={theme.background} />
              ) : (
                <ThemedText type="smallBold" style={{ color: theme.background }}>
                  {sent ? 'Print again' : 'Print'}
                </ThemedText>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: Spacing.four,
  },
  wrapper: {
    width: '100%',
    maxWidth: MaxContentWidth,
    // A fixed tall card rather than one that hugs its content: the paper area
    // is the point of this modal, and it shouldn't shrink to a sliver just
    // because a receipt has only two items on it.
    height: '85%',
  },
  card: {
    flex: 1,
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  title: {
    flexShrink: 1,
  },
  paperFrame: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
  paperScroll: {
    padding: Spacing.three,
    alignItems: 'center',
  },
  // Always pure white with black text, whatever the theme does — this is a
  // picture of paper, not a surface of the app.
  paper: {
    width: '100%',
    backgroundColor: '#ffffff',
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.two,
  },
  paperLine: {
    fontFamily: Fonts.mono,
    color: '#000000',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonFlex: {
    flex: 1,
  },
  error: {
    color: '#e5484d',
  },
});
