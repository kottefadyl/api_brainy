import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { Collection, CollectionSchema } from './collection.schema.js';
import { CollectionsResolver } from './collections.resolver.js';
import { CollectionsService } from './collections.service.js';
import { Entry, EntrySchema } from './entry.schema.js';
import { TransferService } from './transfer.service.js';
import { MoveOperation, MoveOperationSchema } from './move-operation.schema.js';
import { User, UserSchema } from '../auth/user.schema.js';
import { EntryReminder, EntryReminderSchema, PushDevice, PushDeviceSchema, ReminderDelivery, ReminderDeliverySchema } from './reminder.schema.js';
import { ReminderService } from './reminder.service.js';
import { ReminderResolver } from './reminder.resolver.js';
import { AnalysisResolver } from './analysis.resolver.js';
import { AnalysisService } from './analysis.service.js';
import { EntryLink, EntryLinkSchema } from './entry-link.schema.js';
import { EntryLinkResolver } from './entry-link.resolver.js';
import { EntryLinkService } from './entry-link.service.js';
import { StarterTemplateResolver } from './starter-template.resolver.js';
import { BookResolver } from './book.resolver.js';
import { LinkPreviewResolver } from './link-preview.resolver.js';
import { TaskPlannerResolver } from './task-planner.resolver.js';
import { TaskPlannerService } from './task-planner.service.js';
import { LinkPreviewCache, LinkPreviewCacheSchema, LinkPreviewService } from './link-preview.service.js';
import { StockLedgerHead, StockLedgerHeadSchema, StockLock, StockLockSchema, StockMovement, StockMovementSchema } from './stock.schema.js';
import { StockService } from './stock.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockResolver } from './stock.resolver.js';
import { ForecastResolver } from './forecast.resolver.js';
import { ForecastService } from './forecast.service.js';
import { MeasurementService } from './measurement.service.js';
import { AuditLog, AuditLogSchema } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { EntryRelation, EntryRelationSchema } from './relation.schema.js';
import { RelationResolver } from './relation.resolver.js';
import { RelationService } from './relation.service.js';
import { WorkspaceBackupResolver } from './workspace-backup.resolver.js';
import { WorkspaceBackupService } from './workspace-backup.service.js';
import { ClassificationResolver } from './classification.resolver.js';
import { ClassificationService } from './classification.service.js';
import { GeoResolver } from './geo.resolver.js';
import { GeoService } from './geo.service.js';
import { ZoneAnalysisService } from './zone-analysis.service.js';
import { BackgroundJob, BackgroundJobSchema } from './background-job.schema.js';
import { BackgroundJobService } from './background-job.service.js';
import { BackgroundJobResolver } from './background-job.resolver.js';
import { WorkflowNotification, WorkflowNotificationSchema } from './workflow.schema.js';
import { WorkflowResolver } from './workflow.resolver.js';
import { WorkflowService } from './workflow.service.js';
import { ContributionLink, ContributionLinkSchema, ContributionSubmission, ContributionSubmissionSchema } from './contribution.schema.js';
import { ContributionResolver } from './contribution.resolver.js';
import { ContributionService } from './contribution.service.js';
import { LedgerHead, LedgerHeadSchema, LedgerRedaction, LedgerRedactionSchema } from './ledger.schema.js';
import { LedgerResolver } from './ledger.resolver.js';
import { LedgerService } from './ledger.service.js';
import { SensitivityService } from './sensitivity.service.js';
import { SensitivityResolver } from './sensitivity.resolver.js';
import { DomainPackageInstall, DomainPackageInstallSchema } from './domain-package.schema.js';
import { DomainPackageResolver } from './domain-package.resolver.js';
import { DomainPackageService } from './domain-package.service.js';
import { DataSource, DataSourceRun, DataSourceRunSchema, DataSourceSchema } from './data-source.schema.js';
import { DataSourceResolver } from './data-source.resolver.js';
import { DataSourceService } from './data-source.service.js';
import { LargeFile, LargeFileSchema } from './large-file.schema.js';
import { LargeFileResolver } from './large-file.resolver.js';
import { LargeFileService } from './large-file.service.js';
import { S3Storage } from './large-file.s3.js';
import { StoredCode, StoredCodeSchema } from './code-list-store.schema.js';
import { CodeListStore } from './code-list-store.service.js';
import { CodeListStoreResolver } from './code-list-store.resolver.js';
import { LinksTemplateMigration } from './links-template-migration.js';
import { LegacyBookMigration } from './legacy-book-migration.js';
import { ReminderCronController } from './reminder-cron.controller.js';

@Module({
  imports: [
    AuthModule,
    CollaboratorsModule,
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
  controllers: [ReminderCronController],
  providers: [CollectionsResolver, CollectionsService, TransferService, ReminderResolver, ReminderService, BackgroundJobResolver, BackgroundJobService, AnalysisResolver, AnalysisService, ZoneAnalysisService, EntryLinkResolver, EntryLinkService, RelationResolver, RelationService, ClassificationResolver, ClassificationService, CodeListStore, CodeListStoreResolver, GeoResolver, GeoService, WorkspaceBackupResolver, WorkspaceBackupService, StarterTemplateResolver, BookResolver, LinkPreviewResolver, LinkPreviewService, TaskPlannerResolver, TaskPlannerService, StockResolver, StockService, StockLedgerService, ForecastResolver, ForecastService, MeasurementService, CollaborationService, WorkflowResolver, WorkflowService, ContributionResolver, ContributionService, LedgerResolver, LedgerService, SensitivityResolver, SensitivityService, DomainPackageResolver, DomainPackageService, DataSourceResolver, DataSourceService, S3Storage, LargeFileService, LargeFileResolver, LinksTemplateMigration, LegacyBookMigration],
  exports: [MeasurementService, CollaborationService],
})
export class CollectionsModule {}
