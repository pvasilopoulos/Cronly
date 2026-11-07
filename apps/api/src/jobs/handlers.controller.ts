import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { HANDLER_CATALOG } from '@cronapp/handlers';
import { RequirePermissions } from '../auth/decorators';

// The handler catalog: which job handlers exist and the payload each expects.
// The web console imports this contract directly; this endpoint exposes it for
// API consumers and Swagger docs.
@ApiTags('Handlers')
@ApiBearerAuth('api-key')
@Controller('handlers')
export class HandlersController {
  @Get()
  @RequirePermissions('jobs:read')
  list() {
    return HANDLER_CATALOG;
  }
}
