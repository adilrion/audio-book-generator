import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@app/config';
import {
  type PublishContext,
  YOUTUBE_LIMITS,
  chaptersProblem,
  composeDescription,
  composeSocial,
  fileTagsFor,
  fitHashtags,
  fitTags,
  partLabel,
  phraseIndex,
  sanitizeHashtag,
  seoReport,
  socialLength,
  uploadFileName,
  youtubeTagChars,
  ytTimestamp,
} from '@app/types';
import { type LLMProvider, type LLMRequest, cleanText, generatePublishDraft, paragraphize, rankTitles, readMediaTags, run, scrub, scrubTitle, templateDraft, writeMediaTags } from '../src';
import { hasFfmpeg } from './runner-fakes';

const ctx: PublishContext = {
  title: 'The Metamorphosis',
  author: 'Franz Kafka',
  language: 'en',
  durationSec: 2317.4,
  pageCount: 77,
  wordCount: 21033,
  chapters: [
    { title: 'I', start: 0, end: 800 },
    { title: 'II', start: 800, end: 1600 },
    { title: 'III', start: 1600, end: 2317.4 },
  ],
  aspectRatio: '16:9',
  hasVideo: true,
  hasAudio: true,
};

describe('publish helpers', () => {
  it('formats YouTube timestamps', () => {
    expect(ytTimestamp(0)).toBe('00:00');
    expect(ytTimestamp(75.9)).toBe('01:15');
    expect(ytTimestamp(3725)).toBe('1:02:05');
    expect(ytTimestamp(5, true)).toBe('0:00:05');
  });

  it('knows when YouTube will show chapters', () => {
    expect(chaptersProblem(ctx.chapters)).toBeUndefined();
    expect(chaptersProblem(ctx.chapters.slice(0, 2))).toMatch(/3 or more/);
    expect(chaptersProblem([{ title: 'a', start: 2, end: 100 }, ...ctx.chapters.slice(1)])).toMatch(/00:00/);
    expect(chaptersProblem([{ title: 'a', start: 0, end: 5 }, ...ctx.chapters.slice(1)])).toMatch(/shorter/);
  });

  it('counts tag characters like YouTube and fits the 500 budget', () => {
    expect(youtubeTagChars(['a', 'b c'])).toBe(1 + 5 + 1); // quotes around "b c", one comma
    const many = Array.from({ length: 80 }, (_, i) => `audiobook tag ${i}`);
    const fitted = fitTags(many);
    expect(youtubeTagChars(fitted)).toBeLessThanOrEqual(YOUTUBE_LIMITS.tagsChars);
    expect(fitTags(['Kafka', 'kafka', ' a,b ', '#x<y>'])).toEqual(['Kafka', 'a b', 'x y']);
  });

  it('cleans hashtags in any script', () => {
    expect(sanitizeHashtag('#Read Along!')).toBe('ReadAlong');
    expect(sanitizeHashtag('বাংলা অডিওবুক')).toBe('বাংলাঅডিওবুক');
    expect(fitHashtags(['a', 'A', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('matches search phrases by words', () => {
    expect(phraseIndex('The Metamorphosis by Franz Kafka – Full Audiobook', 'the metamorphosis audiobook')).toBe(4);
    expect(phraseIndex('Kafka – Full Audiobook', 'the metamorphosis audiobook')).toBe(-1);
  });

  it('composes the description with chapters, disclosure and hashtags', () => {
    const d = templateDraft(ctx);
    const text = composeDescription(d.youtube, ctx.chapters);
    expect(text).toContain('Chapters:\n00:00 I\n13:20 II\n26:40 III');
    expect(text).toContain('text-to-speech');
    expect(text.trim().split('\n').pop()).toMatch(/^#Audiobook /);
    expect(composeDescription({ ...d.youtube, includeChapters: false, aiNarrationNote: false, hashtags: [] }, ctx.chapters)).toBe(d.youtube.description);
  });

  it('counts X links as 23 characters', () => {
    const post = { text: 'Hello', hashtags: ['A'] };
    expect(composeSocial(post, 'https://youtu.be/abc')).toBe('Hello\n\nhttps://youtu.be/abc\n\n#A');
    expect(socialLength('x', post, 'https://youtu.be/a-very-long-link-that-is-shortened')).toBe('Hello\n\n#A'.length + 2 + 23);
  });

  it('builds file tags; the audiobook is marked as one', () => {
    const d = templateDraft(ctx);
    const v = fileTagsFor(d, ctx, 'video');
    expect(v).toMatchObject({ title: 'The Metamorphosis', artist: 'Franz Kafka', album_artist: 'Franz Kafka', genre: 'Audiobook' });
    expect(v.keywords.split(',')).toContain('The Metamorphosis audiobook');
    expect([...v.description].length).toBeLessThanOrEqual(255);
    expect(v.media_type).toBeUndefined();
    expect(fileTagsFor(d, ctx, 'audio').media_type).toBe('2');
  });

  it('makes safe upload file names', () => {
    expect(uploadFileName(['The Metamorphosis', 'Franz Kafka', 'audiobook'], 'mp4')).toBe('the-metamorphosis-franz-kafka-audiobook.mp4');
    expect(uploadFileName(['পোস্টমাস্টার', 'অডিওবুক'], 'mp4')).toBe('পোস্টমাস্টার-অডিওবুক.mp4');
    expect(uploadFileName(['../..'], 'jpg')).toBe('audiobook.jpg');
  });
});

describe('rule-based draft', () => {
  it('passes its own title and description checks', () => {
    const d = templateDraft(ctx);
    expect([...d.youtube.title].length).toBeLessThanOrEqual(YOUTUBE_LIMITS.titleVisible);
    const r = seoReport(d, ctx, { thumbnail: true, applied: 'current' });
    expect(r.blocking).toBe(0);
    const failing = r.checks.filter((c) => c.status !== 'pass').map((c) => c.id);
    expect(failing).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('writes Bangla metadata for a Bangla book', () => {
    const d = templateDraft({ ...ctx, title: 'পোস্টমাস্টার', author: 'রবীন্দ্রনাথ ঠাকুর', language: 'bn' });
    expect(d.youtube.title).toContain('অডিওবুক');
    expect(d.youtube.hashtags[0]).toBe('অডিওবুক');
    expect(d.file.genre).toBe('অডিওবুক');
    expect(composeDescription(d.youtube, ctx.chapters)).toContain('অধ্যায়সমূহ:');
  });

  it('flags what YouTube rejects', () => {
    const d = templateDraft(ctx);
    d.youtube.title = 'x'.repeat(101);
    d.youtube.description = 'Read <this>';
    d.youtube.hashtags = ['two words'];
    const ids = seoReport(d, ctx, { thumbnail: false, applied: 'none' })
      .checks.filter((c) => c.status === 'fail')
      .map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['title-length', 'brackets', 'hashtags']));
  });
});

/** Answers each JSON request with the next canned answer. */
class FakeLLM implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'test';
  requests: LLMRequest[] = [];
  constructor(private readonly answers: unknown[]) {}
  async isAvailable() {
    return { ok: true, message: 'ready' };
  }
  async generateJson<T>(req: LLMRequest): Promise<T> {
    this.requests.push(req);
    return this.answers.shift() as T;
  }
}

const longText = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} tells you about The Metamorphosis audiobook by Franz Kafka.`).join(' ');

describe('AI metadata', () => {
  it('cleans what the model must not write', () => {
    expect(cleanText('Watch https://x.y/z now <b>\n00:00 Intro\n#a #b\nEnd', 500)).toBe('Watch now b\nEnd');
    expect(paragraphize(longText).split('\n\n')).toHaveLength(4);
  });

  it('merges a good answer and keeps the upload settings', async () => {
    const llm = new FakeLLM([
      {
        titles: ['"The Metamorphosis Audiobook by Franz Kafka | Read Along"', 'x', 'The Metamorphosis – Kafka – Full Audiobook'],
        description: longText,
        primary_keyword: 'the metamorphosis audiobook',
        tags: ['kafka', 'Kafka', 'existentialism'],
        hashtags: ['themetamorphosis', '#Kafka', 'two words'],
        category: 'Entertainment',
        thumbnail_text: 'Metamorphosis',
        pinned_comment: 'What would you do?',
      },
      {
        facebook: { text: 'Watch the classic now! Link in bio! #Kafka', hashtags: ['booklovers'] },
        instagram: { text: 'Woke up as a bug? link in bio', hashtags: ['booktok'] },
        tiktok: { text: 'Kafka but make it read-along. BookTok', hashtags: ['booktok'] },
        x: { text: 'y'.repeat(400), hashtags: ['Kafka'] },
        linkedin: { text: '', hashtags: [] },
      },
    ]);
    const base = templateDraft(ctx);
    base.youtube.visibility = 'unlisted';
    const d = await generatePublishDraft(llm, { ctx, excerpt: 'One morning…' }, base, ['youtube', 'social'], base.ai);
    expect(llm.requests[0].prompt).toContain('BOOK TITLE: The Metamorphosis');
    expect(llm.requests[0].temperature).toBeGreaterThan(0);
    // The search format outranks the model's titles; "read along" is dropped from titles.
    expect(d.youtube.title).toBe('The Metamorphosis by Franz Kafka | Full Audiobook with Text');
    expect(d.youtube.titleOptions).toContain('The Metamorphosis Audiobook by Franz Kafka');
    expect(d.youtube.titleOptions).not.toContain('x');
    expect(d.youtube.visibility).toBe('unlisted');
    expect(d.youtube.categoryId).toBe('24');
    expect(d.youtube.hashtags).toEqual(['Audiobook', 'TheMetamorphosis', 'FranzKafka', 'Kafka', 'twowords']);
    expect(d.youtube.tags.filter((t) => t.toLowerCase() === 'kafka')).toHaveLength(1);
    expect(d.youtube.description.split('\n\n').length).toBeGreaterThan(1);
    expect(d.origin).toEqual({ youtube: 'ai', social: 'ai' });
    expect(d.model).toBe('fake:test');

    expect(d.social.facebook.text).toBe('Watch the classic now!');
    expect(d.social.facebook.hashtags).toEqual(['BookLovers', 'Kafka']);
    expect(d.social.instagram.text).toContain('link in bio');
    expect(d.social.tiktok.text).toBe('Kafka but make it follow-along.');
    expect(socialLength('x', d.social.x, 'https://youtu.be/xxxxxxxxxxx')).toBeLessThanOrEqual(280);
    expect(d.social.linkedin.text).toBe(base.social.linkedin.text); // empty answer → rule-based post
  });

  it('falls back to the rules for unusable answers', async () => {
    const llm = new FakeLLM([{ titles: [], description: 'too short', primary_keyword: '', tags: [], hashtags: [], category: 'Nope', thumbnail_text: '', pinned_comment: '' }]);
    const base = templateDraft(ctx);
    const d = await generatePublishDraft(llm, { ctx, excerpt: '' }, base, ['youtube'], base.ai);
    expect(d.youtube.title).toBe(base.youtube.title);
    expect(d.youtube.description).toBe(base.youtube.description);
    expect(d.youtube.categoryId).toBe(base.youtube.categoryId);
    expect(d.youtube.hashtags).toContain('Audiobook');
    expect(d.social).toEqual(base.social); // not requested
  });
});

describe.skipIf(!hasFfmpeg)('writing tags into media files (ffmpeg)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-publish-'));
  const cfg = loadConfig({ STORAGE_DIR: tmp, DISK_RESERVE_GB: 0 }, { reload: true });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const make = async () => {
    const meta = path.join(tmp, 'meta.txt');
    fs.writeFileSync(meta, ';FFMETADATA1\ntitle=Old\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=One\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Two\n');
    const srt = path.join(tmp, 's.srt');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n');
    const mp4 = path.join(tmp, 'audiobook.mp4');
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', srt, '-i', meta,
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map_metadata', '3', '-map_chapters', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'mov_text', mp4]);
    const m4a = path.join(tmp, 'audiobook.m4a');
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', meta, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', m4a]);
    const jpg = path.join(tmp, 'cover.jpg');
    await run('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:size=128x72', '-frames:v', '1', jpg]);
    return { mp4, m4a, jpg };
  };

  it('embeds tags and cover art, keeps every stream and chapter, and re-applies cleanly', async () => {
    const { mp4, m4a, jpg } = await make();
    const d = templateDraft(ctx);
    await writeMediaTags(cfg, { file: mp4, kind: 'video', tags: fileTagsFor(d, ctx, 'video'), cover: jpg, language: 'en' });
    let t = await readMediaTags(cfg, mp4);
    expect(t.tags).toMatchObject({ title: 'The Metamorphosis', artist: 'Franz Kafka', genre: 'Audiobook' });
    expect(t.tags.keywords).toContain('Franz Kafka audiobook');
    expect(t.tags.synopsis).toContain('Chapters:');
    expect(t.hasCover).toBe(true);
    expect(t.chapters).toBe(2);
    expect(t.duration).toBeGreaterThan(1.8);

    // Again with a cover: still exactly one cover; without: removed; empty values clear tags.
    await writeMediaTags(cfg, { file: mp4, kind: 'video', tags: { ...fileTagsFor(d, ctx, 'video'), comment: '' }, cover: jpg, language: 'en' });
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream_disposition=attached_pic', '-of', 'json', mp4])) as { streams: { codec_type: string; disposition: { attached_pic: number } }[] };
    expect(probe.streams.filter((s) => s.disposition.attached_pic === 1)).toHaveLength(1);
    expect(probe.streams.some((s) => s.codec_type === 'subtitle')).toBe(true);
    t = await readMediaTags(cfg, mp4);
    expect(t.tags.comment).toBeUndefined();
    await writeMediaTags(cfg, { file: mp4, kind: 'video', tags: { title: 'No cover' }, language: 'en' });
    expect((await readMediaTags(cfg, mp4)).hasCover).toBe(false);

    await writeMediaTags(cfg, { file: m4a, kind: 'audio', tags: fileTagsFor(d, ctx, 'audio'), cover: jpg, language: 'en' });
    const a = await readMediaTags(cfg, m4a);
    expect(a.tags.media_type).toBe('2');
    expect(a.hasCover).toBe(true);
    expect(a.chapters).toBe(2);
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tags.tmp'))).toEqual([]);
  });
});

describe('partial narration (only some chapters)', () => {
  const part: PublishContext = {
    ...ctx,
    durationSec: 2317,
    chapters: [{ title: 'I', start: 0, end: 2317 }],
    coverage: { complete: false, label: 'Chapter I', narratedChapters: 1, totalChapters: 3, pages: [3, 26], narratedWords: 7355, totalWords: 21975 },
  };

  it('names the part', () => {
    expect(partLabel(['I'], 'en')).toBe('Chapter I');
    expect(partLabel(['Part One'], 'en')).toBe('Part One');
    expect(partLabel(['1', '2', '3'], 'en')).toBe('Chapters 1–3');
    expect(partLabel(['I'], 'bn')).toBe('অধ্যায় I');
  });

  it('never promises the whole book in the rule-based draft', () => {
    const d = templateDraft(part);
    expect(d.youtube.title).toBe('The Metamorphosis – Chapter I | Franz Kafka Audiobook with Text');
    for (const t of [d.youtube.title, d.youtube.description, d.thumbnail!.kicker, d.file.comment, ...Object.values(d.social).map((p) => p.text)]) expect(t).not.toMatch(/\b(full|complete)\b/i);
    expect(d.youtube.description).toMatch(/1 of 3 chapters/);
    expect(d.youtube.description).toMatch(/next chapter/);
    expect(d.youtube.tags).not.toContain('full audiobook');
    expect(d.file.title).toBe('The Metamorphosis – Chapter I');
    const r = seoReport(d, part, { thumbnail: true, applied: 'current' });
    expect(r.checks.find((c) => c.id === 'scope')?.status).toBe('pass');
    expect(r.blocking).toBe(0);
  });

  it('fails a draft that says “full audiobook”', () => {
    const d = templateDraft(ctx); // written as if it were the whole book
    const scope = seoReport(d, part, { thumbnail: true, applied: 'current' }).checks.find((c) => c.id === 'scope');
    expect(scope?.status).toBe('fail');
    expect(scope?.detail).toMatch(/title, description, thumbnail/);
  });

  it('ranks and scrubs AI wording', () => {
    expect(scrubTitle('The Metamorphosis Audiobook: Franz Kafka Read-Along')).toBe('The Metamorphosis Audiobook: Franz Kafka');
    expect(scrubTitle('The Metamorphosis – Full Audiobook with Read-Along Text')).toBe('The Metamorphosis – Full Audiobook with Text');
    expect(scrub('A read-along experience. Read along now!', ctx, 'en')).toBe('A follow-along experience. Follow along now!');
    expect(scrub('Enjoy the full audiobook and the complete book.', part, 'en')).toBe('Enjoy the audiobook and the book.');
    const ranked = rankTitles(['The Metamorphosis | Full Audiobook', 'The Metamorphosis – Chapter I | Franz Kafka Audiobook', 'Kafka Read Along'], part, 'Audiobook');
    expect(ranked[0]).toBe('The Metamorphosis – Chapter I | Franz Kafka Audiobook');
  });

  it('tells the model which part it is', async () => {
    const llm = new FakeLLM([{ titles: ['The Metamorphosis Full Audiobook by Franz Kafka'], description: `The full audiobook of ${longText}`, primary_keyword: '', tags: [], hashtags: [], category: 'Education', thumbnail_text: 'Full Audiobook', pinned_comment: '' }]);
    const base = templateDraft(part);
    const d = await generatePublishDraft(llm, { ctx: part, excerpt: '' }, base, ['youtube'], base.ai);
    expect(llm.requests[0].prompt).toContain('THIS VIDEO COVERS ONLY: Chapter I (1 of 3 chapters, pages 3–26)');
    expect(d.youtube.title).toContain('Chapter I');
    expect(d.youtube.description).not.toMatch(/\bfull audiobook\b/i);
    expect(d.youtube.thumbnailText).toBe(base.youtube.thumbnailText);
  });
});
