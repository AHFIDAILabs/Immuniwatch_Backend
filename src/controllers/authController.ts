import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { User }         from '../models/User';
import { Organization } from '../models/Organization';
import { AuditLog }     from '../models/AuditLog';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt';
import { AppError }     from '../utils/AppError';
import { config }       from '../config';
import { AuthenticatedRequest, AuditAction, UserRole } from '../types';

// ── Invite helpers ────────────────────────────────────────────────────────────

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Link sent to the user who was personally invited (set their own password) */
export function inviteLink(token: string): string {
  return `${config.frontendUrl}/accept-invite/${token}`;
}

/** Link that lets someone self-register as the org admin for an organization */
export function orgClaimLink(token: string): string {
  return `${config.frontendUrl}/claim-org/${token}`;
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_MS  = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   config.cookie.secure,
  sameSite: config.cookie.sameSite as 'strict' | 'lax' | 'none',
};

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('access_token', accessToken, { ...BASE_COOKIE_OPTIONS, maxAge: ACCESS_TOKEN_TTL_MS, path: '/' });
  res.cookie('refresh_token', refreshToken, { ...BASE_COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_TTL_MS, path: '/api' });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token',  { ...BASE_COOKIE_OPTIONS, path: '/' });
  res.clearCookie('refresh_token', { ...BASE_COOKIE_OPTIONS, path: '/api' });
}

// ── Controllers ───────────────────────────────────────────────────────────────

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = req.body as { email: string; password: string };

    // Find active user first
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Clear messages for specific account states
    if (user.isInvitePending) {
      throw new AppError(403, 'INVITE_PENDING', 'You must accept your invite and set a password before logging in. Check your invite link.');
    }
    if (!user.isActive) {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Contact your administrator.');
    }

    const orgId = user.organizationId?.toString() ?? null;
    const accessToken  = signAccessToken(user.id, user.role, orgId);
    const refreshToken = signRefreshToken(user.id, user.role, orgId);

    user.refreshToken = refreshToken;
    user.lastActive   = new Date();
    await user.save();

    await AuditLog.create({
      actor: user._id, actorName: user.name,
      action: AuditAction.USER_LOGIN, resourceType: 'User', resourceId: user.id,
      ipAddress: req.ip,
    });

    let organization: { id: string; name: string; slug: string } | null = null;
    if (orgId) {
      const org = await Organization.findById(orgId).select('name slug').lean();
      if (org) organization = { id: org._id.toString(), name: org.name, slug: org.slug };
    }

    setAuthCookies(res, accessToken, refreshToken);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: orgId },
      organization,
    });
  } catch (err) { next(err); }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (!refreshToken) throw new AppError(401, 'No refresh token');

    const payload = verifyToken(refreshToken);
    if (payload.type !== 'refresh') throw new AppError(401, 'Invalid token type');

    const user = await User.findById(payload.sub).select('+refreshToken');
    if (!user || user.refreshToken !== refreshToken) throw new AppError(401, 'Refresh token revoked');

    // Session invalidated by admin deactivation
    if (!user.isActive) {
      clearAuthCookies(res);
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Contact your administrator.');
    }

    const orgId = user.organizationId?.toString() ?? null;
    const newAccess  = signAccessToken(user.id, user.role, orgId);
    const newRefresh = signRefreshToken(user.id, user.role, orgId);

    user.refreshToken = newRefresh;
    user.lastActive   = new Date();
    await user.save();

    setAuthCookies(res, newAccess, newRefresh);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user } = req as AuthenticatedRequest;
    await User.findByIdAndUpdate(user.id, { $unset: { refreshToken: '' } });
    await AuditLog.create({ actor: user.id, action: AuditAction.USER_LOGOUT, resourceType: 'User', resourceId: user.id });
    clearAuthCookies(res);
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
}

// ── Invite flow ───────────────────────────────────────────────────────────────

// ── Org-admin self-registration (claim) flow ─────────────────────────────────

/** GET /auth/claim-org/:token — validate token, return org info for the claim page */
export async function getOrgClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.params;
    const org = await Organization.findOne({ claimToken: token }).lean();

    if (!org)                                              throw new AppError(404, 'CLAIM_NOT_FOUND',  'This link is invalid or has been revoked.');
    if (org.claimTokenExpiresAt && org.claimTokenExpiresAt < new Date())
                                                           throw new AppError(410, 'CLAIM_EXPIRED',    'This invite link has expired. Ask the platform admin to regenerate it.');
    if (org.adminClaimed)                                  throw new AppError(409, 'CLAIM_ALREADY_USED','An admin has already been registered for this organization.');

    res.json({ orgName: org.name, orgId: org._id.toString(), region: org.region, state: org.state });
  } catch (err) { next(err); }
}

