import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class WorkspaceBackupPreview {
  @Field() version!: number;
  @Field() collections!: number;
  @Field() entries!: number;
  @Field() relations!: number;
  @Field() stockMovements!: number;
  @Field(() => [String]) conflicts!: string[];
  @Field() allowed!: boolean;
  @Field() restored!: boolean;
}
