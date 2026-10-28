import type Stripe from 'stripe';

export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.upcoming',
  'charge.refunded',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];
