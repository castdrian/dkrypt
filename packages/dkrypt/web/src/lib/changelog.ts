export interface ChangelogEntry {
  date: string;
  title: string;
  description: string;
  isMeta?: boolean;
  link?: { tab: string; subtab?: string };
}

export const CHANGELOG: ChangelogEntry[] = [
  ...GENERATED_CHANGELOG,
  {
    date: '2026-08-26',
    title: 'Authenticated IPA artifacts',
    description: 'Completed decrypts stay in the IPA Library with stable authenticated downloads until the artifact is removed or evicted.',
    link: { tab: 'home' },
  },
  {
    date: '2026-07-26',
    title: 'Liquid glass design',
    description:
      'The dashboard has a new visual system, cleaner navigation, a readable activity table, and a full-height log console while the status panel remains in place.',
    link: { tab: 'home' },
  },
  {
    date: '2026-07-25',
    title: 'Dashboard polish pass',
    description:
      'Maintenance mode now confirms before pausing everything and moved to Settings → Devices with a proper banner, rate limits are visible before you hit them, accent color contrast is fixed across every theme, and a handful of other UX cleanups.',
    link: { tab: 'settings', subtab: 'devices' },
  },
  {
    date: '2026-07-24',
    title: 'On-device App Store installs',
    description:
      "Decrypts now install through the device's own signed-in App Store via autoinstall - dkrypt no longer handles Apple authentication.",
  },
  {
    date: '2026-07-24',
    title: 'Maintenance mode',
    description: "Decrypts and the API pause automatically when the primary device isn't in a usable state, with a manual override in Settings.",
    link: { tab: 'settings', subtab: 'devices' },
  },
  {
    date: '2026-07-23',
    title: 'Paid plans',
    description: 'Subscribe to unlock TestFlight scoping, higher key limits, and priority queueing.',
    link: { tab: 'billing' },
  },
  {
    date: '2026-07-23',
    title: 'Discord role perks',
    description: 'Link Discord roles to dashboard permissions, across more than one guild.',
    link: { tab: 'settings', subtab: 'roles' },
  },
  {
    date: '2026-07-23',
    title: 'Session management',
    description: 'See every active session signed in as you, and revoke them individually or all at once.',
  },
  {
    date: '2026-07-23',
    title: 'Scheduled backups',
    description: 'Automatic backup snapshots on a schedule, with history and one-click restore.',
    link: { tab: 'settings', subtab: 'backup' },
  },
  {
    date: '2026-07-23',
    title: 'Push notifications',
    description: 'Get notified in the browser when your decrypts finish or a system alert fires - even with the tab closed.',
  },
  {
    date: '2026-07-18',
    title: 'Role-based permissions',
    description: 'Discord-style bitfield roles replace the old boolean permission flags, with much finer-grained control.',
    link: { tab: 'settings', subtab: 'roles' },
  },
  {
    date: '2026-07-18',
    title: 'Multi-device pools',
    description: 'Register more than one iDevice and spread App Store decrypts across the whole pool.',
    link: { tab: 'settings', subtab: 'devices' },
  },
  {
    date: '2026-07-18',
    title: 'Command palette',
    description: 'Press Cmd/Ctrl+K to jump anywhere or run an action instantly, from any tab.',
  },
];
import { GENERATED_CHANGELOG } from '#lib/generatedChangelog';
