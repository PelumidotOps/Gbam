export interface SubscriptionPlan {
  id: '1_week' | '1_month' | '3_months';
  name: string;
  badge: string;
  priceNgn: number;
  days: number;
  description: string;
}

export class PaystackService {
  private static instance: PaystackService;
  private readonly secretKey: string;
  private readonly publicKey: string;

  private constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY || '';
    this.publicKey = process.env.PAYSTACK_PUBLIC_KEY || '';
  }

  public static getInstance(): PaystackService {
    if (!PaystackService.instance) {
      PaystackService.instance = new PaystackService();
    }
    return PaystackService.instance;
  }

  public getPlans(): Record<string, SubscriptionPlan> {
    const p1w = Number(process.env.PRICE_1_WEEK) || 1500;
    const p1m = Number(process.env.PRICE_1_MONTH) || 5000;
    const p3m = Number(process.env.PRICE_3_MONTHS) || 12000;

    return {
      '1_week': {
        id: '1_week',
        name: '1 Week Access',
        badge: '🟢 Starter',
        priceNgn: p1w,
        days: 7,
        description: '7 Days of full VIP access & high-confidence multi-platform slips'
      },
      '1_month': {
        id: '1_month',
        name: '1 Month VIP',
        badge: '🔥 Most Popular',
        priceNgn: p1m,
        days: 30,
        description: '30 Days of daily VIP predictions, value accumulators, and booking codes'
      },
      '3_months': {
        id: '3_months',
        name: '3 Months Pro VIP',
        badge: '👑 Best Value',
        priceNgn: p3m,
        days: 90,
        description: '90 Days of nonstop betting intelligence at the biggest discount'
      }
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey && this.secretKey.startsWith('sk_'));
  }

  /**
   * Initialize a Paystack checkout transaction
   */
  public async initializeTransaction(params: {
    telegramId: number;
    username?: string;
    planId: '1_week' | '1_month' | '3_months' | string;
  }): Promise<{
    success: boolean;
    authorizationUrl?: string;
    reference?: string;
    error?: string;
    plan?: SubscriptionPlan;
  }> {
    const plans = this.getPlans();
    const cleanId = (params.planId || '').replace(/^plan_/, '');
    const plan = plans[cleanId] || plans[params.planId];
    if (!plan) {
      return { success: false, error: 'Invalid plan selected' };
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Paystack is not configured yet. Secret key missing.'
      };
    }

    const reference = `GBAM_${plan.id.toUpperCase()}_${params.telegramId}_${Date.now()}`;
    // Fallback email compliant with Paystack
    const email = params.username
      ? `${params.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'user'}@gbamai.com`
      : `vip_${params.telegramId}@gbamai.com`;

    const amountInKobo = plan.priceNgn * 100;

    try {
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          reference,
          currency: 'NGN',
          callback_url: 'https://t.me/GbamAI_bot',
          metadata: {
            telegramId: params.telegramId,
            username: params.username || '',
            planId: plan.id,
            planName: plan.name,
            days: plan.days,
            custom_fields: [
              {
                display_name: 'Telegram User ID',
                variable_name: 'telegram_id',
                value: String(params.telegramId)
              },
              {
                display_name: 'Subscription Plan',
                variable_name: 'plan_name',
                value: plan.name
              }
            ]
          }
        }),
      });

      const data = (await response.json()) as any;

      if (!response.ok || !data.status) {
        return {
          success: false,
          error: data.message || `Paystack initialization failed (HTTP ${response.status})`
        };
      }

      return {
        success: true,
        authorizationUrl: data.data.authorization_url,
        reference: data.data.reference,
        plan
      };
    } catch (err: any) {
      console.error('[PaystackService] Initialization error:', err);
      return {
        success: false,
        error: err.message || 'Network error connecting to Paystack'
      };
    }
  }

  /**
   * Verify transaction status with Paystack
   */
  public async verifyTransaction(reference: string): Promise<{
    success: boolean;
    status: 'success' | 'failed' | 'abandoned' | 'pending';
    amountNgn?: number;
    telegramId?: number;
    planId?: string;
    days?: number;
    paidAt?: string;
    message?: string;
  }> {
    if (!this.isConfigured()) {
      return {
        success: false,
        status: 'failed',
        message: 'Paystack is not configured.'
      };
    }

    try {
      const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      const res = (await response.json()) as any;

      if (!response.ok || !res.status) {
        return {
          success: false,
          status: 'failed',
          message: res.message || 'Verification lookup failed'
        };
      }

      const tx = res.data;
      const isPaid = tx.status === 'success';

      const metadata = tx.metadata || {};
      const telegramId = metadata.telegramId ? Number(metadata.telegramId) : undefined;
      const planId = metadata.planId;
      const days = metadata.days ? Number(metadata.days) : undefined;
      const amountNgn = tx.amount ? tx.amount / 100 : undefined;

      return {
        success: isPaid,
        status: tx.status,
        amountNgn,
        telegramId,
        planId,
        days,
        paidAt: tx.paid_at,
        message: tx.gateway_response || tx.status,
      };
    } catch (err: any) {
      console.error('[PaystackService] Verification error:', err);
      return {
        success: false,
        status: 'failed',
        message: err.message || 'Network error verifying with Paystack'
      };
    }
  }

  /**
   * Look up recent successful transactions on Paystack for a telegram user
   * Returns transaction details if a valid unexpired transaction is found.
   */
  public async findLatestValidCustomerPayment(telegramId: number): Promise<{
    found: boolean;
    reference?: string;
    planId?: string;
    days?: number;
    amountNgn?: number;
    paidAt?: string;
    expiresAt?: string;
  }> {
    if (!this.isConfigured()) return { found: false };

    try {
      const response = await fetch('https://api.paystack.co/transaction?perPage=50', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      const res = (await response.json()) as any;
      if (!response.ok || !res.status || !Array.isArray(res.data)) {
        return { found: false };
      }

      const now = Date.now();
      const targetIdStr = String(telegramId);

      for (const tx of res.data) {
        if (tx.status !== 'success') continue;

        const metaId = tx.metadata?.telegramId ? String(tx.metadata.telegramId) : '';
        const email = tx.customer?.email || '';
        const isMatch = metaId === targetIdStr || email.includes(`_${targetIdStr}@`);

        if (isMatch && tx.paid_at) {
          const days = Number(tx.metadata?.days) || 7;
          const paidTime = new Date(tx.paid_at).getTime();
          const expiryTime = paidTime + days * 24 * 60 * 60 * 1000;

          if (expiryTime > now) {
            return {
              found: true,
              reference: tx.reference,
              planId: tx.metadata?.planId || '1_week',
              days,
              amountNgn: (tx.amount || 0) / 100,
              paidAt: tx.paid_at,
              expiresAt: new Date(expiryTime).toISOString(),
            };
          }
        }
      }

      return { found: false };
    } catch (err: any) {
      console.error('[PaystackService] findLatestValidCustomerPayment error:', err);
      return { found: false };
    }
  }
}

