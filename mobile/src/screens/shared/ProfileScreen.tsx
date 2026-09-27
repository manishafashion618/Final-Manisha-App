import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  Button,
  ErrorBanner,
  Group,
  Input,
  KeyboardAwareScrollView,
  NavBar,
  Row,
  Screen,
  SectionLabel,
} from '../../components/ui';
import { authApi, type ReauthProof } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import {
  GoogleSignInError,
  googleErrorMessage,
  signInWithGoogle,
  signOutGoogle,
} from '../../services/googleAuth';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { confirmEmailCode, updateProfile } from '../../store/slices/authSlice';
import { colors, spacing, typography, wholesaleStatusStyle } from '../../theme';

type EmailStep =
  | { step: 'idle' }
  | { step: 'verify' }
  | { step: 'enter' }
  | { step: 'code'; target: string; purpose: 'verify' | 'change' };

/**
 * The account facts that cannot be edited, the name, and the email.
 *
 * The email is a sign-in credential, so it is never typed straight in: a new
 * address (or the current one, to verify it) gets a 6-digit code, and only
 * that code applies it.
 *
 * Both steps also ask the owner to prove it is them — the password, or a
 * fresh Google confirmation for a Google-only account. A signed-in phone left
 * unlocked, or a stolen session, is not enough to move the address.
 */
