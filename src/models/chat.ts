import { Schema, model, Document, Types } from 'mongoose';

export interface IChatConversation extends Document<Types.ObjectId> {
  familyId: Types.ObjectId;
  type: 'dm' | 'group';
  name?: string; // group name or DM label
  participantIds: Types.ObjectId[];
  createdById: Types.ObjectId;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  archivedBy: Types.ObjectId[];
}

export interface IChatMessage extends Document<Types.ObjectId> {
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  content: string;
  readBy: { userId: Types.ObjectId; readAt: Date }[];
  createdAt: Date;
}

const chatConversationSchema = new Schema<IChatConversation>(
  {
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    type: { type: String, enum: ['dm', 'group'], required: true },
    name: { type: String, maxlength: 120 },
    participantIds: {
      type: [Schema.Types.ObjectId],
      ref: 'User',
      required: true,
      validate: {
        validator: (ids: Types.ObjectId[]) => ids.length >= 2,
        message: 'A conversation needs at least 2 participants',
      },
    },
    createdById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String, maxlength: 140 },
    archivedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true },
);

// One DM per pair within a family: same sorted participants cannot create duplicates.
chatConversationSchema.index({ familyId: 1, type: 1, participantIds: 1 });

export const ChatConversation = model<IChatConversation>('ChatConversation', chatConversationSchema);

const chatMessageSchema = new Schema<IChatMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatConversation',
      required: true,
      index: true,
    },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    content: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000 },
    readBy: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, readAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);

chatMessageSchema.index({ conversationId: 1, createdAt: -1 });

export const ChatMessage = model<IChatMessage>('ChatMessage', chatMessageSchema);
