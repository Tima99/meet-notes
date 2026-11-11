/**
 * Structural snapshot of Meet's layout around the captions, for troubleshooting
 * hidden-captions mode and broken selectors. Deliberately contains NO text
 * content (no captions, no participant names): only tags, classes, roles,
 * jsname/inline styles and geometry.
 */
import { HIDDEN_ATTR } from '../ui/caption-hider';
import { findCaptionPanel } from './caption-panel';

const TILE = '[data-participant-id], [data-requested-participant-id]';
const MAX_ANCESTORS = 14;
const MAX_CHILDREN = 12;

function tag(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const classes = Array.from(el.classList).slice(0, 4).map((c) => `.${c}`).join('');
  const attrs = ['role', 'jsname', 'jscontroller', 'aria-haspopup', 'aria-live', 'tabindex']
    .map((a) => (el.hasAttribute(a) ? `[${a}=${el.getAttribute(a) ?? ''}]` : ''))
    .join('');
  const label = el.closest('[role="region"]') === el ? `[aria-label=${el.getAttribute('aria-label') ?? ''}]` : '';
  return `${el.tagName.toLowerCase()}${id}${classes}${attrs}${label}${el.hasAttribute(HIDDEN_ATTR) ? ' «HIDDEN BY MEETNOTES»' : ''}`;
}

function box(el: Element): string {
  const r = el.getBoundingClientRect();
  return `top=${Math.round(r.top)} h=${Math.round(r.height)} w=${Math.round(r.width)}`;
}

function layout(el: Element): string {
  const cs = getComputedStyle(el);
  const parts = [`display:${cs.display}`, `position:${cs.position}`];
  for (const prop of ['top', 'bottom', 'height', 'inset', 'padding-bottom', 'margin-bottom', 'flex', 'grid-template-rows', 'transform'] as const) {
    const value = cs.getPropertyValue(prop);
    if (value && !['auto', 'none', '0px', 'normal', '0 1 auto'].includes(value)) parts.push(`${prop}:${value}`);
  }
  return parts.join('; ');
}

function inlineStyle(el: Element): string {
  const style = el.getAttribute('style');
  return style ? ` style="${style.slice(0, 220)}"` : '';
}

function flags(el: Element, region: Element): string {
  const f: string[] = [];
  if (el.contains(region)) f.push('HAS-CAPTIONS');
  if (el.matches(TILE) || el.querySelector(TILE)) f.push('has-tiles');
  if (el.querySelector('video')) f.push('has-video');
  return f.length ? ` {${f.join(',')}}` : '';
}

/** Tag skeleton of an element, nested, without any text. Stops at `stopAt`. */
function skeleton(el: Element, depth: number, indent: string, stopAt?: Element): string[] {
  const lines = [`${indent}${tag(el)}${el === stopAt ? ' (captions — see below)' : ''}`];
  if (depth <= 0 || el === stopAt) return lines;
  for (const child of Array.from(el.children).slice(0, 6)) lines.push(...skeleton(child, depth - 1, `${indent}  `, stopAt));
  return lines;
}

export function collectLayoutDiagnostics(doc: Document, region: Element | null): string {
  const out: string[] = [
    'MeetNotes layout diagnostics (no caption text, no names)',
    `viewport=${doc.defaultView?.innerWidth ?? '?'}x${doc.defaultView?.innerHeight ?? '?'}`,
  ];
  if (!region) {
    out.push('Captions region NOT FOUND. Turn captions on and collect again.');
    return out.join('\n');
  }
  const panel = findCaptionPanel(region);
  out.push(`panel chosen: ${tag(panel)} (depth ${depthBetween(region, panel)} above region)`, '', '== Ancestors (region → body) ==');

  let el: Element | null = region;
  for (let depth = 0; el && el !== doc.documentElement && depth < MAX_ANCESTORS; depth++, el = el.parentElement) {
    out.push(`[${depth}] ${tag(el)}${flags(el, region)}${inlineStyle(el)}`, `     ${box(el)} | ${layout(el)}`);
    if (depth > 0) {
      for (const child of Array.from(el.children).slice(0, MAX_CHILDREN)) {
        out.push(`       └ ${tag(child)}${flags(child, region)}${inlineStyle(child)} | ${box(child)} | ${layout(child)}`);
      }
    }
  }

  out.push('', '== Participant tiles (outermost) ==');
  const tiles = Array.from(doc.querySelectorAll(TILE)).filter((t) => !t.parentElement?.closest(TILE));
  for (const tile of tiles.slice(0, 6)) out.push(`  ${tag(tile)} | ${box(tile)}${inlineStyle(tile)}`);
  const lowestTileBottom = Math.max(0, ...tiles.map((t) => t.getBoundingClientRect().bottom));
  out.push(`  lowest tile bottom=${Math.round(lowestTileBottom)}`);

  out.push('', '== Caption panel skeleton ==', ...skeleton(panel, 9, '', region));
  out.push('', '== Caption region skeleton ==', ...skeleton(region, 4, ''));
  return out.join('\n');
}

function depthBetween(from: Element, to: Element): number {
  let depth = 0;
  for (let el: Element | null = from; el && el !== to; el = el.parentElement) depth++;
  return depth;
}
