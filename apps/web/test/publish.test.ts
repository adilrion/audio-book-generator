import { type PublishContext, type PublishDraft, composeDescription } from '@app/types';
import { describe, expect, it } from 'vitest';
import { SEO_TARGET, kitJson, kitText, sameDraft, uploadNames } from '@/lib/publish';

const ctx: PublishContext = {
  title: 'The Metamorphosis',
  author: 'Franz Kafka',
  language: 'en',
  durationSec: 2317,
  pageCount: 77,
  wordCount: 21033,
  chapters: [
    { title: 'I', start: 0, end: 800 },
    { title: 'II', start: 800, end: 1600 },
    { title: 'III', start: 1600, end: 2317 },
  ],
  aspectRatio: '16:9',
  hasVideo: true,
  hasAudio: true,
};

const post = (text: string) => ({ text, hashtags: ['Audiobook'] });
const draft: PublishDraft = {
  version: 1,
  youtube: {
    title: 'The Metamorphosis by Franz Kafka – Full Audiobook',
    titleOptions: [],
    description: 'Listen to the complete The Metamorphosis audiobook.',
    includeChapters: true,
    tags: ['the metamorphosis audiobook', 'franz kafka'],
    hashtags: ['Audiobook', 'Kafka'],
    primaryKeyword: 'the metamorphosis audiobook',
    categoryId: '27',
    language: 'en',
    visibility: 'unlisted',
    madeForKids: false,
    license: 'youtube',
    aiNarrationNote: false,
    pinnedComment: 'Which part stayed with you?',
    thumbnailText: 'The Metamorphosis',
  },
  social: { facebook: post('fb'), instagram: post('ig'), tiktok: post('tt'), x: post('x'), linkedin: post('li') },
  file: { title: 'The Metamorphosis', artist: 'Franz Kafka', album: 'The Metamorphosis', genre: 'Audiobook', year: '2026', copyright: '', comment: '', embedCover: true },
  videoUrl: 'https://youtu.be/abc',
  ai: { language: 'en', tone: 'friendly', keywords: '' },
  origin: { youtube: 'template', social: 'template' },
};

describe('upload kit', () => {
  it('lists everything to paste into YouTube Studio', () => {
    const t = kitText(draft, ctx);
    expect(t).toContain('TITLE\n');
    expect(t).toContain(composeDescription(draft.youtube, ctx.chapters));
    expect(t).toContain('the metamorphosis audiobook, franz kafka');
    expect(t).toContain('Visibility: Unlisted');
    expect(t).toContain('Category: Education');
    expect(t).toContain('FACEBOOK POST\n────');
    expect(t).toContain('fb\n\nhttps://youtu.be/abc\n\n#Audiobook');
  });

  it('exports the YouTube Data API shape', () => {
    const j = kitJson(draft, ctx);
    expect(j.snippet).toMatchObject({ title: draft.youtube.title, categoryId: '27', defaultLanguage: 'en', tags: draft.youtube.tags });
    expect(j.snippet.description).toContain('00:00 I');
    expect(j.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, license: 'youtube' });
  });

  it('names the files after the book', () => {
    expect(uploadNames(ctx)).toEqual({
      video: 'the-metamorphosis-franz-kafka-audiobook.mp4',
      audio: 'the-metamorphosis-franz-kafka-audiobook.m4a',
      thumbnail: 'the-metamorphosis-franz-kafka-audiobook-thumbnail.jpg',
      subtitles: 'the-metamorphosis-franz-kafka-audiobook.srt',
    });
  });

  it('maps every SEO area to a field and compares drafts by value', () => {
    expect(Object.keys(SEO_TARGET).sort()).toEqual(['chapters', 'description', 'engagement', 'file', 'hashtags', 'tags', 'thumbnail', 'title']);
    expect(sameDraft(draft, JSON.parse(JSON.stringify(draft)) as PublishDraft)).toBe(true);
    expect(sameDraft(draft, { ...draft, videoUrl: '' })).toBe(false);
  });
});
