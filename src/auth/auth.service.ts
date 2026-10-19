import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Model } from 'mongoose';
import { AuthPayload, LoginInput, RegisterInput } from './auth.types';
import { FirebaseIdentityService } from './firebase-identity.service';
import { User } from './user.schema';

const scrypt = promisify(scryptCallback);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tokenLifetimeSeconds = 60 * 60 * 24 * 7;

@Injectable()
export class AuthService {
  private readonly secret: string;

  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly firebaseIdentity: FirebaseIdentityService,
  ) {
    const configured = process.env.JWT_SECRET;
    if (process.env.NODE_ENV === 'production' && (!configured || configured.length < 32)) {
      throw new Error('JWT_SECRET must contain at least 32 characters in production');
    }
    this.secret = configured || 'brainy-local-development-secret-change-before-deploying';
  }

  async register(input: RegisterInput): Promise<AuthPayload> {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    this.validateCredentials(email, input.password);
    if (name.length < 2 || name.length > 80) {
      throw new BadRequestException('Name must be between 2 and 80 characters');
    }
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(input.password, salt, 64)) as Buffer;
    try {
      const user = await this.users.create({ name, email, passwordHash: `${salt}:${hash.toString('hex')}` });
      return { user, token: this.sign(user.id) };
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async login(input: LoginInput): Promise<AuthPayload> {
    const email = input.email.trim().toLowerCase();
    const user = await this.users.findOne({ email }).select('+passwordHash').exec();
    if (!user?.passwordHash) throw new UnauthorizedException('Incorrect email or password');
    const [salt, stored] = user.passwordHash.split(':');
    if (!salt || !stored) throw new UnauthorizedException('Incorrect email or password');
    const actual = (await scrypt(input.password, salt, 64)) as Buffer;
    const expected = Buffer.from(stored, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('Incorrect email or password');
    }
    return { user, token: this.sign(user.id) };
  }

  async loginWithGoogle(firebaseIdToken: string): Promise<AuthPayload> {
    const identity = await this.firebaseIdentity.verifyGoogleToken(firebaseIdToken);
    let user = await this.users.findOne({ firebaseUid: identity.uid }).exec();
    if (!user) {
      user = await this.users.findOne({ email: identity.email }).exec();
      if (user) {
        if (user.firebaseUid && user.firebaseUid !== identity.uid) {
          throw new ConflictException('This email is linked to another Google account');
        }
        user = await this.users.findOneAndUpdate(
          { _id: user.id, firebaseUid: { $exists: false } },
          { $set: { firebaseUid: identity.uid } },
          { new: true },
        ).exec() ?? await this.users.findOne({ firebaseUid: identity.uid }).exec();
      } else {
        try {
          user = await this.users.create({
            name: identity.name.slice(0, 80),
            email: identity.email,
            firebaseUid: identity.uid,
          });
        } catch (error: unknown) {
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) {
            throw error;
          }
          user = await this.users.findOne({ firebaseUid: identity.uid }).exec();
        }
      }
    }
    if (!user) throw new ConflictException('This email is already linked to another account');
    return { user, token: this.sign(user.id) };
  }

  async currentUser(authorization?: string): Promise<User> {
    const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Sign in to continue');
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) throw new UnauthorizedException('Invalid session');
    const signed = `${header}.${payload}`;
    const expected = createHmac('sha256', this.secret).update(signed).digest();
    const provided = Buffer.from(signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid session');
    }
    try {
      const tokenHeader = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string; exp?: number };
      if (tokenHeader.alg !== 'HS256' || typeof claims.sub !== 'string' ||
          typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
        throw new Error('Invalid claims');
      }
      const user = await this.users.findById(claims.sub).exec();
      if (!user) throw new Error('Account missing');
      return user;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }

  private validateCredentials(email: string, password: string): void {
    if (email.length > 254 || !emailPattern.test(email)) {
      throw new BadRequestException('Enter a valid email address');
    }
    if (password.length < 8 || password.length > 128) {
      throw new BadRequestException('Password must be between 8 and 128 characters');
    }
  }

  private sign(userId: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + tokenLifetimeSeconds,
    })).toString('base64url');
    const body = `${header}.${payload}`;
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }
}
