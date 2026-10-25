export function isBundleIdAllowed(scope: string[] | undefined, bundleId: string): boolean {
  return !scope || scope.length === 0 || scope.includes(bundleId);
}
