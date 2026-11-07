import { Global, Module } from '@nestjs/common';
import { PrincipalService } from './principal.service';

@Global()
@Module({
  providers: [PrincipalService],
  exports: [PrincipalService],
})
export class RbacModule {}
