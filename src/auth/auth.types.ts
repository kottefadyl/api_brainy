import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { User } from './user.schema.js';

@InputType()
export class RegisterInput {
  @Field()
  name!: string;

  @Field()
  email!: string;

  @Field()
  password!: string;
}

@InputType()
export class LoginInput {
  @Field()
  email!: string;

  @Field()
  password!: string;
}

@InputType()
export class ProfileInput {
  @Field()
  name!: string;

  @Field()
  profession!: string;

  @Field()
  job!: string;

  @Field()
  fieldOfStudy!: string;

  @Field(() => [String])
  interests!: string[];

  @Field(() => [String])
  hobbies!: string[];
}

@ObjectType()
export class AuthPayload {
  @Field()
  token!: string;

  @Field(() => User)
  user!: User;
}
