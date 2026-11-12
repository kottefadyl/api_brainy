import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { Note, NoteSchema } from './note.schema.js';
import { NotesResolver } from './notes.resolver.js';
import { NotesService } from './notes.service.js';

@Module({
  imports: [AuthModule, MongooseModule.forFeature([{ name: Note.name, schema: NoteSchema }])],
  providers: [NotesResolver, NotesService],
})
export class NotesModule {}
