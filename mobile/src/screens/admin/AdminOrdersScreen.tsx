import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Chip,
  Divider,
  EmptyState,
  ErrorBanner,
  LargeTitle,
  ListRow,
  LoadingView,
  Screen,
  StatusText,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { StaggerItem } from '../../components/motion';
import { adminApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { colors, orderStatusStyle, radius, shadow, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import { codCollectionLine } from '../../utils/orderMoney';
import type { AdminTabParamList, RootStackParamList } from '../../navigation/types';
import type { Order, OrderStatus, Pagination } from '../../api/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<AdminTabParamList, 'AdminOrders'>;

const FILTERS: Array<{ value: OrderStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  // Unpaid online / COD-shipping orders: not real orders to ship yet.
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'placed', label: 'Placed' },
  { value: 'processing', label: 'Processing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * PRD 4.7 — screen 26. View all orders, filter by status, open for updates.
 *
 * The design shows a four-slot segmented control; the order lifecycle has six
 * states, which will not fit one at 412px, so this uses the kit's scrolling
 * chip row — the same overflow idiom as the customer catalogue's categories.
 */
export function AdminOrdersScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();

  const [status, setStatus] = useState<OrderStatus | 'all'>(route.params?.status ?? 'all');
  const [search, setSearch] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (page = 1, nextStatus = status, query = search) => {
      if (page === 1) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const { data, pagination: meta } = await adminApi.listOrders({
          page,
          limit: 20,
          status: nextStatus === 'all' ? undefined : nextStatus,
          search: query.trim() || undefined,
        });
        setOrders((current) => (page === 1 ? data : [...current, ...data]));
        setPagination(meta ?? null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load orders.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [status, search],
  );

  useFocusEffect(
    useCallback(() => {
      void load(1);
    }, [load]),
  );

  const handleFilter = (next: OrderStatus | 'all') => {
    setStatus(next);
    void load(1, next);
  };

  if (loading && orders.length === 0) return <LoadingView variant="list" />;

  return (
    <Screen>
      <LargeTitle overline="Admin" title="Orders">

        <View style={styles.searchField}>
          <Icon name="search" size={17} color={colors.textPlaceholder} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => void load(1)}
            placeholder="Order number or customer"
            placeholderTextColor={colors.textPlaceholder}
            returnKeyType="search"
            autoCapitalize="characters"
            style={styles.searchInput}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          style={styles.chipsRow}
        >
          {FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              label={filter.label}
              active={status === filter.value}
              onPress={() => handleFilter(filter.value)}
            />
          ))}
        </ScrollView>
      </LargeTitle>

      {error ? (
        <View style={styles.bannerWrap}>
          <ErrorBanner message={error} onRetry={() => void load(1)} />
        </View>
      ) : null}

      <FlatList
          // A search result stays tappable while the keyboard is open;
          // without this the first tap only dismisses the keyboard.
          keyboardShouldPersistTaps="handled"
        data={orders}
        keyExtractor={(order) => order.id}
        style={[styles.card, shadow]}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void load(1)}
            tintColor={colors.primary}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (!loadingMore && pagination?.hasMore) void load(pagination.page + 1);
        }}
        ListEmptyComponent={
          <EmptyState
            icon="clipboard"
            title="No orders here"
            message="Try a different status filter."
          />
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.xl }} />
          ) : null
        }
        renderItem={({ item, index }) => {
          const style = orderStatusStyle[item.orderStatus];
          const pieces = item.items.reduce((sum, entry) => sum + entry.quantity, 0);

          return (
            <StaggerItem index={index}>
              <ListRow
              title={item.orderNumber}
              subtitle={`${item.customer?.name ?? 'Customer'} · ${item.customer?.phone ?? '—'}`}
              trailing={<StatusText label={style.label} color={style.fg} />}
              dimmed={item.orderStatus === 'cancelled'}
              onPress={() => navigation.navigate('AdminOrderDetail', { orderId: item.id })}
              footer={
                <View style={styles.footerRow}>
                  <Text style={styles.meta} numberOfLines={1}>
                    {pieces} piece{pieces === 1 ? '' : 's'} ·{' '}
                    {item.paymentMethod === 'cod' ? 'COD' : 'Prepaid'}
                    {item.refundState === 'due' || item.refundState === 'failed'
                      ? ' · refund due'
                      : item.paymentStatus === 'paid'
                        ? ' paid'
                        : item.paymentStatus === 'refunded'
                          ? ' refunded'
                          : item.paymentStatus === 'expired'
                            ? ' expired'
                            : ' pending'}
                    {item.cancellationRequest && item.orderStatus !== 'cancelled' ? ' · cancel requested' : ''}{' '}
                    ·{' '}
                    {new Date(item.createdAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </Text>
                  <Text style={styles.total}>{formatPaise(item.totalAmount)}</Text>
                  {/* What the delivery person collects, for COD. */}
                  {codCollectionLine(item) && item.orderStatus !== 'cancelled' ? (
                    <Text style={styles.codLine} numberOfLines={2}>
                      {codCollectionLine(item)}
                    </Text>
                  ) : null}
                </View>
              }
              />
            </StaggerItem>
          );
        }}
      />
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

  bannerWrap: { paddingHorizontal: spacing.xl },

  card: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  footerRow: {
    flexDirection: 'row',
    // The COD collection line (full width) drops beneath the meta and total.
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.md - 2,
  },
  meta: { ...typography.caption, color: colors.textMuted, flex: 1 },
  codLine: { ...typography.captionStrong, color: colors.text, width: '100%', marginTop: spacing.xs },
  total: { ...typography.heading, color: colors.text },
});
