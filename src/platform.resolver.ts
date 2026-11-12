import { Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { frozenModules, maxEntryAttachmentBytes } from './platform.js';

@ObjectType()
export class PlatformCapabilities {
  /** Modules paused on this hosting, among reminders, backgroundJobs, dataSources and largeFiles. */
  @Field(() => [String]) frozenModules!: string[];
  @Field(() => Int) maxEntryAttachmentBytes!: number;
}

/** Public and secret-free: lets clients hide what this hosting cannot run. */
@Resolver()
export class PlatformResolver {
  @Query(() => PlatformCapabilities)
  platformCapabilities(): PlatformCapabilities {
    return { frozenModules: [...frozenModules()], maxEntryAttachmentBytes: maxEntryAttachmentBytes() };
  }
}
