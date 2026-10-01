import {
  type PublishContext,
  type PublishDraft,
  type SocialDraft,
  type SocialPlatform,
  type YouTubeDraft,
  chaptersProblem,
  fitHashtags,
  fitTags,
  YOUTUBE_LIMITS,
} from '@app/types';

/**
 * Rule-based publishing metadata. It is the starting point of every draft and the fallback when
 * the local AI is not available, so a book can always be published without Ollama.
 */

/** "The Metamorphosis" → "TheMetamorphosis" (Bangla words are joined without changing case). */
export function camelTag(s: string): string {
  return s
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase() + w.slice(1))
    .join('');
}

function durationText(sec: number, lang: 'en' | 'bn'): string {
  const total = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (lang === 'bn') return [h ? `${h} ঘণ্টা` : '', m ? `${m} মিনিট` : ''].filter(Boolean).join(' ');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return [h ? plural(h, 'hour') : '', m ? plural(m, 'minute') : ''].filter(Boolean).join(' ');
}

/** The first candidate that fits the visible part of a search result, else the shortest one clipped to 100. */
export function pickTitle(candidates: string[]): string {
  const clean = candidates.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fit = clean.find((c) => [...c].length <= YOUTUBE_LIMITS.titleVisible);
  if (fit) return fit;
  const shortest = [...clean].sort((a, b) => a.length - b.length)[0] ?? 'Audiobook';
  return [...shortest].slice(0, YOUTUBE_LIMITS.title).join('').trim();
}

function englishYouTube(ctx: PublishContext): Omit<YouTubeDraft, 'visibility' | 'madeForKids' | 'license' | 'aiNarrationNote' | 'language' | 'categoryId'> {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const by = a ? ` by ${a}` : '';
  const titles = [`${t}${by} – Full Audiobook with Read-Along Text`, `${t}${by} – Full Audiobook`, `${t} – Full Audiobook with Read-Along Text`, `${t} – Full Audiobook`, t];
  const timed = !chaptersProblem(ctx.chapters);
  const n = ctx.chapters.length;
  const description = [
    `Listen to the complete ${t}${by} as a full audiobook, with every sentence highlighted on the page as it is read — ideal for reading along, building reading skills, or simply enjoying the book hands-free.`,
    `This read-along audiobook covers all ${ctx.pageCount.toLocaleString('en')} pages (about ${ctx.wordCount.toLocaleString('en')} words) in ${durationText(ctx.durationSec, 'en')}${n > 1 ? `, across ${n} chapters` : ''}. Follow the text on screen, pause whenever you like${timed ? ', and use the chapter timestamps below to jump to any part of the book' : ''}.`,
    'If you enjoy it, subscribe for more full-length read-along audiobooks, and tell us in the comments which book you would like to hear next.',
  ].join('\n\n');
  const tags = [
    `${t} audiobook`,
    t,
    ...(a ? [a, `${a} audiobook`, `${t} ${a}`] : []),
    `${t} full audiobook`,
    'audiobook',
    'full audiobook',
    'audiobook with text',
    'read along audiobook',
    'read along',
    'audiobooks',
    'audio book',
    'complete audiobook',
    'book narration',
  ];
  return {
    title: pickTitle(titles),
    titleOptions: [...new Set(titles.slice(0, 3).map((x) => pickTitle([x])))],
    description,
    includeChapters: timed,
    tags: fitTags(tags),
    hashtags: fitHashtags(['Audiobook', camelTag(t), ...(a ? [camelTag(a)] : []), 'ReadAlong', 'FullAudiobook'], 5),
    primaryKeyword: `${t} audiobook`,
    pinnedComment: `Thanks for listening! Which moment from ${t} stayed with you the most? Tell us in the comments — and which book should we narrate next?`,
    thumbnailText: t.length <= 40 ? t : `${t.slice(0, 39).trimEnd()}…`,
  };
}

function banglaYouTube(ctx: PublishContext): ReturnType<typeof englishYouTube> {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const titles = [`${t}${a ? ` – ${a}` : ''} | সম্পূর্ণ অডিওবুক (পাঠসহ)`, `${t}${a ? ` – ${a}` : ''} | সম্পূর্ণ অডিওবুক`, `${t} | সম্পূর্ণ অডিওবুক`, t];
  const timed = !chaptersProblem(ctx.chapters);
  const n = ctx.chapters.length;
  const description = [
    `${a ? `${a}-এর ` : ''}${t} — সম্পূর্ণ অডিওবুক। শোনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয়, তাই শুনতে শুনতে সঙ্গে সঙ্গে পড়তেও পারবেন।`,
    `এই অডিওবুকে বইটির ${ctx.pageCount} পৃষ্ঠা (প্রায় ${ctx.wordCount.toLocaleString('en')} শব্দ) রয়েছে, মোট সময় ${durationText(ctx.durationSec, 'bn')}${n > 1 ? `, ${n}টি অধ্যায়ে` : ''}। যেকোনো সময় থামিয়ে পড়ুন${timed ? ', আর নিচের সময়সূচি থেকে যেকোনো অধ্যায়ে চলে যান' : ''}।`,
    'ভালো লাগলে চ্যানেলটি সাবস্ক্রাইব করুন, আর কমেন্টে জানান পরের কোন বইটি শুনতে চান।',
  ].join('\n\n');
  const tags = [
    `${t} অডিওবুক`,
    t,
    ...(a ? [a, `${a} অডিওবুক`, `${t} ${a}`] : []),
    'অডিওবুক',
    'বাংলা অডিওবুক',
    'সম্পূর্ণ অডিওবুক',
    'bangla audiobook',
    'bengali audiobook',
    `${t} audiobook`,
    'audiobook',
    'বাংলা গল্প',
    'গল্প পাঠ',
  ];
  return {
    title: pickTitle(titles),
    titleOptions: [...new Set(titles.slice(0, 3).map((x) => pickTitle([x])))],
    description,
    includeChapters: timed,
    tags: fitTags(tags),
    hashtags: fitHashtags(['অডিওবুক', camelTag(t), 'BanglaAudiobook', ...(a ? [camelTag(a)] : []), 'বাংলা'], 5),
    primaryKeyword: `${t} অডিওবুক`,
    pinnedComment: `শোনার জন্য ধন্যবাদ! ${t}-এর কোন অংশটি আপনার সবচেয়ে ভালো লেগেছে? কমেন্টে জানান — আর পরের কোন বইটি শুনতে চান?`,
    thumbnailText: t.length <= 40 ? t : `${t.slice(0, 39).trimEnd()}…`,
  };
}

