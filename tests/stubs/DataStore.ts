/* In-memory stand-in for Vencord's IndexedDB-backed DataStore. */

const db = new Map<string, unknown>();

export async function get<T>(key: string): Promise<T | undefined> {
    return db.get(key) as T | undefined;
}

export async function set(key: string, value: unknown): Promise<void> {
    db.set(key, value);
}

export async function del(key: string): Promise<void> {
    db.delete(key);
}

export function _reset(): void {
    db.clear();
}
