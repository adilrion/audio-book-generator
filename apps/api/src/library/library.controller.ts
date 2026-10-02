import { Body, Controller, Get, Logger, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { describeError } from '@app/shared';
import type { ImportEvent } from '@app/types';
import { toUserError } from '../common/errors';
import { LibraryService } from './library.service';

/** Abort `ctrl` when the client goes away before the response was sent. */
function abortOnClose(res: Response): AbortController {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl;
}

@Controller()
export class LibraryController {
  private readonly log = new Logger('Library');

  constructor(private readonly library: LibraryService) {}

  @Get('library/search')
  search(@Query() query: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    return this.library.search(query, abortOnClose(res).signal);
  }

  @Get('library/archive/:id')
  book(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.library.book(id, abortOnClose(res).signal);
  }

  /**
   * Create a project from a library book or a PDF link, like POST /projects. Problems found before
   * the download starts (bad link, not a PDF, too large…) are normal JSON errors. Once the first
   * bytes are confirmed to be a PDF the answer is 200 NDJSON: progress lines, then one `done` (with
   * the ProjectDetail) or `error` line. Closing the request cancels the download.
   */
  @Post('projects/import')
  async import(@Body() body: unknown, @Res() res: Response) {
    const ctrl = abortOnClose(res);
    let streaming = false;
    const send = (event: ImportEvent) => {
      if (ctrl.signal.aborted) return;
      if (!streaming) {
        streaming = true;
        res.status(200).setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const project = await this.library.import(body, { signal: ctrl.signal, onProgress: (p) => send({ type: 'progress', ...p }) });
      send({ type: 'done', project });
      res.end();
    } catch (e) {
      if (!streaming) throw e; // → UserErrorFilter, with the right HTTP status
      const err = toUserError(e);
      if (err.code !== 'ABORTED') this.log.warn(`Import failed: ${describeError(e)}`);
      send({ type: 'error', error: err.toUser() });
      res.end();
    }
  }
}
