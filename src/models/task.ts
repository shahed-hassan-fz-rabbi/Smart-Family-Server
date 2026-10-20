import { Schema, model, Document, Types } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface ITask extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;
  assigneeId?: Types.ObjectId;
  createdById: Types.ObjectId;
  completedAt?: Date;
  createdBy: 'user' | 'ai';
}

const taskSchema = new Schema<ITask>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 2000 },
    status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending', index: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium', index: true },
    dueDate: { type: Date },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    completedAt: { type: Date },
    createdBy: { type: String, enum: ['user', 'ai'], default: 'user' },
  },
  { timestamps: true },
);

taskSchema.index({ familyId: 1, status: 1, dueDate: 1 });

export const Task = model<ITask>('Task', taskSchema);
