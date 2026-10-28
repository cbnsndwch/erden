// The registry origin rule, with no imports: `@erden/contracts/registry-origin` exports this module alone, so the
// capability-closed authorization core can use it without loading the rest of the contracts.

export function isRegistryOrigin(value: string): boolean {
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname.length > 0 &&
            parsed.username.length === 0 &&
            parsed.password.length === 0 &&
            parsed.pathname === '/' &&
            parsed.search.length === 0 &&
            parsed.hash.length === 0 &&
            parsed.origin !== 'null'
        );
    } catch {
        return false;
    }
}

export function normalizeRegistryOrigin(value: string): string {
    if (!isRegistryOrigin(value)) {
        throw new TypeError(`Not an Erden registry origin: ${value}`);
    }
    return new URL(value).origin;
}
