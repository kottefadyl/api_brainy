import { PlatformResolver } from './platform.resolver';
import { join } from 'node:path';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { HealthResolver } from './health.resolver';
import { NotesModule } from './notes/notes.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Vercel's file system is read-only: the schema stays in memory there; locally it is written for the clients' codegen.
      autoSchemaFile: process.env.VERCEL ? true : join(process.cwd(), 'schema.gql'),
      sortSchema: true,
      context: ({ req }: { req: { headers: { authorization?: string } } }) => ({ req }),
      graphiql: process.env.NODE_ENV !== 'production',
    }),
    MongooseModule.forRoot(
      process.env.MONGODB_URI ?? 'mongodb://localhost:27017/brainy',
    ),
    AuthModule,
    CollectionsModule,
    NotesModule,
  ],
  providers: [HealthResolver, PlatformResolver],
})
export class AppModule {}
