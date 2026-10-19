import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { User } from './user.schema';

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

@ObjectType()
export class AuthPayload {
  @Field()
  token!: string;

  @Field(() => User)
  user!: User;
}
