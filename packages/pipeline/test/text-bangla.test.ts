import { describe, expect, it } from 'vitest';
import type { ExtractionMeta } from '@app/types';
import {
  LANGUAGE_DEFAULTS,
  analyzeCleaned,
  asciiToBn,
  bnToAscii,
  cleanDocument,
  defaultVoice,
  dehyphenate,
  fallbackSections,
  headingNarration,
  isBackMatterTitle,
  isChapterMarkerLine,
  isFrontMatterTitle,
  looksBroken,
  normalizeNarration,
  printedWordTimes,
  repairBanglaWord,
  speechWeight,
  splitSentences,
  voiceLanguage,
} from '../src';
import { bodyLines, page } from './fixtures';

const meta = (n: number): ExtractionMeta => ({ pdfHash: 'x', extractorVersion: 'v', pageCount: n, toc: [], wordCount: 1000, emptyPages: [], ocrPages: [], pagesFile: 'p', pageSizes: [] });
const sentences = (text: string) => splitSentences(text, 'bn').map((s) => text.slice(s.start, s.end));
const bn = (s: string) => normalizeNarration(s, 'bn');

// য় ড় ঢ় are printed either as one code point or as letter + nukta (which is what NFC produces).
const YA_SINGLE = 'য়';
const YA_NUKTA = 'য়';

describe('Bangla sentences', () => {
  it('ends sentences at the danda, ? and !', () => {
    expect(sentences('তিনি বাড়ি গেলেন। তারপর ঘুমিয়ে পড়লেন। কেন? জানি না!')).toEqual(['তিনি বাড়ি গেলেন।', 'তারপর ঘুমিয়ে পড়লেন।', 'কেন?', 'জানি না!']);
  });

  it('does not end a sentence at an abbreviation, an initial or a decimal point', () => {
    expect(sentences('ডা. রহমান এলেন। মো. করিম বসলেন।')).toEqual(['ডা. রহমান এলেন।', 'মো. করিম বসলেন।']);
    expect(sentences('এ. কে. ফজলুল হক বক্তৃতা দিলেন। সবাই শুনল।')).toEqual(['এ. কে. ফজলুল হক বক্তৃতা দিলেন।', 'সবাই শুনল।']);
    expect(sentences('মোট ৩.৫ কেজি চাল লাগবে। বাজারে চলো।')).toEqual(['মোট ৩.৫ কেজি চাল লাগবে।', 'বাজারে চলো।']);
  });
});

describe('Bangla narration', () => {
  it('says abbreviations in full', () => {
    expect(bn('ডা. রহমান এলেন।')).toBe('ডাক্তার রহমান এলেন।');
    expect(bn('ডাঃ রহমান এলেন।')).toBe('ডাক্তার রহমান এলেন।');
    expect(bn('মোঃ করিম ও মো. রহিম')).toBe('মোহাম্মদ করিম ও মোহাম্মদ রহিম');
    expect(bn('পৃ. ১২ দেখুন।')).toBe('পৃষ্ঠা ১২ দেখুন।');
    expect(bn('মহানবী মুহাম্মদ (সা.) বলেছেন।')).toBe('মহানবী মুহাম্মদ সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম বলেছেন।');
  });

  it('reads years in hundreds, other numbers as they are', () => {
    expect(bn('১৯৭১ সালে দেশ স্বাধীন হয়।')).toBe('উনিশশো ৭১ সালে দেশ স্বাধীন হয়।');
    expect(bn('২৬ মার্চ, ১৯৭১ তারিখে')).toBe('২৬ মার্চ, উনিশশো ৭১ তারিখে');
    expect(bn('1905 সালে বঙ্গভঙ্গ হয়।')).toBe('উনিশশো ৫ সালে বঙ্গভঙ্গ হয়।');
    expect(bn('১৯০০ খ্রিস্টাব্দে')).toBe('উনিশশো খ্রিস্টাব্দে');
    expect(bn('১৪৩০ বঙ্গাব্দ')).toBe('চোদ্দোশো ৩০ বঙ্গাব্দ');
    expect(bn('১৫০০ টাকা লাগবে।')).toBe('১৫০০ টাকা লাগবে।');
    expect(bn('২০২৪ সালে')).toBe('২০২৪ সালে'); // "দুই হাজার চব্বিশ" is how it is said
  });

  it('handles %, &, the visarga used as a colon, footnote numbers and joiners', () => {
    expect(bn('৫০% মানুষ রাজি।')).toBe('৫০ শতাংশ মানুষ রাজি।');
    expect(bn('প্রশ্নঃ তুমি কে?')).toBe('প্রশ্ন: তুমি কে?');
    expect(bn('সাধারণতঃ এমন হয় না।')).toBe('সাধারণত এমন হয় না।');
    expect(bn('দুঃখ পেলাম।')).toBe('দুঃখ পেলাম।');
    expect(bn('তিনি লিখেছিলেন।১ পরে')).toBe('তিনি লিখেছিলেন। পরে');
    expect(bn('র‍্যাব এলো।')).toBe('র্যাব এলো।');
  });

  it('drops a full stop inside a sentence, which the voice would read as its end', () => {
    expect(bn('এ. কে. ফজলুল হক এলেন।')).toBe('এ কে ফজলুল হক এলেন।');
    expect(bn('মোট ৩.৫ কেজি।')).toBe('মোট ৩.৫ কেজি।');
  });

  it('leaves English narration alone', () => {
    expect(normalizeNarration('In 1971, 50% agreed.', 'en')).toBe('In 1971, 50 percent agreed.');
  });

  it('gives headings a danda', () => {
    expect(headingNarration('প্রথম অধ্যায়', 'bn')).toBe('প্রথম অধ্যায়।');
    expect(headingNarration('প্রথম অধ্যায়।', 'bn')).toBe('প্রথম অধ্যায়।');
    expect(headingNarration('Chapter One')).toBe('Chapter One.');
  });
});

