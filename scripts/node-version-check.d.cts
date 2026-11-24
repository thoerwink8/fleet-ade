export function checkNodeVersion(version?: string, rootDir?: string): string | undefined;
export function assertNodeVersion(): void;
export function nodeVersionError(version: string, range: string): string;
export function satisfiesRange(version: string, range: string): boolean;
