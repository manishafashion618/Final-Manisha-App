/**
 * The business details shown on the public pages (privacy policy, terms,
 * account deletion). One place, so the client confirms them once.
 *
 * Every value marked [CONFIRM WITH CLIENT] is a placeholder that appears on
 * the live pages until it is replaced. Google Play reviewers read the privacy
 * policy: it must name the real business and a contact that answers.
 */
export const BUSINESS = {
  /** Trading name, as customers know it. */
  brand: 'Manisha Fashions',
  /** The registered legal entity (proprietorship, LLP, Pvt Ltd…). */
  legalName: 'Manisha Fashions [CONFIRM WITH CLIENT: registered legal name]',
  address: '[CONFIRM WITH CLIENT: registered business address, city, state, PIN]',
  /** The privacy contact given in the client's privacy policy. */
  email: 'manishafashion618@gmail.com',
  phone: '[CONFIRM WITH CLIENT: support phone number]',
  /** Grievance officer — named contact required by the IT Rules, 2021. */
  grievanceOfficer: '[CONFIRM WITH CLIENT: name of grievance officer]',
  /** "Last updated" on each page: move a page's date when its content changes. */
  privacyPolicyDate: '2 October 2026',
  termsDate: '29 September 2026',
} as const;