export function templateSocial(ctx: PublishContext, lang: 'en' | 'bn'): Record<SocialPlatform, SocialDraft> {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const ct = camelTag(t);
  const ca = a ? camelTag(a) : '';
  const d = durationText(ctx.durationSec, lang);
  if (lang === 'bn') {
    const of = a ? `${a}-এর ` : '';
    return {
      facebook: { text: `এখন ইউটিউবে: ${of}${t} — সম্পূর্ণ অডিওবুক, পাঠসহ। শোনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয়। মোট ${d}।`, hashtags: fitHashtags(['অডিওবুক', ct], 3) },
      instagram: { text: `📖 ${of}${t} — সম্পূর্ণ অডিওবুক\n\nশুনুন আর সঙ্গে পড়ুন: প্রতিটি বাক্য পাতায় হাইলাইট হয়।\n\n🎧 ${d} · লিংক বায়োতে`, hashtags: fitHashtags(['অডিওবুক', 'বাংলাবই', ct, 'BanglaAudiobook', 'বইপড়া', ...(ca ? [ca] : [])], 10) },
      tiktok: { text: `${t} — পুরো অডিওবুক, পাঠসহ 📖 প্রতিটি বাক্য পাতায় হাইলাইট হয়।`, hashtags: fitHashtags(['অডিওবুক', 'BookTok', ct, 'BanglaAudiobook'], 5) },
      x: { text: `${of}${t} — সম্পূর্ণ অডিওবুক, পাঠসহ 🎧📖`, hashtags: fitHashtags(['অডিওবুক', ct], 2) },
      linkedin: { text: `চলতে চলতে পড়া: ${of}${t} এখন পাঠসহ অডিওবুক হিসেবে। বর্ণনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয় — শুনুন, পড়ুন, অথবা দুটোই। মোট ${d}।`, hashtags: fitHashtags(['অডিওবুক', 'বইপড়া', 'Learning'], 4) },
    };
  }
  const by = a ? ` by ${a}` : '';
  return {
    facebook: { text: `Now on YouTube: the complete ${t}${by} as a read-along audiobook — listen while every sentence is highlighted on the page. ${d} of narration.`, hashtags: fitHashtags(['Audiobook', ct], 3) },
    instagram: {
      text: `📖 ${t}${by} — the full audiobook\n\nListen and read along: every sentence lights up on the page as it is read.\n\n🎧 ${d} · link in bio`,
      hashtags: fitHashtags(['Audiobook', 'ReadAlong', 'Bookstagram', ct, ...(ca ? [ca] : []), 'Books', 'Reading'], 10),
    },
    tiktok: { text: `The full ${t} audiobook — read along as every sentence lights up 📖`, hashtags: fitHashtags(['BookTok', 'Audiobook', ct, 'ReadAlong'], 5) },
    x: { text: `The complete ${t}${by}, as a read-along audiobook 🎧📖`, hashtags: fitHashtags(['Audiobook', ct], 2) },
    linkedin: {
      text: `Reading on the go: ${t}${by} is now a read-along audiobook. Every sentence is highlighted on the page as it is narrated, so you can listen, read, or both. ${d}.`,
      hashtags: fitHashtags(['Audiobooks', 'Reading', 'Learning'], 4),
    },
  };
}

/** A complete draft from the book's facts alone. */
export function templateDraft(ctx: PublishContext, now = new Date()): PublishDraft {
  const lang = ctx.language;
  const yt = lang === 'bn' ? banglaYouTube(ctx) : englishYouTube(ctx);
  return {
    version: 1,
    youtube: { ...yt, categoryId: '27', language: lang, visibility: 'public', madeForKids: false, license: 'youtube', aiNarrationNote: true },
    social: templateSocial(ctx, lang),
    file: {
      title: ctx.title.trim(),
      artist: ctx.author?.trim() ?? '',
      album: ctx.title.trim(),
      genre: lang === 'bn' ? 'অডিওবুক' : 'Audiobook',
      year: String(now.getFullYear()),
      copyright: '',
      comment: lang === 'bn' ? `পাঠসহ অডিওবুক · ${durationText(ctx.durationSec, 'bn')}` : `Read-along audiobook · ${durationText(ctx.durationSec, 'en')}`,
      embedCover: true,
    },
    thumbnail: { layout: 'cover', kicker: lang === 'bn' ? 'সম্পূর্ণ অডিওবুক' : 'Full audiobook', accent: '#FFD54F', showAuthor: true, showBadge: true },
    videoUrl: '',
    ai: { language: lang, tone: 'friendly', keywords: '' },
    origin: { youtube: 'template', social: 'template' },
  };
}
