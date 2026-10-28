export function compareCodePoints(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function sortCodePoints(values: ReadonlyArray<string>): ReadonlyArray<string> {
    return [...values].sort(compareCodePoints);
}

export function portableLocator(value: string): string {
    return value.replaceAll('\\', '/');
}
