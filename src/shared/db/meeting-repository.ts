import { promisifyRequest, withTransaction } from './idb';
import { MEETING_INDEXES, STORES, type MeetingRecord } from './schema';

export interface MeetingRepository {
  /** Inserts the meeting if it does not exist yet (idempotent). Returns the stored record. */
  create(meeting: MeetingRecord): Promise<MeetingRecord>;
  get(id: string): Promise<MeetingRecord | null>;
  /** Applies `change` to the stored record atomically. Returns null if missing. */
  update(id: string, change: (current: MeetingRecord) => MeetingRecord): Promise<MeetingRecord | null>;
  /** Newest first. */
  listRecent(limit: number): Promise<MeetingRecord[]>;
  listActive(): Promise<MeetingRecord[]>;
  delete(id: string): Promise<void>;
}

export class IndexedDbMeetingRepository implements MeetingRepository {
  constructor(private readonly db: () => Promise<IDBDatabase>) {}

  async create(meeting: MeetingRecord): Promise<MeetingRecord> {
    const db = await this.db();
    return withTransaction(db, STORES.meetings, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.meetings);
      const existing = (await promisifyRequest(store.get(meeting.id))) as MeetingRecord | undefined;
      if (existing) return existing;
      await promisifyRequest(store.add(meeting));
      return meeting;
    });
  }

  async get(id: string): Promise<MeetingRecord | null> {
    const db = await this.db();
    return withTransaction(db, STORES.meetings, 'readonly', async (tx) => {
      const found = (await promisifyRequest(tx.objectStore(STORES.meetings).get(id))) as MeetingRecord | undefined;
      return found ?? null;
    });
  }

  async update(id: string, change: (current: MeetingRecord) => MeetingRecord): Promise<MeetingRecord | null> {
    const db = await this.db();
    return withTransaction(db, STORES.meetings, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORES.meetings);
      const current = (await promisifyRequest(store.get(id))) as MeetingRecord | undefined;
      if (!current) return null;
      const next = change(current);
      await promisifyRequest(store.put(next));
      return next;
    });
  }

  async listRecent(limit: number): Promise<MeetingRecord[]> {
    const db = await this.db();
    return withTransaction(db, STORES.meetings, 'readonly', async (tx) => {
      const index = tx.objectStore(STORES.meetings).index(MEETING_INDEXES.startedAt);
      const out: MeetingRecord[] = [];
      await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(null, 'prev');
        request.onerror = () => reject(request.error ?? new Error('cursor failed'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= limit) return resolve();
          out.push(cursor.value as MeetingRecord);
          cursor.continue();
        };
      });
      return out;
    });
  }

  async listActive(): Promise<MeetingRecord[]> {
    const db = await this.db();
    return withTransaction(db, STORES.meetings, 'readonly', async (tx) => {
      const index = tx.objectStore(STORES.meetings).index(MEETING_INDEXES.status);
      return (await promisifyRequest(index.getAll('active'))) as MeetingRecord[];
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await withTransaction(db, STORES.meetings, 'readwrite', async (tx) => {
      await promisifyRequest(tx.objectStore(STORES.meetings).delete(id));
    });
  }
}
