import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoadingView } from '../components/ui';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { ForgotPasswordScreen } from '../screens/auth/ForgotPasswordScreen';
import { ResetOtpScreen } from '../screens/auth/ResetOtpScreen';
import { ResetPasswordScreen } from '../screens/auth/ResetPasswordScreen';
import { WholesalePendingScreen } from '../screens/auth/WholesalePendingScreen';
import { ProductDetailScreen } from '../screens/customer/ProductDetailScreen';
import { FiltersScreen } from '../screens/customer/FiltersScreen';
import { CheckoutScreen } from '../screens/customer/CheckoutScreen';
import { RazorpayCheckoutScreen } from '../screens/customer/RazorpayCheckoutScreen';
import { OrderConfirmationScreen } from '../screens/customer/OrderConfirmationScreen';
import { OrderDetailScreen } from '../screens/customer/OrderDetailScreen';
import { AddressesScreen } from '../screens/customer/AddressesScreen';
import { AddressFormScreen } from '../screens/customer/AddressFormScreen';
import { ProfileScreen } from '../screens/shared/ProfileScreen';
import { DeleteAccountScreen } from '../screens/shared/DeleteAccountScreen';
import { AdminProductFormScreen } from '../screens/admin/AdminProductFormScreen';
import { AdminCategoriesScreen } from '../screens/admin/AdminCategoriesScreen';
import { AdminCodSettingsScreen } from '../screens/admin/AdminCodSettingsScreen';
import { AdminOrderDetailScreen } from '../screens/admin/AdminOrderDetailScreen';
import { AdminUsersScreen } from '../screens/admin/AdminUsersScreen';
import { useAppSelector } from '../store/hooks';
import { colors, typography } from '../theme';
import { AdminTabs } from './AdminTabs';
import { CustomerTabs } from './CustomerTabs';
import { PendingIntentRunner } from './PendingIntentRunner';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();


const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};

/**
 * PRD 4.7 / 8.10 — route guarding lives here.
 *
 * Which stack mounts is derived from the signed-in account, not from a
 * navigation call, so a customer account has no reachable route into the admin
 * screens and a blocked wholesale account has no reachable route into the
 * catalogue. The server enforces the same rules independently (PRD 8.8).
 */
export function RootNavigator() {
  const status = useAppSelector((state) => state.auth.status);
  const user = useAppSelector((state) => state.auth.user);

  if (status === 'booting') {
    return <LoadingView label="Getting things ready…" />;
  }

  const isStaff = user?.accountType === 'admin' || user?.accountType === 'staff';
  const isBlockedWholesale =
    user?.accountType === 'wholesale' && user.wholesaleStatus !== 'approved';

  return (
    <NavigationContainer theme={navTheme} ref={navigationRef}>
      <PendingIntentRunner />
      <Stack.Navigator
        screenOptions={{
          // The customer screens draw their own 52px bar (see ui.tsx NavBar), so
          // the stack header only ever shows on the admin side.
          headerTitleStyle: { ...typography.heading, color: colors.text },
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {isBlockedWholesale ? (
          // PRD 4.1 — login only: browsing and ordering stay unreachable until
          // an admin approves the application.
          <Stack.Screen
            name="WholesalePending"
            component={WholesalePendingScreen}
            options={{ headerShown: false }}
          />
        ) : isStaff ? (
          <Stack.Group screenOptions={{ headerShown: false }}>
            <Stack.Screen name="AdminTabs" component={AdminTabs} />
            <Stack.Screen
              name="AdminProductForm"
              component={AdminProductFormScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen name="AdminCategories" component={AdminCategoriesScreen} />
            <Stack.Screen name="AdminOrderDetail" component={AdminOrderDetailScreen} />
            <Stack.Screen name="AdminUsers" component={AdminUsersScreen} />
            <Stack.Screen name="AdminCodSettings" component={AdminCodSettingsScreen} />
            <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
            <Stack.Screen name="Profile" component={ProfileScreen} />
            <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} />
          </Stack.Group>
        ) : (
          <Stack.Group screenOptions={{ headerShown: false }}>
            <Stack.Screen name="CustomerTabs" component={CustomerTabs} />

            {/* Sign-in lives inside the customer stack as a modal so a guest who
                backs out lands exactly where they were, still browsing. */}
            <Stack.Screen
              name="Login"
              component={LoginScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen
              name="ForgotPassword"
              component={ForgotPasswordScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen
              name="ResetOtp"
              component={ResetOtpScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen
              name="ResetPassword"
              component={ResetPasswordScreen}
              options={{ presentation: 'modal' }}
            />

            <Stack.Screen name="ProductDetail" component={ProductDetailScreen} />
            <Stack.Screen
              name="Filters"
              component={FiltersScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen name="Checkout" component={CheckoutScreen} />
            <Stack.Screen
              name="RazorpayCheckout"
              component={RazorpayCheckoutScreen}
              options={{ headerShown: true, title: 'Payment', presentation: 'modal' }}
            />
            <Stack.Screen name="OrderConfirmation" component={OrderConfirmationScreen} />
            <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
            <Stack.Screen name="Addresses" component={AddressesScreen} />
            <Stack.Screen
              name="AddressForm"
              component={AddressFormScreen}
              options={{ presentation: 'modal' }}
            />
            <Stack.Screen name="Profile" component={ProfileScreen} />
            <Stack.Screen name="DeleteAccount" component={DeleteAccountScreen} />
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
