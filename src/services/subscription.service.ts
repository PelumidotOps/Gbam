import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Subscriber {
  telegramId: number;
  username?: string;
  fullName?: string;
  plan: '1_week' | '1_month' | '3_months' | 'lifetime' | 'custom' | string;
  status: 'active' | 'expired' | 'revoked';
  activatedAt: string; // ISO string
  expiresAt: string;   // ISO string
  isLifetime: boolean;
  paymentReference?: string;
  redeemedCode?: string;
}

export interface ActivationCode {
  code: string;
  days: number;
  isLifetime: boolean;
  createdBy: number;
  createdAt: string;
  isUsed: boolean;
  usedBy?: number;
  usedByUsername?: string;
  usedAt?: string;
  label?: string;
}

export interface SubscriptionData {
  subscribers: Record<string, Subscriber>;
  codes: Record<string, ActivationCode>;
}

export class SubscriptionService {
  private static instance: SubscriptionService;
  private readonly filePath: string;
  private data: SubscriptionData = { subscribers: {}, codes: {} };
  private adminId: number;

  private constructor() {
    this.filePath = path.resolve(process.cwd(), 'data', 'subscriptions.json');
    this.adminId = Number(process.env.ADMIN_TELEGRAM_ID) || 2003833302;
    this.loadData();
    this.seedAdmin();
  }

  public static getInstance(): SubscriptionService {
    if (!SubscriptionService.instance) {
      SubscriptionService.instance = new SubscriptionService();
    }
    return SubscriptionService.instance;
  }

  public getAdminId(): number {
    return this.adminId;
  }

  public isAdmin(telegramId: number): boolean {
    return Number(telegramId) === this.adminId;
  }

