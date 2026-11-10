import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum CollectionRole {
  OWNER = 'OWNER',
  EDITOR = 'EDITOR',
  READER = 'READER',
}

registerEnumType(CollectionRole, { name: 'CollectionRole' });

@ObjectType()
@Schema({ _id: false })
export class CollectionMember {
  @Field()
  @Prop({ required: true })
  userId!: string;

  @Field()
  @Prop({ required: true })
  email!: string;

  @Field()
  @Prop({ required: true })
  name!: string;

  @Field(() => CollectionRole)
  @Prop({ required: true, enum: Object.values(CollectionRole), default: CollectionRole.READER })
  role!: CollectionRole;

  @Field()
  @Prop({ required: true, default: () => new Date() })
  addedAt!: Date;

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: [] })
  sharedFieldIds?: string[];

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: [] })
  sensitiveFieldIds?: string[];
}

export const CollectionMemberSchema = SchemaFactory.createForClass(CollectionMember);

@ObjectType()
@Schema({ timestamps: true })
export class AuditLog {
  @Field(() => ID)
  id!: string;

  @Field()
  @Prop({ required: true, index: true })
  collectionId!: string;

  @Field()
  @Prop({ required: true, index: true })
  userId!: string;

  @Field()
  @Prop({ required: true })
  action!: string;

  @Field({ nullable: true })
  @Prop()
  details?: string;

  @Field()
  @Prop({ required: true, default: () => new Date() })
  occurredAt!: Date;

  /** Fingerprint of a sensitive aggregate query (T43/3); never a value. */
  @Prop()
  queryKey?: string;

  /** Number of observations behind a sensitive aggregate (T43/3). */
  @Prop()
  observationCount?: number;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ collectionId: 1, occurredAt: -1 });
AuditLogSchema.index({ collectionId: 1, userId: 1, action: 1, occurredAt: -1 });