describe('Bangla digits and repairs', () => {
  it('converts digits both ways', () => {
    expect(bnToAscii('১৯৭১')).toBe('1971');
    expect(asciiToBn(2024)).toBe('২০২৪');
  });

  it('collapses a vowel sign printed twice (Chrome/Skia ligature mapping)', () => {
    expect(repairBanglaWord('অধ্যাায়')).toBe('অধ্যায়');
    expect(repairBanglaWord('শ্রীীকান্ত')).toBe('শ্রীকান্ত');
    expect(repairBanglaWord('যাযাবর')).toBe('যাযাবর'); // a repeated syllable is a real word
  });

  it('flags paragraphs with words that start with a vowel sign (lost conjuncts)', () => {
    expect(looksBroken('িতীয় অধ্যায় শুরু হলো। তারা িক বলল ে শুনল না।')).toBe(true);
    expect(looksBroken('দ্বিতীয় অধ্যায় শুরু হলো। তারা কী বলল কে শুনল না।')).toBe(false);
  });

  it('keeps Bangla hyphenated pairs, joins only what the book prints joined', () => {
    expect(dehyphenate('দেওয়া-', 'নেওয়া', new Set())).toBe('দেওয়া-নেওয়া');
    expect(dehyphenate('স্বাধী-', 'নতা', new Set(['স্বাধীনতা']))).toBe('স্বাধীনতা');
  });
});

