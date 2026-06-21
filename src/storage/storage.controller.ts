import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { StorageService } from './storage.service';
import { StorageKind, StorageNotFoundError } from './storage.types';

const VALID_KINDS: readonly StorageKind[] = [
  'PROFILE_PHOTO',
  'ID_DOCUMENT',
  'CLIENT_DOCUMENT',
  'WAREHOUSE_PHOTO',
  'OTHER',
];

/**
 * Two endpoints:
 *
 *   POST /storage/upload  — accepts multipart/form-data with one field
 *                           named `file`, plus a `kind` query/body param.
 *                           Returns the persistent URL the FE then attaches
 *                           to whatever entity (ClientDocument, User profile
 *                           photo, etc.) it was uploading for.
 *
 *   GET  /files/*key      — streams a previously-uploaded file back. Same
 *                           JwtAuthGuard the rest of the API uses, so
 *                           uploaded KYC documents aren't world-readable.
 *
 * Notes:
 *  - Multer is configured in StorageModule for memory storage with a
 *    generous 25 MB ceiling. Per-kind size limits are enforced by
 *    StorageService — multer's just there to receive the body.
 *  - Cookie-based auth isn't wired here. If you need <img src="..."> for
 *    a public-ish thumbnail later, we can add a separate "public files"
 *    bucket or a presigned-URL handshake. For KYC documents the right
 *    answer is FE fetch + Blob URL, which the JWT-guarded GET supports
 *    naturally.
 */
@ApiTags('Storage')
@Controller()
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('storage/upload')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary:
      "Upload a file. multipart/form-data, single field `file`. Pass `?kind=` to pick per-kind size/mime limits (PROFILE_PHOTO, ID_DOCUMENT, CLIENT_DOCUMENT, WAREHOUSE_PHOTO, OTHER). Pass `?subjectUserId=` if the file is attached to a different user's record (e.g. WM uploading a client's KYC doc). Returns { key, url, size, contentType, originalName, storedAt } — persist the `url` on the relevant entity.",
  })
  @ApiQuery({ name: 'kind', enum: VALID_KINDS as unknown as string[] })
  @ApiQuery({ name: 'subjectUserId', required: false })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('kind') kind: string,
    @Query('subjectUserId') subjectUserId: string | undefined,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') uploaderUserId: string,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file received. Send a multipart/form-data request with a "file" field.',
      );
    }
    if (!VALID_KINDS.includes(kind as StorageKind)) {
      throw new BadRequestException(
        `Invalid kind "${kind}". Allowed: ${VALID_KINDS.join(', ')}.`,
      );
    }
    return this.storage.upload({
      file: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      kind: kind as StorageKind,
      ownerScope: { tenantId, uploaderUserId, subjectUserId },
    });
  }

  /**
   * Serve a previously-uploaded file. The wildcard captures the full key
   * — `tenants/abc/clients/xyz/documents/2026-06/<uuid>.pdf` — and we hand
   * it straight to the provider. The provider's path-traversal guard is
   * the last line of defence; we also reject `..` segments at the
   * controller level for clarity.
   */
  @Get('files/*key')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Serve a stored file by key. JWT-required so KYC documents are not world-readable. The FE should fetch with the Authorization header, convert to a Blob URL, and render the image / PDF locally.',
  })
  async serve(
    @Param('key') key: string | string[],
    @Res() res: Response,
  ) {
    // Nest's wildcard param hands you an array (one per path segment) on
    // newer versions and a single string on older ones — accept either.
    const flatKey = Array.isArray(key) ? key.join('/') : key;
    if (!flatKey || flatKey.includes('..')) {
      throw new BadRequestException('Invalid file key.');
    }
    try {
      const obj = await this.storage.get(flatKey);
      res.setHeader('Content-Type', obj.contentType);
      res.setHeader('Content-Length', obj.size);
      // No `Content-Disposition: attachment` — let the browser render
      // images inline. PDFs render inline too in most browsers.
      obj.stream.pipe(res);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        throw new NotFoundException(`File not found: ${flatKey}`);
      }
      throw err;
    }
  }
}
