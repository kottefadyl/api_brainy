import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateNoteInput, UpdateNoteInput } from './note.input';
import { Note } from './note.schema';

@Injectable()
export class NotesService {
  constructor(@InjectModel(Note.name) private readonly notes: Model<Note>) {}

  async findAll(ownerId: string): Promise<Note[]> {
    return this.notes.find({ ownerId }).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string, ownerId: string): Promise<Note | null> {
    return this.notes.findOne({ _id: id, ownerId }).exec();
  }

  async create(input: CreateNoteInput, ownerId: string): Promise<Note> {
    return this.notes.create({ ...input, ownerId });
  }

  async update(id: string, input: UpdateNoteInput, ownerId: string): Promise<Note | null> {
    return this.notes.findOneAndUpdate({ _id: id, ownerId }, input, { new: true, runValidators: true }).exec();
  }

  async remove(id: string, ownerId: string): Promise<boolean> {
    const result = await this.notes.findOneAndDelete({ _id: id, ownerId }).exec();
    return result !== null;
  }
}
