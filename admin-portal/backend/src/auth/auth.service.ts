import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  private readonly adminUsername = process.env.ADMIN_USERNAME || 'admin';
  private readonly adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  constructor(private jwtService: JwtService) {}

  async login(username: string, password: string) {
    if (username !== this.adminUsername || password !== this.adminPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: 'admin', username };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
