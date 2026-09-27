import { useCallback, useState } from 'react';
import {
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import {
  Chip,
  EmptyState,
  ErrorBanner,
  Group,
  LargeTitle,
  LoadingView,
  NavBar,
  Screen,
  SectionLabel,
  StatusText,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { PressableScale } from '../../components/motion';
import { adminApi, type RoleChange } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useAppSelector } from '../../store/hooks';
import { colors, spacing, typography, wholesaleStatusStyle } from '../../theme';
import type { AccountType, User } from '../../api/types';

const TABS: Array<{ value: AccountType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'retail', label: 'Retail' },
  { value: 'wholesale', label: 'Wholesale' },
  { value: 'staff', label: 'Staff' },
  { value: 'admin', label: 'Admin' },
];

/**
 * PRD 8.9 — screen 31. Admin-only account management. Staff cannot reach this
 * screen (the menu entry is permission-gated) and the API refuses it
 * independently.
 */
export function AdminUsersScreen() {
  const navigation = useNavigation();
  const currentUserId = useAppSelector((state) => state.auth.user?.id);

  const [tab, setTab] = useState<AccountType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<RoleChange[]>([]);

  const load = useCallback(
    async (nextTab = tab, query = search) => {
      setLoading(true);
      setError(null);
      try {
        const { data } = await adminApi.listUsers({
          accountType: nextTab === 'all' ? undefined : nextTab,
          search: query.trim() || undefined,
          page: 1,
          limit: 50,
        });
        setUsers(data);
        // The trail is secondary: failing to load it must not hide the accounts.
        adminApi
          .roleChanges()
          .then((rows) => setChanges(rows.slice(0, 10)))
          .catch(() => setChanges([]));
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load accounts.');
      } finally {
        setLoading(false);
      }
    },
    [tab, search],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const changeRole = (user: User) => {
    // No "Admin" choice: admin comes only from the store's ADMIN_EMAILS list,
    // and the server refuses it here.
    const options: Array<{ label: string; value: 'retail' | 'staff' }> = [
      { label: 'Retail customer', value: 'retail' as const },
      { label: 'Staff', value: 'staff' as const },
    ].filter((option) => option.value !== user.accountType);

    Alert.alert(
      'Change role',
      `${user.name ?? user.email ?? user.phone} is currently ${user.accountType}. Changing the role signs them out of every device. Admin access is granted only through the store's admin email list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        ...options.map((option) => ({
          text: option.label,
          onPress: async () => {
            try {
              await adminApi.setRole(user.id, option.value);
              await load();
            } catch (caught) {
              Alert.alert(
                'Could not change role',
                caught instanceof ApiError ? caught.message : 'Please try again.',
              );
            }
          },
        })),
      ],
    );
  };

  const toggleActive = (user: User) => {
    Alert.alert(
      'Deactivate this account?',
      'They will be signed out immediately and cannot sign back in until reactivated.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: async () => {
            try {
              await adminApi.setActive(user.id, false);
              await load();
            } catch (caught) {
              Alert.alert(
                'Could not update',
                caught instanceof ApiError ? caught.message : 'Please try again.',
              );
            }
          },
        },
      ],
    );
  };

  return (
    <Screen edges={['top']}>
      <NavBar onBack={() => navigation.goBack()} />

      <LargeTitle overline="Admin only" title="Accounts">

        <View style={styles.searchField}>
          <Icon name="search" size={17} color={colors.textPlaceholder} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => void load()}
            placeholder="Name, phone or business"
            placeholderTextColor={colors.textPlaceholder}
            returnKeyType="search"
            style={styles.searchInput}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsRow}
        >
          {TABS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.label}
              active={tab === entry.value}
              onPress={() => {
                setTab(entry.value);
                void load(entry.value);
              }}
            />
          ))}
        </ScrollView>
      </LargeTitle>

      {loading && users.length === 0 ? (
        <LoadingView variant="list" />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          // A row stays tappable while the search keyboard is open.
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void load()}
              tintColor={colors.primary}
            />
          }
        >
          {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}

          {users.length === 0 ? (
            <EmptyState
              icon="users"
              title="No accounts found"
              message="Try a different filter or search."
            />
          ) : (
            <Group>
              {users.map((user) => {
                const isSelf = user.id === currentUserId;
                const pendingTrade =
                  user.accountType === 'wholesale' && user.wholesaleStatus !== 'approved';
                const roleLabel =
                  user.accountType === 'wholesale'
                    ? `Wholesale · ${wholesaleStatusStyle[user.wholesaleStatus].label.toLowerCase()}`
                    : user.accountType.charAt(0).toUpperCase() + user.accountType.slice(1);

                return (
                  <View key={user.id} style={styles.row}>
                    <View style={styles.rowTop}>
                      <Text style={styles.name} numberOfLines={1}>
                        {user.name ?? user.business?.businessName ?? 'Unnamed'}
                        {isSelf ? <Text style={styles.self}> (you)</Text> : null}
                      </Text>
                      <StatusText
                        label={roleLabel}
                        color={pendingTrade ? colors.warning : colors.textFaint}
                      />
                    </View>

                    <Text style={styles.meta}>
                      {user.phone} · joined{' '}
                      {new Date(user.createdAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </Text>

                    {/* An admin cannot change their own role or deactivate
                        themselves — the API enforces this too. */}
                    {!isSelf ? (
                      <View style={styles.actions}>
                        <PressableScale onPress={() => changeRole(user)} hitSlop={8}>
                          <Text style={styles.action}>Change role</Text>
                        </PressableScale>
                        <PressableScale onPress={() => toggleActive(user)} hitSlop={8}>
                          <Text style={[styles.action, styles.actionQuiet]}>Deactivate</Text>
                        </PressableScale>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </Group>
          )}

          {/* Who promoted or deactivated whom — the one change nobody notices
              afterwards, because the list above only shows the result. */}
          {changes.length > 0 ? (
            <View style={styles.block}>
              <SectionLabel>Recent role changes</SectionLabel>
              <Group>
                {changes.map((change) => (
                  <View key={change.id} style={styles.changeRow}>
                    <Text style={styles.changeText}>
                      <Text style={styles.changeStrong}>{change.targetEmail ?? 'An account'}</Text>
                      {change.action === 'role'
                        ? ` ${change.from} → ${change.to}`
                        : change.to === 'false'
                          ? ' deactivated'
                          : ' reactivated'}
                    </Text>
                    <Text style={styles.meta}>
                      by {change.actorEmail ?? 'an admin'} ·{' '}
                      {new Date(change.at).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </Text>
                  </View>
                ))}
              </Group>
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({

  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    backgroundColor: colors.fill,
    borderRadius: 12,
    paddingHorizontal: spacing.md + 2,
    marginTop: spacing.lg,
  },
  searchInput: { flex: 1, paddingVertical: spacing.md, fontSize: 16, color: colors.text },

  chipsRow: { flexGrow: 0, marginTop: spacing.md, marginHorizontal: -spacing.xl },
  chips: { paddingHorizontal: spacing.xl, gap: spacing.sm },

  list: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },

  row: { paddingHorizontal: spacing.lg + 2, paddingVertical: spacing.lg + 2 },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  name: { ...typography.bodyStrong, fontWeight: '600', color: colors.text, flex: 1 },
  self: { fontWeight: '400', color: colors.textFaint },
  meta: { ...typography.caption, color: colors.textFaint, marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.md },
  action: { ...typography.calloutStrong, color: colors.primary },
  actionQuiet: { color: colors.textFaint },

  block: { marginTop: spacing.xl },
  changeRow: { paddingHorizontal: spacing.lg + 2, paddingVertical: spacing.md + 2 },
  changeText: { ...typography.callout, color: colors.textMuted },
  changeStrong: { ...typography.calloutStrong, color: colors.text },
});
