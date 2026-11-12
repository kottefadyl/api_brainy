import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthResolver } from './auth.resolver.js';
import { AuthService } from './auth.service.js';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import { User, UserSchema } from './user.schema.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
  providers: [AuthResolver, AuthService, FirebaseIdentityService],
  exports: [AuthService],
})
export class AuthModule {}