  private loadData(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.subscribers) this.data.subscribers = {};
        if (!this.data.codes) this.data.codes = {};
      } else {
        this.data = { subscribers: {}, codes: {} };
        this.saveData();
      }
    } catch (err) {
      console.error('[SubscriptionService] Error loading database:', err);
      this.data = { subscribers: {}, codes: {} };
    }
  }

  private saveData(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Atomic write using a temp file
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[SubscriptionService] Error saving database:', err);
    }
  }

  private seedAdmin(): void {
    if (!this.adminId) return;
    const adminKey = String(this.adminId);
    if (!this.data.subscribers[adminKey]) {
      this.data.subscribers[adminKey] = {
        telegramId: this.adminId,
        username: 'oxclone',
        fullName: 'Admin (Gbam Owner)',
        plan: 'lifetime',
        status: 'active',
        activatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(),
        isLifetime: true,
      };
      this.saveData();
    }
  }

  /**
   * Check if a Telegram user has an active unexpired subscription
   */
  public isUserActive(telegramId: number): {
    active: boolean;
    reason?: string;
    subscriber?: Subscriber;
    daysRemaining?: number;
  } {
    const idNum = Number(telegramId);
    if (this.isAdmin(idNum)) {
      return { active: true, subscriber: this.data.subscribers[String(idNum)], daysRemaining: 99999 };
    }

    const sub = this.data.subscribers[String(idNum)];
    if (!sub) {
      return { active: false, reason: 'NO_SUBSCRIPTION' };
    }

    if (sub.status === 'revoked') {
      return { active: false, reason: 'REVOKED', subscriber: sub };
    }

    if (sub.isLifetime) {
      return { active: true, subscriber: sub, daysRemaining: 99999 };
    }

    const now = Date.now();
    const expiryTime = new Date(sub.expiresAt).getTime();

    if (expiryTime > now) {
      const daysRemaining = Math.max(1, Math.ceil((expiryTime - now) / (1000 * 60 * 60 * 24)));
      return { active: true, subscriber: sub, daysRemaining };
    }

    // Auto mark expired if time has passed
    if (sub.status !== 'expired') {
      sub.status = 'expired';
      this.saveData();
    }

    return { active: false, reason: 'EXPIRED', subscriber: sub, daysRemaining: 0 };
  }

  /**
   * Activate or renew a user's subscription
   */
  public activateUser(params: {
    telegramId: number;
    username?: string;
    fullName?: string;
    days: number;
    plan: string;
    paymentReference?: string;
    redeemedCode?: string;
    isLifetime?: boolean;
  }): Subscriber {
    const {
      telegramId,
      username,
      fullName,
      days,
      plan,
      paymentReference,
      redeemedCode,
      isLifetime = false
    } = params;

    const idKey = String(telegramId);
    const existing = this.data.subscribers[idKey];
    const now = Date.now();

    let newExpiryTime: number;
    if (isLifetime) {
      newExpiryTime = now + 100 * 365 * 24 * 60 * 60 * 1000;
    } else {
      // If user currently has active time left, extend from their current expiry
      const currentExpiry = existing && new Date(existing.expiresAt).getTime() > now
        ? new Date(existing.expiresAt).getTime()
        : now;
      newExpiryTime = currentExpiry + days * 24 * 60 * 60 * 1000;
    }

    const subscriber: Subscriber = {
      telegramId,
      username: username || existing?.username,
      fullName: fullName || existing?.fullName,
      plan,
      status: 'active',
      activatedAt: existing?.activatedAt || new Date(now).toISOString(),
      expiresAt: new Date(newExpiryTime).toISOString(),
      isLifetime: isLifetime || existing?.isLifetime || false,
      paymentReference: paymentReference || existing?.paymentReference,
      redeemedCode: redeemedCode || existing?.redeemedCode,
    };

    this.data.subscribers[idKey] = subscriber;
    this.saveData();

    return subscriber;
  }

  /**
   * Admin generates a single-use VIP activation code
   */
  public generateCode(options: {
    days?: number;
    isLifetime?: boolean;
    createdBy: number;
    label?: string;
  }): ActivationCode {
    const { days = 30, isLifetime = false, createdBy, label } = options;
    const tag = isLifetime ? 'LIFE' : `${days}D`;
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `VIP-${tag}-${randomHex}`;

    const activationCode: ActivationCode = {
      code,
      days: isLifetime ? 36500 : days,
      isLifetime,
      createdBy,
      createdAt: new Date().toISOString(),
      isUsed: false,
      label,
    };

    this.data.codes[code] = activationCode;
    this.saveData();

    return activationCode;
  }

  /**
   * Redeem a VIP activation code
   */
  public redeemCode(params: {
    code: string;
    telegramId: number;
    username?: string;
    fullName?: string;
  }): { success: boolean; message: string; subscriber?: Subscriber; daysAdded?: number } {
    const cleanCode = params.code.trim().toUpperCase();
    const codeRecord = this.data.codes[cleanCode];

    if (!codeRecord) {
      return { success: false, message: 'Invalid activation code. Please check and try again.' };
    }

    if (codeRecord.isUsed) {
      return { success: false, message: 'This activation code has already been redeemed.' };
    }

    // Mark code as used
    codeRecord.isUsed = true;
    codeRecord.usedBy = params.telegramId;
    codeRecord.usedByUsername = params.username;
    codeRecord.usedAt = new Date().toISOString();

    // Activate subscriber
    const planName = codeRecord.isLifetime ? 'VIP Lifetime (Gift)' : `VIP ${codeRecord.days} Days (Gift)`;
    const subscriber = this.activateUser({
      telegramId: params.telegramId,
      username: params.username,
      fullName: params.fullName,
      days: codeRecord.days,
      plan: planName,
      redeemedCode: cleanCode,
      isLifetime: codeRecord.isLifetime,
    });

    this.saveData();

    return {
      success: true,
      message: `Code redeemed successfully! VIP access activated for ${codeRecord.isLifetime ? 'Lifetime' : `${codeRecord.days} days`}.`,
      subscriber,
      daysAdded: codeRecord.days,
    };
  }

  /**
   * Admin revokes access immediately
   */
  public revokeUser(telegramId: number): { success: boolean; message: string } {
    if (this.isAdmin(telegramId)) {
      return { success: false, message: 'Admin account cannot be revoked.' };
    }
    const idKey = String(telegramId);
    const sub = this.data.subscribers[idKey];
    if (!sub) {
      return { success: false, message: 'Subscriber not found.' };
    }

    sub.status = 'revoked';
    this.saveData();
    return { success: true, message: `Access for user ${sub.username || telegramId} has been revoked.` };
  }

  /**
   * Admin extends access by N days
   */
  public extendUser(telegramId: number, days: number): { success: boolean; message: string; subscriber?: Subscriber } {
    const idKey = String(telegramId);
    const sub = this.data.subscribers[idKey];
    if (!sub) {
      return { success: false, message: 'Subscriber not found.' };
    }

    const now = Date.now();
    const currentExpiry = new Date(sub.expiresAt).getTime() > now
      ? new Date(sub.expiresAt).getTime()
      : now;
    const newExpiry = currentExpiry + days * 24 * 60 * 60 * 1000;

    sub.expiresAt = new Date(newExpiry).toISOString();
    sub.status = 'active';
    this.saveData();

    return {
      success: true,
      message: `Extended ${sub.username || telegramId} by ${days} days. New expiry: ${new Date(newExpiry).toLocaleDateString()}`,
      subscriber: sub,
    };
  }

  /**
   * Get all registered subscribers
   */
  public getAllSubscribers(): Subscriber[] {
    return Object.values(this.data.subscribers);
  }

  /**
   * Get all generated codes
   */
  public getAllCodes(): ActivationCode[] {
    return Object.values(this.data.codes);
  }

  /**
   * Quick membership analytics
   */
  public getStats(): {
    totalSubscribers: number;
    activeSubscribers: number;
    expiredSubscribers: number;
    revokedSubscribers: number;
    totalCodesGenerated: number;
    unusedCodes: number;
  } {
    const subs = Object.values(this.data.subscribers);
    const codes = Object.values(this.data.codes);
    const now = Date.now();

    let active = 0;
    let expired = 0;
    let revoked = 0;

    for (const s of subs) {
      if (s.status === 'revoked') revoked++;
      else if (s.isLifetime || new Date(s.expiresAt).getTime() > now) active++;
      else expired++;
    }

    return {
      totalSubscribers: subs.length,
      activeSubscribers: active,
      expiredSubscribers: expired,
      revokedSubscribers: revoked,
      totalCodesGenerated: codes.length,
      unusedCodes: codes.filter(c => !c.isUsed).length,
    };
  }
}