export function ProfileScreen() {
  const navigation = useNavigation();
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.auth.user);

  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);

  const [emailFlow, setEmailFlow] = useState<EmailStep>({ step: 'idle' });
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  /** Held only for the length of one email flow, then cleared. */
  const [password, setPassword] = useState('');
  const hasPassword = user?.authProviders.includes('password') ?? false;

  const handleSave = async () => {
    setSaving(true);
    await dispatch(updateProfile({ name: name.trim() || undefined }));
    setSaving(false);
    navigation.goBack();
  };

  /**
   * The credential the server wants for this account. A Google-only account
   * gets the account picker every time: clearing the cached Google account
   * first is what guarantees a freshly minted token, since the server refuses
   * one older than five minutes. Null when the customer backs out.
   */
  const proveOwner = async (): Promise<ReauthProof | null> => {
    if (hasPassword) return { password };
    await signOutGoogle();
    const googleIdToken = await signInWithGoogle();
    return googleIdToken ? { googleIdToken } : null;
  };

  const endFlow = () => {
    setEmailFlow({ step: 'idle' });
    setNewEmail('');
    setCode('');
    setPassword('');
  };

  const sendCode = async (target: string) => {
    setEmailError(null);
    setEmailNotice(null);
    setEmailBusy(true);
    try {
      const proof = await proveOwner();
      if (!proof) return;
      const result = await authApi.requestEmailCode(target, proof);
      setCode('');
      setEmailFlow({ step: 'code', target: result.email, purpose: result.purpose });
    } catch (caught) {
      setEmailError(
        caught instanceof GoogleSignInError
          ? googleErrorMessage(caught)
          : caught instanceof ApiError
            ? caught.message
            : 'Could not send the code.',
      );
    } finally {
      setEmailBusy(false);
    }
  };

  const confirm = async () => {
    setEmailError(null);
    setEmailBusy(true);
    let proof: ReauthProof | null;
    try {
      proof = await proveOwner();
    } catch (caught) {
      setEmailBusy(false);
      setEmailError(googleErrorMessage(caught));
      return;
    }
    if (!proof) {
      setEmailBusy(false);
      return;
    }
    const result = await dispatch(confirmEmailCode({ otp: code.trim(), ...proof }));
    setEmailBusy(false);
    if (confirmEmailCode.fulfilled.match(result)) {
      setEmailNotice(
        emailFlow.step === 'code' && emailFlow.purpose === 'change'
          ? 'Email changed. You have been signed out on every other device.'
          : 'Email verified.',
      );
      endFlow();
    } else {
      setEmailError(result.payload ?? 'That code did not work.');
    }
  };

  /** The password field, or a note that Google will ask — whichever applies. */
  const ownerProofField = hasPassword ? (
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
    <Text style={styles.hint}>You'll be asked to confirm with Google.</Text>
  );
  const proofReady = !hasPassword || password.length > 0;

  if (!user) return <Screen />;

  const status = wholesaleStatusStyle[user.wholesaleStatus];
  const accountLabel =
    user.accountType === 'admin'
      ? 'Admin'
      : user.accountType === 'staff'
        ? 'Staff'
        : user.accountType === 'wholesale'
          ? `Wholesale · ${status.label}`
          : 'Retail';

  const newEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim());

  return (
    <Screen edges={['top']}>
      <NavBar title="Profile" onBack={() => navigation.goBack()} />

      <KeyboardAwareScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.scroll}
      >
        <SectionLabel>Account</SectionLabel>
        <Group>
          {user.phone ? <Row label="Mobile number" value={user.phone} /> : null}
          <Row label="Account type" value={accountLabel} />
          {user.business?.businessName ? (
            <Row label="Business" value={user.business.businessName} />
          ) : null}
          {user.business?.gstNumber ? <Row label="GSTIN" value={user.business.gstNumber} /> : null}
        </Group>

        <View style={styles.block}>
          <SectionLabel>Email</SectionLabel>
          <Group>
            <Row
              label={user.email ?? 'No email on this account'}
              detail={user.emailVerified ? 'Verified' : 'Not verified'}
            />
          </Group>

          {emailNotice ? <Text style={[styles.hint, styles.success]}>{emailNotice}</Text> : null}
          {emailError ? <ErrorBanner message={emailError} /> : null}

          {emailFlow.step === 'idle' ? (
            <View style={styles.emailActions}>
              {user.email && !user.emailVerified ? (
                <Button
                  label="Verify email"
                  variant="secondary"
                  onPress={() => {
                    setEmailError(null);
                    setEmailNotice(null);
                    setEmailFlow({ step: 'verify' });
                  }}
                />
              ) : null}
              <Button
                label="Change email"
                variant="ghost"
                onPress={() => {
                  setEmailError(null);
                  setEmailNotice(null);
                  setEmailFlow({ step: 'enter' });
                }}
              />
            </View>
          ) : null}

          {emailFlow.step === 'enter' ? (
            <Group padded>
              <Input
                label="New email"
                value={newEmail}
                onChangeText={setNewEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                hint="We'll send a 6-digit code to this address. Your email changes only after you enter it."
              />
              {ownerProofField}
              <Button
                label="Send code"
                onPress={() => void sendCode(newEmail.trim().toLowerCase())}
                loading={emailBusy}
                disabled={!newEmailValid || !proofReady}
              />
              <Button label="Cancel" variant="ghost" onPress={endFlow} />
            </Group>
          ) : null}

          {emailFlow.step === 'verify' && user.email ? (
            <Group padded>
              <Text style={styles.stepLead}>We'll send a 6-digit code to {user.email}.</Text>
              {ownerProofField}
              <Button
                label="Send code"
                onPress={() => void sendCode(user.email as string)}
                loading={emailBusy}
                disabled={!proofReady}
              />
              <Button label="Cancel" variant="ghost" onPress={endFlow} />
            </Group>
          ) : null}

          {emailFlow.step === 'code' ? (
            <Group padded>
              <Input
                label={`Code sent to ${emailFlow.target}`}
                value={code}
                onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                keyboardType="number-pad"
                maxLength={6}
              />
              <Button
                label={emailFlow.purpose === 'change' ? 'Change email' : 'Verify email'}
                onPress={() => void confirm()}
                loading={emailBusy}
                disabled={code.length !== 6 || !proofReady}
              />
              {hasPassword && !password ? ownerProofField : null}
              <Button
                label="Send a new code"
                variant="ghost"
                onPress={() => void sendCode(emailFlow.target)}
                disabled={!proofReady}
              />
              <Button label="Cancel" variant="ghost" onPress={endFlow} />
            </Group>
          ) : null}
        </View>

        <View style={styles.block}>
          <SectionLabel>Your details</SectionLabel>
          <Group padded>
            <Input
              label="Your name"
              value={name}
              onChangeText={setName}
              placeholder="How should we address you?"
              autoCapitalize="words"
            />
            <Button label="Save changes" onPress={handleSave} loading={saving} />
          </Group>
        </View>
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl },
  block: { marginTop: spacing.xl },
  emailActions: { marginTop: spacing.md, gap: spacing.sm },
  hint: {
    ...typography.footnote,
    color: colors.textFaint,
    lineHeight: 19,
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  success: { color: colors.success },
  stepLead: { ...typography.callout, color: colors.textMuted, marginBottom: spacing.md },
});
