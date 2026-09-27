import { createAsyncThunk, createSlice, isAnyOf, type PayloadAction } from '@reduxjs/toolkit';
import * as Device from 'expo-device';
import { authApi, type ReauthProof } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import {
  clearTokens,
  getRefreshToken,
  isTokenExpired,
  loadTokens,
  saveTokens,
} from '../../api/tokenStorage';
import type { Address, User } from '../../api/types';
import { googleErrorMessage, signInWithGoogle, signOutGoogle } from '../../services/googleAuth';

/**
 * PRD 8.1 authSlice — current user, phone number, account type and wholesale
 * approval status. Also owns the app-start token lifecycle from PRD 8.10.
 */

/**
 * `guest` is a browsing state, not a locked-out one: the catalogue renders for
 * guests and only account-bound actions bounce to sign-in.
 */
export type AuthStatus = 'booting' | 'guest' | 'signedIn';

/**
 * What a guest was trying to do when sign-in interrupted them. Kept
 * serialisable so it can live in the store, and replayed verbatim once the
 * session exists — a guest who tapped "Add to cart" gets that item added, not
 * a trip back to Home.
 */
export type AuthIntent =
  | { type: 'addToCart'; productId: string; quantity: number }
  | { type: 'toggleWishlist'; productId: string }
  | { type: 'openTab'; tab: 'Cart' | 'Wishlist' | 'Orders' | 'Account' }
  | { type: 'checkout' }
  /** A guest who tapped "Buy now" lands on checkout for that product, not the cart. */
  | { type: 'buyNow'; productId: string; quantity: number };

interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** Set when a gated action bounced to sign-in; replayed on success. */
  pendingIntent: AuthIntent | null;
  /** Retail or wholesale, chosen while creating an account. */
  pendingAccountType: 'retail' | 'wholesale';
  /** Wholesale details typed on the signup form, submitted with registration. */
  pendingApplication: { businessName?: string; gstNumber?: string } | null;
  loading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  status: 'booting',
  user: null,
  pendingIntent: null,
  pendingAccountType: 'retail',
  pendingApplication: null,
  loading: false,
  error: null,
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/**
 * PRD 8.10 — app start:
 *   no access token         → Home as a guest (no login wall)
 *   token present, expired  → refresh silently; on failure, fall back to guest
 *   token present, valid    → Home, already signed in, no OTP prompt
 *
 * A failed refresh no longer routes anywhere: it drops to guest, and the user
 * is only asked to sign in if they take an action that needs an account.
 */
export const bootstrapSession = createAsyncThunk<User | null>(
  'auth/bootstrap',
  async () => {
    const { accessToken, refreshToken } = await loadTokens();
    if (!accessToken || !refreshToken) return null;

    if (isTokenExpired(accessToken)) {
      try {
        const result = await authApi.refresh(refreshToken);
        await saveTokens(result.accessToken, result.refreshToken);
        return result.user;
      } catch {
        await clearTokens();
        return null;
      }
    }

    try {
      return await authApi.me();
    } catch {
      await clearTokens();
      return null;
    }
  },
);

/**
 * Email + password credentials.
 *
 * Both sign-in routes persist tokens through `saveTokens`, so they land in
 * the same session state.
 */
export const registerWithPassword = createAsyncThunk<
  User,
  { email: string; password: string; name?: string; accountType?: 'retail' | 'wholesale' },
  { rejectValue: string }
