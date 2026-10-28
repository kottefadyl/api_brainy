import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class MoveOperation {
  @Prop({ required: true, index: true }) ownerId!: string;
  @Prop({ required: true }) sourceCollectionId!: string;
  @Prop({ required: true }) targetCollectionId!: string;
  @Prop({ required: true }) sourceObjectId!: string;
  @Prop({ required: true, unique: true }) transferKey!: string;
  @Prop({ required: true, enum: ['PLANNED', 'PREPARED', 'COPIED', 'COMPLETE', 'RECOVERING', 'ROLLED_BACK', 'FAILED'] }) state!: string;
  @Prop() targetObjectId?: string;
  @Prop({ type: [String], default: [] }) targetFormatIds!: string[];
  @Prop({ type: [String], default: [] }) targetUnitIds!: string[];
  @Prop() failure?: string;
  @Prop() createdAt!: Date;
  @Prop() updatedAt!: Date;
}
export const MoveOperationSchema = SchemaFactory.createForClass(MoveOperation);
