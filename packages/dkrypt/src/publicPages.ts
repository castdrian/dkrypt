import { listPlans } from '#billing.js';

const contactAddress = 'contact<span>@</span>dylib.dev';

const navigation = `
  <nav aria-label="Public pages">
    <a href="/pricing">Pricing</a>
    <a href="/request">Check an app</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/refund-policy">Refund policy</a>
    <a href="/contact">Contact</a>
    <a href="/status">Status</a>
  </nav>
`;

const footer = `
  <footer>
    ${navigation}
    <p>${contactAddress}</p>
  </footer>
`;

const pageContent: Record<string, string> = {
  '/': `
    <main>
      <h1>dkrypt</h1>
      <p>dkrypt is a subscription service for authorized iOS application decryption workflows, request tracking, downloadable results, and optional API access.</p>
      <p>Free accounts include 3 new decrypts per rolling 30 days, read-only IPA Library metadata, and a 30-minute download window for each result. Paid plans include persistent IPA downloads and higher decrypt allowances.</p>
      <p><a href="/request">Check an app before signing up</a>, <a href="/pricing">view pricing</a>, or <a href="/#sign-in">sign in</a>.</p>
    </main>
  `,
  '/request': `
    <main>
      <h1>Check an app</h1>
      <p>See whether dkrypt can resolve an App Store app or public TestFlight link before creating an account.</p>
      <p>After signing in, you can review the app and choose whether to submit a decrypt request or TestFlight link.</p>
    </main>
  `,
  '/terms': `
    <main>
      <article>
        <h1>Terms of service</h1>
        <p>Last updated: 27 October 2026</p>
        <p>These Terms of Service govern access to and use of dkrypt. By creating an account, accessing the service, or continuing to use it, you agree to these terms.</p>
        <h2>The service</h2>
        <p>dkrypt provides tools for managing authorized iOS application decryption workflows, including request queues, status tracking, downloadable results, and optional API access. Available features depend on account permissions and subscription plan.</p>
        <h2>Accounts and acceptable use</h2>
        <p>You must provide accurate account information, protect your account and API keys, and use dkrypt only for lawful purposes involving software and data you have the rights and authorization to process. You must not infringe third-party rights, distribute malware, commit fraud, bypass security controls, overload the service, or enable unauthorized access.</p>
        <h2>Subscriptions, payments, and taxes</h2>
        <p>Stripe plans renew monthly until canceled and show applicable card or bank taxes in Stripe checkout. Crypto access is granted for 30 days after a verified NOWPayments invoice and requires another payment to renew. Stripe Managed Payments handles eligible card or bank purchases as merchant of record. Crypto purchases are outside Stripe Managed Payments, do not use Stripe, and do not require a billing address in the configured checkout. NOWPayments sends funds to the merchant payout wallet, while dkrypt does not store full card details, crypto custody, or wallet private keys.</p>
        <h2>Cancellation and refunds</h2>
        <p>Stripe subscriptions can be canceled through the billing portal and normally end at the current period. Crypto renewal is stopped immediately from dkrypt. Refunds follow the provider-specific refund process, the <a href="/refund-policy">Refund Policy</a>, and mandatory consumer law.</p>
        <h2>Free plan and result retention</h2>
        <p>Free accounts receive up to 3 new decrypts in each rolling 30-day period. A successful result is available for download for 30 minutes, after which the file, download access, and associated job history are deleted. Shared IPA Library files are not included in the Free plan; Free accounts can browse app and build metadata only.</p>
        <h2>Service availability and liability</h2>
        <p>The service is provided on an as-available basis and may change or experience interruptions. To the fullest extent permitted by law, implied warranties are disclaimed and aggregate liability will not exceed the amount paid for dkrypt during the six months before the event giving rise to the claim.</p>
        <h2>Contact</h2>
        <p>Questions about these terms may be sent to ${contactAddress}.</p>
      </article>
    </main>
  `,
  '/privacy': `
    <main>
      <article>
        <h1>Privacy notice</h1>
        <p>Last updated: 28 October 2026</p>
        <p>This notice explains how dkrypt handles personal data. Privacy requests may be sent to ${contactAddress}.</p>
        <h2>Data collected</h2>
        <p>dkrypt processes identity-provider account details, billing and subscription identifiers, service requests and results, API-key metadata, preferences, support communications, session identifiers, timestamps, request records, and security audit data. Stripe processes card or bank payment details, and NOWPayments processes crypto invoice and payment details. dkrypt does not store full card details or wallet private keys.</p>
        <h2>How data is used</h2>
        <p>Data is used to authenticate users, provide requested features, administer subscriptions and entitlements, operate queues and notifications, provide support, secure the service, prevent abuse, diagnose faults, and meet legal obligations. Free decrypt results and their job history are retained for up to 30 minutes; minimal completion timestamps are retained for 30 days to enforce the Free allowance.</p>
        <p>To limit automated account creation and Free-tier abuse, dkrypt stores keyed hashes of the exact request IP and its coarse IPv4 /24 or IPv6 /56 network prefix for up to 30 days; it does not store the full IP in the abuse counters. Signup records also contain a keyed email hash and a random first-party browser signal that expires after at most seven days. When Cloudflare Turnstile supplies an ephemeral identifier, dkrypt stores its keyed hash separately for up to seven days. These signals are not hardware IDs, and dkrypt does not build a persistent hardware or browser fingerprint.</p>
        <h2>Sharing and processors</h2>
        <p>Data is shared only as needed with GitHub or Discord for authentication, Cloudflare for mandatory new-account Turnstile verification, ipapi.is or legacy IPinfo when an operator configures IP reputation checks, Stripe for card or bank payment and subscription administration, NOWPayments for crypto invoices and payment status, infrastructure providers, Apple services needed to fulfill authorized requests, and authorities where required by law. Turnstile receives the browser challenge and connection IP for verification. When IP reputation checks are enabled, dkrypt sends request IPs for signup checks and Free-tier decrypts without a cached classification to the configured provider. It stores only VPN, proxy, Tor, relay, residential-proxy, hosting, anonymous-network, and abuse flags against the keyed exact-address hash for up to 12 hours. Personal data is not sold or used for third-party behavioral advertising.</p>
        <h2>Cookies, retention, and security</h2>
        <p>dkrypt uses an essential session cookie and browser storage for interface preferences. It also uses a signed, HttpOnly abuse-prevention cookie for up to seven days. When signup verification is enabled, it sets a signed, HttpOnly challenge cookie for up to 10 minutes. Data is retained only as long as needed for service, legal, accounting, dispute, security, and backup obligations. Technical and organizational safeguards include access controls, signed sessions, restricted secrets, and encrypted transport.</p>
        <h2>Your rights</h2>
        <p>Depending on location, users may have rights to access, correct, delete, restrict, object to, or obtain a portable copy of personal data, withdraw consent, and complain to a supervisory authority. Requests may be sent to ${contactAddress}.</p>
      </article>
    </main>
  `,
  '/refund-policy': `
    <main>
      <article>
        <h1>Refund policy</h1>
        <p>Last updated: 23 July 2026</p>
        <p>Stripe Managed Payments acts as merchant of record for eligible card or bank purchases and handles checkout, receipts, subscription billing, and transaction support. NOWPayments processes crypto invoices and payment status; crypto is priced in EUR and paid to the configured merchant wallet. dkrypt handles product-level support and any refund request under this policy, the provider rules, and applicable law.</p>
        <h2>Refund period</h2>
        <p>You may request a refund within 14 days of a transaction. Requests are assessed under this policy and applicable law. Nothing in this policy limits mandatory consumer rights.</p>
        <h2>How to request a refund</h2>
        <p>For Stripe purchases, open the dkrypt billing portal or contact ${contactAddress}. For crypto purchases, include the purchase email, NOWPayments invoice or payment identifier, wallet address, and enough transaction information to locate the payment. Do not send full card details or private keys.</p>
        <h2>Technical problems and cancellations</h2>
        <p>For persistent technical defects, contact ${contactAddress}. Stripe subscriptions can be canceled through the billing portal or receipt link. Crypto renewal can be stopped from dkrypt immediately. Cancellation does not automatically refund a completed payment.</p>
        <h2>Processing</h2>
        <p>Approved refunds are generally returned to the original payment method. Processing times vary, and paid access may end when a transaction is refunded.</p>
      </article>
    </main>
  `,
  '/contact': `
    <main>
      <h1>Contact dkrypt</h1>
      <p>For product, account, service, security, or privacy questions, email ${contactAddress}.</p>
      <p>For billing and refund questions, open the dkrypt billing portal or email ${contactAddress} with the purchase email and relevant receipt details.</p>
    </main>
  `,
  '/status': `
    <main>
      <h1>dkrypt service status</h1>
      <p>View the current service and device automation status.</p>
      <p><a href="/status">Open the live status page</a> or <a href="/#sign-in">sign in</a> to manage your account.</p>
    </main>
  `,
};

