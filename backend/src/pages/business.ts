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
  /** The legal entity: a proprietorship. */
  legalName: 'Manisha Fashions (proprietor: Uma Maheswari)',
  proprietor: 'Uma Maheswari',
  address:
    'B-39, Gaffour Nagar Extn, Sree Nivas Garden, Manjalai Road, Kakaayanthope, Ariankuppam, Puducherry 605007',
  /** The privacy contact given in the client's privacy policy. */
  email: 'manishafashion618@gmail.com',
  /** Phone and WhatsApp are the same number. */
  phone: '+91 80561 14501',
  whatsappUrl: 'https://wa.me/918056114501',
  /** Courts named in the terms. */
  jurisdictionCity: 'Puducherry',
  /** Grievance officer — named contact required by the IT Rules, 2021. */
  grievanceOfficer: '[CONFIRM WITH CLIENT: name of grievance officer]',
  /** "Last updated" on each page: move a page's date when its content changes. */
  privacyPolicyDate: '2 October 2026',
  termsDate: '2 October 2026',
} as const;
