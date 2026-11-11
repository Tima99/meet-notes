// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectLayoutDiagnostics } from '../src/content/meet/layout-diagnostics';
import { FakeMeet } from './fixtures/fake-meet';

describe('collectLayoutDiagnostics', () => {
  it('describes the layout without leaking caption text or names', () => {
    document.body.innerHTML = '';
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    meet.addBlock('Amit Kumar', 'Secret caption text');
    const report = collectLayoutDiagnostics(document, region);
    expect(report).toContain('HAS-CAPTIONS');
    expect(report).toContain('has-tiles');
    expect(report).not.toContain('Secret caption text');
    expect(report).not.toContain('Amit Kumar');
  });

  it('says so when captions are off', () => {
    expect(collectLayoutDiagnostics(document, null)).toContain('NOT FOUND');
  });
});