function pricingContent(): string {
  const plans = listPlans();
  const sections = plans.map((plan) => {
    const amount = Number.isInteger(plan.amount) ? String(plan.amount) : plan.amount.toFixed(2);
    const allowance = plan.dailyDecryptLimit === undefined ? 'Unlimited new decrypts' : `${plan.dailyDecryptLimit} new decrypts per rolling 24 hours`;
    const api = plan.api ? ` API access${plan.apiRatePerMinute ? ` at ${plan.apiRatePerMinute} requests per minute` : ''}.` : '';
    const priority = plan.priority > 0 ? ' Higher queue priority.' : '';
    return `<h2>${plan.name} — €${amount}/month</h2><p>IPA Library access. ${allowance}.${api}${priority}</p>`;
  }).join('');
  return `<main><h1>dkrypt pricing</h1><p>Stripe renews monthly. Crypto access lasts 30 days after a verified NOWPayments payment, where the selected asset supports the plan price.</p><section>${sections}</section><p><a href="/#sign-in">Sign in to subscribe</a>.</p></main>`;
}

export function renderPublicPage(indexHtml: string, pathname: string): string {
  const content = pathname === '/pricing' ? pricingContent() : pageContent[pathname] ?? pageContent['/'];
  const fallback = `
    <div data-app-fallback style="max-width: 880px; margin: 0 auto; padding: 48px 24px; font-family: system-ui, sans-serif; line-height: 1.6;">
      <header><a href="/"><strong>dkrypt</strong></a>${navigation}</header>
      ${content}
      ${footer}
    </div>
  `;
  return indexHtml.replace('<div id="app-root"></div>', `<div id="app-root">${fallback}</div>`);
}
