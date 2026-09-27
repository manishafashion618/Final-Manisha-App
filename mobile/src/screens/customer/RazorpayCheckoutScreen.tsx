import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, EmptyState, LoadingView, Screen } from '../../components/ui';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { confirmPayment } from '../../store/slices/cartSlice';
import { colors } from '../../theme';
import type { RootStackParamList } from '../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList, 'RazorpayCheckout'>;
type Route = RouteProp<RootStackParamList, 'RazorpayCheckout'>;

/**
 * PRD 4.4 — Razorpay checkout.
 *
 * Razorpay's standard checkout is hosted in a WebView rather than a native
 * module, so the app runs in Expo Go and a dev build alike with no custom
 * native code. The signature that comes back is verified server-side
 * (PRD 8.4) — this screen never decides that a payment succeeded on its own.
 */
export function RazorpayCheckoutScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const dispatch = useAppDispatch();

  const user = useAppSelector((state) => state.auth.user);
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const checkoutHtml = useMemo(() => {
    const options = {
      key: params.handle.keyId,
      amount: params.handle.amount,
      currency: params.handle.currency,
      order_id: params.handle.razorpayOrderId,
      name: 'Manisha Fashions',
      description: params.description ?? 'Jewellery order',
      prefill: {
        contact: user?.phone ?? '',
        name: user?.name ?? '',
        email: user?.email ?? '',
      },
      theme: { color: colors.primary },
    };

    return `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" /></head>
  <body style="margin:0;background:${colors.background}">
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <script>
      function send(payload) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
      try {
        var options = ${JSON.stringify(options)};
        options.handler = function (response) { send({ type: 'success', response: response }); };
        options.modal = { ondismiss: function () { send({ type: 'dismissed' }); } };
        var rzp = new Razorpay(options);
        rzp.on('payment.failed', function (event) {
          send({ type: 'failed', message: (event && event.error && event.error.description) || 'Payment failed' });
        });
        rzp.open();
      } catch (error) {
        send({ type: 'failed', message: 'Could not open the payment window.' });
      }
    </script>
  </body>
</html>`;
  }, [params.handle, user]);

  const handleMessage = async (event: WebViewMessageEvent) => {
    let payload: {
      type: string;
      message?: string;
      response?: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      };
    };

    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    // Not paid (sheet closed, or the attempt failed): the order is NOT placed
    // — it waits unpaid, and the same payment can be retried. Back to where the
    // customer came from, which offers "Try again"; the webhook still settles
    // it if the payment went through outside the app.
    if (payload.type === 'dismissed' || payload.type === 'failed') {
      const message =
        payload.type === 'failed'
          ? payload.message ?? 'Your payment did not go through.'
          : 'Payment not completed.';
      if (params.returnTo === 'checkout') {
        navigation.popTo(
          'Checkout',
          { paymentOutcome: { orderId: params.orderId, handle: params.handle, message } },
          { merge: true },
        );
        return;
      }
      if (params.returnTo === 'order' || payload.type === 'dismissed') {
        navigation.goBack();
        return;
      }
      setFailure(message);
      return;
    }

    if (payload.type === 'success' && payload.response) {
      setVerifying(true);
      const result = await dispatch(
        confirmPayment({
          orderId: params.orderId,
          razorpayPaymentId: payload.response.razorpay_payment_id,
          razorpaySignature: payload.response.razorpay_signature,
        }),
      );
      setVerifying(false);

      if (confirmPayment.fulfilled.match(result)) {
        /* Reset rather than replace: the sheet is pushed over the checkout
           screen (so a closed sheet can return to it), and going back onto a
           checkout whose cart has just been emptied is a dead end. Back from
           the confirmation now goes to the shop. */
        navigation.reset({
          index: 1,
          routes: [
            { name: 'CustomerTabs', params: { screen: 'Catalog' } },
            { name: 'OrderConfirmation', params: { orderId: params.orderId } },
          ],
        });
      } else {
        setFailure(
          typeof result.payload === 'string'
            ? result.payload
            : 'We could not verify your payment. If money was deducted it will be reconciled automatically.',
        );
      }
    }
  };

  if (verifying) return <LoadingView label="Verifying your payment…" />;

  if (failure) {
    return (
      <Screen>
        <EmptyState
          icon="info"
          title="Payment not completed"
          message={failure}
          action={
            <Button
              label="Back to orders"
              onPress={() => navigation.replace('CustomerTabs', { screen: 'Orders' })}
              fullWidth={false}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        source={{ html: checkoutHtml, baseUrl: 'https://checkout.razorpay.com' }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        renderLoading={() => <LoadingView label="Opening secure payment…" />}
        originWhitelist={['*']}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  webview: { flex: 1, backgroundColor: colors.background },
});
