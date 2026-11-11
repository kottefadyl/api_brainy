// T52: collaborators module (personal link, acceptance, list, end of collaboration).
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { User, UserSchema } from '../auth/user.schema';
import { Collection, CollectionSchema } from '../collections/collection.schema';
import { AuditLog, AuditLogSchema } from '../collections/collaboration.schema';
import { Collaboration, CollaborationSchema, CollaboratorInvite, CollaboratorInviteSchema } from './collaborator.schema';
import { CollaboratorsResolver, CollectionOwnerResolver } from './collaborators.resolver';
import { CollaboratorsService } from './collaborators.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: CollaboratorInvite.name, schema: CollaboratorInviteSchema },
      { name: Collaboration.name, schema: CollaborationSchema },
      { name: User.name, schema: UserSchema },
      { name: Collection.name, schema: CollectionSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [CollaboratorsService, CollaboratorsResolver, CollectionOwnerResolver],
  exports: [CollaboratorsService],
})
export class CollaboratorsModule {}
