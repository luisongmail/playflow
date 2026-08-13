import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ pool: undefined, hasDatabaseConfigured: () => false }));

describe('sessionService — sin DB', () => {
  beforeEach(() => {
    process.env.JWT_REFRESH_TOKEN_DAYS = '30';
    process.env.COOKIE_SECURE = 'true';
    process.env.COOKIE_SAME_SITE = 'Strict';
  });

  it('createSession sin DB retorna sessionId y refreshToken', async () => {
    const { createSession } = await import('./sessionService');
    const { sessionId, refreshToken } = await createSession('usr_1', '127.0.0.1', 'Mozilla');
    expect(sessionId).toMatch(/^sess_/);
    expect(sessionId.length).toBeLessThanOrEqual(36);
    expect(refreshToken).toHaveLength(64); // 32 bytes en hex
  });

  it('rotateRefreshToken sin DB retorna expired', async () => {
    const { rotateRefreshToken } = await import('./sessionService');
    const result = await rotateRefreshToken('some_token');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('buildRefreshCookie incluye los atributos de seguridad', async () => {
    const { buildRefreshCookie } = await import('./sessionService');
    const cookie = buildRefreshCookie('mytoken123');
    expect(cookie).toContain('pf_refresh=mytoken123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/auth/token/refresh');
    expect(cookie).toContain('Max-Age=2592000');
    expect(cookie).toContain('Secure');
  });

  it('buildClearCookie tiene Max-Age=0', async () => {
    const { buildClearCookie } = await import('./sessionService');
    const cookie = buildClearCookie();
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('pf_refresh=;');
  });
});
