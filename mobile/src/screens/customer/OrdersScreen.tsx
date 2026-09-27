import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, EmptyState, Group, LargeTitle, Screen } from '../../components/ui';
import { PressableScale } from '../../components/motion';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { fetchOrders } from '../../store/slices/cartSlice';
import { colors, orderStatusStyle, spacing, typography } from '../../theme';
import { formatPaise } from '../../utils/money';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * PRD 4.5 — order status and history. Status is coloured text rather than a
 * block, and a cancelled order fades instead of being flagged.
 */
export function OrdersScreen() {
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();
  const orders = useAppSelector((state) => state.cart.orders);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    await dispatch(fetchOrders());
    setRefreshing(false);
  }, [dispatch]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (orders.length === 0 && !refreshing) {
    return (
      <Screen>
        <EmptyState
          icon="package"
          title="No orders yet"
          message="Your orders and their delivery status will appear here."
          action={
            <Button
              label="Browse the collection"
              onPress={() => navigation.navigate('CustomerTabs', { screen: 'Catalog' })}
              fullWidth={false}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <LargeTitle title="Orders" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />
        }
      >
        <Group>
          {orders.map((order) => {
            const status = orderStatusStyle[order.orderStatus];
            const pieces = order.items.reduce((sum, entry) => sum + entry.quantity, 0);
            const cancelled = order.orderStatus === 'cancelled';
            const thumbs = order.items.filter((item) => item.image).slice(0, 3);

            return (
              <PressableScale
                key={order.id}
                onPress={() => navigation.navigate('OrderDetail', { orderId: order.id })}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  cancelled && styles.rowCancelled,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.orderNumber}>{order.orderNumber}</Text>
                  <Text style={[styles.status, { color: status.fg }]}>{status.label}</Text>
                </View>

                <Text style={styles.meta}>
                  {new Date(order.createdAt).toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short',
                  })}{' '}
                  · {pieces} piece{pieces === 1 ? '' : 's'} ·{' '}
                  {order.paymentMethod === 'cod' ? 'COD' : 'Online'}
                  {/* A COD order can be waiting on a payment too — its shipping
                      charge is paid online before the order is placed. */}
                  {order.orderStatus === 'pending_payment' ||
                  (order.paymentMethod === 'razorpay' && order.paymentStatus === 'pending')
                    ? ' · payment pending'
                    : order.paymentStatus === 'expired'
                      ? ' · payment not completed'
                      : order.paymentStatus === 'refunded'
                        ? ' · refunded'
                        : ''}
                </Text>

                {!cancelled ? (
                  <View style={styles.rowBottom}>
                    {thumbs.map((item, index) => (
                      <Image
                        key={`${item.productId}-${index}`}
                        source={item.image}
                        style={styles.thumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                      />
                    ))}
                    <View style={{ flex: 1 }} />
                    <Text style={styles.total}>{formatPaise(order.totalAmount)}</Text>
                  </View>
                ) : null}
              </PressableScale>
            );
          })}
        </Group>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },

  row: { padding: spacing.xl },
  rowCancelled: { opacity: 0.5 },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  orderNumber: { ...typography.bodyStrong, fontWeight: '600', color: colors.text },
  status: { ...typography.captionStrong },
  meta: { ...typography.caption, color: colors.textFaint, marginTop: spacing.xs },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md + 2 },
  thumb: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.background },
  total: { ...typography.heading, color: colors.text },
});
