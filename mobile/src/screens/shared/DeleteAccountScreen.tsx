import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  Button,
  ErrorBanner,
  Group,
  Input,
  KeyboardAwareScrollView,
  NavBar,
  Screen,
  SectionLabel,
} from '../../components/ui';
import { authApi, type ReauthProof } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { signOut } from '../../store/slices/authSlice';
import {
  GoogleSignInError,
  googleErrorMessage,
  signInWithGoogle,
  signOutGoogle,
} from '../../services/googleAuth';
import { colors, spacing, typography } from '../../theme';

const DELETED = [
  'Your name, email address and phone number',
  'Your saved delivery addresses',
  'Your cart and saved items',
  'Your password and Google sign-in link',
  'Your name, phone number and street address on past orders',
];

const KEPT = [
  'Order records — items, amounts, dates, and the city, state and PIN code — which the store must keep for its accounts and tax records',
  'Your reviews, shown as "Customer" instead of your name',
];

/**
 * Account deletion (Google Play policy).
 *
 * Says plainly what goes and what stays before anything happens, then asks
 * the owner to prove it is them — the password, or a fresh Google
 * confirmation — the same proof as changing the email. On success the
 * account is anonymised on the server and this device signs out.
 */
export function DeleteAccountScreen() {
  const navigation = useNavigation();
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.auth.user);

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPassword = user?.authProviders.includes('password') ?? false;

  const proveOwner = async (): Promise<ReauthProof | null> => {
    if (hasPassword) return { password };
    // Cleared first so the picker mints a fresh token; the server refuses one
    // older than five minutes.
    await signOutGoogle();
    const googleIdToken = await signInWithGoogle();
    return googleIdToken ? { googleIdToken } : null;
  };

  const performDelete = async () => {
    setError(null);
    setBusy(true);
    try {
      const proof = await proveOwner();
      if (!proof) return;
      await authApi.deleteAccount(proof);
      // Every session is already dead on the server; this clears the device.
      await dispatch(signOut());
      Alert.alert('Account deleted', 'Your account has been deleted. Thank you for shopping with us.');
    } catch (caught) {
      setError(
        caught instanceof GoogleSignInError
          ? googleErrorMessage(caught)
          : caught instanceof ApiError
            ? caught.message
            : 'Could not delete your account. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete your account?',
      "This can't be undone. You will be signed out on every device.",
      [
        { text: 'Keep my account', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => void performDelete() },
      ],
    );
  };

  if (!user) return <Screen />;

  return (
    <Screen edges={['top']}>
      <NavBar title="Delete account" onBack={() => navigation.goBack()} />

      <KeyboardAwareScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.scroll}
      >
        <Text style={styles.lead}>
          Deleting your account is permanent. Here is exactly what happens.
        </Text>

        <View style={styles.block}>
          <SectionLabel>Deleted</SectionLabel>
          <Group padded>
            {DELETED.map((line) => (
              <Text key={line} style={styles.item}>
                • {line}
              </Text>
            ))}
          </Group>
        </View>

        <View style={styles.block}>
          <SectionLabel>Kept</SectionLabel>
          <Group padded>
            {KEPT.map((line) => (
              <Text key={line} style={styles.item}>
                • {line}
              </Text>
            ))}
          </Group>
        </View>

        <Text style={styles.note}>
          If you have an order that is still being delivered, or a refund that has not reached you
          yet, please contact the store first — the account can be deleted once it is settled.
        </Text>

        {error ? <ErrorBanner message={error} /> : null}

        <View style={styles.block}>
          <Group padded>
            {hasPassword ? (
              <Input
                label="Current password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                textContentType="password"
                hint="To keep your account safe, confirm it's you."
              />
            ) : (
              <Text style={styles.note}>You'll be asked to confirm with Google.</Text>
            )}
            <Button
              label="Delete my account"
              onPress={confirmDelete}
              loading={busy}
              disabled={hasPassword && password.length === 0}
            />
          </Group>
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl },
  block: { marginTop: spacing.xl },
  lead: { ...typography.body, color: colors.text },
  item: { ...typography.callout, color: colors.textMuted, lineHeight: 23, marginBottom: spacing.sm },
  note: {
    ...typography.footnote,
    color: colors.textFaint,
    lineHeight: 19,
    marginTop: spacing.lg,
  },
});
