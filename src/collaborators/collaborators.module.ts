// T52: collaborators module (personal link, acceptance, list, end of collaboration).
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/user.schema.js';
import { Collection, CollectionSchema } from '../collections/collection.schema.js';
import { AuditLog, AuditLogSchema } from '../collections/collaboration.schema.js';
import { Collaboration, CollaborationSchema, CollaboratorInvite, CollaboratorInviteSchema } from './collaborator.schema.js';
import { CollaboratorsResolver, CollectionOwnerResolver } from './collaborators.resolver.js';
import { EntryAuthorsResolver } from './entry-authors.resolver.js';
import { CollaboratorsService } from './collaborators.service.js';
import { PersonFieldResolver } from './person-field.resolver.js';
import { PersonFieldService } from './person-field.service.js';

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
  providers: [CollaboratorsService, CollaboratorsResolver, CollectionOwnerResolver, EntryAuthorsResolver, PersonFieldService, PersonFieldResolver],
  exports: [CollaboratorsService, PersonFieldService],
})
export class CollaboratorsModule {}
