import { SymbolView } from 'expo-symbols';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { type ReceiptPaymentProof } from '@/context/receipts';
import { useTheme } from '@/hooks/use-theme';

type PaymentProofViewModalProps = {
  /** Present to show the modal; null closes it. */
  proof: ReceiptPaymentProof | null;
  onClose: () => void;
};

// View-only — a proof photo can only ever be uploaded once (see
// receipt-db.ts's setPaymentProof), so there's no edit/replace action here.
export function PaymentProofViewModal({ proof, onClose }: PaymentProofViewModalProps) {
  return (
    <Modal visible={!!proof} transparent animationType="fade" onRequestClose={onClose}>
      {proof && <PaymentProofViewBody proof={proof} onClose={onClose} />}
    </Modal>
  );
}

function PaymentProofViewBody({ proof, onClose }: { proof: ReceiptPaymentProof; onClose: () => void }) {
  const theme = useTheme();

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.wrapper}>
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <View style={styles.header}>
            <ThemedText type="smallBold" numberOfLines={1} style={styles.fileName}>
              {proof.fileName}
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
          <Image source={{ uri: proof.localUri }} style={[styles.image, { backgroundColor: theme.backgroundElement }]} resizeMode="contain" />
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
    maxHeight: '92%',
  },
  card: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  fileName: {
    flex: 1,
  },
  image: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: Spacing.two,
  },
});
