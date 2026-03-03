import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { LicenseModule } from './license/license.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, LicenseModule],
})
export class AppModule {}
