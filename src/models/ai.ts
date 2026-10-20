import { Schema, model, Document, Types } from 'mongoose';

export interface IAiMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  meta?: {
    proposalId?: string;
    actionType?: string;
    executionResult?: Record<string, unknown>;
    providerError?: boolean;
  };
}

export interface IAiConversation extends Document<Types.ObjectId> {
  userId: Types.ObjectId;
  familyId?: Types.ObjectId;
  title: string;
  messages: IAiMessage[];
  lastMessageAt: Date;
}

/** A structured action proposal produced by the AI, awaiting user confirmation. */
export interface IAiProposal {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: Types.ObjectId;
  type: string;
  payload: Record<string, unknown>;
  explanation: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed';
  result?: Record<string, unknown>;
  createdAt: Date;
}

const aiMessageSchema = new Schema<IAiMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 8000 },
    createdAt: { type: Date, default: Date.now },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const aiConversationSchema = new Schema<IAiConversation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', index: true },
    title: { type: String, default: 'New conversation', maxlength: 160 },
    messages: { type: [aiMessageSchema], default: [] },
    lastMessageAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

const aiProposalSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: 'AIConversation', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  familyId: { type: Schema.Types.ObjectId, ref: 'Family', required: true },
  type: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  explanation: { type: String, maxlength: 2000 },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'executed', 'failed'],
    default: 'pending',
    index: true,
  },
  result: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

export const AIConversation = model<IAiConversation>('AIConversation', aiConversationSchema);
export const AIProposal = model<IAiProposal>('AIProposal', aiProposalSchema);
