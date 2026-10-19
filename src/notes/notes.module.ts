import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Note, NoteSchema } from './note.schema';
import { NotesResolver } from './notes.resolver';
import { NotesService } from './notes.service';

@Module({
  imports: [AuthModule, MongooseModule.forFeature([{ name: Note.name, schema: NoteSchema }])],
  providers: [NotesResolver, NotesService],
})
export class NotesModule {}
