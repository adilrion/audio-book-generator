'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, toApiError } from '@/lib/api';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Re-fetch now; resolves with the fresh data (or undefined on error). */
  refresh: () => Promise<T | undefined>;
  /** Replace the cached data locally (e.g. with the body of a PATCH response). */
  mutate: (data: T) => void;
}

/**
 * Tiny data hook: fetches when `key` changes, optionally polls every `interval` ms
 * (paused while the tab is hidden), keeps the last good data when a refresh fails.
 * Pass key = null to disable.
 */
export function useApi<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, opts: { interval?: number | false } = {}): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState<boolean>(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const ctrlRef = useRef<AbortController | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(async (): Promise<T | undefined> => {
    const k = keyRef.current;
    if (k === null) return undefined;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const value = await fetcherRef.current(ctrl.signal);
      if (ctrl.signal.aborted || keyRef.current !== k) return undefined;
      setData(value);
      setError(undefined);
      return value;
    } catch (err) {
      if (ctrl.signal.aborted || (err as Error)?.name === 'AbortError') return undefined;
      setError(toApiError(err));
      return undefined;
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void run();
    return () => ctrlRef.current?.abort();
  }, [key, run]);

  const interval = opts.interval;
  useEffect(() => {
    if (key === null || !interval) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || ctrlRef.current) return;
      void run();
    }, interval);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, interval, run]);

  const mutate = useCallback((value: T) => {
    setData(value);
    setError(undefined);
  }, []);

  return { data, error, loading, refresh: run, mutate };
}
