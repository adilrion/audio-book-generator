import { describe, expect, it } from 'vitest';
import { defaultShortThumbnail, firstSentence, headlineWords } from '@/lib/short-thumbnail';
import { effectiveCaptions, formatTags, lengthVerdict, parseHashtags, parseTags, youtubeDescription } from '@/lib/shorts';

describe('short thumbnail text', () => {
  it('colours the words in *stars*', () => {
    expect(headlineWords('The *loneliest* job in the *whole world*')).toEqual([
      { t: 'The', accent: false },
      { t: 'loneliest', accent: true },
      { t: 'job', accent: false },
      { t: 'in', accent: false },
      { t: 'the', accent: false },
      { t: 'whole', accent: true },
      { t: 'world', accent: true },
    ]);
    expect(headlineWords('*একা* পোস্টমাস্টার').map((w) => w.accent)).toEqual([true, false]);
  });

  it('quotes the first sentence of the script', () => {
    expect(firstSentence('What if one letter changed a life? It did.')).toBe('What if one letter changed a life?');
    expect(firstSentence('একটি গ্রাম। একটি গল্প।')).toBe('একটি গ্রাম।');
    expect(firstSentence('x'.repeat(300)).length).toBe(178);
  });

  it('starts from the book cover when the short has a book', () => {
    expect(defaultShortThumbnail({ accent: '#FACC15', language: 'en', hasBook: true })).toEqual({ layout: 'cover', headline: '', kicker: 'Audiobook', accent: '#FACC15' });
    expect(defaultShortThumbnail({ accent: '#FFFFFF', language: 'bn', hasBook: false }).layout).toBe('headline');
  });
});

describe('short YouTube fields', () => {
  it('parses the tags box like YouTube Studio does', () => {
    expect(parseTags('the alchemist, paulo coelho,\n#audiobook, The Alchemist')).toEqual(['the alchemist', 'paulo coelho', 'audiobook']);
    expect(formatTags(['a b', 'c'])).toBe('a b, c');
  });

  it('builds the description with hashtags at the end', () => {
    expect(youtubeDescription(' A taste of Tagore. ', parseHashtags('#Shorts, #Tagore #Shorts'))).toBe('A taste of Tagore.\n\n#Shorts #Tagore');
  });

  it('warns about long scripts and swaps karaoke for a box on paper', () => {
    expect(lengthVerdict(Array(170).fill('word').join(' '), 'en', 1).tone).toBe('warning');
    expect(lengthVerdict(Array(600).fill('word').join(' '), 'en', 1).tone).toBe('error');
    expect(effectiveCaptions('karaoke', 'paper')).toBe('box');
    expect(effectiveCaptions('karaoke', 'midnight')).toBe('karaoke');
  });
});
