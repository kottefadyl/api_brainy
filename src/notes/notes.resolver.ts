import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { CreateNoteInput, UpdateNoteInput } from './note.input';
import { Note } from './note.schema';
import { NotesService } from './notes.service';

@Resolver(() => Note)
export class NotesResolver {
  constructor(private readonly notes: NotesService, private readonly auth: AuthService) {}

  private async ownerId(request: { headers: { authorization?: string } }): Promise<string> {
    return (await this.auth.currentUser(request.headers.authorization)).id;
  }

  @Query(() => [Note])
  async notesList(@Context('req') request: { headers: { authorization?: string } }): Promise<Note[]> {
    return this.notes.findAll(await this.ownerId(request));
  }

  @Query(() => Note, { nullable: true })
  async note(@Args('id') id: string, @Context('req') request: { headers: { authorization?: string } }): Promise<Note | null> {
    return this.notes.findOne(id, await this.ownerId(request));
  }

  @Mutation(() => Note)
  async createNote(@Args('input') input: CreateNoteInput, @Context('req') request: { headers: { authorization?: string } }): Promise<Note> {
    return this.notes.create(input, await this.ownerId(request));
  }

  @Mutation(() => Note, { nullable: true })
  async updateNote(
    @Args('id') id: string,
    @Args('input') input: UpdateNoteInput,
    @Context('req') request: { headers: { authorization?: string } },
  ): Promise<Note | null> {
    return this.notes.update(id, input, await this.ownerId(request));
  }

  @Mutation(() => Boolean)
  async deleteNote(@Args('id') id: string, @Context('req') request: { headers: { authorization?: string } }): Promise<boolean> {
    return this.notes.remove(id, await this.ownerId(request));
  }
}
