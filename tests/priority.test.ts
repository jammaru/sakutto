// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { bandForRect, contentKind, lookaheadScreens, translationPriority } from '@/dom/priority';

describe('translation priority', () => {
  it('finishes article prose before navigation and infoboxes', () => {
    const visibleProse = translationPriority('visible', 2000, 'prose');
    const nearProse = translationPriority('near', 0, 'prose');
    const farProse = translationPriority('far', 2000, 'prose');
    const visibleChrome = translationPriority('visible', 0, 'chrome');
    const farChrome = translationPriority('far', 0, 'chrome');

    expect(translationPriority('selection', 0, 'prose')).toBe(0);
    expect(visibleProse).toBeLessThan(nearProse);
    expect(nearProse).toBeLessThan(farProse);
    expect(farProse).toBeLessThan(visibleChrome);
    expect(visibleChrome).toBeLessThan(farChrome);
  });

  it('classifies article text as prose and navigation as chrome', () => {
    document.body.innerHTML = `
      <nav><ul><li><a href="#a">Etymology</a></li></ul></nav>
      <aside><div>Appearance</div></aside>
      <main>
        <h1>Osaka</h1>
        <p>Osaka is a designated city.</p>
      </main>
    `;

    const item = document.querySelector('li');
    const appearance = document.querySelector('aside div');
    const heading = document.querySelector('h1');
    const paragraph = document.querySelector('p');
    if (!item || !appearance || !heading || !paragraph) throw new Error('missing blocks');

    expect(contentKind(item)).toBe('chrome');
    expect(contentKind(appearance)).toBe('chrome');
    expect(contentKind(heading)).toBe('prose');
    expect(contentKind(paragraph)).toBe('prose');
  });

  it('treats an article headline in its own header as prose and the site header as chrome', () => {
    document.body.innerHTML = `
      <header><a href="/">Home</a><div>Sign in to continue reading</div></header>
      <main>
        <article>
          <header><h1>Funding the harbour libraries</h1></header>
          <p>The cooperative is placing part of its surplus into branch libraries.</p>
        </article>
      </main>
    `;

    const site = document.querySelector('body > header div');
    const headline = document.querySelector('h1');
    if (!site || !headline) throw new Error('missing blocks');

    expect(contentKind(site)).toBe('chrome');
    expect(contentKind(headline)).toBe('prose');
  });

  it('keeps the date and category labels of an article header behind the body', () => {
    document.body.innerHTML = `
      <main>
        <article>
          <header>
            <h1>Funding the harbour libraries</h1>
            <p id="dek">The cooperative is placing part of its surplus into a fund for branch libraries.</p>
            <p id="date">Oct 18, 2026</p>
            <p id="category">Announcements</p>
          </header>
          <p>The cooperative is placing part of its surplus into branch libraries.</p>
        </article>
      </main>
    `;

    const block = (selector: string): Element => {
      const found = document.querySelector(selector);
      if (!found) throw new Error(`missing ${selector}`);
      return found;
    };

    expect(contentKind(block('h1'))).toBe('prose');
    expect(contentKind(block('#dek'))).toBe('prose');
    expect(contentKind(block('#date'))).toBe('chrome');
    expect(contentKind(block('#category'))).toBe('chrome');
  });

  it('keeps hatnotes, coordinates and infoboxes behind the lead paragraph', () => {
    document.body.innerHTML = `
      <div class="hatnote">For other uses, see Osaka (disambiguation) and the places that share the name.</div>
      <div id="coordinates">Coordinates: 34°41′38″N 135°30′8″E</div>
      <table class="infobox"><tbody><tr><td>Osaka is the capital of Osaka Prefecture and this cell is long enough to look like a paragraph.</td></tr></tbody></table>
      <p>Osaka is a designated city in the Kansai region.</p>
    `;

    const hatnote = document.querySelector('.hatnote');
    const coordinates = document.querySelector('#coordinates');
    const cell = document.querySelector('td');
    const lead = document.querySelector('p');
    if (!hatnote || !coordinates || !cell || !lead) throw new Error('missing blocks');

    expect(contentKind(hatnote)).toBe('chrome');
    expect(contentKind(coordinates)).toBe('chrome');
    expect(contentKind(cell)).toBe('chrome');
    expect(contentKind(lead)).toBe('prose');
    expect(translationPriority('visible', 40, 'prose')).toBeLessThan(
      translationPriority('visible', 0, 'chrome'),
    );
  });

  it('treats an on-screen box as visible and a distant one as far', () => {
    expect(bandForRect({ top: 10, bottom: 40, width: 100, height: 30 }, 800)).toBe('visible');
    expect(bandForRect({ top: 900, bottom: 940, width: 100, height: 40 }, 800)).toBe('near');
    expect(bandForRect({ top: 4000, bottom: 4040, width: 100, height: 40 }, 800)).toBe('far');
    expect(bandForRect({ top: 0, bottom: 0, width: 0, height: 0 }, 800)).toBe('far');
  });

  it('prefetches more of the page for PLaMo when the look-ahead is widened', () => {
    // The look-ahead is how much of the page is handed to PLaMo before it is on screen.
    // It used to decide how much Chrome drafted; now it is pure model prefetch.
    expect(lookaheadScreens('g', 'quality')).toBe(2);
    expect(lookaheadScreens('c8', 'quality')).toBe(1);
    expect(lookaheadScreens('c4', 'quality')).toBe(0.5);
    expect(lookaheadScreens('g', 'fast')).toBeGreaterThan(lookaheadScreens('g', 'quality'));
    expect(lookaheadScreens('c8', 'fast')).toBeGreaterThan(lookaheadScreens('c8', 'quality'));
    expect(lookaheadScreens(null, 'fast')).toBeGreaterThan(lookaheadScreens(null, 'quality'));
  });
});
