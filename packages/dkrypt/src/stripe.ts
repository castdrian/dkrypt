import Stripe from 'stripe';
import { config, isValidStripeSecretKeyRotation } from '#config.js';
import { log } from '#logger.js';

let cachedClients: {
  currentKey: string;
  previousKey: string;
  current?: Stripe;
  previous?: Stripe;
} | undefined;

function clientsForConfiguredKeys() {
  if (!cachedClients || cachedClients.currentKey !== config.stripeSecretKey || cachedClients.previousKey !== config.stripeSecretKeyPrevious) {
    cachedClients = { currentKey: config.stripeSecretKey, previousKey: config.stripeSecretKeyPrevious };
  }
  return cachedClients;
}

function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: '2026-08-26.dahlia' as Stripe.LatestApiVersion });
}

export function getStripe(): Stripe {
  if (!config.stripeSecretKey) throw new Error('Stripe secret key is not configured');
  const clients = clientsForConfiguredKeys();
  clients.current ??= createStripe(config.stripeSecretKey);
  return clients.current;
}

function getPreviousStripe(): Stripe {
  const clients = clientsForConfiguredKeys();
  clients.previous ??= createStripe(config.stripeSecretKeyPrevious);
  return clients.previous;
}

export async function stripeRequest<T>(request: (client: Stripe) => Promise<T>): Promise<T> {
  try {
    return await request(getStripe());
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeAuthenticationError)
      || error.statusCode !== 401
      || !isValidStripeSecretKeyRotation(config.stripeSecretKey, config.stripeSecretKeyPrevious)) {
      throw error;
    }
    log.warn('Stripe API key rotation fallback used after current-key authentication rejection');
    return request(getPreviousStripe());
  }
}

export async function constructStripeWebhookEvent(rawBody: string | Buffer, signature: string): Promise<Stripe.Event> {
  let lastError: unknown;
  for (const secret of [config.stripeWebhookSecret, config.stripeWebhookSecretPrevious].filter(Boolean)) {
    try {
      return await getStripe().webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Stripe webhook signature verification failed');
}
