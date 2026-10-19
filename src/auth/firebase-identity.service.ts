import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export type GoogleIdentity = {
  uid: string;
  email: string;
  name: string;
};

@Injectable()
export class FirebaseIdentityService {
  private app?: App;

  async verifyGoogleToken(idToken: string): Promise<GoogleIdentity> {
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    if (!projectId) {
      throw new ServiceUnavailableException('Google sign-in is not configured on the server');
    }
    if (!idToken || idToken.length > 8192) {
      throw new UnauthorizedException('Invalid Google session');
    }

    this.app ??= getApps().find((app) => app.name === 'brainy') ??
      initializeApp({ projectId }, 'brainy');
    try {
      const decoded = await getAuth(this.app).verifyIdToken(idToken);
      const email = decoded.email?.trim().toLowerCase();
      if (!decoded.uid || !email || !decoded.email_verified ||
          decoded.firebase.sign_in_provider !== 'google.com') {
        throw new Error('Google account has no verified email');
      }
      return {
        uid: decoded.uid,
        email,
        name: decoded.name?.trim() || email.split('@')[0],
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired Google session');
    }
  }
}
