import { describe, expect, it } from 'vitest';
import {
  SHORT_BATCH_EXAMPLE,
  autoShortParts,
  estimateShortSec,
  parseDelimited,
  parseShortBatch,
  shortBatchPrompt,
  similarShorts,
  splitShortScript,
} from '../src';

describe('reading a batch of shorts', () => {
  it('reads the format our prompt asks for (and its own example)', () => {
    const r = parseShortBatch(SHORT_BATCH_EXAMPLE);
    expect(r.format).toBe('sections');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      title: 'The letter that changed a lonely life',
      hashtags: ['Shorts', 'Tagore', 'Audiobook'],
      tags: ['the postmaster', 'rabindranath tagore', 'tagore short stories', 'bengali literature', 'audiobook'],
    });
    expect(r.items[0].script.split('\n')).toHaveLength(4);
    expect(r.items[0].description).toMatch(/^A lonely postmaster/);
  });

  it('reads a ChatGPT answer: chatter, bold labels, Hook/Body/CTA, scene notes', () => {
    const text = `Sure! Here are 3 YouTube Shorts scripts for The Alchemist:

---

### **Short 1: Your Treasure Is Closer Than You Think**

**Hook (0–3s):** What if everything you're searching for is right where you started?
**Visual:** Desert at sunrise, slow zoom.
**Body:** Santiago crosses a whole desert chasing a dream. 🌅
And the treasure? It was buried back home.
**CTA:** Follow for the full audiobook. #Shorts #TheAlchemist

**Description:** A shepherd, a dream, and a journey that leads him home.

---

### **Short 2: The Language of Omens**

**Hook:** The universe is talking to you.
**Body:** Paulo Coelho calls them omens.

---

### **Short 3: Maktub**

**Script:**
It is written.
Maktub.

---

Let me know if you'd like more scripts or a different tone!`;
    const r = parseShortBatch(text);
    expect(r.items.map((i) => i.title)).toEqual(['Your Treasure Is Closer Than You Think', 'The Language of Omens', 'Maktub']);
    expect(r.items[0].script).toBe("What if everything you're searching for is right where you started?\nSantiago crosses a whole desert chasing a dream.\nAnd the treasure? It was buried back home.\nFollow for the full audiobook.");
    expect(r.items[0].hashtags).toEqual(['Shorts', 'TheAlchemist']); // moved out of the script
    expect(r.items[0].description).toBe('A shepherd, a dream, and a journey that leads him home.');
    expect(r.items[2].script).toBe('It is written.\nMaktub.'); // the chatter after the last short is gone
  });

  it('reads numbered "1. Title:" lists without headings (Gemini style)', () => {
    const text = `1. **Title:** Why we fear change
   **Script:** Change is scary. Here is why.
2. **Title:** The comfort zone trap
   **Script:** Comfort feels safe, but it is a cage.`;
    const r = parseShortBatch(text);
    expect(r.items.map((i) => [i.title, i.script])).toEqual([
      ['Why we fear change', 'Change is scary. Here is why.'],
      ['The comfort zone trap', 'Comfort feels safe, but it is a cage.'],
    ]);
  });

  it('reads JSON, also inside a code fence and under any key', () => {
    const json = '```json\n{"shorts":[{"title":"A","voiceover":"First script."},{"headline":"B","hook":"Look.","body":"Second script.","hashtags":["#x","y"],"tags":"one, two"}, "Just a script."]}\n```';
    const r = parseShortBatch(json);
    expect(r.format).toBe('json');
    expect(r.items.map((i) => i.title)).toEqual(['A', 'B', 'Just a script']);
    expect(r.items[1]).toMatchObject({ script: 'Look.\nSecond script.', hashtags: ['Shorts', 'x', 'y'], tags: ['one', 'two'] });
  });

  it('reads a spreadsheet with quoted cells (CSV and TSV)', () => {
    const csv = 'Title,Script,Description\n"Hello, world","Line one.\nLine ""two"".",Desc\nSecond,Another script.,';
    const r = parseShortBatch(csv);
    expect(r.format).toBe('table');
    expect(r.items.map((i) => [i.title, i.script])).toEqual([
      ['Hello, world', 'Line one.\nLine "two".'],
      ['Second', 'Another script.'],
    ]);
    expect(parseShortBatch('title\tscript\nT\tS one.').items[0]).toMatchObject({ title: 'T', script: 'S one.' });
    expect(parseDelimited('a,"b\nc"\n', ',')).toEqual([['a', 'b\nc']]);
  });

  it('keeps plain text as one short and does not mistake narration for headings', () => {
    const r = parseShortBatch('Episode 3 is my favourite part of the book.\nPart 2: it begins.\nAnd then it ends.');
    expect(r.format).toBe('single');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toBe('Episode 3 is my favourite part of the book');
    expect(r.items[0].script.split('\n')).toHaveLength(3);
  });

  it('splits plain scripts on "---", keeping a first one that is not chatter', () => {
    const r = parseShortBatch('First short, no labels.\n---\nSecond short.\n---\nThird short.');
    expect(r.items.map((i) => i.script)).toEqual(['First short, no labels.', 'Second short.', 'Third short.']);
  });

  it('reads Bangla labels and headings', () => {
    const r = parseShortBatch('শর্ট ১\nশিরোনাম: একা পোস্টমাস্টার\nস্ক্রিপ্ট: একটি ছোট্ট গ্রাম। একটি গল্প।\n\nশর্ট ২\nশিরোনাম: রতন\nস্ক্রিপ্ট: অপেক্ষা।');
    expect(r.items.map((i) => i.title)).toEqual(['একা পোস্টমাস্টার', 'রতন']);
    expect(r.items[0].script).toBe('একটি ছোট্ট গ্রাম। একটি গল্প।');
  });

  it('skips blocks without a script and returns nothing for empty text', () => {
    expect(parseShortBatch('## Short 1\nTitle: Only a title\n\n## Short 2\nScript: Real.').items.map((i) => i.script)).toEqual(['Real.']);
    expect(parseShortBatch('   ').items).toEqual([]);
  });
});

