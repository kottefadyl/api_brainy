import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { S3Storage } from '../collections/large-file.s3.js';
import { AdminResolver } from './admin.resolver.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule],
  providers: [AdminResolver, AdminService, S3Storage],
})
export class AdminModule {}
