import { expect, test } from 'bun:test';
import { getFailureGuidance } from './failureGuidance.js';

test('authorization failures request device action instead of another automatic retry', () => {
  expect(getFailureGuidance('App Store authorization requires action on the device (MZCommerce.ConfirmPaymentSheet.Auth)')).toMatchObject({
    category: 'Authorization required', retryRecommended: false,
  });
});

test('offers a concrete recovery action for bridge failures', () => {
  expect(getFailureGuidance('autoinstall bridge request timed out')).toEqual({
    category: 'Timed out',
    title: 'The operation timed out',
    action: 'Check the job timeline and bridge diagnostics before retrying.',
    retryRecommended: true,
  });
});

test('explains queue deadline failures using the blocker recorded on the job', () => {
  expect(getFailureGuidance('job deadline exceeded while waiting in the queue: Waiting for a compatible device')).toEqual({
    category: 'Queue wait expired',
    title: 'The job waited too long to start',
    action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
    retryRecommended: true,
  });
});

test('does not claim a blocker is available when the queue deadline has no blocker detail', () => {
  expect(getFailureGuidance('job deadline exceeded while waiting in the queue')).toEqual({
    category: 'Queue wait expired',
    title: 'The job waited too long to start',
    action: 'Check device readiness and queue status, then retry.',
    retryRecommended: true,
  });
});

test('uses structured queue blocker data when the free-text error is generic', () => {
  expect(getFailureGuidance('job deadline exceeded while waiting in the queue', 'Waiting for a compatible device')).toMatchObject({
    category: 'Queue wait expired',
    action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
  });
});
