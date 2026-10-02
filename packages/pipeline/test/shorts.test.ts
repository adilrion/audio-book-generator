import { describe, expect, it } from 'vitest';
import { estimateShortSec, suggestShortTags, youtubeTagChars } from '@app/types';
import type { LLMProvider, LLMRequest } from '../src/llm/provider';
import { captionGroups, captionsSrt, groupLimits } from '../src/shorts/captions';
import { captionWords, shortRenderKey, shortSegments } from '../src/shorts/render';
import { cleanHashtags, cleanScript, cleanTags, generateShortMetadata, generateShortScript, targetWords } from '../src/shorts/script';

const timed = (text: string, dt = 0.4) => text.split(' ').map((t, i) => ({ t, start: i * dt, end: (i + 1) * dt }));

describe('caption cards', () => {
  it('holds a few words, never spans two sentences and bridges short pauses', () => {
    const words = timed('Once upon a time there was a king. He had three daughters, and one was brave.');
    const g = captionGroups(words, { ...groupLimits('karaoke'), duration: 8 });
    expect(g.map((c) => c.words.map((w) => w.t).join(' '))).toEqual(['Once upon a time', 'there was a king.', 'He had three daughters,', 'and one was brave.']);
    for (let i = 0; i + 1 < g.length; i++) expect(g[i].end).toBe(g[i + 1].start); // no flicker between cards
    expect(g.at(-1)!.end).toBe(8); // the last card stays to the end
  });

  it('does not leave a sentence’s last word alone on a card', () => {
    const g = captionGroups(timed('taught you how to love? Then he leaves.'), { ...groupLimits('karaoke'), duration: 4 });
    expect(g.map((c) => c.words.map((w) => w.t).join(' '))).toEqual(['taught you how to love?', 'Then he leaves.']);
  });

  it('takes a word along rather than leave the last one alone when the card is full', () => {
    const g = captionGroups(timed('তরুণ পোস্টমাস্টার একা থাকেন। তাঁর সঙ্গী রতন।'), { ...groupLimits('karaoke'), duration: 5 });
    expect(g.map((c) => c.words.map((w) => w.t).join(' '))).toEqual(['তরুণ পোস্টমাস্টার', 'একা থাকেন।', 'তাঁর সঙ্গী রতন।']);
    expect(g[1].start).toBe(g[0].end);
  });

  it('is one word per card in word style and leaves a long pause mostly empty', () => {
    const words = [
      { t: 'Hello.', start: 0, end: 0.5 },
      { t: 'World', start: 2.5, end: 3 },
    ];
    const g = captionGroups(words, { ...groupLimits('word'), duration: 3.2 });
    expect(g).toHaveLength(2);
    expect(g[0].end).toBeCloseTo(0.8); // lingers 0.3 s into the 2 s pause, not until the next word
  });

  it('breaks long cards by characters, Bangla included', () => {
    const g = captionGroups(timed('একটি ছোট্ট গ্রামের পোস্টমাস্টার আর এক অনাথ বালিকা।'), { ...groupLimits('karaoke'), duration: 4 });
    expect(g.every((c) => c.words.map((w) => w.t).join(' ').length <= 24)).toBe(true);
    expect(g.at(-1)!.words.at(-1)!.t).toBe('বালিকা।');
  });

  it('writes one subtitle cue per card', () => {
    const srt = captionsSrt([{ start: 0, end: 1.5, words: [{ t: 'Hi', start: 0, end: 0.5 }, { t: 'there.', start: 0.5, end: 1 }] }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\nHi there.\n');
  });
});

describe('short narration', () => {
  it('reads sentence by sentence, with a longer pause at a new line', () => {
    const segs = shortSegments('What if one letter changed everything? It did.\nThis is that story — e.g. a true one.', 'en');
    expect(segs.map((s) => s.pauseMs)).toEqual([220, 420, 0]);
    expect(segs[2].printed).toBe('This is that story — e.g. a true one.');
    expect(segs[2].text).toContain('for example');
  });

  it('times the printed words against what the voice said', () => {
    const segs = shortSegments('It was 1913, e.g. long ago.', 'en');
    const words = captionWords(segs, [{ id: segs[0].id, start: 1, end: 4 }]);
    expect(words.map((w) => w.t)).toEqual(['It', 'was', '1913,', 'e.g.', 'long', 'ago.']);
    expect(words[0].start).toBe(1);
    expect(words.at(-1)!.end).toBe(4);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
  });

  it('changes the render key with the script or the look', () => {
    const settings = { language: 'en' as const, tts: { engine: 'kokoro' as const, voice: 'af_heart', speed: 1 }, look: { theme: 'midnight' as const, captions: 'karaoke' as const, accent: '#FACC15', position: 'center' as const, uppercase: true, showTitle: true, showProgress: true } };
    const a = shortRenderKey({ title: 'T', script: 'Hello.', settings }, false);
    expect(shortRenderKey({ title: 'T', script: 'Hello!', settings }, false)).not.toBe(a);
    expect(shortRenderKey({ title: 'T', script: 'Hello.', settings: { ...settings, look: { ...settings.look, accent: '#FF0000' } } }, false)).not.toBe(a);
    expect(shortRenderKey({ title: 'T', script: 'Hello.', settings }, false)).toBe(a);
  });

  it('estimates the length of a script', () => {
    expect(estimateShortSec(Array(165).fill('word').join(' '), 'en')).toBe(60);
    expect(estimateShortSec(Array(165).fill('word').join(' '), 'en', 1.5)).toBe(40);
    expect(estimateShortSec('', 'bn')).toBe(0);
  });
});

describe('AI script', () => {
  it('strips what a voice must not read', () => {
    const raw = '## Hook\n**Narrator:** Have you ever felt alone? 😢\n- (soft music)\n[Pause]\nThis is #Tagore at his best. #Shorts\n1. Read it.';
    expect(cleanScript(raw)).toBe('Hook\nHave you ever felt alone?\nThis is at his best.\nRead it.');
  });

  it('cleans hashtags and puts Shorts first', () => {
    expect(cleanHashtags(['#Tagore', 'book tok', 'shorts', '', 'রবীন্দ্রনাথ'], ['Audiobook'])).toEqual(['Shorts', 'Tagore', 'booktok', 'রবীন্দ্রনাথ', 'Audiobook']);
  });

  it('asks for the right length, language and book, and cleans the answer', async () => {
    let req: LLMRequest | undefined;
    const provider: LLMProvider = {
      name: 'fake',
      model: 'm',
      isAvailable: async () => ({ ok: true, message: '' }),
      generateJson: async <T>(r: LLMRequest) => {
        req = r;
        return { title: '"The Postmaster in 60 seconds"', script: 'A lonely postmaster. A girl named Ratan. 🙂 '.repeat(6), description: 'A taste of Tagore.\nListen now.', hashtags: ['Tagore'], tags: ['#tagore short story', 'the postmaster'] } as T;
      },
    };
    const r = await generateShortScript(provider, { kind: 'book', title: 'The Postmaster', author: 'Tagore', excerpt: 'The postmaster first took up his duties in the village of Ulapur.' }, { language: 'bn', seconds: 60, style: 'hook' });
    expect(req!.prompt).toContain('BOOK: The Postmaster by Tagore');
    expect(req!.prompt).toContain(`about ${targetWords(60, 'bn')} words`);
    expect(req!.prompt).toContain('Bangla');
    expect(req!.prompt).toContain('Ulapur');
    expect(req!.temperature).toBeGreaterThan(0);
    expect(r.title).toBe('The Postmaster in 60 seconds');
    expect(r.script).not.toMatch(/🙂/u);
    expect(r.description).toBe('A taste of Tagore. Listen now.');
    expect(r.hashtags).toEqual(['Shorts', 'Tagore', 'Audiobook']);
    expect(r.tags.slice(0, 3)).toEqual(['tagore short story', 'the postmaster', 'The Postmaster Tagore']); // AI first, then rules (deduplicated)
    expect(req!.prompt).toContain('TAGS:');
  });

  it('refuses an empty answer', async () => {
    const provider = { name: 'f', model: 'm', isAvailable: async () => ({ ok: true, message: '' }), generateJson: async <T>() => ({ title: 'x', script: '(music)', description: '', hashtags: [] }) as T };
    await expect(generateShortScript(provider, { kind: 'topic', topic: 'Black holes' }, { language: 'en', seconds: 30, style: 'summary' })).rejects.toMatchObject({ code: 'LLM_BAD_OUTPUT' });
  });

  it('writes YouTube details for a hand-written script', async () => {
    let prompt = '';
    const provider: LLMProvider = {
      name: 'f',
      model: 'm',
      isAvailable: async () => ({ ok: true, message: '' }),
      generateJson: async <T>(r: LLMRequest) => {
        prompt = r.prompt;
        return { description: 'A boy, a desert, a dream.\nWatch.', hashtags: ['#alchemist'], tags: ['the alchemist book'] } as T;
      },
    };
    const r = await generateShortMetadata(provider, { title: 'Follow your heart', script: 'A shepherd boy dreams of treasure.', language: 'en', bookTitle: 'The Alchemist', author: 'Coelho, Paulo' });
    expect(prompt).toContain('A shepherd boy dreams of treasure.');
    expect(prompt).toContain('The Alchemist by Coelho, Paulo');
    expect(r).toMatchObject({ description: 'A boy, a desert, a dream. Watch.', hashtags: ['Shorts', 'alchemist', 'Audiobook'] });
    expect(r.tags[0]).toBe('the alchemist book');
    expect(r.tags).toContain('Paulo Coelho');
  });
});

describe('YouTube tags', () => {
  it('suggests the book, its author and audiobook phrases, most specific first', () => {
    const tags = suggestShortTags({ title: 'Follow Your Heart', hashtags: ['Shorts', 'TheAlchemist', 'paulocoelho'], bookTitle: 'The Alchemist : a fable', author: 'Coelho, Paulo', language: 'en' });
    expect(tags.slice(0, 4)).toEqual(['The Alchemist', 'The Alchemist Paulo Coelho', 'Paulo Coelho', 'The Alchemist audiobook']);
    expect(tags).not.toContain('paulocoelho'); // glued hashtags are no search phrase
    expect(tags.at(-1)).toBe('youtube shorts');
    expect(tags.length).toBeLessThanOrEqual(15);
  });

  it('uses Bangla phrases for a Bangla short and drops stray joiners from PDF text', () => {
    const tags = suggestShortTags({ title: 'গল্প', bookTitle: 'পোস্ট\u200cমাস্টার', author: 'রবীন্দ্রনাথ ঠাকুর', language: 'bn' });
    expect(tags[0]).toBe('পোস্টমাস্টার');
    expect(tags).toContain('বাংলা অডিওবুক');
    expect(tags.some((t) => t.includes('\u200c'))).toBe(false);
  });

  it('keeps the AI’s tags first and stays within 500 characters', () => {
    const many = Array.from({ length: 40 }, (_, i) => `a fairly long search phrase number ${i}`);
    const tags = cleanTags(many, ['fallback']);
    expect(tags[0]).toBe('a fairly long search phrase number 0');
    expect(youtubeTagChars(tags)).toBeLessThanOrEqual(500);
    expect(cleanTags('nope', ['x', 'y'])).toEqual(['x', 'y']);
  });
});
