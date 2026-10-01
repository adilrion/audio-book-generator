'use client';

import { LoaderCircle, Play, Square, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { errorFromResponse, toApiError, voicePreviewUrl } from '@/lib/api';

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'playing' } | { kind: 'error'; message: string };

/** The sample playing anywhere on the page: starting another one stops it. */
let stopCurrent: (() => void) | undefined;

/**
 * The voice picker (`children`) with a Listen button beside it: a few seconds of the chosen voice at the
 * chosen speed. The first sample of a voice is synthesized locally (a few seconds, longer while the engine
 * loads); after that the browser and the API cache it.
 */
export function VoicePreview({ engine, voice, speed, language, disabled, children }: { engine: string; voice?: string; speed: number; language: string; disabled?: boolean; children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stopRef = useRef<() => void>(undefined);
  const url = voice ? voicePreviewUrl(engine, voice, speed, language) : undefined;

  // Another voice or speed: stop the old sample and forget its error.
  useEffect(() => {
    setState({ kind: 'idle' });
    return () => stopRef.current?.();
  }, [url]);

  const play = async () => {
    if (!url) return;
    stopCurrent?.();
    const ctrl = new AbortController();
    let audio: HTMLAudioElement | undefined;
    let objectUrl: string | undefined;
    const stop = () => {
      ctrl.abort();
      audio?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (stopCurrent === stop) stopCurrent = undefined;
      if (stopRef.current === stop) stopRef.current = undefined;
      setState({ kind: 'idle' });
    };
    stopCurrent = stopRef.current = stop;
    setState({ kind: 'loading' });
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw errorFromResponse(res.status, await res.text());
      objectUrl = URL.createObjectURL(await res.blob());
      if (ctrl.signal.aborted) return URL.revokeObjectURL(objectUrl);
      audio = new Audio(objectUrl);
      audio.onended = stop;
      await audio.play();
      if (!ctrl.signal.aborted) setState({ kind: 'playing' });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      stop();
      setState({ kind: 'error', message: (err as Error)?.name === 'NotAllowedError' ? 'The browser blocked playback. Click Listen again.' : toApiError(err).message });
    }
  };

  const busy = state.kind === 'loading' || state.kind === 'playing';
  return (
    <>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        <Button
          type="button"
          variant="outline"
          className="h-10"
          disabled={disabled || !url}
          onClick={() => (busy ? stopRef.current?.() : void play())}
          aria-label={busy ? 'Stop the voice sample' : 'Hear a sample of this voice'}
        >
          {state.kind === 'loading' ? <LoaderCircle className="animate-spin" aria-hidden /> : state.kind === 'playing' ? <Square className="fill-current" aria-hidden /> : <Play aria-hidden />}
          {state.kind === 'loading' ? 'Preparing…' : state.kind === 'playing' ? 'Stop' : 'Listen'}
        </Button>
      </div>
      {state.kind === 'error' && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {state.message}
        </p>
      )}
    </>
  );
}
