import fs from 'node:fs';
import path from 'node:path';
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { loadConfig } from '@app/config';
import { notFound } from '../common/errors';
import { ProjectsService } from './projects.service';

const cfg = loadConfig();
const tmpDir = path.join(cfg.storage.uploads, '.incoming');
fs.mkdirSync(tmpDir, { recursive: true });

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** Multipart upload streamed straight to disk (never buffered in memory). */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpDir, filename: (_r, _f, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`) }),
      limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    }),
  )
  create(@UploadedFile() file: Express.Multer.File, @Body('settings') settings?: string, @Body('name') name?: string) {
    return this.projects.create(file, settings, name);
  }

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.projects.detail(id);
  }

  @Patch(':id/settings')
  updateSettings(@Param('id') id: string, @Body() body: unknown) {
    return this.projects.updateSettings(id, body);
  }

  @Post(':id/process')
  process(@Param('id') id: string) {
    return this.projects.process(id, false);
  }

  /** Retry failed step = resume: completed steps are cached and skipped. */
  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.projects.process(id, false);
  }

  @Post(':id/restart')
  restart(@Param('id') id: string) {
    return this.projects.process(id, true);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.projects.cancel(id);
  }

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.projects.status(id);
  }

  @Get(':id/steps')
  steps(@Param('id') id: string) {
    return this.projects.steps(id);
  }

  @Get(':id/output')
  outputs(@Param('id') id: string) {
    return this.projects.outputs(id);
  }

  @Get(':id/output/:name')
  download(@Param('id') id: string, @Param('name') name: string, @Query('inline') inline: string, @Res() res: Response) {
    const file = this.projects.outputPath(id, name);
    if (!fs.existsSync(file)) throw notFound('File');
    if (!inline) res.attachment(name);
    res.sendFile(file, { acceptRanges: true, dotfiles: 'deny' }); // Range support for audio/video seeking
  }

  @Get(':id/timeline')
  async timeline(@Param('id') id: string, @Res() res: Response) {
    res.type('application/json').sendFile(await this.projects.timelinePath(id));
  }

  @Get(':id/pages/:page/image')
  async page(@Param('id') id: string, @Param('page', ParseIntPipe) page: number, @Res() res: Response) {
    const file = await this.projects.pageImage(id, page);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.type('image/jpeg').sendFile(file);
  }

  @Delete(':id/cache')
  cleanCache(@Param('id') id: string) {
    return this.projects.cleanCache(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Query('deleteOutputs') deleteOutputs?: string) {
    return this.projects.remove(id, deleteOutputs === 'true');
  }
}

