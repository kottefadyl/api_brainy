import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class StartBackgroundJobInput {
  @Field() kind!: string;
  @Field() requestKey!: string;
  @Field() payload!: string;
}
