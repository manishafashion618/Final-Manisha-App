import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * An append-only record of every role and activation change made from admin.
 *
 * Staff promotion is the one action that hands someone else power, and it is
 * the one action nobody notices afterwards: the accounts screen shows the
 * current role, never who set it. This is the trail — who did it, to whom,
 * from what to what, and when.
 *
 * Deliberately not deleted with the account it refers to: the point of an
 * audit trail is that it outlives the thing it describes. The row keeps ids
 * and the role change, and an email snapshot only so a deleted account is
 * still identifiable to whoever reads the log.
 */
export interface IRoleChange extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  actorEmail?: string;
  targetId: Types.ObjectId;
  targetEmail?: string;
  action: 'role' | 'active';
  from: string;
  to: string;
  createdAt: Date;
}

const roleChangeSchema = new Schema<IRoleChange>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    targetId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    action: { type: String, enum: ['role', 'active'], required: true },
    from: { type: String, required: true, maxlength: 40 },
    to: { type: String, required: true, maxlength: 40 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The log is read newest-first, and occasionally filtered to one account.
roleChangeSchema.index({ createdAt: -1 });
roleChangeSchema.index({ targetId: 1, createdAt: -1 });

export const RoleChange = model<IRoleChange>('RoleChange', roleChangeSchema);
