import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Collection, CollectionSchema } from './collection.schema';
import { CollectionsResolver } from './collections.resolver';
import { CollectionsService } from './collections.service';
import { Entry, EntrySchema } from './entry.schema';
import { TransferService } from './transfer.service';
import { MoveOperation, MoveOperationSchema } from './move-operation.schema';
import { User, UserSchema } from '../auth/user.schema';
import { EntryReminder, EntryReminderSchema, PushDevice, PushDeviceSchema, ReminderDelivery, ReminderDeliverySchema } from './reminder.schema';
import { ReminderService } from './reminder.service';
import { ReminderResolver } from './reminder.resolver';
import { AnalysisResolver } from './analysis.resolver';
import { AnalysisService } from './analysis.service';
import { EntryLink, EntryLinkSchema } from './entry-link.schema';
import { EntryLinkResolver } from './entry-link.resolver';
import { EntryLinkService } from './entry-link.service';
import { StarterTemplateResolver } from './starter-template.resolver';
import { StockLock, StockLockSchema, StockMovement, StockMovementSchema } from './stock.schema';
import { StockService } from './stock.service';
import { StockResolver } from './stock.resolver';
import { ForecastResolver } from './forecast.resolver';
import { ForecastService } from './forecast.service';
import { MeasurementService } from './measurement.service';
import { AuditLog, AuditLogSchema } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Collection.name, schema: CollectionSchema },
      { name: Entry.name, schema: EntrySchema },
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: StockLock.name, schema: StockLockSchema },
      { name: EntryLink.name, schema: EntryLinkSchema },
      { name: MoveOperation.name, schema: MoveOperationSchema },
      { name: User.name, schema: UserSchema },
      { name: EntryReminder.name, schema: EntryReminderSchema },
      { name: ReminderDelivery.name, schema: ReminderDeliverySchema },
      { name: PushDevice.name, schema: PushDeviceSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [CollectionsResolver, CollectionsService, TransferService, ReminderResolver, ReminderService, AnalysisResolver, AnalysisService, EntryLinkResolver, EntryLinkService, StarterTemplateResolver, StockResolver, StockService, ForecastResolver, ForecastService, MeasurementService, CollaborationService],
  exports: [MeasurementService, CollaborationService],
})
export class CollectionsModule {}
