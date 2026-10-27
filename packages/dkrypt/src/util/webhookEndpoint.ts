import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = parts;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || (second === 88 && third === 99) || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const firstGroup = Number.parseInt(address.split(':')[0] || '0', 16);
  if (firstGroup < 0x2000 || firstGroup > 0x3fff) return false;
  const value = address.toLowerCase();
  if (value.startsWith('2001:0:') || value.startsWith('2001:2:') || value.startsWith('2001:db8:') || value.startsWith('2001:10:') || value.startsWith('2001:20:') || value.startsWith('2002:') || value.startsWith('3fff:')) return false;
  return true;
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isPublicIpv4(address) : version === 6 ? isPublicIpv6(address) : false;
}

export async function validatePublicWebhookEndpoint(input: string): Promise<{ url: string; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid HTTPS webhook URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Webhook tests require an HTTPS URL on the standard port');
  }
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.test')) {
    throw new Error('Webhook tests cannot target local or reserved network names');
  }
  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resolved = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Webhook hostname lookup timed out')), 5_000); }),
      ]);
      addresses = resolved.map((entry) => entry.address);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('Webhook tests can only target publicly reachable addresses');
  }
  url.hash = '';
  return { url: url.toString(), addresses: [...new Set(addresses)] };
}
