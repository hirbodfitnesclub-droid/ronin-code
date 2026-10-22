import { ApiError } from './errors';
import { clearSession, loadSession, saveSession } from './session';
import {
  MOCK_BALANCE,
  MOCK_CARD,
  MOCK_CLAIMS,
  MOCK_DEVICES,
  MOCK_LEDGER,
  MOCK_PACKS,
  MOCK_USAGE,
  MOCK_USER,
} from './fixtures';
import type {
  AccountStatus,
  Claim,
  CreditsResult,
  Device,
  MeResult,
  OtpVerifyResult,
  PacksResult,
  PanelApi,
  Session,
  UsageSummary,
} from './types';

const delay = () => new Promise((r) => setTimeout(r, 250));

export class MockApiClient implements PanelApi {
  private session: Session | null = loadSession();
  /** Set by the factory when only claims are mocked (live owns the session). */
  claimsLenient = false;
  private claims: Claim[] = [...MOCK_CLAIMS];
  private devicesList: Device[] = [...MOCK_DEVICES];

  getSession(): Session | null {
    return this.session;
  }

  private setSession(s: Session | null): void {
    this.session = s;
    if (s) saveSession(s);
    else clearSession();
  }

  private requireSession(): void {
    if (!this.session) throw new ApiError(401, 'unauthorized', 'Session expired');
  }

  async requestOtp(phone: string): Promise<{ ok: boolean }> {
    await delay();
    if (!/^09\d{9}$/.test(phone)) throw new ApiError(400, 'invalid_phone', 'Invalid phone');
    return { ok: true };
  }

  async verifyOtp(phone: string, code: string): Promise<OtpVerifyResult> {
    await delay();
    if (code === '000000') throw new ApiError(400, 'otp_expired', 'Code expired');
    if (code !== '123456') throw new ApiError(400, 'otp_wrong', 'Wrong code');
    const result: OtpVerifyResult = {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      accessExpiresInSec: 900,
      user: { ...MOCK_USER, phone },
      deviceId: 'dev-1',
    };
    this.setSession({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
      user: result.user,
    });
    return result;
  }

  async logout(): Promise<void> {
    await delay();
    this.setSession(null);
  }

  async logoutAll(): Promise<void> {
    await delay();
    this.setSession(null);
  }

  async me(): Promise<MeResult> {
    await delay();
    this.requireSession();
    return {
      user: this.session!.user,
      balanceTokens: MOCK_BALANCE,
      spendableTokens: MOCK_BALANCE,
      isAdminPhone: false,
    };
  }

  async accountStatus(): Promise<AccountStatus> {
    await delay();
    this.requireSession();
    return {
      userId: MOCK_USER.id,
      status: 'active',
      isActive: true,
      balanceTokens: MOCK_BALANCE,
      spendableTokens: MOCK_BALANCE,
      lots: [
        { id: 'lot-1', tokensLeft: MOCK_BALANCE, expiresAt: new Date(Date.now() + 52 * 86_400_000).toISOString() },
      ],
      deviceAuthorized: true,
      activeDevices: 2,
      serverTime: new Date().toISOString(),
    };
  }

  async packs(): Promise<PacksResult> {
    await delay();
    return { packs: MOCK_PACKS, card: MOCK_CARD };
  }

  async credits(): Promise<CreditsResult> {
    await delay();
    this.requireSession();
    // Purchases screen must NOT use these embedded orders — it uses listClaims().
    return { balanceTokens: MOCK_BALANCE, spendableTokens: MOCK_BALANCE, ledger: MOCK_LEDGER, orders: [] };
  }

  async devices(): Promise<Device[]> {
    await delay();
    this.requireSession();
    return [...this.devicesList];
  }

  async revokeDevice(id: string): Promise<void> {
    await delay();
    this.requireSession();
    this.devicesList = this.devicesList.filter((d) => d.id !== id);
  }

  async listClaims(): Promise<Claim[]> {
    await delay();
    if (!this.claimsLenient) this.requireSession();
    return [...this.claims];
  }

  async createClaim(packId: string, receiptFile: File): Promise<Claim> {
    await delay();
    if (!this.claimsLenient) this.requireSession();
    if (!receiptFile) throw new ApiError(400, 'receipt_required', 'Receipt required');
    if (!receiptFile.type.startsWith('image/'))
      throw new ApiError(400, 'invalid_receipt_type', 'Receipt must be an image');
    if (receiptFile.size > 5 * 1024 * 1024) throw new ApiError(400, 'receipt_too_large', 'Receipt too large');
    if (this.claims.filter((c) => c.status === 'pending').length >= 3) {
      throw new ApiError(409, 'too_many_pending', 'Too many pending claims');
    }
    const pack = MOCK_PACKS.find((p) => p.id === packId);
    if (!pack) throw new ApiError(404, 'not_found', 'Pack not found');
    const claim: Claim = {
      id: `claim-${Date.now()}`,
      packId: pack.id,
      packTitle: pack.title,
      tokens: pack.tokens,
      priceRials: pack.priceRials,
      status: 'pending',
      rejectReason: null,
      adminNote: null,
      hasReceipt: true,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    };
    this.claims = [claim, ...this.claims];
    return claim;
  }

  async usageSummary(): Promise<UsageSummary> {
    await delay();
    this.requireSession();
    return MOCK_USAGE;
  }
}
