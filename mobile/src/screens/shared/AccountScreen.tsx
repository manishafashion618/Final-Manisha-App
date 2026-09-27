import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PressableScale } from '../../components/motion';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Group,
  Row,
  Screen,
  SectionLabel,
  StatusPill,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import {
  PERMISSIONS,
  useAppDispatch,
  useAppSelector,
  useIsStaff,
  usePermission,
} from '../../store/hooks';
import { applyForWholesale, refreshProfile, signOut } from '../../store/slices/authSlice';
import { colors, radius, shadow, shadowAccent, spacing, typography } from '../../theme';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Screen 19 — settings-style grouped rows. The identity block carries the only
 * saturated element on the screen (the avatar), and every destination below it
 * is one plain row with a chevron.
 */
export function AccountScreen() {
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const user = useAppSelector((state) => state.auth.user);
  const orderCount = useAppSelector((state) => state.cart.orders.length);
  const savedCount = useAppSelector((state) => state.product.wishlistIds.length);
  const isStaff = useIsStaff();
  const canManageUsers = usePermission(PERMISSIONS.USER_MANAGE);
  const canManageCategories = usePermission(PERMISSIONS.CATEGORY_MANAGE);
  const canManageCod = usePermission(PERMISSIONS.COD_CONFIG_MANAGE);

  const [applying, setApplying] = useState(false);

  useEffect(() => {
    void dispatch(refreshProfile());
  }, [dispatch]);

  const handleApplyWholesale = () => {
    Alert.alert(
      'Apply for wholesale pricing?',
      'An admin will review your application. Wholesale pricing unlocks once approved.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Apply',
          onPress: async () => {
            setApplying(true);
            await dispatch(applyForWholesale({}));
            setApplying(false);
          },
        },
      ],
    );
  };

  const handleSignOut = () => {
    Alert.alert('Log out?', 'You will need to verify your number again next time.', [
      { text: 'Stay signed in', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void dispatch(signOut()) },
    ]);
  };

  if (!user) return <Screen />;

  const tier =
    user.accountType === 'admin'
      ? 'Admin'
      : user.accountType === 'staff'
        ? 'Staff'
        : user.accountType === 'wholesale'
          ? 'Wholesale'
          : 'Retail';

  return (
    <Screen>
      {/* The identity block is the obvious thing to tap to edit yourself, so
          it now is one — previously the only route was the "Profile details"
          row further down. The tier moves into a pill so it reads as a status
          rather than as part of the phone number. */}
      <PressableScale
        style={styles.identity}
        onPress={() => navigation.navigate('Profile')}
        accessibilityRole="button"
        accessibilityLabel="Profile details"
      >
        <View style={[styles.avatar, shadowAccent]}>
          <Text style={styles.avatarText}>
            {/* Google-only accounts have no phone; fall back to the email. */}
            {(user.name ?? user.phone ?? user.email ?? '?').slice(0, 2).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{user.name ?? 'Add your name'}</Text>
          <View style={styles.identityMeta}>
            <Text style={styles.phone}>{user.phone}</Text>
            <StatusPill label={tier} tone={tier === 'Wholesale' ? 'accent' : 'neutral'} />
          </View>
        </View>
        <Icon name="chevronRight" size={18} color={colors.textDisabled} />
      </PressableScale>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {!isStaff ? (
          <View style={[styles.stats, shadow]}>
            <Stat value={orderCount} label="Orders" />
            <Stat value={savedCount} label="Saved" />
            <Stat value={user.addresses.length} label="Addresses" />
          </View>
        ) : null}

        <View style={styles.block}>
          <Group>
            <Row
              icon="user"
              label="Profile details"
              chevron
              onPress={() => navigation.navigate('Profile')}
            />
            {!isStaff ? (
              <Row
                icon="mapPin"
                label="Delivery addresses"
                chevron
                onPress={() => navigation.navigate('Addresses')}
              />
            ) : null}
            {!isStaff ? (
              <Row
                icon="package"
                label="Order history"
                chevron
                onPress={() => navigation.navigate('CustomerTabs', { screen: 'Orders' })}
              />
            ) : null}
          </Group>
        </View>

        {isStaff ? (
          <View style={styles.block}>
            <SectionLabel>Store management</SectionLabel>
            <Group>
              {canManageCategories ? (
                <Row
                  icon="tag"
                  label="Categories"
                  chevron
                  onPress={() => navigation.navigate('AdminCategories')}
                />
              ) : null}
              {canManageUsers ? (
                <Row
                  icon="users"
                  label="Customer & staff accounts"
                  chevron
                  onPress={() => navigation.navigate('AdminUsers')}
                />
              ) : null}
              {canManageCod ? (
                <Row
                  icon="sliders"
                  label="COD settings"
                  detail="Availability and charge, per state"
                  chevron
                  onPress={() => navigation.navigate('AdminCodSettings')}
                />
              ) : null}
            </Group>
          </View>
        ) : null}

        {/* PRD 4.1 — a retail customer can apply for wholesale from inside the app. */}
        {user.accountType === 'retail' ? (
          <View style={styles.block}>
            <Group>
              <Row
                label={applying ? 'Sending your application…' : 'Apply for wholesale'}
                detail="Trade pricing, once the shop approves you"
                chevron
                onPress={applying ? undefined : handleApplyWholesale}
              />
            </Group>
          </View>
        ) : null}

        {/* Play policy: deletion is reachable from inside the app. Not offered
            to an admin — that role comes from ADMIN_EMAILS, and the server
            refuses to delete such an account here. */}
        {user.accountType !== 'admin' ? (
          <View style={styles.block}>
            <Group>
              <Row
                icon="trash"
                label="Delete account"
                tone="muted"
                chevron
                onPress={() => navigation.navigate('DeleteAccount')}
              />
            </Group>
          </View>
        ) : null}

        <PressableScale onPress={handleSignOut} style={styles.logOut} accessibilityRole="button">
          <Text style={styles.logOutLabel}>Log out</Text>
        </PressableScale>
      </ScrollView>
    </Screen>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  identityMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl - 4,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 22, fontWeight: '500', color: colors.textInverse },
  name: { ...typography.title, color: colors.text },
  phone: { ...typography.callout, color: colors.textFaint, marginTop: 2 },

  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
  block: { marginTop: spacing.xl },

  stats: {
    flexDirection: 'row',
    padding: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  statValue: { ...typography.title, fontSize: 24, color: colors.text },
  statLabel: { ...typography.footnote, color: colors.textFaint, marginTop: 3 },

  logOut: {
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  logOutLabel: { ...typography.bodyStrong, color: colors.primary },
});
