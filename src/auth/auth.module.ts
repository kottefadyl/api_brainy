import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { FirebaseIdentityService } from './firebase-identity.service';
import { User, UserSchema } from './user.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
  providers: [AuthResolver, AuthService, FirebaseIdentityService],
  exports: [AuthService],
})
export class AuthModule {}
