// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { findCaptionPanel } from '../src/content/meet/caption-panel';
import { FakeMeet } from './fixtures/fake-meet';

describe('findCaptionPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('climbs to the captions panel and stops before the stage with participant tiles', () => {
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    expect(findCaptionPanel(region)).toBe(meet.panel);
  });

  it('never climbs into a container holding the call toolbar', () => {
    document.body.innerHTML = `
      <div id="root">
        <div id="wrap"><div id="region" role="region" aria-label="Captions"></div></div>
        <div><button jsname="CQylAd"></button></div>
      </div>`;
    const region = document.getElementById('region');
    if (!region) throw new Error('fixture');
    expect(findCaptionPanel(region).id).toBe('wrap');
  });

  it('falls back to the region itself when its parent holds meeting content', () => {
    document.body.innerHTML = `<div id="stage"><div data-participant-id="p"></div><div id="region" role="region"></div></div>`;
    const region = document.getElementById('region');
    if (!region) throw new Error('fixture');
    expect(findCaptionPanel(region)).toBe(region);
  });
});

describe('findCaptionPanel on the real Meet structure', () => {
  it('returns div.a4cQT (language bar + captions), not the inner region', () => {
    document.body.innerHTML = '';
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    const panel = findCaptionPanel(region);
    expect(panel.classList.contains('a4cQT')).toBe(true);
    expect(panel.contains(meet.languagePicker)).toBe(true);
  });

  it('climbs to the overlay host when class names change, still stopping before the tiles', () => {
    document.body.innerHTML = '';
    const meet = new FakeMeet(document, { obfuscated: true });
    const region = meet.enableCaptions();
    expect(findCaptionPanel(region)).toBe(meet.host);
  });
});

describe('CssCaptionHider', () => {
  it('collapses the panel, asks Meet to re-layout, and restores everything', async () => {
    const { CssCaptionHider } = await import('../src/content/ui/caption-hider');
    document.body.innerHTML = '';
    const meet = new FakeMeet(document);
    const region = meet.enableCaptions();
    let resizes = 0;
    window.addEventListener('resize', () => resizes++);
    const hider = new CssCaptionHider(document, { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } });
    hider.hide(region);
    expect(meet.panel?.hasAttribute('data-meetnotes-hidden')).toBe(true);
    await new Promise((r) => setTimeout(r, 1300));
    expect(resizes).toBeGreaterThanOrEqual(4);
    hider.show();
    expect(meet.panel?.hasAttribute('data-meetnotes-hidden')).toBe(false);
    expect(document.getElementById('meetnotes-caption-hider')).toBeNull();
  });
});

describe('hidden-captions stylesheet', () => {
  it('collapses the panel, its children and the caption scroller that Meet sizes the layout from', async () => {
    const { buildHiderCss, MODE_ATTR } = await import('../src/content/ui/caption-hider');
    const css = buildHiderCss();
    expect(css).toContain(`html[${MODE_ATTR}] div.a4cQT,`);
    expect(css).toContain(`html[${MODE_ATTR}] div.a4cQT > div,`);
    expect(css).toContain(`html[${MODE_ATTR}] div.a4cQT div[jsname="dsyhDe"]`);
    expect(css).toContain('height: 0 !important');
  });
});
