import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { HealthResolver } from './health.resolver';
import { NotesModule } from './notes/notes.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      context: ({ req }: { req: { headers: { authorization?: string } } }) => ({ req }),
      graphiql: process.env.NODE_ENV !== 'production',
    }),
    MongooseModule.forRoot(
      process.env.MONGODB_URI ?? 'mongodb://localhost:27017/brainy',
    ),
    AuthModule,
    NotesModule,
  ],
  providers: [HealthResolver],
})
export class AppModule {}
