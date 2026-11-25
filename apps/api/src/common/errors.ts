import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Turns database errors into clear HTTP answers without leaking internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Error');
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      return res.status(err.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    }
    const map: Record<string, [number, string]> = {
      '23P01': [409, 'That time overlaps another appointment for this doctor or room'],
      '23505': [409, 'That already exists'],
      '23503': [400, 'A referenced record does not exist in this workspace'],
      '42501': [403, 'Not allowed in this workspace'],
      '23514': [400, 'A value is not allowed'],
      '22P02': [400, 'Invalid value'],
      'P0001': [400, ''],
    };
    const m = err?.code && map[err.code];
    if (m) {
      const message = err.code === 'P0001' ? err.message : m[1];
      const body: Record<string, unknown> = { message };
      if (err.code === '23P01') body.code = 'double_booking';
      return res.status(m[0]).json(body);
    }
    this.log.error(err?.stack ?? String(err));
    return res.status(500).json({ message: 'Something went wrong' });
  }
}
