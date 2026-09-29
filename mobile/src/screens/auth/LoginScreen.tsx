import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, ErrorBanner, Input, Screen, Segmented } from '../../components/ui';
import { GoogleButton } from '../../components/GoogleButton';
import { PressableScale } from '../../components/motion';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  clearError,
  loginWithGoogle,
  loginWithPassword,
  registerWithPassword,
  setPendingAccountType,
} from '../../store/slices/authSlice';
import { colors, spacing, typography } from '../../theme';
import { openLegalPage } from '../../utils/legalLinks';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Login'>;

/**
 * The only sign-in screen: email + password, or native Google Sign-In.
 *
 * Both paths end in the same session state, so the navigator routes by the
 * server-returned role without knowing which one was used.
 *
 * The Retail/Wholesale choice appears only while creating an account. Account
 * type is a property of signup, not of signing in, and showing it on the
 * sign-in path implied it could be changed by logging in a different way.
 */
export function LoginScreen() {
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();
  const { loading, error } = useAppSelector((state) => state.auth);
  const accountType = useAppSelector((state) => state.auth.pendingAccountType);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [touched, setTouched] = useState(false);
  // Separate from the store's `loading`, which drives the email button.
  const [googlePending, setGooglePending] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  // Only enforced when creating an account — an older password must still work.
  const passwordValid = isRegister
    ? password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password)
    : password.length > 0;

  const handleSubmit = async () => {
    setTouched(true);
    if (!emailValid || !passwordValid) return;
    const credentials = { email: email.trim().toLowerCase(), password };
    if (isRegister) {
      await dispatch(registerWithPassword({ ...credentials, accountType }));
    } else {
      await dispatch(loginWithPassword(credentials));
    }
  };

  const handleGoogle = async () => {
    if (googlePending) return;
    setGooglePending(true);
    try {
      await dispatch(loginWithGoogle());
    } finally {
      setGooglePending(false);
    }
  };

  const toggleMode = () => {
    setIsRegister((current) => !current);
    setTouched(false);
    dispatch(clearError());
  };

  return (
    <Screen
      scroll
      keyboardAvoiding
      tone="plain"
      edges={['top', 'bottom']}
      contentStyle={styles.content}
    >
      {/* Sign-in opens over whatever a guest was browsing, so backing out has
          to be possible — it returns them there, still a guest. */}
      {navigation.canGoBack() ? (
        <PressableScale
          onPress={() => navigation.goBack()}
          hitSlop={10}
          accessibilityRole="button"
          style={styles.cancel}
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </PressableScale>
      ) : null}

      <Image source={require('../../../assets/logo.jpeg')} style={styles.logo} />

      <Text style={styles.heading}>{isRegister ? 'Create account' : 'Sign in'}</Text>
      <Text style={styles.subheading}>
        {isRegister
          ? 'Use your email address, or continue with Google.'
          : 'Sign in with your email and password, or continue with Google.'}
      </Text>

      {error ? <ErrorBanner message={error} /> : null}

      {isRegister ? (
        <View style={styles.segmentBlock}>
          <Segmented
            options={[
              { value: 'retail' as const, label: 'Retail' },
              { value: 'wholesale' as const, label: 'Wholesale' },
            ]}
            value={accountType}
            onChange={(next) => {
              dispatch(setPendingAccountType(next));
              dispatch(clearError());
            }}
            tone="plain"
          />
          <Text style={styles.segmentHint}>
            {accountType === 'retail'
              ? 'Shop at our standard retail prices.'
              : 'Approved by the shop before wholesale pricing unlocks.'}
          </Text>
        </View>
      ) : (
        <View style={{ height: spacing.xxl }} />
      )}

      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
        error={touched && !emailValid ? 'Enter a valid email address' : null}
      />

      <Input
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        textContentType={isRegister ? 'newPassword' : 'password'}
        error={touched && !passwordValid ? 'Use 8+ characters with a letter and a number' : null}
        hint={isRegister ? 'At least 8 characters, with a letter and a number.' : undefined}
      />

      {!isRegister ? (
        <PressableScale
          onPress={() => navigation.navigate('ForgotPassword')}
          hitSlop={8}
          accessibilityRole="button"
          style={styles.forgot}
        >
          <Text style={styles.forgotLabel}>Forgot password?</Text>
        </PressableScale>
      ) : null}

      {isRegister && accountType === 'wholesale' ? (
        <>
          <Input
            label="Business name"
            value={businessName}
            onChangeText={setBusinessName}
            placeholder="Your shop or firm name"
            autoCapitalize="words"
          />
          <Input
            label="GST number"
            value={gstNumber}
            onChangeText={(value) => setGstNumber(value.toUpperCase().slice(0, 15))}
            placeholder="24AAAAA0000A1Z5"
            autoCapitalize="characters"
            maxLength={15}
            hint="Optional — speeds up approval. You can add this later."
          />
        </>
      ) : null}

      <View style={{ flex: 1, minHeight: spacing.xl }} />

      <Button
        label={isRegister ? 'Create account' : 'Sign in'}
        onPress={handleSubmit}
        loading={loading}
        disabled={googlePending}
      />

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerLabel}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <GoogleButton onPress={handleGoogle} loading={googlePending} disabled={loading} />

      <PressableScale
        onPress={toggleMode}
        hitSlop={8}
        accessibilityRole="button"
        style={styles.switchMode}
      >
        <Text style={styles.switchModeLabel}>
          {isRegister ? 'I already have an account' : 'Create an account'}
        </Text>
      </PressableScale>

      {/* Real links, not just words: Play requires the privacy policy to be
          reachable from inside the app. */}
      <Text style={styles.legal}>
        By continuing you agree to our{' '}
        <Text
          style={styles.legalLink}
          onPress={() => openLegalPage('terms')}
          accessibilityRole="link"
        >
          terms of service
        </Text>{' '}
        and{' '}
        <Text
          style={styles.legalLink}
          onPress={() => openLegalPage('privacy')}
          accessibilityRole="link"
        >
          privacy policy
        </Text>
        .
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: spacing.xxl, paddingTop: spacing.xl },
  cancel: { alignSelf: 'flex-start', paddingVertical: spacing.sm, marginBottom: spacing.md },
  cancelLabel: { ...typography.bodyStrong, color: colors.primary },
  logo: { width: 132, height: 104, resizeMode: 'contain' },
  heading: { ...typography.hero, color: colors.text, lineHeight: 38, marginTop: spacing.xxl },
  subheading: { ...typography.row, color: colors.textMuted, lineHeight: 26, marginTop: spacing.md },

  segmentBlock: { marginTop: spacing.xxxl, marginBottom: spacing.xxl },
  segmentHint: { ...typography.footnote, color: colors.textFaint, marginTop: spacing.md },

  forgot: { alignSelf: 'flex-end', paddingVertical: spacing.sm },
  forgotLabel: { ...typography.footnoteStrong, color: colors.primary },

  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: spacing.lg,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.borderStrong },
  dividerLabel: { ...typography.footnote, color: colors.textFaint },

  switchMode: { alignSelf: 'center', paddingVertical: spacing.md },
  switchModeLabel: { ...typography.footnoteStrong, color: colors.primary },

  legal: {
    ...typography.tiny,
    fontWeight: '400',
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  legalLink: { color: colors.primary, fontWeight: '500' },
});
