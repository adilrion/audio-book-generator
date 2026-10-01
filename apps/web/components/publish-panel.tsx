'use client';

import {
  type FileTagsDraft,
  type ProjectDetail,
  type PublishAiOptions,
  type PublishDraft,
  type PublishState,
  type SeoCheck,
  type SocialPlatform,
  type ThumbnailDesign,
  type YouTubeDraft,
  SOCIAL_PLATFORMS,
  SOCIAL_RULES,
  YOUTUBE_CATEGORIES,
  YOUTUBE_LIMITS,
  chapterLines,
  chaptersProblem,
  composeDescription,
  composeSocial,
  fileTagsFor,
  sanitizeHashtag,
  sanitizeTag,
  seoReport,
  socialLength,
  youtubeTagChars,
} from '@app/types';
import {
  Captions,
  ChevronDown,
  CircleCheck,
  CircleStop,
  Download,
  FileJson,
  FileText,
  Film,
  ImageIcon,
  Info,
  LoaderCircle,
  Megaphone,
  Music,
  PackageCheck,
  Rocket,
  Save,
  Sparkles,
  Tags,
  TriangleAlert,
  Type,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { CopyButton } from '@/components/copy-button';
import { CharCount, Meter, PubField, TagInput } from '@/components/publish-fields';
import { SearchPreview, SocialPreview, WatchPreview } from '@/components/publish-preview';
import { SeoChecklist } from '@/components/seo-checklist';
import { FormSection } from '@/components/settings-form';
import { ThumbnailDesigner } from '@/components/thumbnail-designer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { type ApiError, api, apiUrl, outputUrl, toApiError } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import {
  LANGUAGE_LABELS,
  LICENSE_LABELS,
  type PublishSection,
  SEO_TARGET,
  VISIBILITY_LABELS,
  categoryLabel,
  cloneDraft,
  downloadText,
  kitJson,
  kitText,
  sameDraft,
  uploadNames,
} from '@/lib/publish';
import { type Phase } from '@/lib/stages';
import { DEFAULT_DESIGN } from '@/lib/thumbnail';
import { cn } from '@/lib/utils';

const SECTIONS: { value: PublishSection; label: string; icon: typeof Film }[] = [
  { value: 'youtube', label: 'YouTube', icon: Film },
  { value: 'thumbnail', label: 'Thumbnail', icon: ImageIcon },
  { value: 'social', label: 'Social posts', icon: Megaphone },
  { value: 'file', label: 'File metadata', icon: Tags },
  { value: 'kit', label: 'Upload kit', icon: PackageCheck },
];

const TONES: { value: PublishAiOptions['tone']; label: string }[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'literary', label: 'Literary' },
  { value: 'energetic', label: 'Energetic' },
  { value: 'academic', label: 'For students' },
];

/** The tags shown in the "will be written / in the file now" comparison, in this order. */
const SHOWN_TAGS: [key: string, label: string][] = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['genre', 'Genre'],
  ['date', 'Year'],
  ['comment', 'Comment'],
  ['copyright', 'Copyright'],
  ['description', 'Description'],
  ['keywords', 'Keywords'],
];

type Busy = { kind: 'save' | 'apply' } | { kind: 'generate'; sections: ('youtube' | 'social')[]; started: number };

