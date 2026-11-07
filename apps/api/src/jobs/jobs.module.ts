import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { HandlersController } from './handlers.controller';
import { JobsService } from './jobs.service';

@Module({
  controllers: [JobsController, HandlersController],
  providers: [JobsService],
})
export class JobsModule {}
