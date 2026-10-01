import {
  type PublishContext,
  type PublishDraft,
  type SeoArea,
  SOCIAL_PLATFORMS,
  SOCIAL_RULES,
  YOUTUBE_CATEGORIES,
  composeDescription,
  composeSocial,
  uploadFileName,
} from '@app/types';

/** Sections of the Publish tab. */
export type PublishSection = 'youtube' | 'thumbnail' | 'social' | 'file' | 'kit';

/** Where an SEO check is fixed: the section and the field to focus. */
export const SEO_TARGET: Record<SeoArea, { section: PublishSection; field: string }> = {
  title: { section: 'youtube', field: 'pub-title' },
  description: { section: 'youtube', field: 'pub-description' },
  chapters: { section: 'youtube', field: 'pub-chapters' },
  tags: { section: 'youtube', field: 'pub-tags' },
  hashtags: { section: 'youtube', field: 'pub-hashtags' },
  engagement: { section: 'youtube', field: 'pub-pinned' },
  thumbnail: { section: 'thumbnail', field: 'pub-thumbnail' },
  file: { section: 'file', field: 'pub-file' },
};

export const VISIBILITY_LABELS = { public: 'Public', unlisted: 'Unlisted', private: 'Private' } as const;
export const LICENSE_LABELS = { youtube: 'Standard YouTube License', creativeCommon: 'Creative Commons – Attribution' } as const;
export const LANGUAGE_LABELS = { en: 'English', bn: 'Bangla (বাংলা)' } as const;

export const categoryLabel = (id: string) => YOUTUBE_CATEGORIES.find((c) => c.id === id)?.label ?? `Category ${id}`;

export const sameDraft = (a: PublishDraft | undefined, b: PublishDraft | undefined) => JSON.stringify(a) === JSON.stringify(b);

export function cloneDraft(d: PublishDraft): PublishDraft {
  return JSON.parse(JSON.stringify(d)) as PublishDraft;
}

/** Descriptive upload file names ("the-metamorphosis-franz-kafka-audiobook.mp4"). */
export function uploadNames(ctx: PublishContext) {
  const parts = [ctx.title, ctx.author, ctx.language === 'bn' ? 'অডিওবুক' : 'audiobook'];
  return {
    video: uploadFileName(parts, 'mp4'),
    audio: uploadFileName(parts, 'm4a'),
    thumbnail: uploadFileName([...parts, 'thumbnail'], 'jpg'),
    subtitles: uploadFileName(parts, 'srt'),
  };
}

/** Everything to paste into YouTube Studio and the social apps, as one text file. */
export function kitText(draft: PublishDraft, ctx: PublishContext): string {
  const yt = draft.youtube;
  const rule = '─'.repeat(48);
  const section = (title: string, body: string) => `${title}\n${rule}\n${body.trim()}\n`;
  const out = [
    `${ctx.title}${ctx.author ? ` — ${ctx.author}` : ''}\nUpload kit · Read-Along Studio\n`,
    section('TITLE', yt.title),
    section('DESCRIPTION', composeDescription(yt, ctx.chapters)),
    section('TAGS (paste into the Tags field)', yt.tags.join(', ')),
    section('PINNED COMMENT', yt.pinnedComment),
    section(
      'UPLOAD SETTINGS',
      [
        `Category: ${categoryLabel(yt.categoryId)}`,
        `Video language: ${LANGUAGE_LABELS[yt.language]}`,
        `Audience: ${yt.madeForKids ? 'Yes, it’s made for kids' : 'No, it’s not made for kids'}`,
        `Visibility: ${VISIBILITY_LABELS[yt.visibility]}`,
        `License: ${LICENSE_LABELS[yt.license]}`,
        'Altered or synthetic content: usually “No” — a generic text-to-speech voice reading a book is not realistic altered content. Choose “Yes” if the voice imitates a real person.',
        'Subtitles: upload subtitles.srt under Subtitles so captions are searchable.',
        'Rights: only publish books that are in the public domain or that you have the rights to.',
      ].join('\n'),
    ),
    ...SOCIAL_PLATFORMS.map((p) => section(`${SOCIAL_RULES[p].label.toUpperCase()} POST`, composeSocial(draft.social[p], draft.videoUrl))),
  ];
  return out.join('\n');
}

/** The YouTube metadata in the shape of the YouTube Data API (videos.insert), for scripts and tools. */
export function kitJson(draft: PublishDraft, ctx: PublishContext) {
  const yt = draft.youtube;
  return {
    snippet: {
      title: yt.title,
      description: composeDescription(yt, ctx.chapters),
      tags: yt.tags,
      categoryId: yt.categoryId,
      defaultLanguage: yt.language,
      defaultAudioLanguage: yt.language,
    },
    status: { privacyStatus: yt.visibility, selfDeclaredMadeForKids: yt.madeForKids, license: yt.license },
    pinnedComment: yt.pinnedComment,
    social: Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, composeSocial(draft.social[p], draft.videoUrl)])),
    file: draft.file,
  };
}

/** Save text as a download (no server round-trip). */
export function downloadText(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
