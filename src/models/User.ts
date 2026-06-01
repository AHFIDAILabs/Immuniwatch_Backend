import mongoose, { Document, Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../types';

export interface IUser extends Document {
  name:                  string;
  email:                 string;
  password:              string;
  role:                  UserRole;
  organizationId?:       Types.ObjectId;
  isActive:              boolean;
  isInvitePending:       boolean;    // true until the invitee accepts and sets password
  inviteToken?:          string;     // 64-char hex, select: false
  inviteTokenExpiresAt?: Date;
  lastActive?:           Date;
  refreshToken?:         string;     // select: false
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name:  { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    // password is set either directly (seed/super_admin) or via accept-invite flow
    password:        { type: String, required: true, minlength: 8, select: false },
    role:            { type: String, enum: Object.values(UserRole), default: UserRole.ANALYST },
    organizationId:  { type: Schema.Types.ObjectId, ref: 'Organization' },
    isActive:        { type: Boolean, default: true },
    isInvitePending: { type: Boolean, default: false },
    inviteToken:     { type: String, select: false },
    inviteTokenExpiresAt: { type: Date },
    lastActive:      { type: Date },
    refreshToken:    { type: String, select: false },
  },
  { timestamps: true },
);

userSchema.index({ email: 1, organizationId: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1 });
userSchema.index({ organizationId: 1 });
userSchema.index({ inviteToken: 1 }, { sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (this.password.startsWith('$2')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
