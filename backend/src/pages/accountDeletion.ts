import { page, escapeHtml } from './layout';

export type DeletionNotice =
  | 'code-sent'
  | 'wrong-code'
  | 'locked'
  | 'confirm-required'
  | 'open-order'
  | 'admin'
  | 'rate-limited';

export type DeletionView =
  | { step: 'email'; notice?: DeletionNotice }
  | { step: 'code'; email: string; notice?: DeletionNotice }
  | { step: 'deleted' };

const NOTICES: Record<DeletionNotice, { tone: 'info' | 'error'; text: string }> = {
  'code-sent': {
    tone: 'info',
    text: 'If an account exists for that email, we\'ve sent it a 6-digit code. It expires in 10 minutes.',
  },
  'wrong-code': {
    tone: 'error',
    text: 'That code is wrong or has expired. Check it, or go back and request a new one.',
  },
  locked: {
    tone: 'error',
    text: 'Too many wrong codes. Please wait 10 minutes and try again.',
  },
  'confirm-required': {
    tone: 'error',
    text: 'Please tick the box to confirm you want to delete your account.',
  },
  'open-order': {
    tone: 'error',
    text: 'You can\'t delete your account while a delivery is on its way or a refund is due to you. Once the delivery arrives or the refund is paid, you can delete it.',
  },
  admin: {
    tone: 'error',
    text: 'Staff accounts can\'t be deleted here. Please contact the shop owner.',
  },
  'rate-limited': {
    tone: 'error',
    text: 'Too many requests. Please wait a few minutes and try again.',
  },
};

function renderNotice(notice?: DeletionNotice): string {
  if (!notice) return '';
  const { tone, text } = NOTICES[notice];
  const role = tone === 'error' ? 'alert' : 'status';
  return `<p class="notice notice-${tone}" role="${role}">${escapeHtml(text)}</p>`;
}

const INTRO = `
  <p>You can delete your account here or in the app (Account → Delete account). Enter your account email and we'll send a 6-digit code to confirm it's you. This works for accounts created with Google too.</p>
`;

const DETAILS = `
  <h2>What gets deleted</h2>
  <ul>
    <li>Your account: email, name, profile photo, password, Google sign-in link, phone number and saved addresses.</li>
    <li>Wholesale business details (business name and GSTIN).</li>
    <li>Your wishlist and cart.</li>
    <li>All your signed-in sessions. You'll be signed out on every device.</li>
  </ul>

  <h2>What we keep</h2>
  <ul>
    <li>Past orders, kept for 8 years for GST and income-tax records. Your name, phone number and street address are removed. Only the city, state and PIN code remain.</li>
    <li>Your reviews, shown as "Customer" with your name removed.</li>
  </ul>

  <h2>When you can't delete yet</h2>
  <ul>
    <li>While a delivery is still on its way.</li>
    <li>While a refund is still due to you.</li>
  </ul>
  <p>Once the delivery arrives or the refund is paid, you can delete your account.</p>

  <p><strong>Deletion is permanent and can't be undone.</strong></p>
  <p>Questions: <a href="mailto:manishafashion618@gmail.com">manishafashion618@gmail.com</a></p>
`;

function emailStep(notice?: DeletionNotice): string {
  return `
    ${INTRO}
    ${renderNotice(notice)}
    <form method="post" action="/account-deletion/code" class="deletion-form">
      <label for="email">Account email</label>
      <input id="email" name="email" type="email" autocomplete="email" required maxlength="254">
      <button type="submit">Send code</button>
    </form>
    ${DETAILS}
  `;
}

function codeStep(email: string, notice?: DeletionNotice): string {
  const safeEmail = escapeHtml(email);
  return `
    ${renderNotice(notice)}
    <p>Enter the 6-digit code sent to <strong>${safeEmail}</strong>.</p>
    <form method="post" action="/account-deletion/confirm" class="deletion-form">
      <input type="hidden" name="email" value="${safeEmail}">
      <label for="code">6-digit code</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
             pattern="[0-9]{6}" maxlength="6" required>
      <label class="checkbox">
        <input type="checkbox" name="confirm" value="yes" required>
        I understand my account will be permanently deleted.
      </label>
      <button type="submit" class="danger">Delete my account</button>
    </form>
    <p><a href="/account-deletion">Use a different email or request a new code</a></p>
    ${DETAILS}
  `;
}

function deletedStep(): string {
  return `
    <p role="status">Your account has been deleted and you've been signed out on every device.</p>
    <p>Thank you for shopping with Manisha Fashions.</p>
  `;
}

export function renderAccountDeletion(view: DeletionView): string {
  let body: string;
  switch (view.step) {
    case 'email':
      body = emailStep(view.notice);
      break;
    case 'code':
      body = codeStep(view.email, view.notice);
      break;
    case 'deleted':
      body = deletedStep();
      break;
  }
  return page('Delete your Manisha Fashions account', body);
}