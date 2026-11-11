export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type IdFactory = () => string;

export const randomId: IdFactory = () => crypto.randomUUID();