function PublishPlaceholder({ phase }: { phase: Phase }) {
  const working = phase === 'active' || phase === 'queued';
  return (
    <div className="grid justify-items-center gap-5 rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Rocket className="size-6" aria-hidden />
      </span>
      <div className="grid max-w-md gap-1.5">
        <p className="text-[15px] font-medium">Publishing tools unlock when the audiobook is ready</p>
        <p className="text-sm text-muted-foreground">
          {working
            ? 'The book is being processed — come back when the video or audiobook has been created.'
            : 'Process the book first. Then write the YouTube title, description, tags and thumbnail here, preview them, and embed the metadata in the files.'}
        </p>
      </div>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="tabular">{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}

function ToggleRow({ label, description, checked, onCheckedChange, disabled, children }: { label: ReactNode; description?: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-3 px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor={id} className="text-[13px]">
            {label}
          </Label>
          {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
      </div>
      {children}
    </div>
  );
}

/** A labelled value with a copy button, for the upload kit. */
function KitRow({ icon, label, value, children }: { icon: ReactNode; label: string; value?: string; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm font-medium">{label}</p>
        {value !== undefined && <p className="truncate text-xs text-muted-foreground">{value || '—'}</p>}
      </div>
      {children}
      {value !== undefined && value && <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />}
    </li>
  );
}

/**
 * The Publish tab: AI-written (or rule-based) YouTube metadata, thumbnail, social posts and file
 * tags; live YouTube-style previews and SEO checks; embedding the metadata in the finished files;
 * and an upload kit with everything to paste into YouTube Studio.
 */
export function PublishPanel({ project, phase, onDirtyChange }: { project: ProjectDetail; phase: Phase; onDirtyChange?: (dirty: boolean) => void }) {
  const id = project.id;
  const ready = project.outputs.some((o) => o.name === 'audiobook.mp4' || o.name === 'audiobook.m4a');
  const outputsSig = project.outputs.map((o) => `${o.name}:${o.size}`).join('|');
  const state = useApi(ready ? `publish:${id}:${outputsSig}` : null, (signal) => api.publish(id, signal));

  const [draft, setDraft] = useState<PublishDraft>();
  const lastServer = useRef<PublishDraft | undefined>(undefined);
  const [section, setSection] = useState<PublishSection>('youtube');
  const [preview, setPreview] = useState<'watch' | 'search' | 'social'>('watch');
  const [platform, setPlatform] = useState<SocialPlatform>('facebook');
  const [livePreview, setLivePreview] = useState<string>();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<ApiError>();
  const [confirm, setConfirm] = useState<('youtube' | 'social')[] | null>(null);
  const [notice, setNotice] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const ids = { title: 'pub-title', desc: 'pub-description', keyword: useId(), pinned: 'pub-pinned', tags: 'pub-tags', hashtags: 'pub-hashtags', url: useId(), keywords: useId() };

  const s = state.data;
  const { mutate } = state;

  // Adopt the server's draft unless there are unsaved edits.
  useEffect(() => {
    if (!s) return;
    setDraft((d) => (!d || sameDraft(d, lastServer.current) ? cloneDraft(s.draft) : d));
    lastServer.current = s.draft;
  }, [s]);

  const dirty = !!draft && !!s && !sameDraft(draft, s.draft);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => abort.current?.abort(), []);

  const adopt = useCallback(
    (fresh: PublishState) => {
      lastServer.current = fresh.draft;
      setDraft(cloneDraft(fresh.draft));
      mutate(fresh);
    },
    [mutate],
  );

  const running = phase === 'active' || phase === 'queued';
  const ctx = s?.context;
  const appliedState = !s?.applied ? 'none' : s.applied.stale.length || dirty ? 'stale' : 'current';
  const report = useMemo(() => (draft && ctx ? seoReport(draft, ctx, { thumbnail: !!s?.thumbnail, applied: appliedState }) : undefined), [draft, ctx, s?.thumbnail, appliedState]);
  const names = useMemo(() => (ctx ? uploadNames(ctx) : undefined), [ctx]);

  if (!ready) return <PublishPlaceholder phase={phase} />;
  if (state.error && !s) return <ApiErrorAlert error={state.error} title="The publishing data could not be loaded" onRetry={() => void state.refresh()} />;
  if (!s || !draft || !ctx || !report || !names) return <Skeleton className="h-[640px] w-full rounded-2xl" />;

  const yt = draft.youtube;
  const design = draft.thumbnail ?? DEFAULT_DESIGN;
  const setYt = (patch: Partial<YouTubeDraft>) => setDraft((d) => d && { ...d, youtube: { ...d.youtube, ...patch } });
  const setFile = (patch: Partial<FileTagsDraft>) => setDraft((d) => d && { ...d, file: { ...d.file, ...patch } });
  const setAi = (patch: Partial<PublishAiOptions>) => setDraft((d) => d && { ...d, ai: { ...d.ai, ...patch } });
  const setSocial = (p: SocialPlatform, patch: Partial<PublishDraft['social'][SocialPlatform]>) =>
    setDraft((d) => d && { ...d, social: { ...d.social, [p]: { ...d.social[p], ...patch } } });
  const setDesign = (t: ThumbnailDesign) => setDraft((d) => d && { ...d, thumbnail: t });

  const thumbSrc = livePreview ?? (s.thumbnail ? `${apiUrl(s.thumbnail.url)}?inline=1&v=${s.thumbnail.size}` : undefined);
  const fullDescription = composeDescription(yt, ctx.chapters);
  const tagChars = youtubeTagChars(yt.tags);
  const chProblem = chaptersProblem(ctx.chapters);
  const hasSrt = project.outputs.some((o) => o.name === 'subtitles.srt');
  const working = !!busy;

  const save = async () => {
    setBusy({ kind: 'save' });
    setError(undefined);
    try {
      adopt(await api.savePublish(id, draft));
      setNotice('Saved.');
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const generate = async (sections: ('youtube' | 'social')[]) => {
    setConfirm(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy({ kind: 'generate', sections, started: Date.now() });
    setError(undefined);
    setNotice(undefined);
    try {
      const fresh = await api.generatePublish(id, { sections, draft, options: draft.ai }, ctrl.signal);
      adopt(fresh);
      setLivePreview(undefined);
      setNotice(sections.length === 2 ? 'New YouTube metadata and social posts are ready — review them before you upload.' : sections[0] === 'youtube' ? 'New YouTube metadata is ready — review it before you upload.' : 'New social posts are ready.');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError(toApiError(e));
    } finally {
      abort.current = null;
      setBusy(null);
    }
  };

  const askGenerate = (sections: ('youtube' | 'social')[]) => (s.saved ? setConfirm(sections) : void generate(sections));

  const apply = async () => {
    setBusy({ kind: 'apply' });
    setError(undefined);
    setNotice(undefined);
    try {
      if (dirty) adopt(await api.savePublish(id, draft));
      adopt(await api.applyPublish(id));
      setNotice('The metadata is now embedded in the files.');
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  };

  const jump = (c: SeoCheck) => {
    const t = SEO_TARGET[c.area];
    setSection(t.section);
    window.setTimeout(() => {
      const el = document.getElementById(t.field);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus({ preventScroll: true });
    }, 50);
  };

  const pickSection = (v: PublishSection) => {
    setSection(v);
    if (v === 'social') setPreview('social');
    else if (preview === 'social') setPreview('watch');
  };

  const ai = s.llm;
  const generating = busy?.kind === 'generate' ? busy : null;
  const appliedNote = s.applied
    ? s.applied.stale.includes('files')
      ? { tone: 'warn' as const, text: 'The files were re-created by a later run, so the metadata was lost. Apply it again.' }
      : s.applied.stale.includes('draft') || dirty
        ? { tone: 'info' as const, text: `Applied ${formatRelative(s.applied.at)} — the draft has changed since. Apply again to update the files.` }
        : { tone: 'ok' as const, text: `Embedded in ${s.applied.files.join(' and ')} ${formatRelative(s.applied.at)}${s.applied.cover ? ', with cover art' : ''}.` }
    : undefined;

  return (
    <div className="grid gap-6">
      {/* ── Toolbar ── */}
      <div className="grid gap-4 rounded-2xl border bg-card p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <p className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
              <Rocket className="size-4 text-muted-foreground" aria-hidden /> Publish kit
              {dirty && <Badge variant="info">Unsaved</Badge>}
            </p>
            <p className="text-sm text-muted-foreground">
              {ai.available ? (
                <>
                  Local AI ready <span className="font-mono text-xs">({ai.model})</span>
                </>
              ) : (
                <span title={ai.message}>Local AI unavailable — {ai.message.replace(/\.$/, '')}. The rule-based draft below still works.</span>
              )}
              {' · '}
              {draft.origin.youtube === 'ai' ? `YouTube text written by AI${draft.generatedAt ? ` ${formatRelative(draft.generatedAt)}` : ''}` : 'Rule-based starting draft'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {generating ? (
              <>
                <span className="flex items-center gap-2 rounded-lg bg-info/10 px-3 py-1.5 text-sm text-info" aria-live="polite">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  Writing {generating.sections.length === 2 ? 'everything' : generating.sections[0] === 'youtube' ? 'YouTube metadata' : 'social posts'}… <Elapsed since={generating.started} />
                </span>
                <Button variant="outline" size="sm" onClick={() => abort.current?.abort()}>
                  <CircleStop aria-hidden /> Stop
                </Button>
              </>
            ) : (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={!ai.available || working}>
                    <Sparkles aria-hidden /> Generate with AI <ChevronDown className="opacity-60" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="font-normal text-muted-foreground">Usually 20–60 seconds on this Mac</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => askGenerate(['youtube', 'social'])}>
                    <Sparkles aria-hidden /> Everything
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => askGenerate(['youtube'])}>
                    <Film aria-hidden /> YouTube title, description & tags
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => askGenerate(['social'])}>
                    <Megaphone aria-hidden /> Social posts
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button variant="outline" onClick={() => void save()} disabled={!dirty || working}>
              {busy?.kind === 'save' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Save aria-hidden />} Save
            </Button>
            <Button variant="brand" onClick={() => void apply()} disabled={working || running} title={running ? 'Available once processing has finished' : 'Embed title, author, tags and cover art in the MP4 and M4A'}>
              {busy?.kind === 'apply' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Tags aria-hidden />} Apply to files
            </Button>
          </div>
        </div>

        <div className="grid gap-3 border-t pt-4 sm:grid-cols-[150px_150px_minmax(0,1fr)]">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Write in</Label>
            <Select value={draft.ai.language} onValueChange={(v) => setAi({ language: v as 'en' | 'bn' })} disabled={working}>
              <SelectTrigger size="sm" aria-label="Metadata language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="bn">Bangla (বাংলা)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Tone</Label>
            <Select value={draft.ai.tone} onValueChange={(v) => setAi({ tone: v as PublishAiOptions['tone'] })} disabled={working}>
              <SelectTrigger size="sm" aria-label="Tone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.keywords} className="text-xs text-muted-foreground">
              Search phrases to work in (optional)
            </Label>
            <Input id={ids.keywords} className="h-8" placeholder="e.g. kafka short story, classic novella" value={draft.ai.keywords} onChange={(e) => setAi({ keywords: e.target.value })} disabled={working} />
          </div>
        </div>
      </div>

      {(error || notice || appliedNote) && (
        <div className="grid gap-3">
          {error && <ApiErrorAlert error={error} />}
          {notice && !error && (
            <Alert variant="success">
              <CircleCheck aria-hidden />
              <AlertDescription className="text-foreground">{notice}</AlertDescription>
            </Alert>
          )}
          {appliedNote && appliedNote.tone !== 'ok' && (
            <Alert variant={appliedNote.tone === 'warn' ? 'warning' : 'info'}>
              {appliedNote.tone === 'warn' ? <TriangleAlert aria-hidden /> : <Info aria-hidden />}
              <AlertDescription className="text-foreground">{appliedNote.text}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="grid min-w-0 gap-5">
          <Segmented value={section} onValueChange={(v) => pickSection(v as PublishSection)} aria-label="Publish section" className="flex-wrap sm:w-fit">
            {SECTIONS.map(({ value, label, icon: Icon }) => (
              <SegmentedItem key={value} value={value}>
                <Icon aria-hidden /> {label}
              </SegmentedItem>
            ))}
          </Segmented>

          {/* ── YouTube ── */}
          <div className={cn('grid gap-5', section !== 'youtube' && 'hidden')}>
            <FormSection icon={<Type aria-hidden />} title="Title & description" description="What people see in search and on the watch page.">
              <PubField
                label="Title"
                htmlFor={ids.title}
                counter={<CharCount value={[...yt.title].length} max={YOUTUBE_LIMITS.title} warn={YOUTUBE_LIMITS.titleVisible} />}
                copy={yt.title}
                hint="Lead with the book title and author; search results show about 70 characters."
              >
                <Input id={ids.title} value={yt.title} onChange={(e) => setYt({ title: e.target.value })} aria-invalid={[...yt.title].length > YOUTUBE_LIMITS.title} />
                {yt.titleOptions.filter((o) => o !== yt.title).length > 0 && (
                  <div className="flex flex-wrap gap-1.5" aria-label="Other title ideas">
                    {yt.titleOptions
                      .filter((o) => o !== yt.title)
                      .map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => setYt({ title: o })}
                          className="max-w-full truncate rounded-full border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          title="Use this title"
                        >
                          {o}
                        </button>
                      ))}
                  </div>
                )}
              </PubField>

              <PubField label="Main search phrase" htmlFor={ids.keyword} hint="The phrase people type to find this book. The checks look for it in the title, the first line and the tags.">
                <Input id={ids.keyword} value={yt.primaryKeyword} onChange={(e) => setYt({ primaryKeyword: e.target.value })} placeholder={`${ctx.title} audiobook`} />
              </PubField>

              <PubField
                label="Description"
                htmlFor={ids.desc}
                counter={<CharCount value={[...fullDescription].length} max={YOUTUBE_LIMITS.description} warn={4500} />}
                copy={fullDescription}
                hint="The first ~150 characters show in search results. Chapters, the narration note and hashtags are added below it automatically."
              >
                <Textarea id={ids.desc} value={yt.description} onChange={(e) => setYt({ description: e.target.value })} className="min-h-48" />
              </PubField>

              <div className="divide-y overflow-hidden rounded-xl border" id="pub-chapters">
                <ToggleRow
                  label="Chapter timestamps"
                  description={chProblem ? `${chProblem} The timestamps would show as plain text.` : `${ctx.chapters.length} timestamps from the narration — YouTube turns them into chapters.`}
                  checked={yt.includeChapters}
                  onCheckedChange={(v) => setYt({ includeChapters: v })}
                >
                  {yt.includeChapters && ctx.chapters.length > 0 && (
                    <pre className="max-h-40 overflow-auto rounded-lg bg-muted/70 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{chapterLines(ctx.chapters).join('\n')}</pre>
                  )}
                </ToggleRow>
                <ToggleRow
                  label="Say the narration is a synthetic voice"
                  description="Adds one line to the description. Honest with listeners, and it explains the read-along format."
                  checked={yt.aiNarrationNote}
                  onCheckedChange={(v) => setYt({ aiNarrationNote: v })}
                />
              </div>

              <PubField label="Pinned comment" htmlFor={ids.pinned} copy={yt.pinnedComment} hint="Post it as the first comment after uploading and pin it — a question invites replies.">
                <Textarea id={ids.pinned} value={yt.pinnedComment} onChange={(e) => setYt({ pinnedComment: e.target.value })} className="min-h-16" />
              </PubField>
            </FormSection>

            <FormSection icon={<Tags aria-hidden />} title="Tags & hashtags" description="Tags help with misspellings and related searches; hashtags are visible and clickable.">
              <PubField label="Tags" htmlFor={ids.tags} counter={<CharCount value={tagChars} max={YOUTUBE_LIMITS.tagsChars} warn={450} />} copy={yt.tags.join(', ')} hint="Press Enter or comma to add. YouTube counts commas, and quotes around tags with spaces.">
                <TagInput id={ids.tags} value={yt.tags} onChange={(tags) => setYt({ tags })} clean={sanitizeTag} placeholder="the metamorphosis audiobook, franz kafka…" />
                <Meter value={tagChars} max={YOUTUBE_LIMITS.tagsChars} />
              </PubField>
              <PubField
                label="Hashtags"
                htmlFor={ids.hashtags}
                counter={<CharCount value={yt.hashtags.length} max={YOUTUBE_LIMITS.hashtagsRecommended} warn={5} />}
                copy={yt.hashtags.map((h) => `#${h}`).join(' ')}
                hint="3–5 is ideal. The first three appear above the title."
              >
                <TagInput id={ids.hashtags} value={yt.hashtags} onChange={(hashtags) => setYt({ hashtags })} clean={sanitizeHashtag} prefix="#" placeholder="Audiobook" />
              </PubField>
            </FormSection>

            <FormSection icon={<Film aria-hidden />} title="Upload settings" description="Chosen in YouTube Studio when you upload — listed in the upload kit so nothing is forgotten.">
              <div className="grid gap-5 sm:grid-cols-2">
                <PubField label="Category">
                  <Select value={yt.categoryId} onValueChange={(v) => setYt({ categoryId: v })}>
                    <SelectTrigger aria-label="Category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {YOUTUBE_CATEGORIES.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </PubField>
                <PubField label="Video language">
                  <Select value={yt.language} onValueChange={(v) => setYt({ language: v as 'en' | 'bn' })}>
                    <SelectTrigger aria-label="Video language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">{LANGUAGE_LABELS.en}</SelectItem>
                      <SelectItem value="bn">{LANGUAGE_LABELS.bn}</SelectItem>
                    </SelectContent>
                  </Select>
                </PubField>
                <PubField label="Visibility">
                  <Segmented value={yt.visibility} onValueChange={(v) => setYt({ visibility: v as YouTubeDraft['visibility'] })} aria-label="Visibility">
                    {(['public', 'unlisted', 'private'] as const).map((v) => (
                      <SegmentedItem key={v} value={v}>
                        {VISIBILITY_LABELS[v]}
                      </SegmentedItem>
                    ))}
                  </Segmented>
                </PubField>
                <PubField label="License">
                  <Select value={yt.license} onValueChange={(v) => setYt({ license: v as YouTubeDraft['license'] })}>
                    <SelectTrigger aria-label="License">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="youtube">{LICENSE_LABELS.youtube}</SelectItem>
                      <SelectItem value="creativeCommon">{LICENSE_LABELS.creativeCommon}</SelectItem>
                    </SelectContent>
                  </Select>
                </PubField>
              </div>
              <div className="divide-y overflow-hidden rounded-xl border">
                <ToggleRow
                  label="Made for kids"
                  description="Required by law (COPPA). Only choose it if the video is directed at children — it turns off comments and personalised ads."
                  checked={yt.madeForKids}
                  onCheckedChange={(v) => setYt({ madeForKids: v })}
                />
              </div>
            </FormSection>
          </div>

          {/* ── Thumbnail ── (always mounted: it renders the live preview image) */}
          <div className={cn(section !== 'thumbnail' && 'hidden')}>
            <FormSection icon={<ImageIcon aria-hidden />} title="Thumbnail" description="Custom thumbnails get far more clicks than a frame YouTube picks.">
              <ThumbnailDesigner
                projectId={id}
                ctx={ctx}
                text={yt.thumbnailText}
                design={design}
                saved={s.thumbnail}
                onTextChange={(t) => setYt({ thumbnailText: t })}
                onDesignChange={setDesign}
                onPreview={setLivePreview}
                onSaved={async (fresh) => {
                  mutate(fresh);
                  setNotice(fresh.thumbnail ? 'Thumbnail saved.' : 'Thumbnail removed.');
                  // Keep the design with the saved image, so it can be changed later.
                  if (dirty) await api.savePublish(id, draft).then(adopt, (e) => setError(toApiError(e)));
                }}
                fileName={names.thumbnail}
                disabled={working}
              />
            </FormSection>
          </div>

          {/* ── Social ── */}
          <div className={cn('grid gap-5', section !== 'social' && 'hidden')}>
            <FormSection icon={<Megaphone aria-hidden />} title="Social posts" description="Announce the video on each platform. The link is added to every post.">
              <PubField label="Video link" htmlFor={ids.url} hint="Paste the YouTube link after uploading; it is added to the posts (not to Instagram, where links aren’t clickable).">
                <Input id={ids.url} type="url" inputMode="url" placeholder="https://youtu.be/…" value={draft.videoUrl} onChange={(e) => setDraft((d) => d && { ...d, videoUrl: e.target.value.trim() })} />
              </PubField>
              <Segmented value={platform} onValueChange={(v) => setPlatform(v as SocialPlatform)} aria-label="Platform" className="flex-wrap sm:w-fit">
                {SOCIAL_PLATFORMS.map((p) => (
                  <SegmentedItem key={p} value={p}>
                    {SOCIAL_RULES[p].label}
                  </SegmentedItem>
                ))}
              </Segmented>
              {(() => {
                const post = draft.social[platform];
                const rule = SOCIAL_RULES[platform];
                const len = socialLength(platform, post, draft.videoUrl);
                return (
                  <div className="grid gap-4">
                    <PubField label={`${rule.label} post`} htmlFor={`pub-social-${platform}`} counter={<CharCount value={len} max={rule.max} />} copy={composeSocial(post, platform === 'instagram' ? undefined : draft.videoUrl)} hint={rule.note}>
                      <Textarea id={`pub-social-${platform}`} value={post.text} onChange={(e) => setSocial(platform, { text: e.target.value })} className="min-h-32" />
                    </PubField>
                    <PubField label="Hashtags" counter={<CharCount value={post.hashtags.length} max={rule.hashtags[1]} warn={rule.hashtags[1]} />} hint={`${rule.hashtags[0]}–${rule.hashtags[1]} work best on ${rule.label}.`}>
                      <TagInput value={post.hashtags} onChange={(hashtags) => setSocial(platform, { hashtags })} clean={sanitizeHashtag} prefix="#" placeholder="Audiobook" />
                    </PubField>
                  </div>
                );
              })()}
            </FormSection>
          </div>

          {/* ── File metadata ── */}
          <div className={cn('grid gap-5', section !== 'file' && 'hidden')} id="pub-file">
            <FormSection icon={<Tags aria-hidden />} title="File metadata" description="Embedded in audiobook.mp4 and audiobook.m4a — shown by players, Apple Books, podcast and audiobook platforms.">
              <div className="grid gap-5 sm:grid-cols-2">
                {(
                  [
                    ['title', 'Title'],
                    ['artist', 'Author / artist'],
                    ['album', 'Album / book'],
                    ['genre', 'Genre'],
                    ['year', 'Year'],
                    ['copyright', 'Copyright'],
                  ] as const
                ).map(([k, label]) => (
                  <PubField key={k} label={label} htmlFor={`pub-file-${k}`}>
                    <Input id={`pub-file-${k}`} value={draft.file[k]} onChange={(e) => setFile({ [k]: e.target.value })} placeholder={k === 'copyright' ? 'e.g. Public domain' : undefined} />
                  </PubField>
                ))}
                <PubField label="Comment" htmlFor="pub-file-comment" className="sm:col-span-2">
                  <Input id="pub-file-comment" value={draft.file.comment} onChange={(e) => setFile({ comment: e.target.value })} />
                </PubField>
              </div>
              <div className="divide-y overflow-hidden rounded-xl border">
                <ToggleRow
                  label="Embed cover art"
                  description="The saved thumbnail in the video, the book cover in the audiobook. Off removes any embedded cover."
                  checked={draft.file.embedCover}
                  onCheckedChange={(v) => setFile({ embedCover: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">The YouTube description becomes the long description, and the tags become keywords. Nothing is re-encoded — applying takes a few seconds.</p>
            </FormSection>

            <FormSection icon={<FileText aria-hidden />} title="In the files" description="What “Apply to files” writes, next to what each file carries now.">
              {appliedNote && (
                <p className={cn('flex items-center gap-2 text-sm', appliedNote.tone === 'ok' ? 'text-success' : appliedNote.tone === 'warn' ? 'text-warning-foreground dark:text-warning' : 'text-info')}>
                  {appliedNote.tone === 'ok' ? <CircleCheck className="size-4" aria-hidden /> : <Info className="size-4" aria-hidden />}
                  {appliedNote.text}
                </p>
              )}
              {s.embedded.map((f) => {
                const kind = f.name.endsWith('.mp4') ? 'video' : 'audio';
                const next = fileTagsFor(draft, ctx, kind);
                return (
                  <div key={f.name} className="grid gap-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {kind === 'video' ? <Film className="size-4 text-muted-foreground" aria-hidden /> : <Music className="size-4 text-muted-foreground" aria-hidden />}
                      <span className="font-mono text-[13px]">{f.name}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatBytes(f.size)} · {f.chapters} chapter{f.chapters === 1 ? '' : 's'} · {f.hasCover ? 'cover art' : 'no cover art'}
                      </span>
                    </p>
                    <div className="overflow-x-auto rounded-xl border">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-muted/60 text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-medium">Tag</th>
                            <th className="px-3 py-2 font-medium">Will be written</th>
                            <th className="px-3 py-2 font-medium">In the file now</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {SHOWN_TAGS.map(([k, label]) => {
                            const want = next[k] ?? '';
                            const have = f.tags[k] ?? '';
                            const differs = want.trim() !== have.trim();
                            return (
                              <tr key={k} className="align-top">
                                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{label}</td>
                                <td className={cn('max-w-[220px] px-3 py-2 break-words', differs && 'text-info')}>
                                  <span className="line-clamp-2">{want || '—'}</span>
                                </td>
                                <td className="max-w-[220px] px-3 py-2 break-words text-muted-foreground">
                                  <span className="line-clamp-2">{have || '—'}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="brand" onClick={() => void apply()} disabled={working || running}>
                  {busy?.kind === 'apply' ? <LoaderCircle className="animate-spin" aria-hidden /> : <Tags aria-hidden />} Apply to files
                </Button>
                {running && <span className="text-xs text-muted-foreground">Available once processing has finished.</span>}
              </div>
            </FormSection>
          </div>

          {/* ── Upload kit ── */}
          <div className={cn('grid gap-5', section !== 'kit' && 'hidden')}>
            <FormSection icon={<PackageCheck aria-hidden />} title="Upload kit" description="Everything for YouTube Studio, in upload order. Files download with descriptive names.">
              <ol className="divide-y overflow-hidden rounded-xl border">
                {ctx.hasVideo && (
                  <KitRow icon={<Film aria-hidden />} label="Video">
                    <Button asChild variant="outline" size="sm">
                      <a href={outputUrl(id, 'audiobook.mp4', { as: names.video })} download={names.video}>
                        <Download aria-hidden /> MP4
                      </a>
                    </Button>
                  </KitRow>
                )}
                <KitRow icon={<ImageIcon aria-hidden />} label="Thumbnail">
                  {s.thumbnail ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={outputUrl(id, 'thumbnail.jpg', { as: names.thumbnail })} download={names.thumbnail}>
                        <Download aria-hidden /> JPG
                      </a>
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => pickSection('thumbnail')}>
                      Create one
                    </Button>
                  )}
                </KitRow>
                <KitRow icon={<Type aria-hidden />} label="Title" value={yt.title} />
                <KitRow icon={<FileText aria-hidden />} label="Description" value={fullDescription} />
                <KitRow icon={<Tags aria-hidden />} label="Tags" value={yt.tags.join(', ')} />
                {hasSrt && (
                  <KitRow icon={<Captions aria-hidden />} label="Subtitles">
                    <Button asChild variant="outline" size="sm">
                      <a href={outputUrl(id, 'subtitles.srt', { as: names.subtitles })} download={names.subtitles}>
                        <Download aria-hidden /> SRT
                      </a>
                    </Button>
                  </KitRow>
                )}
                <KitRow icon={<Megaphone aria-hidden />} label="Pinned comment" value={yt.pinnedComment} />
                {ctx.hasAudio && (
                  <KitRow icon={<Music aria-hidden />} label="Audiobook (for podcast & audio platforms)">
                    <Button asChild variant="outline" size="sm">
                      <a href={outputUrl(id, 'audiobook.m4a', { as: names.audio })} download={names.audio}>
                        <Download aria-hidden /> M4A
                      </a>
                    </Button>
                  </KitRow>
                )}
              </ol>

              <dl className="grid gap-x-6 gap-y-2 rounded-xl bg-muted/60 p-4 text-sm sm:grid-cols-2">
                {[
                  ['Category', categoryLabel(yt.categoryId)],
                  ['Video language', LANGUAGE_LABELS[yt.language]],
                  ['Audience', yt.madeForKids ? 'Made for kids' : 'Not made for kids'],
                  ['Visibility', VISIBILITY_LABELS[yt.visibility]],
                  ['License', LICENSE_LABELS[yt.license]],
                  ['Altered or synthetic content', 'Usually “No” for a generic voice'],
                ].map(([k, v]) => (
                  <div key={k} className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Only publish books that are in the public domain or that you have the rights to. YouTube asks about altered or synthetic content for realistic
                media; a generic text-to-speech voice reading a book usually isn’t — choose “Yes” if the voice imitates a real person.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => downloadText(names.video.replace(/\.mp4$/, '-upload-kit.txt'), kitText(draft, ctx))}>
                  <FileText aria-hidden /> Download kit (.txt)
                </Button>
                <Button variant="outline" onClick={() => downloadText(names.video.replace(/\.mp4$/, '-metadata.json'), JSON.stringify(kitJson(draft, ctx), null, 2), 'application/json')}>
                  <FileJson aria-hidden /> Metadata (.json)
                </Button>
                <CopyButton text={kitText(draft, ctx)} label="Copy the whole kit" className="size-9 border" />
              </div>
            </FormSection>
          </div>
        </div>

        {/* ── Preview + checks ── */}
        <aside className="grid gap-4 lg:sticky lg:top-8" aria-label="Preview and checks">
          <div className="grid gap-4 rounded-2xl border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">Preview</p>
              <Segmented value={preview} onValueChange={(v) => setPreview(v as typeof preview)} aria-label="Preview" className="w-fit">
                <SegmentedItem value="watch">Watch</SegmentedItem>
                <SegmentedItem value="search">Search</SegmentedItem>
                <SegmentedItem value="social">Social</SegmentedItem>
              </Segmented>
            </div>
            {preview === 'watch' ? (
              <WatchPreview draft={draft} ctx={ctx} thumb={thumbSrc} />
            ) : preview === 'search' ? (
              <SearchPreview draft={draft} ctx={ctx} thumb={thumbSrc} />
            ) : (
              <>
                {section !== 'social' && (
                  <Select value={platform} onValueChange={(v) => setPlatform(v as SocialPlatform)}>
                    <SelectTrigger size="sm" aria-label="Platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOCIAL_PLATFORMS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {SOCIAL_RULES[p].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <SocialPreview platform={platform} draft={draft} ctx={ctx} thumb={thumbSrc} />
              </>
            )}
          </div>
          <div className="rounded-2xl border bg-card p-5 shadow-card">
            <SeoChecklist report={report} onJump={jump} />
          </div>
        </aside>
      </div>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace with new AI-written text?</DialogTitle>
            <DialogDescription>
              {confirm?.includes('youtube') ? 'The title, description, tags, hashtags and pinned comment' : 'The social posts'}
              {confirm?.length === 2 ? ' and the social posts' : ''} are rewritten. Upload settings, file metadata and the thumbnail stay as they are
              {dirty ? '; your other unsaved edits are saved' : ''}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="brand" onClick={() => confirm && void generate(confirm)}>
              <Sparkles aria-hidden /> Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
