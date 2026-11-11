// T52: collaborators linked by a personal, revocable invitation link.
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** One personal invitation link per person; regenerating it invalidates the previous one. */
@Schema({ timestamps: true })
export class CollaboratorInvite {
  @Prop({ required: true, unique: true })
  userId!: string;

  @Prop({ required: true, unique: true })
  token!: string;
}
export const CollaboratorInviteSchema = SchemaFactory.createForClass(CollaboratorInvite);

/** A mutual collaboration between two people; `pairKey` is both ids sorted and joined by ":". */
@Schema({ timestamps: true })
export class Collaboration {
  @Prop({ required: true, unique: true })
  pairKey!: string;

  @Prop({ type: [String], required: true, index: true })
  userIds!: string[];

  /** Person whose link was accepted (absent for collaborations migrated from T28 members). */
  @Prop()
  inviterId?: string;

  createdAt?: Date;
}
export const CollaborationSchema = SchemaFactory.createForClass(Collaboration);

@ObjectType()
export class Collaborator {
  @Field(() => ID)
  userId!: string;

  @Field()
  name!: string;

  @Field()
  email!: string;

  @Field()
  since!: Date;

  @Field()
  hasPhoto!: boolean;
}

@ObjectType()
export class CollaborationInvitePreview {
  @Field()
  inviterName!: string;

  /** The signed-in viewer opened their own link. */
  @Field()
  isSelf!: boolean;

  /** The signed-in viewer already collaborates with the inviter. */
  @Field()
  alreadyCollaborator!: boolean;
}

@ObjectType()
export class CollectionOwnerSummary {
  @Field(() => ID)
  userId!: string;

  @Field()
  name!: string;
}
