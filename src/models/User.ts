import mongoose, { Document, Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../types';

export interface IUser extends Document {
  name:            string;
  email:           string;
  password:        string;
  role:            UserRole;
  organizationId?: Types.ObjectId;  // absent/null for super_admin (platform-level)
  isActive:        boolean;
  lastActive?:     Date;
  refreshToken?:   string;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name:  { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    role: {
      type:    String,
      enum:    Object.values(UserRole),
      default: UserRole.ANALYST,
    },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    isActive:       { type: Boolean, default: true },
    lastActive:     { type: Date },
    refreshToken:   { type: String, select: false },
  },
  { timestamps: true },
);

// Email unique within an org — two orgs can share the same email address.
// super_admin has no org (organizationId null), so email must still be globally
// unique for them; the partial filter handles this.
userSchema.index(
  { email: 1, organizationId: 1 },
  { unique: true, sparse: true },
);
// Keep a simple email index for fast lookups by login
userSchema.index({ email: 1 });
userSchema.index({ organizationId: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (this.password.startsWith('$2')) return next(); // already hashed
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