/** POST /auth/claim-org — self-register as org admin */
export async function acceptOrgClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, name, email, password } = req.body as {
      token: string; name: string; email: string; password: string;
    };
    if (!token || !name || !email || !password || password.length < 8) {
      throw new AppError(400, 'INVALID', 'token, name, email and password (min 8 chars) are required');
    }

    const org = await Organization.findOne({ claimToken: token });
    if (!org)                                              throw new AppError(404, 'CLAIM_NOT_FOUND',  'This link is invalid or has been revoked.');
    if (org.claimTokenExpiresAt && org.claimTokenExpiresAt < new Date())
                                                           throw new AppError(410, 'CLAIM_EXPIRED',    'This invite link has expired. Ask the platform admin to regenerate it.');
    if (org.adminClaimed)                                  throw new AppError(409, 'CLAIM_ALREADY_USED','An admin has already been registered for this organization.');

    // Check email not already used in this org
    const exists = await User.findOne({ email: email.toLowerCase(), organizationId: org._id }).lean();
    if (exists) throw new AppError(409, 'CONFLICT', 'This email is already registered in the organization.');

    // Create the org_admin user
    const user = await User.create({
      name,
      email:          email.toLowerCase(),
      password,
      role:           UserRole.ORG_ADMIN,
      organizationId: org._id,
      isActive:       true,
      isInvitePending: false,
    });

    // Mark org as claimed and clear the token
    org.adminClaimed        = true;
    org.claimToken          = undefined;
    org.claimTokenExpiresAt = undefined;
    org.userCount           = (org.userCount ?? 0) + 1;
    await org.save();

    res.status(201).json({ message: 'Admin account created. You can now log in.', email: user.email });
  } catch (err) { next(err); }
}

/** POST /auth/invite/:token — validate token, return public user info */
export async function getInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = req.params;
    const user = await User.findOne({ inviteToken: token }).select('+inviteToken +inviteTokenExpiresAt').lean();

    if (!user)                                           throw new AppError(404, 'INVITE_NOT_FOUND',  'Invite link is invalid or has already been used.');
    if (!user.inviteTokenExpiresAt || user.inviteTokenExpiresAt < new Date())
                                                         throw new AppError(410, 'INVITE_EXPIRED',    'This invite link has expired. Ask your admin to resend it.');
    if (!user.isInvitePending)                           throw new AppError(409, 'INVITE_ALREADY_USED','This invite has already been accepted. Please log in.');

    let orgName: string | null = null;
    if (user.organizationId) {
      const org = await Organization.findById(user.organizationId).select('name').lean();
      orgName = org?.name ?? null;
    }

    res.json({
      name:     user.name,
      email:    user.email,
      role:     user.role,
      orgName,
    });
  } catch (err) { next(err); }
}

/** POST /auth/accept-invite — set password, activate account */
export async function acceptInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, password } = req.body as { token: string; password: string };
    if (!token || !password || password.length < 8) {
      throw new AppError(400, 'INVALID', 'token and password (min 8 chars) are required');
    }

    const user = await User.findOne({ inviteToken: token }).select('+inviteToken +inviteTokenExpiresAt +password');
    if (!user)                                           throw new AppError(404, 'INVITE_NOT_FOUND',  'Invite link is invalid or has already been used.');
    if (!user.inviteTokenExpiresAt || user.inviteTokenExpiresAt < new Date())
                                                         throw new AppError(410, 'INVITE_EXPIRED',    'This invite link has expired. Ask your admin to resend it.');
    if (!user.isInvitePending)                           throw new AppError(409, 'INVITE_ALREADY_USED','Invite already accepted. Please log in.');

    // Set real password, clear invite fields, activate account
    user.password              = password;  // pre-save hook will hash it
    user.inviteToken           = undefined;
    user.inviteTokenExpiresAt  = undefined;
    user.isInvitePending       = false;
    user.isActive              = true;
    await user.save();

    res.json({ message: 'Password set successfully. You can now log in.', email: user.email });
  } catch (err) { next(err); }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user } = req as AuthenticatedRequest;
    const dbUser = await User.findById(user.id).lean();
    if (!dbUser) throw new AppError(404, 'User not found');

    // Account was deactivated while session was live
    if (!dbUser.isActive) {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Contact your administrator.');
    }

    const orgId = dbUser.organizationId?.toString() ?? null;
    let organization: { id: string; name: string; slug: string } | null = null;
    if (orgId) {
      const org = await Organization.findById(orgId).select('name slug').lean();
      if (org) organization = { id: org._id.toString(), name: org.name, slug: org.slug };
    }

    res.json({
      id: dbUser._id.toString(), name: dbUser.name, email: dbUser.email,
      role: dbUser.role, organizationId: orgId, organization,
    });
  } catch (err) { next(err); }
}
