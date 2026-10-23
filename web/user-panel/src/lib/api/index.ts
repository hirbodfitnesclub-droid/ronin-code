import { LiveApiClient } from './live';
import { MockApiClient } from './mock';
import type { Claim, OnboardingInput, PanelApi } from './types';

export * from './types';
export * from './errors';

/* Factory — ONE PanelApi for the whole app.
   VITE_API_MODE='mock' selects the full MockApiClient. Otherwise the live
   client is used, including claims: VITE_CLAIMS_ADAPTER routes
   listClaims/createClaim and defaults to 'live' (set it to 'mock' only for
   offline UI work) — the merged backend serves the receipt /api/orders. */
class ClaimsAdapter implements PanelApi {
  constructor(
    private live: LiveApiClient,
    private mock: MockApiClient,
    private claimsLive: boolean,
  ) {}
  getSession = () => this.live.getSession() ?? this.mock.getSession();
  requestOtp = (p: string) => this.live.requestOtp(p);
  verifyOtp = (p: string, c: string, d: string) => this.live.verifyOtp(p, c, d);
  logout = () => this.live.logout();
  logoutAll = () => this.live.logoutAll();
  me = () => this.live.me();
  submitOnboarding = (i: OnboardingInput) => this.live.submitOnboarding(i);
  accountStatus = () => this.live.accountStatus();
  packs = () => this.live.packs();
  credits = () => this.live.credits();
  devices = () => this.live.devices();
  revokeDevice = (id: string) => this.live.revokeDevice(id);
  usageSummary = () => this.live.usageSummary();
  recentUsage = () => this.live.recentUsage();
  issueHandoff = () => this.live.issueHandoff();
  listClaims = (): Promise<Claim[]> => (this.claimsLive ? this.live.listClaims() : this.mock.listClaims());
  createClaim = (packId: string, f: File): Promise<Claim> =>
    this.claimsLive ? this.live.createClaim(packId, f) : this.mock.createClaim(packId, f);
}

function createApi(): PanelApi {
  if (import.meta.env.VITE_API_MODE === 'mock') return new MockApiClient();
  const claimsLive = import.meta.env.VITE_CLAIMS_ADAPTER !== 'mock';
  // Mock claims share no session with the live client, so the factory sets
  // claimsLenient on the mock instance used purely as the claims adapter.
  const mock = new MockApiClient();
  mock.claimsLenient = true;
  return new ClaimsAdapter(new LiveApiClient(), mock, claimsLive);
}

export const api: PanelApi = createApi();