describe('cutting one long script into shorts', () => {
  const sentence = (i: number) => `Sentence number ${i} has exactly eight words here.`;
  const long = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join(' ');

  it('cuts at sentence ends into parts of even length, in order', () => {
    const parts = splitShortScript(long, 4);
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.split(' ').length)).toEqual([80, 80, 80, 80]);
    expect(parts.join(' ')).toBe(long);
    expect(parts[1].startsWith('Sentence number 11 ')).toBe(true);
  });

  it('keeps line breaks and prefers cutting where a new line starts', () => {
    const parts = splitShortScript('One two three.\nFour five six.\nSeven eight nine.\nTen eleven twelve.', 2);
    expect(parts).toEqual(['One two three.\nFour five six.', 'Seven eight nine.\nTen eleven twelve.']);
    expect(splitShortScript('Only one sentence.', 5)).toEqual(['Only one sentence.']);
    expect(splitShortScript('', 3)).toEqual([]);
  });

  it('picks a part count of under a minute each, at most 10', () => {
    expect(autoShortParts(long, 'en')).toBe(Math.ceil(estimateShortSec(long, 'en') / 58));
    expect(autoShortParts('Short.', 'en')).toBe(1);
    expect(autoShortParts(Array(5000).fill('word').join(' '), 'en')).toBe(10);
  });
});

describe('batch checks', () => {
  it('flags shorts with the same title or mostly the same script', () => {
    const base = 'The shepherd crossed the desert to find a treasure that was buried under the tree at home all along.';
    const pairs = similarShorts([
      { title: 'Treasure', script: base },
      { title: 'Other', script: `${base} Follow for more.` },
      { title: 'treasure!', script: 'Something completely different about omens and the language of the world.' },
      { title: 'Fresh', script: 'A brand new idea with its own words and its own hook for the viewer.' },
    ]);
    expect(pairs).toEqual([
      { a: 0, b: 1, why: 'script' },
      { a: 0, b: 2, why: 'title' },
    ]);
  });

  it('writes a prompt for other AI tools with the length in words', () => {
    const p = shortBatchPrompt({ about: 'The Alchemist', count: 5, seconds: 45, language: 'en' });
    expect(p).toContain('Write 5 different YouTube Shorts scripts about: The Alchemist');
    expect(p).toContain('about 114 words (45 seconds)');
    expect(p).toContain('## Short 1\nTitle:');
    expect(shortBatchPrompt({ about: '', count: 3, seconds: 30, language: 'bn' })).toContain('[YOUR TOPIC OR BOOK]');
  });
});
