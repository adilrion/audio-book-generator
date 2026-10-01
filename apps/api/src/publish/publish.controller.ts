import { Body, Controller, Delete, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { YOUTUBE_LIMITS } from '@app/types';
import { badRequest } from '../common/errors';
import { PublishService } from './publish.service';

/** Read a raw request body (the thumbnail JPEG), refusing more than `max` bytes. */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw badRequest('The thumbnail must be 2 MB or smaller (YouTube’s limit).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@Controller('projects/:id/publish')
export class PublishController {
  constructor(private readonly publish: PublishService) {}

  @Get()
  state(@Param('id') id: string) {
    return this.publish.state(id);
  }

  @Put()
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.publish.save(id, body);
  }

  /** Can take a minute with a local model; closing the request stops the generation. */
  @Post('generate')
  generate(@Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort();
    });
    return this.publish.generate(id, body, ctrl.signal);
  }

  @Post('apply')
  apply(@Param('id') id: string) {
    return this.publish.apply(id);
  }

  /** Body: the JPEG itself (Content-Type: image/jpeg). */
  @Put('thumbnail')
  async thumbnail(@Param('id') id: string, @Req() req: Request) {
    return this.publish.saveThumbnail(id, await readBody(req, YOUTUBE_LIMITS.thumbnailBytes));
  }

  @Delete('thumbnail')
  deleteThumbnail(@Param('id') id: string) {
    return this.publish.deleteThumbnail(id);
  }
}
