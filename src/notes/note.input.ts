import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class CreateNoteInput {
  @Field()
  title!: string;

  @Field()
  content!: string;
}

@InputType()
export class UpdateNoteInput {
  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  content?: string;
}
