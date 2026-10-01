import {
  type PublishContext,
  type PublishDraft,
  type SocialDraft,
  type SocialPlatform,
  type YouTubeDraft,
  chaptersProblem,
  fitHashtags,
  fitTags,
  isPartial,
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

type YouTubeWords = Omit<YouTubeDraft, 'visibility' | 'madeForKids' | 'license' | 'aiNarrationNote' | 'language' | 'categoryId'>;

/** The narrated part ("Chapter I") when the video is not the whole book. */
const partOf = (ctx: PublishContext) => (isPartial(ctx) ? ctx.coverage?.label || 'Part 1' : undefined);

const short = (t: string) => (t.length <= 40 ? t : `${t.slice(0, 39).trimEnd()}…`);

function englishYouTube(ctx: PublishContext): YouTubeWords {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const by = a ? ` by ${a}` : '';
  const part = partOf(ctx);
  const cov = ctx.coverage;
  const timed = !chaptersProblem(ctx.chapters);
  const n = ctx.chapters.length;
  const focus = 'Each sentence is highlighted as it is spoken, which makes it easy to stay focused, enjoy the original text, or improve your reading and your English.';
  // Title, author and format first — "Full Audiobook with Text" is how people search for this kind of video.
  // A partial narration says which part it is instead of promising the whole book.
  const titles = part
    ? [`${t} – ${part} | ${a ? `${a} ` : ''}Audiobook with Text`, `${t}${by} | ${part} Audiobook`, `${t} – ${part} | Audiobook with Text`, `${t} – ${part} | Audiobook`, `${t} – ${part}`]
    : [`${t}${by} | Full Audiobook with Text`, `${t}${by} | Full Audiobook`, `${t} | Full Audiobook with Text`, `${t} | Full Audiobook`, t];
  const description = (
    part
      ? [
          `${part} of ${t}${by} — as an audiobook, with the book’s own pages on screen so you can follow every word as it is read.`,
          `In this ${durationText(ctx.durationSec, 'en')} video: ${part}${cov?.pages ? ` (pages ${cov.pages[0]}–${cov.pages[1]}` : ' ('}${cov?.narratedWords ? `${cov.pages ? ', ' : ''}about ${cov.narratedWords.toLocaleString('en')} words` : ''})${cov?.totalChapters ? `, ${cov.narratedChapters} of ${cov.totalChapters} chapters` : ''}. ${focus} Pause whenever you like and pick up right where you left off.`,
          'Subscribe so you don’t miss the next chapter, and tell us in the comments what you think so far.',
        ]
      : [
          `${t}${by} — the full audiobook, with the book’s own pages on screen so you can follow every word as it is read.`,
          `Sit back and enjoy the complete book in ${durationText(ctx.durationSec, 'en')}${n > 1 ? `, across ${n} chapters` : ''}: all ${ctx.pageCount.toLocaleString('en')} pages, about ${ctx.wordCount.toLocaleString('en')} words, narrated from start to finish. ${focus}${timed ? ' Use the chapter timestamps below to jump straight to any part of the book.' : ''}`,
          'If you enjoy it, subscribe for more full audiobooks with text, and tell us in the comments which book you want to hear next.',
        ]
  )
    .join('\n\n')
    .replace(' () ', ' ')
    .replace(' ()', '');
  const tags = [
    `${t} audiobook`,
    t,
    ...(a ? [a, `${a} audiobook`, `${t} ${a}`] : []),
    ...(part ? [`${t} ${part}`.toLowerCase(), `${t} audiobook ${part}`.toLowerCase()] : [`${t} full audiobook`]),
    'audiobook',
    ...(part ? [] : ['full audiobook']),
    'audiobook with text',
    'audiobook with subtitles',
    ...(part ? [] : ['complete audiobook']),
    'audiobooks',
    'audio book',
    `${t} book`,
    'english audiobook',
    'read along audiobook',
  ];
  return {
    title: pickTitle(titles),
    titleOptions: [...new Set(titles.slice(0, 3).map((x) => pickTitle([x])))],
    description,
    includeChapters: timed,
    tags: fitTags(tags),
    hashtags: fitHashtags(['Audiobook', camelTag(t), ...(a ? [camelTag(a)] : []), ...(part ? [] : ['FullAudiobook']), 'AudiobookWithText'], 5),
    primaryKeyword: `${t} audiobook`,
    pinnedComment: part
      ? `Thanks for listening to ${part} of ${t}! What do you think so far — and should we narrate the next chapter?`
      : `Thanks for listening! What did you think of ${t}? Tell us in the comments — and which book should we narrate next?`,
    thumbnailText: short(t),
  };
}

function banglaYouTube(ctx: PublishContext): YouTubeWords {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const of = a ? `${a}-এর ` : '';
  const part = partOf(ctx);
  const cov = ctx.coverage;
  const timed = !chaptersProblem(ctx.chapters);
  const n = ctx.chapters.length;
  const dash = a ? ` – ${a}` : '';
  const titles = part
    ? [`${t} – ${part}${dash} | অডিওবুক (পাঠসহ)`, `${t} – ${part} | অডিওবুক (পাঠসহ)`, `${t} – ${part} | অডিওবুক`, `${t} – ${part}`]
    : [`${t}${dash} | সম্পূর্ণ অডিওবুক (পাঠসহ)`, `${t}${dash} | সম্পূর্ণ অডিওবুক`, `${t} | সম্পূর্ণ অডিওবুক`, t];
  const description = (
    part
      ? [
          `${of}${t} — ${part}, অডিওবুক। শোনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয়, তাই শুনতে শুনতে সঙ্গে সঙ্গে পড়তেও পারবেন।`,
          `এই ভিডিওতে ${part}${cov?.pages ? ` (পৃষ্ঠা ${cov.pages[0]}–${cov.pages[1]})` : ''}${cov?.totalChapters ? `, ${cov.totalChapters}টি অধ্যায়ের মধ্যে ${cov.narratedChapters}টি` : ''}, মোট সময় ${durationText(ctx.durationSec, 'bn')}। যেকোনো সময় থামিয়ে পড়ুন, আবার সেখান থেকেই শুরু করুন।`,
          'পরের অধ্যায় যেন মিস না হয়, তাই চ্যানেলটি সাবস্ক্রাইব করুন, আর কমেন্টে জানান কেমন লাগছে।',
        ]
      : [
          `${of}${t} — সম্পূর্ণ অডিওবুক। শোনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয়, তাই শুনতে শুনতে সঙ্গে সঙ্গে পড়তেও পারবেন।`,
          `এই অডিওবুকে বইটির ${ctx.pageCount} পৃষ্ঠা (প্রায় ${ctx.wordCount.toLocaleString('en')} শব্দ) রয়েছে, মোট সময় ${durationText(ctx.durationSec, 'bn')}${n > 1 ? `, ${n}টি অধ্যায়ে` : ''}। যেকোনো সময় থামিয়ে পড়ুন${timed ? ', আর নিচের সময়সূচি থেকে যেকোনো অধ্যায়ে চলে যান' : ''}।`,
          'ভালো লাগলে চ্যানেলটি সাবস্ক্রাইব করুন, আর কমেন্টে জানান পরের কোন বইটি শুনতে চান।',
        ]
  ).join('\n\n');
  const tags = [
    `${t} অডিওবুক`,
    t,
    ...(a ? [a, `${a} অডিওবুক`, `${t} ${a}`] : []),
    ...(part ? [`${t} ${part}`] : []),
    'অডিওবুক',
    'বাংলা অডিওবুক',
    ...(part ? [] : ['সম্পূর্ণ অডিওবুক']),
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
    hashtags: fitHashtags(['অডিওবুক', camelTag(t), ...(a ? [camelTag(a)] : []), 'BanglaAudiobook', 'বাংলা'], 5),
    primaryKeyword: `${t} অডিওবুক`,
    pinnedComment: part
      ? `শোনার জন্য ধন্যবাদ! ${t}-এর ${part} কেমন লাগল? কমেন্টে জানান — পরের অধ্যায়টি কি শুনতে চান?`
      : `শোনার জন্য ধন্যবাদ! ${t}-এর কোন অংশটি আপনার সবচেয়ে ভালো লেগেছে? কমেন্টে জানান — আর পরের কোন বইটি শুনতে চান?`,
    thumbnailText: short(t),
  };
}

export function templateSocial(ctx: PublishContext, lang: 'en' | 'bn'): Record<SocialPlatform, SocialDraft> {
  const t = ctx.title.trim();
  const a = ctx.author?.trim();
  const ct = camelTag(t);
  const ca = a ? camelTag(a) : '';
  const d = durationText(ctx.durationSec, lang);
  const part = partOf(ctx);
  if (lang === 'bn') {
    const of = a ? `${a}-এর ` : '';
    const what = part ? `${part}, অডিওবুক` : 'সম্পূর্ণ অডিওবুক';
    return {
      facebook: { text: `এখন ইউটিউবে: ${of}${t} — ${what}, পাঠসহ। শোনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয়। মোট ${d}।`, hashtags: fitHashtags(['অডিওবুক', ct], 3) },
      instagram: { text: `📖 ${of}${t} — ${what}\n\nশুনুন আর সঙ্গে পড়ুন: প্রতিটি বাক্য পাতায় হাইলাইট হয়।\n\n🎧 ${d} · লিংক বায়োতে`, hashtags: fitHashtags(['অডিওবুক', 'বাংলাবই', ct, 'BanglaAudiobook', 'বইপড়া', ...(ca ? [ca] : [])], 10) },
      tiktok: { text: `${t} — ${what}, পাঠসহ 📖 প্রতিটি বাক্য পাতায় হাইলাইট হয়।`, hashtags: fitHashtags(['অডিওবুক', 'BookTok', ct, 'BanglaAudiobook'], 5) },
      x: { text: `${of}${t} — ${what}, পাঠসহ 🎧📖`, hashtags: fitHashtags(['অডিওবুক', ct], 2) },
      linkedin: { text: `চলতে চলতে পড়া: ${of}${t}${part ? ` (${part})` : ''} এখন পাঠসহ অডিওবুক হিসেবে। বর্ণনার সময় প্রতিটি বাক্য পাতায় হাইলাইট হয় — শুনুন, পড়ুন, অথবা দুটোই। মোট ${d}।`, hashtags: fitHashtags(['অডিওবুক', 'বইপড়া', 'Learning'], 4) },
    };
  }
  const by = a ? ` by ${a}` : '';
  const what = part ? `${part}, as an audiobook` : 'the full audiobook';
  return {
    facebook: { text: `🎧 New on YouTube: ${t}${by} — ${what}, with the text on screen so you can follow every word. ${d} of listening, free to watch.`, hashtags: fitHashtags(['Audiobook', ct], 3) },
    instagram: {
      text: `📖 ${t}${by} — ${what}\n\nPress play and follow along: every sentence lights up on the page as it is read.\n\n🎧 ${d} · link in bio`,
      hashtags: fitHashtags(['Audiobook', 'Bookstagram', ct, ...(ca ? [ca] : []), 'BookLovers', 'Books', 'Reading'], 10),
    },
    tiktok: {
      text: part ? `Start ${t} the easy way — ${part}, with every sentence lighting up on the page 📖` : `Finally get through ${t} — the full audiobook, with every sentence lighting up on the page 📖`,
      hashtags: fitHashtags(['BookTok', 'Audiobook', ct, 'BookRecommendations'], 5),
    },
    x: { text: `${t}${by} — ${what}, with the text on screen 🎧📖`, hashtags: fitHashtags(['Audiobook', ct], 2) },
    linkedin: {
      text: `Reading on the go: ${t}${by}${part ? ` (${part})` : ''} is now an audiobook with the text on screen. Every sentence is highlighted as it is narrated, so you can listen, read, or both. ${d}.`,
      hashtags: fitHashtags(['Audiobooks', 'Reading', 'Learning'], 4),
    },
  };
}

/** A complete draft from the book's facts alone. */
export function templateDraft(ctx: PublishContext, now = new Date()): PublishDraft {
  const lang = ctx.language;
  const part = partOf(ctx);
  const yt = lang === 'bn' ? banglaYouTube(ctx) : englishYouTube(ctx);
  return {
    version: 1,
    youtube: { ...yt, categoryId: '27', language: lang, visibility: 'public', madeForKids: false, license: 'youtube', aiNarrationNote: true },
    social: templateSocial(ctx, lang),
    file: {
      title: part ? `${ctx.title.trim()} – ${part}` : ctx.title.trim(),
      artist: ctx.author?.trim() ?? '',
      album: ctx.title.trim(),
      genre: lang === 'bn' ? 'অডিওবুক' : 'Audiobook',
      year: String(now.getFullYear()),
      copyright: '',
      comment:
        lang === 'bn'
          ? `${part ? `${part} · ` : ''}পাঠসহ অডিওবুক · ${durationText(ctx.durationSec, 'bn')}`
          : `${part ? `${part} · audiobook` : 'Full audiobook'} with text · ${durationText(ctx.durationSec, 'en')}`,
      embedCover: true,
    },
    thumbnail: { layout: 'cover', kicker: part ?? (lang === 'bn' ? 'সম্পূর্ণ অডিওবুক' : 'Full audiobook'), accent: '#FFD54F', showAuthor: true, showBadge: true },
    videoUrl: '',
    ai: { language: lang, tone: 'friendly', keywords: '' },
    origin: { youtube: 'template', social: 'template' },
  };
}
