// Real-time data synchronisation through Cloud Firestore signals (see realtime.service.ts).
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Collection, CollectionSchema } from '../collections/collection.schema';
import { Entry, EntrySchema } from '../collections/entry.schema';
import { RealtimeInterceptor } from './realtime.interceptor';
import { RealtimeResolver } from './realtime.resolver';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [AuthModule, MongooseModule.forFeature([{ name: Collection.name, schema: CollectionSchema }, { name: Entry.name, schema: EntrySchema }])],
  providers: [RealtimeService, RealtimeResolver, { provide: APP_INTERCEPTOR, useClass: RealtimeInterceptor }],
  exports: [RealtimeService],
})
export class RealtimeModule {}
