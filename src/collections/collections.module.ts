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
import { BookResolver } from './book.resolver';
import { LinkPreviewResolver } from './link-preview.resolver';
import { LinkPreviewCache, LinkPreviewCacheSchema, LinkPreviewService } from './link-preview.service';
import { StockLedgerHead, StockLedgerHeadSchema, StockLock, StockLockSchema, StockMovement, StockMovementSchema } from './stock.schema';
import { StockService } from './stock.service';
import { StockLedgerService } from './stock-ledger.service';
import { StockResolver } from './stock.resolver';
import { ForecastResolver } from './forecast.resolver';
import { ForecastService } from './forecast.service';
import { MeasurementService } from './measurement.service';
import { AuditLog, AuditLogSchema } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';
import { EntryRelation, EntryRelationSchema } from './relation.schema';
import { RelationResolver } from './relation.resolver';
import { RelationService } from './relation.service';
import { WorkspaceBackupResolver } from './workspace-backup.resolver';
import { WorkspaceBackupService } from './workspace-backup.service';
import { ClassificationResolver } from './classification.resolver';
import { ClassificationService } from './classification.service';
import { GeoResolver } from './geo.resolver';
import { GeoService } from './geo.service';
import { ZoneAnalysisService } from './zone-analysis.service';
import { BackgroundJob, BackgroundJobSchema } from './background-job.schema';
import { BackgroundJobService } from './background-job.service';
import { BackgroundJobResolver } from './background-job.resolver';
import { WorkflowNotification, WorkflowNotificationSchema } from './workflow.schema';
import { WorkflowResolver } from './workflow.resolver';
import { WorkflowService } from './workflow.service';
import { ContributionLink, ContributionLinkSchema, ContributionSubmission, ContributionSubmissionSchema } from './contribution.schema';
import { ContributionResolver } from './contribution.resolver';
import { ContributionService } from './contribution.service';
import { LedgerHead, LedgerHeadSchema, LedgerRedaction, LedgerRedactionSchema } from './ledger.schema';
import { LedgerResolver } from './ledger.resolver';
import { LedgerService } from './ledger.service';
import { SensitivityService } from './sensitivity.service';
import { SensitivityResolver } from './sensitivity.resolver';
import { DomainPackageInstall, DomainPackageInstallSchema } from './domain-package.schema';
import { DomainPackageResolver } from './domain-package.resolver';
import { DomainPackageService } from './domain-package.service';
import { DataSource, DataSourceRun, DataSourceRunSchema, DataSourceSchema } from './data-source.schema';
import { DataSourceResolver } from './data-source.resolver';
import { DataSourceService } from './data-source.service';
import { LargeFile, LargeFileSchema } from './large-file.schema';
import { LargeFileResolver } from './large-file.resolver';
import { LargeFileService } from './large-file.service';
import { S3Storage } from './large-file.s3';
import { StoredCode, StoredCodeSchema } from './code-list-store.schema';
import { CodeListStore } from './code-list-store.service';
import { CodeListStoreResolver } from './code-list-store.resolver';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Collection.name, schema: CollectionSchema },
      { name: Entry.name, schema: EntrySchema },
      { name: LinkPreviewCache.name, schema: LinkPreviewCacheSchema },
      { name: StoredCode.name, schema: StoredCodeSchema },
      { name: StockMovement.name, schema: StockMovementSchema },
      { name: StockLock.name, schema: StockLockSchema },
      { name: StockLedgerHead.name, schema: StockLedgerHeadSchema },
      { name: EntryLink.name, schema: EntryLinkSchema },
      { name: EntryRelation.name, schema: EntryRelationSchema },
      { name: MoveOperation.name, schema: MoveOperationSchema },
      { name: User.name, schema: UserSchema },
      { name: EntryReminder.name, schema: EntryReminderSchema },
      { name: ReminderDelivery.name, schema: ReminderDeliverySchema },
      { name: PushDevice.name, schema: PushDeviceSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
      { name: BackgroundJob.name, schema: BackgroundJobSchema },
      { name: WorkflowNotification.name, schema: WorkflowNotificationSchema },
      { name: ContributionLink.name, schema: ContributionLinkSchema },
      { name: ContributionSubmission.name, schema: ContributionSubmissionSchema },
      { name: LedgerHead.name, schema: LedgerHeadSchema },
      { name: LedgerRedaction.name, schema: LedgerRedactionSchema },
      { name: DomainPackageInstall.name, schema: DomainPackageInstallSchema },
      { name: DataSource.name, schema: DataSourceSchema },
      { name: DataSourceRun.name, schema: DataSourceRunSchema },
      { name: LargeFile.name, schema: LargeFileSchema },
    ]),
  ],
  providers: [CollectionsResolver, CollectionsService, TransferService, ReminderResolver, ReminderService, BackgroundJobResolver, BackgroundJobService, AnalysisResolver, AnalysisService, ZoneAnalysisService, EntryLinkResolver, EntryLinkService, RelationResolver, RelationService, ClassificationResolver, ClassificationService, CodeListStore, CodeListStoreResolver, GeoResolver, GeoService, WorkspaceBackupResolver, WorkspaceBackupService, StarterTemplateResolver, BookResolver, LinkPreviewResolver, LinkPreviewService, StockResolver, StockService, StockLedgerService, ForecastResolver, ForecastService, MeasurementService, CollaborationService, WorkflowResolver, WorkflowService, ContributionResolver, ContributionService, LedgerResolver, LedgerService, SensitivityResolver, SensitivityService, DomainPackageResolver, DomainPackageService, DataSourceResolver, DataSourceService, S3Storage, LargeFileService, LargeFileResolver],
  exports: [MeasurementService, CollaborationService],
})
export class CollectionsModule {}
