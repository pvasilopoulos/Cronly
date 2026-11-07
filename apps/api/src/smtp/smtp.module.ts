import { Module } from '@nestjs/common';
import { SmtpController } from './smtp.controller';
import { SmtpService } from './smtp.service';

/** Instance SMTP settings (super-admin). Relies on the global PrismaModule. */
@Module({
  controllers: [SmtpController],
  providers: [SmtpService],
})
export class SmtpModule {}