describe('Bangla chapters', () => {
  it('recognizes Bangla chapter labels, in either spelling of য়', () => {
    for (const ya of [YA_SINGLE, YA_NUKTA]) {
      const ch = `অধ্যা${ya}`;
      expect(isChapterMarkerLine(`${ch} ৩`)).toBe(true);
      expect(isChapterMarkerLine(`প্রথম ${ch}`)).toBe(true);
      expect(isChapterMarkerLine(`দ্বিতী${ya} ${ch}`)).toBe(true);
      expect(isChapterMarkerLine(`${ch}-১২`)).toBe(true);
      expect(isChapterMarkerLine(`${ch} এক`)).toBe(true);
    }
    expect(isChapterMarkerLine('৩য় পরিচ্ছেদ')).toBe(true);
    expect(isChapterMarkerLine('পর্ব ২।')).toBe(true);
    expect(isChapterMarkerLine('অধ্যায় ৩ ছিল সবচেয়ে ভালো অংশ')).toBe(false);
    expect(isChapterMarkerLine('একটি পর্ব শেষ হলো')).toBe(false);
  });

  it('knows Bangla front and back matter', () => {
    expect(isFrontMatterTitle('সূচিপত্র')).toBe(true);
    expect(isFrontMatterTitle('উৎসর্গ')).toBe(true);
    expect(isFrontMatterTitle('প্রথম অধ্যায়')).toBe(false);
    expect(isBackMatterTitle('নির্ঘণ্ট')).toBe(true);
    expect(isBackMatterTitle('লেখক পরিচিতি')).toBe(true);
    expect(isBackMatterTitle('উপসংহার')).toBe(false);
  });

  it('names fallback sections in Bangla', () => {
    const paras = Array.from({ length: 30 }, (_, i) => ({ kind: 'body' as const, lines: [], tokens: [{ t: 'কথা', parts: [] }], size: 11, bold: false, pageStart: i + 1, pageEnd: i + 1 }));
    expect(fallbackSections(paras, 12, 'bn').map((s) => s.title)).toEqual(['পর্ব ১', 'পর্ব ২', 'পর্ব ৩']);
    expect(fallbackSections(paras, 12).map((s) => s.title)).toEqual(['Part 1', 'Part 2', 'Part 3']);
  });

  it('analyzes a Bangla book: page numbers, running headers, chapters, sentences, narration', async () => {
    const LONG = 'এই লাইনটি যথেষ্ট লম্বা যাতে পাতার ডান দিকের প্রান্ত পর্যন্ত পৌঁছে যায় নিশ্চিত';
    const folio = (n: number) => ({ text: asciiToBn(n), x: 210, y: 610, size: 9 });
    const header = (n: number) => ({ text: `আমার ছেলেবেলা ${asciiToBn(n)}`, x: 150, y: 20, size: 9 });
    const more = (y: number) => [...bodyLines([LONG, 'আরও একটি অনুচ্ছেদ এখানে শেষ হলো।'], y), ...bodyLines([LONG, 'শেষ অনুচ্ছেদটিও এখানে শেষ।'], y + 45)];
    const pages = [
      page(1, [header(1), { text: 'ভূমিকা', x: 180, y: 80, size: 16 }, ...bodyLines([LONG, 'এই বই ছোটদের জন্য লেখা।'], 110), ...more(155), folio(1)]),
      page(2, [header(2), { text: 'প্রথম অধ্যায়', x: 170, y: 80, size: 16 }, ...bodyLines([LONG, 'ডা. রহমান ১৯৭১ সালে গ্রামে এলেন। সবাই খুশি হলো।'], 110), ...more(155), folio(2)]),
      page(3, [header(3), ...bodyLines([LONG, 'তারপর অনেক দিন কেটে গেল।'], 60), ...more(105), folio(3)]),
      page(4, [header(4), { text: 'দ্বিতীয় অধ্যাায়', x: 170, y: 80, size: 16 }, ...bodyLines([LONG, 'নতুন গল্প শুরু হলো। পৃষ্ঠা উল্টাও।'], 110), ...more(155), { text: 'পৃষ্ঠা ৪', x: 200, y: 610, size: 9 }]),
    ];
    const a = await analyzeCleaned(cleanDocument(pages), meta(pages.length), { language: 'bn', skipFrontMatter: false });
    expect(a.chapters.map((c) => c.title)).toEqual(['ভূমিকা', 'প্রথম অধ্যায়', 'দ্বিতীয় অধ্যায়']);
    const all = a.chapters.flatMap((c) => c.paragraphs.flatMap((p) => p.sentences));
    // Page numbers ("২", "পৃষ্ঠা ৪") and the running header are gone; the doubled vowel sign is repaired.
    expect(all.some((s) => /^[০-৯]+$|পৃষ্ঠা ৪|আমার ছেলেবেলা/.test(s.text))).toBe(false);
    expect(a.chapters[1].paragraphs[0].sentences[0].narration).toBe('প্রথম অধ্যায়।');
    const ch1 = a.chapters[1].paragraphs.flatMap((p) => p.sentences.map((s) => s.narration));
    expect(ch1.some((n) => n.endsWith('নিশ্চিত ডাক্তার রহমান উনিশশো ৭১ সালে গ্রামে এলেন।'))).toBe(true);
    expect(ch1).toContain('সবাই খুশি হলো।');
  });
});

describe('Bangla word timing', () => {
  it('counts vowel signs as sounds and pauses after a danda', () => {
    expect(speechWeight('ভালোবাসি')).toBe(8 + 1);
    expect(speechWeight('স্বাধীন')).toBe(6 + 1); // the hasanta is not a sound
    expect(speechWeight('গেলেন।')).toBe(speechWeight('গেলেন') + 5);
  });

  it('aligns printed words to the narration ("ডা." takes the time of "ডাক্তার")', () => {
    const printed = ['ডা.', 'রহমান', 'কি', 'বললেন?'];
    const t = printedWordTimes(printed, 'ডাক্তার রহমান কি বললেন?', 0, 4);
    expect(t).toHaveLength(4);
    expect(t[0].start).toBe(0);
    expect(t[3].end).toBe(4);
    for (let i = 1; i < t.length; i++) expect(t[i].start).toBeCloseTo(t[i - 1].end, 9);
    expect(t[0].end - t[0].start).toBeGreaterThan(t[2].end - t[2].start); // "ডাক্তার" is longer than "কি"
  });
});

describe('Bangla voices', () => {
  it('starts Bangla projects on the Piper Bangla voice', () => {
    expect(LANGUAGE_DEFAULTS.bn.engine).toBe('piper');
    expect(LANGUAGE_DEFAULTS.bn.engines).not.toContain('kokoro');
    expect(defaultVoice('piper', 'bn')).toBe('bn_BD-google-medium:4811');
    expect(defaultVoice('piper', 'en')).toBe('en_US-lessac-medium');
    expect(defaultVoice('say', 'bn')).toBeUndefined();
  });

  it('reads the language from voice ids', () => {
    expect(voiceLanguage('bn_BD-google-medium:4811')).toBe('bn');
    expect(voiceLanguage('en_US-lessac-medium')).toBe('en');
    expect(voiceLanguage('af_heart')).toBe('en');
    expect(voiceLanguage('ef_dora')).toBe('es');
    expect(voiceLanguage('Samantha')).toBeUndefined();
  });
});