>('auth/registerWithPassword', async (input, { rejectWithValue }) => {
  try {
    const result = await authApi.register({
      ...input,
      deviceId: Device.osInternalBuildId ?? Device.modelId ?? undefined,
    });
    await saveTokens(result.accessToken, result.refreshToken);
    return result.user;
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

export const loginWithPassword = createAsyncThunk<
  User,
  { email: string; password: string },
  { rejectValue: string }
>('auth/loginWithPassword', async (input, { rejectWithValue }) => {
  try {
    const result = await authApi.login({
      ...input,
      deviceId: Device.osInternalBuildId ?? Device.modelId ?? undefined,
    });
    await saveTokens(result.accessToken, result.refreshToken);
    return result.user;
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

/**
 * Native Google sign-in, then the same token exchange and session path as a
 * password login. Resolves with `null` when the user closed the picker — that
 * is a normal choice, not an error, and leaves the state untouched.
 */
export const loginWithGoogle = createAsyncThunk<User | null, void, { rejectValue: string }>(
  'auth/loginWithGoogle',
  async (_, { rejectWithValue }) => {
    try {
      const idToken = await signInWithGoogle();
      if (!idToken) return null;
      const result = await authApi.google({
        idToken,
        deviceId: Device.osInternalBuildId ?? Device.modelId ?? undefined,
      });
      await saveTokens(result.accessToken, result.refreshToken);
      return result.user;
    } catch (error) {
      // Signed in on the device but refused by the API: forget the Google
      // account too, so the next attempt shows the picker again.
      await signOutGoogle();
      return rejectWithValue(googleErrorMessage(error));
    }
  },
);

export const requestPasswordReset = createAsyncThunk<string, string, { rejectValue: string }>(
  'auth/requestPasswordReset',
  async (email, { rejectWithValue }) => {
    try {
      const result = await authApi.forgotPassword(email);
      return result.message;
    } catch (error) {
      return rejectWithValue(messageFor(error));
    }
  },
);

export const verifyResetOtp = createAsyncThunk<
  { resetToken: string },
  { email: string; otp: string },
  { rejectValue: string }
>('auth/verifyResetOtp', async (input, { rejectWithValue }) => {
  try {
    const result = await authApi.verifyResetOtp(input);
    return { resetToken: result.resetToken };
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

export const submitPasswordReset = createAsyncThunk<
  string,
  { token: string; password: string },
  { rejectValue: string }
>('auth/submitPasswordReset', async (input, { rejectWithValue }) => {
  try {
    const result = await authApi.resetPassword(input);
    return result.message;
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

export const refreshProfile = createAsyncThunk<User>('auth/refreshProfile', async () =>
  authApi.me(),
);

/** PRD 8.10 — logout invalidates the refresh token server-side, not just on-device. */
export const signOut = createAsyncThunk('auth/signOut', async () => {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    await authApi.logout(refreshToken).catch(() => undefined);
  }
  await clearTokens();
  // So the account picker appears again next time; never blocks sign-out.
  await signOutGoogle();
});

export const applyForWholesale = createAsyncThunk<
  User,
  { businessName?: string; gstNumber?: string },
  { rejectValue: string }
>('auth/applyForWholesale', async (input, { rejectWithValue }) => {
  try {
    return await authApi.applyForWholesale(input);
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

export const updateProfile = createAsyncThunk<User, { name?: string }>(
  'auth/updateProfile',
  async (input) => authApi.updateProfile(input),
);

/**
 * Step 2 of verify/change email. A change revokes every other session, so the
 * response carries a fresh token pair for this device — stored here the same
 * way a sign-in stores it.
 */
export const confirmEmailCode = createAsyncThunk<
  User,
  { otp: string } & ReauthProof,
  { rejectValue: string }
>(
  'auth/confirmEmailCode',
  async ({ otp, ...proof }, { rejectWithValue }) => {
    try {
      const result = await authApi.confirmEmailCode({
        otp,
        deviceId: Device.osInternalBuildId ?? Device.modelId ?? undefined,
        ...proof,
      });
      await saveTokens(result.accessToken, result.refreshToken);
      return result.user;
    } catch (error) {
      return rejectWithValue(messageFor(error));
    }
  },
);

/* ── Addresses (PRD 4.3) ────────────────────────────────────────────────── */

export const fetchAddresses = createAsyncThunk<Address[]>('auth/fetchAddresses', async () =>
  authApi.listAddresses(),
);

export const saveAddress = createAsyncThunk<
  Address[],
  { id?: string; input: Omit<Address, 'id' | 'isDefault'> & { isDefault?: boolean } },
  { rejectValue: string }
>('auth/saveAddress', async ({ id, input }, { rejectWithValue }) => {
  try {
    return id ? await authApi.updateAddress(id, input) : await authApi.addAddress(input);
  } catch (error) {
    return rejectWithValue(messageFor(error));
  }
});

export const deleteAddress = createAsyncThunk<Address[], string>(
  'auth/deleteAddress',
  async (id) => authApi.deleteAddress(id),
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    /**
     * Called by the Axios interceptor when the refresh token is dead. Drops to
     * guest rather than to a login wall — the catalogue keeps working, and the
     * next gated action is what prompts a sign-in.
     */
    sessionExpired(state) {
      state.status = 'guest';
      state.user = null;
      state.error = 'Your session expired. Please sign in again.';
    },
    /** Records what a guest was attempting before being sent to sign-in. */
    setPendingIntent(state, action: PayloadAction<AuthIntent | null>) {
      state.pendingIntent = action.payload;
    },
    clearPendingIntent(state) {
      state.pendingIntent = null;
    },
    clearError(state) {
      state.error = null;
    },
    setPendingAccountType(state, action: PayloadAction<'retail' | 'wholesale'>) {
      state.pendingAccountType = action.payload;
    },
    setPendingApplication(
      state,
      action: PayloadAction<{ businessName?: string; gstNumber?: string } | null>,
    ) {
      state.pendingApplication = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(bootstrapSession.pending, (state) => {
        state.status = 'booting';
      })
      .addCase(bootstrapSession.fulfilled, (state, action) => {
        state.user = action.payload;
        state.status = action.payload ? 'signedIn' : 'guest';
      })
      .addCase(bootstrapSession.rejected, (state) => {
        state.status = 'guest';
        state.user = null;
      })

      .addCase(refreshProfile.fulfilled, (state, action) => {
        state.user = action.payload;
      })

      .addCase(signOut.fulfilled, (state) => {
        state.status = 'guest';
        state.pendingIntent = null;
        state.user = null;
          state.error = null;
      })

      // Google has its own spinner on its own button, so it leaves the shared
      // `loading` flag (which drives the email button) alone.
      .addCase(loginWithGoogle.pending, (state) => {
        state.error = null;
      })
      .addCase(loginWithGoogle.fulfilled, (state, action) => {
        if (!action.payload) return;
        state.user = action.payload;
        state.status = 'signedIn';
        state.pendingApplication = null;
      })
      .addCase(loginWithGoogle.rejected, (state, action) => {
        state.error = action.payload ?? "Couldn't sign you in with Google. Please try again.";
      })

      .addCase(applyForWholesale.fulfilled, (state, action) => {
        state.user = action.payload;
      })
      .addCase(applyForWholesale.rejected, (state, action) => {
        state.error = action.payload ?? 'Could not submit your application.';
      })

      .addCase(updateProfile.fulfilled, (state, action) => {
        state.user = action.payload;
      })
      .addCase(confirmEmailCode.fulfilled, (state, action) => {
        state.user = action.payload;
      })

      .addCase(fetchAddresses.fulfilled, (state, action) => {
        if (state.user) state.user.addresses = action.payload;
      })
      .addCase(saveAddress.fulfilled, (state, action) => {
        if (state.user) state.user.addresses = action.payload;
      })
      .addCase(saveAddress.rejected, (state, action) => {
        state.error = action.payload ?? 'Could not save the address.';
      })
      .addCase(deleteAddress.fulfilled, (state, action) => {
        if (state.user) state.user.addresses = action.payload;
      })

      // Registering and signing in land in the same signed-in state, so the
      // navigator does not need to know which of the two got the user there.
      .addMatcher(
        isAnyOf(registerWithPassword.pending, loginWithPassword.pending),
        (state) => {
          state.loading = true;
          state.error = null;
        },
      )
      .addMatcher(
        isAnyOf(
          registerWithPassword.fulfilled,
          loginWithPassword.fulfilled,
        ),
        (state, action) => {
          state.loading = false;
          state.user = action.payload as User;
          state.status = 'signedIn';
          state.pendingApplication = null;
        },
      )
      .addMatcher(
        isAnyOf(
          registerWithPassword.rejected,
          loginWithPassword.rejected,
        ),
        (state, action) => {
          state.loading = false;
          state.error = (action.payload as string) ?? 'Could not sign you in.';
        },
      )

      // Reset requests never change session state — only loading and error.
      .addMatcher(
        isAnyOf(
          requestPasswordReset.pending,
          verifyResetOtp.pending,
          submitPasswordReset.pending,
        ),
        (state) => {
          state.loading = true;
          state.error = null;
        },
      )
      .addMatcher(
        isAnyOf(
          requestPasswordReset.fulfilled,
          verifyResetOtp.fulfilled,
          submitPasswordReset.fulfilled,
        ),
        (state) => {
          state.loading = false;
        },
      )
      .addMatcher(
        isAnyOf(
          requestPasswordReset.rejected,
          verifyResetOtp.rejected,
          submitPasswordReset.rejected,
        ),
        (state, action) => {
          state.loading = false;
          state.error = (action.payload as string) ?? 'Something went wrong.';
        },
      );
  },
});

export const {
  sessionExpired,
  setPendingIntent,
  clearPendingIntent,
  clearError,
  setPendingAccountType,
  setPendingApplication,
} = authSlice.actions;
export default authSlice.reducer;
