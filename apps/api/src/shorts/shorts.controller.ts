import fs from 'node:fs';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { notFound } from '../common/errors';
import { downloadName } from '../projects/projects.controller';
import { ShortsService } from './shorts.service';

@Controller('shorts')
export class ShortsController {
  constructor(private readonly shorts: ShortsService) {}

  @Get()
  list() {
    return this.shorts.list();
  }

  /** Default settings for a new short (voice from .env). */
  @Get('defaults')
  defaults() {
    return this.shorts.defaults();
  }

  @Post()
  create(@Body() body: unknown) {
    return this.shorts.create(body);
  }

  /** Local AI writes a script (20–60 s); closing the request stops the model. Nothing is saved. */
  @Post('script')
  script(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort();
    });
    return this.shorts.generateScript(body, ctrl.signal);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.shorts.detail(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.shorts.update(id, body);
  }

  @Post(':id/render')
  render(@Param('id') id: string) {
    return this.shorts.render(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.shorts.cancel(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.shorts.remove(id);
  }

  /** `inline` streams for the player; `as` downloads under another name. */
  @Get(':id/output/:name')
  download(@Param('id') id: string, @Param('name') name: string, @Query('inline') inline: string, @Query('as') as: string | undefined, @Res() res: Response) {
    const file = this.shorts.outputPath(id, name);
    if (!fs.existsSync(file)) throw notFound('File');
    if (!inline) res.attachment(downloadName(as, name));
    res.sendFile(file, { acceptRanges: true, dotfiles: 'deny' });
  }
}
