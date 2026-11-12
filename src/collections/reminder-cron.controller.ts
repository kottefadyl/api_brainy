// T20: on a host without a background process (Vercel Hobby), an external scheduler (for example
// cron-job.org, free, every minute) calls GET /cron/reminders with "Authorization: Bearer <CRON_SECRET>"
// to send the reminders that are due. Without CRON_SECRET the route does not exist.
import { Controller, Get, Headers, HttpCode, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ReminderService } from './reminder.service';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Controller('cron')
export class ReminderCronController {
  constructor(private readonly reminders: ReminderService) {}

  @Get('reminders')
  @HttpCode(200)
  async run(@Headers('authorization') authorization?: string): Promise<{ ok: true }> {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || secret.length < 16) throw new NotFoundException();
    if (!authorization || !same(authorization, `Bearer ${secret}`)) throw new UnauthorizedException();
    await this.reminders.processDue();
    return { ok: true };
  }
}
