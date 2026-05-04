# Backend Development Rules (NestJS Starter)

> این فایل قوانین و استانداردهای کدنویسی پروژه بک‌اند را مشخص می‌کند. تمام LLM ها و توسعه‌دهندگان باید از این قوانین پیروی کنند.

---

## ۱. اطلاعات کلی پروژه

- **فریمورک**: NestJS 11
- **زبان**: TypeScript (strict mode)
- **دیتابیس**: PostgreSQL + TypeORM
- **احراز هویت**: JWT + Passport + OTP (پیامک)
- **Validation**: class-validator + class-transformer
- **مستندسازی API**: Swagger (`@nestjs/swagger`)
- **آپلود فایل**: AWS S3 SDK (`@aws-sdk/client-s3`)
- **پیامک**: Asanak / Ghasedak (قابل تنظیم)
- **پکیج منیجر**: npm
- **تنظیمات**: `@nestjs/config` با فایل `.env`

---

## ۲. ساختار فولدرها

```
src/
├── main.ts                         # Entry point — bootstrap اپلیکیشن
├── app.module.ts                   # Root module
├── app.controller.ts               # Root controller
├── app.service.ts                  # Root service
│
├── common/                         # کدهای مشترک و عمومی
│   ├── abstracts/                  # کلاس‌های abstract پایه
│   │   └── base.entity.ts          # BaseTimestampEntity (id, created_at, updated_at)
│   ├── decorators/                 # دکوریتورهای سفارشی
│   │   └── public.decorator.ts     # @Public() — مسیرهای بدون نیاز به احراز هویت
│   └── enums/                      # Enum های مشترک
│       └── user-role.enum.ts       # UserRole (USER, ADMIN, OPERATOR)
│
├── libs/                           # کتابخانه‌های داخلی (سرویس‌های زیرساختی)
│   ├── config/                     # تنظیمات اپلیکیشن
│   │   ├── config.module.ts        # ConfigModule (global)
│   │   └── configuration.ts        # تابع configuration — خواندن env vars
│   ├── database/                   # اتصال دیتابیس
│   │   └── database.module.ts      # TypeORM connection setup
│   ├── interceptors/               # Interceptor های عمومی
│   │   └── response.interceptor.ts # فرمت‌دهی یکسان response ها
│   ├── logger/                     # لاگر
│   │   └── logger.middleware.ts    # لاگ request ها
│   ├── otp/                        # سیستم OTP
│   │   ├── otp.controller.ts
│   │   ├── otp.dto.ts
│   │   ├── otp.entity.ts
│   │   ├── otp.module.ts
│   │   └── otp.service.ts
│   └── sms/                        # سرویس ارسال پیامک
│       ├── index.ts                # barrel export
│       ├── sms.module.ts
│       └── sms.service.ts
│
└── modules/                        # ماژول‌های اصلی (فیچرها)
    ├── auth/                       # احراز هویت
    │   ├── auth.controller.ts
    │   ├── auth.decorator.ts       # @Auth() / @CurrentUser()
    │   ├── auth.dto.ts
    │   ├── auth.guard.ts           # AuthGuard سفارشی
    │   ├── auth.interface.ts       # AuthInterface, JwtPayload
    │   ├── auth.module.ts
    │   ├── auth.service.ts
    │   ├── jwt-auth.guard.ts       # JwtAuthGuard (Passport)
    │   └── jwt.strategy.ts         # JWT Strategy
    ├── file/                       # مدیریت فایل (S3)
    │   ├── file.controller.ts
    │   ├── file.dto.ts
    │   ├── file.entity.ts
    │   ├── file.module.ts
    │   └── file.service.ts
    └── user/                       # مدیریت کاربران
        ├── user.controller.ts
        ├── user.dto.ts
        ├── user.entity.ts
        ├── user.module.ts
        └── user.service.ts
```

### قوانین ساختار:

- **`src/modules/`**: هر فیچر اصلی یک فولدر جداگانه دارد. ماژول‌های جدید اینجا ساخته می‌شوند.
- **`src/libs/`**: سرویس‌های زیرساختی و مشترک (config, database, sms, otp, logger, interceptors). اینها فیچر نیستند بلکه ابزارهایی هستند که ماژول‌ها از آنها استفاده می‌کنند.
- **`src/common/`**: کدهای مشترک بین تمام ماژول‌ها (abstracts, decorators, enums, interfaces, pipes, filters).
- هر ماژول جدید باید در `app.module.ts` ثبت شود.

---

## ۳. نام‌گذاری فایل‌ها

هر ماژول از الگوی زیر پیروی می‌کند:

| فایل | نام‌گذاری | مثال |
|------|-----------|------|
| Module | `[name].module.ts` | `user.module.ts` |
| Controller | `[name].controller.ts` | `user.controller.ts` |
| Service | `[name].service.ts` | `user.service.ts` |
| Entity | `[name].entity.ts` | `user.entity.ts` |
| DTO | `[name].dto.ts` | `user.dto.ts` |
| Guard | `[name].guard.ts` | `auth.guard.ts` |
| Strategy | `[name].strategy.ts` | `jwt.strategy.ts` |
| Interface | `[name].interface.ts` | `auth.interface.ts` |
| Decorator | `[name].decorator.ts` | `auth.decorator.ts` |
| Middleware | `[name].middleware.ts` | `logger.middleware.ts` |
| Interceptor | `[name].interceptor.ts` | `response.interceptor.ts` |

### قوانین نام‌گذاری:

- نام فایل‌ها: **kebab-case** (مثل `user-role.enum.ts`)
- نام کلاس‌ها: **PascalCase** (مثل `UserService`, `AuthGuard`)
- نام DTO ها: **PascalCase** با پسوند `Dto` (مثل `GenerateOtpDto`)
- نام Entity ها: **PascalCase** (مثل `User`, `FileEntity`)
- نام Enum ها: **PascalCase** (مثل `UserRole`)
- نام جداول دیتابیس: **snake_case جمع** (مثل `users`, `files`, `otp`)
- نام ستون‌های دیتابیس: **snake_case** (مثل `first_name`, `created_at`)

---

## ۴. الگوی ساخت ماژول جدید

هنگام ساخت یک ماژول جدید، این فایل‌ها را بسازید:

### ۴.۱. Entity

```typescript
// src/modules/product/product.entity.ts
import { Entity, Column } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';

@Entity('products')
export class Product extends BaseTimestampEntity {
  // id, created_at, updated_at از BaseTimestampEntity ارث‌بری می‌شوند

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'decimal', precision: 12, scale: 0 })
  price: number;

  @Column({ default: true })
  is_active: boolean;
}
```

> **مهم**: همیشه از `BaseTimestampEntity` ارث‌بری کنید تا `id`, `created_at`, `updated_at` به صورت خودکار اضافه شوند.

### ۴.۲. DTO

```typescript
// src/modules/product/product.dto.ts
import { IsNotEmpty, IsString, IsNumber, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProductDto {
  @ApiProperty({ example: 'محصول تست', description: 'نام محصول' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: 100000, description: 'قیمت محصول' })
  @IsNotEmpty()
  @IsNumber()
  price: number;
}

export class UpdateProductDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  price?: number;
}
```

> **مهم**: همیشه از `class-validator` برای validation و `@nestjs/swagger` (`@ApiProperty`) برای مستندسازی استفاده کنید.

### ۴.۳. Service

```typescript
// src/modules/product/product.service.ts
import { Injectable, HttpException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity';
import { CreateProductDto, UpdateProductDto } from './product.dto';

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  async findAll() {
    return await this.productRepository.find();
  }

  async findById(id: number) {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new HttpException('محصول یافت نشد', 404);
    }
    return product;
  }

  async create(data: CreateProductDto) {
    const product = this.productRepository.create(data);
    return await this.productRepository.save(product);
  }

  async update(id: number, data: UpdateProductDto) {
    const product = await this.findById(id);
    Object.assign(product, data);
    return await this.productRepository.save(product);
  }

  async remove(id: number) {
    const product = await this.findById(id);
    return await this.productRepository.remove(product);
  }
}
```

### ۴.۴. Controller

```typescript
// src/modules/product/product.controller.ts
import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProductService } from './product.service';
import { CreateProductDto, UpdateProductDto } from './product.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { User } from '../user/user.entity';

@ApiTags('Products')
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  @ApiOperation({ summary: 'Get all products' })
  findAll() {
    return this.productService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product by ID' })
  findById(@Param('id') id: number) {
    return this.productService.findById(id);
  }

  @Post()
  @ApiBearerAuth('access-token')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Create a new product' })
  create(@Body() data: CreateProductDto, @Auth() user: User) {
    return this.productService.create(data);
  }
}
```

### ۴.۵. Module

```typescript
// src/modules/product/product.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './product.entity';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Product]),
    AuthModule, // برای استفاده از AuthGuard
  ],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
```

### ۴.۶. ثبت در AppModule

```typescript
// src/app.module.ts — اضافه کردن import
import { ProductModule } from './modules/product/product.module';

@Module({
  imports: [AuthModule, DatabaseModule, ConfigModule, UserModule, FileModule, ProductModule],
  // ...
})
```

---

## ۵. فرمت Response

تمام response ها توسط `ResponseInterceptor` به صورت یکسان فرمت می‌شوند:

### Response موفق:
```json
{
  "meta": {
    "status": "success",
    "timestamp": "2025-01-15 14:30:00"
  },
  "data": { ... }
}
```

### Response خطا:
```json
{
  "meta": {
    "status": 400,
    "timestamp": "2025-01-15T14:30:00.000Z"
  },
  "error": {
    "message": "پیام خطا",
    "statusCode": 400
  }
}
```

> **مهم**: نیازی به فرمت‌دهی دستی response نیست. فقط داده را return کنید و interceptor فرمت‌دهی را انجام می‌دهد. برای خطا از `HttpException` استفاده کنید.

---

## ۶. احراز هویت (Authentication)

### سیستم:
- احراز هویت با **OTP پیامکی** + **JWT**
- فلوی ورود: `POST /auth/otp` (ارسال کد) → `POST /auth/otp/verify` (تأیید و دریافت توکن)
- توکن JWT در هدر `Authorization: Bearer <token>` ارسال می‌شود.

### محافظت از مسیرها:
```typescript
// مسیر محافظت‌شده — نیاز به توکن
@UseGuards(AuthGuard)
@ApiBearerAuth('access-token')
@Get('profile')
getProfile(@Auth() user: User) {
  return user;
}

// مسیر عمومی — بدون نیاز به توکن
@Public()
@Get('public-data')
getPublicData() {
  return { message: 'public' };
}
```

### دکوریتورهای موجود:
- `@Auth()` — استخراج کاربر احراز هویت‌شده از request
- `@Auth('id')` — استخراج فقط یک فیلد خاص از کاربر
- `@CurrentUser()` — alias برای `@Auth()`
- `@Public()` — علامت‌گذاری مسیر به عنوان عمومی (بدون نیاز به توکن)

### نقش‌های کاربری:
```typescript
enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  OPERATOR = 'operator',
}
```

### شماره‌های تست (OTP ثابت):
| شماره | کد OTP | نقش |
|-------|--------|------|
| `09121111111` | `1111` | USER |
| `09122222222` | `2222` | OPERATOR |
| `09123333333` | `3333` | ADMIN |

---

## ۷. دیتابیس و Entity

### قوانین Entity:
- از `BaseTimestampEntity` ارث‌بری کنید (مگر اینکه ساختار خاصی نیاز باشد مثل `Otp`).
- نام جدول **جمع و snake_case** باشد: `@Entity('products')`
- نام ستون‌ها **snake_case** باشد: `first_name`, `is_active`, `created_at`
- از `enum` برای فیلدهای محدود استفاده کنید.
- relation ها را با `@ManyToOne`, `@OneToMany`, `@ManyToMany` تعریف کنید.
- `@JoinColumn` را با `name` مشخص کنید: `@JoinColumn({ name: 'user_id' })`

### BaseTimestampEntity:
```typescript
// فیلدهای خودکار: id (auto-increment), created_at, updated_at
export abstract class BaseTimestampEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updated_at: Date;
}
```

### نکات TypeORM:
- `synchronize: true` فقط در development فعال است. در production **حتماً** از migration استفاده کنید.
- `autoLoadEntities: true` فعال است — نیازی به لیست کردن entity ها در database module نیست.
- برای query های پیچیده از `QueryBuilder` استفاده کنید.

---

## ۸. Validation و DTO

- **همیشه** از DTO برای ورودی‌های API استفاده کنید.
- از `class-validator` decorators استفاده کنید: `@IsNotEmpty()`, `@IsString()`, `@IsNumber()`, `@IsOptional()`, `@Matches()`, `@IsEmail()`, `@IsEnum()`, ...
- از `class-transformer` برای تبدیل داده استفاده کنید: `@Transform()`, `@Exclude()`, `@Expose()`
- `ValidationPipe` به صورت global فعال است با `transform: true`.
- شماره تلفن ایرانی با `@Transform` به فرمت `+98` نرمال‌سازی می‌شود.
- از `@ApiProperty()` برای مستندسازی Swagger استفاده کنید.

---

## ۹. تنظیمات و Environment Variables

تمام تنظیمات از فایل `.env` خوانده می‌شوند و در `src/libs/config/configuration.ts` ساختاردهی می‌شوند.

### دسترسی به تنظیمات:
```typescript
// در service ها
constructor(private configService: ConfigService) {}

// خواندن مقدار
const secret = this.configService.get<string>('jwt.secret');
const dbHost = this.configService.get('database.host');
```

### متغیرهای محیطی موجود:

| متغیر | توضیح | پیش‌فرض |
|--------|-------|---------|
| `APP_NAME` | نام اپلیکیشن | `Pishrun Project` |
| `NODE_ENV` | محیط اجرا | `development` |
| `HOST` | آدرس سرور | `localhost` |
| `PORT` | پورت سرور | `3000` |
| `DB_TYPE` | نوع دیتابیس | `postgres` |
| `DB_HOST` | آدرس دیتابیس | `localhost` |
| `DB_PORT` | پورت دیتابیس | `5432` |
| `DB_NAME` | نام دیتابیس | `postgres` |
| `DB_USERNAME` | نام کاربری دیتابیس | `postgres` |
| `DB_PASSWORD` | رمز دیتابیس | `secret` |
| `JWT_SECRET` | کلید رمزنگاری JWT | `secretKey` |
| `JWT_EXPIRES_IN` | مدت اعتبار توکن | `60m` |
| `OTP_EXPIRE_MINUTES` | مدت اعتبار OTP (دقیقه) | `2` |
| `SMS_PROVIDER` | سرویس‌دهنده پیامک | `asanak` |
| `SMS_BASE_URL` | آدرس API پیامک | — |
| `SMS_USERNAME` | نام کاربری پیامک | — |
| `SMS_PASSWORD` | رمز پیامک | — |
| `SMS_SOURCE` | شماره فرستنده | — |
| `SMS_API_KEY` | کلید API (قاصدک) | — |
| `SMS_LINE_NUMBER` | شماره خط (قاصدک) | — |
| `S3_REGION` | منطقه S3 | — |
| `S3_ACCESS_KEY` | کلید دسترسی S3 | — |
| `S3_SECRET_KEY` | کلید محرمانه S3 | — |
| `S3_BUCKET_NAME` | نام باکت S3 | — |
| `S3_PUBLIC_URL` | آدرس عمومی S3 | — |
| `S3_ENDPOINT` | Endpoint سفارشی S3 | — |

> برای اضافه کردن تنظیمات جدید: ۱) متغیر را در `.env.example` اضافه کنید ۲) در `configuration.ts` بخوانید ۳) در service با `configService.get()` استفاده کنید.

---

## ۱۰. سرویس فایل (File Module)

سرویس آپلود فایل با S3 پیاده‌سازی شده و متدهای زیر را دارد:

| متد | توضیح |
|-----|-------|
| `uploadFile(file, metadata)` | آپلود فایل از Multer به S3 |
| `uploadFileFromPath(filePath, metadata)` | آپلود فایل از مسیر فایل سیستم |
| `getFile(path)` | دریافت فایل از S3 |
| `findFileById(id)` | جستجوی فایل در دیتابیس |
| `downloadFileFromS3(s3Path)` | دانلود فایل به صورت Buffer |
| `downloadAndEncodeFile(s3Path, mimeType)` | دانلود و تبدیل به Base64 |
| `getPublicUrl(s3Path)` | دریافت URL عمومی فایل |
| `getPresignedUrl(s3Path, expiresIn)` | دریافت URL موقت با امضا |

> اگر S3 پیکربندی نشده باشد، سرویس بدون خطا کار می‌کند و فقط warning لاگ می‌کند.

---

## ۱۱. سرویس پیامک (SMS Module)

دو provider پشتیبانی می‌شود:

| Provider | توضیح |
|----------|-------|
| `asanak` | سرویس آسانک (پیش‌فرض) |
| `ghasedak` | سرویس قاصدک |

```typescript
// استفاده
await this.smsService.sendSms({
  receptor: '+989121234567',
  message: 'کد ورود شما: 1234',
  provider: SmsProvider.ASANAK, // اختیاری — از تنظیمات پیش‌فرض استفاده می‌شود
});
```

> اگر SMS پیکربندی نشده باشد، پیامک ارسال نمی‌شود و فقط warning لاگ می‌شود (مناسب برای development).

---

## ۱۲. قوانین کلی کدنویسی

1. **Dependency Injection**: همیشه از DI NestJS استفاده کنید. هرگز service ها را مستقیم `new` نکنید.
2. **Circular Dependencies**: از `forwardRef(() => ...)` برای وابستگی‌های دایره‌ای استفاده کنید.
3. **Error Handling**: از `HttpException` با پیام فارسی و status code مناسب استفاده کنید.
4. **Async/Await**: تمام متدهای service که با دیتابیس کار می‌کنند باید `async` باشند.
5. **Repository Pattern**: از `@InjectRepository()` و TypeORM Repository استفاده کنید.
6. **Swagger**: تمام endpoint ها باید `@ApiTags`, `@ApiOperation`, `@ApiResponse` داشته باشند.
7. **Guards**: مسیرهای محافظت‌شده باید `@UseGuards(AuthGuard)` و `@ApiBearerAuth('access-token')` داشته باشند.
8. **Exports**: هر service که در ماژول‌های دیگر استفاده می‌شود باید در `exports` ماژول قرار بگیرد.
9. **بدون console.log**: در کد نهایی از `console.log` استفاده نکنید (فقط `console.error` و `console.warn` مجاز).
10. **Single Responsibility**: هر service فقط یک مسئولیت دارد. منطق پیچیده را به service های جداگانه بشکنید.

---

## ۱۳. Prettier و ESLint

### Prettier:
```json
{
  "singleQuote": true,
  "trailingComma": "all"
}
```

### ESLint:
- TypeScript ESLint با type checking
- Prettier integration
- `@typescript-eslint/no-explicit-any`: خاموش
- `@typescript-eslint/no-floating-promises`: هشدار
- `@typescript-eslint/no-unsafe-argument`: هشدار

---

## ۱۴. دستورات توسعه

```bash
npm run start:dev      # سرور توسعه با watch mode
npm run build          # بیلد production
npm run start:prod     # اجرای production
npm run lint           # بررسی و رفع ESLint
npm run format         # فرمت با Prettier
npm run test           # اجرای تست‌ها
```

---

## ۱۵. لیست ماژول‌ها و سرویس‌های موجود

> **⚠️ قانون مهم**: قبل از پیاده‌سازی هر سرویس جدید، ابتدا این لیست را بررسی کنید. اگر سرویس مورد نیاز وجود دارد، از همان استفاده کنید. فقط در صورتی سرویس جدید بسازید که واقعاً در این لیست موجود نباشد.

### ماژول‌های اصلی (`src/modules/`)

| ماژول | مسیر | توضیح |
|--------|------|-------|
| **AuthModule** | `src/modules/auth/` | احراز هویت با OTP + JWT. شامل: ارسال OTP، تأیید OTP، صدور توکن، AuthGuard، JwtStrategy، دکوریتورهای `@Auth()` و `@Public()` |
| **UserModule** | `src/modules/user/` | مدیریت کاربران. شامل: CRUD کاربر، جستجو با شماره تلفن، ساخت خودکار کاربر (`findByPhoneNumberOrCreate`) |
| **FileModule** | `src/modules/file/` | مدیریت فایل با S3. شامل: آپلود، دانلود، presigned URL، public URL، ذخیره metadata در دیتابیس |

### کتابخانه‌های داخلی (`src/libs/`)

| کتابخانه | مسیر | توضیح |
|-----------|------|-------|
| **ConfigModule** | `src/libs/config/` | تنظیمات عمومی اپلیکیشن — خواندن `.env` و ساختاردهی با `configuration.ts`. به صورت global ثبت شده. |
| **DatabaseModule** | `src/libs/database/` | اتصال TypeORM به PostgreSQL. `autoLoadEntities` فعال است. |
| **OtpModule** | `src/libs/otp/` | سیستم OTP — تولید کد ۴ رقمی، اعتبارسنجی، انقضا، شماره‌های تست |
| **SmsModule** | `src/libs/sms/` | ارسال پیامک — پشتیبانی از Asanak و Ghasedak. اگر پیکربندی نشده باشد بدون خطا skip می‌کند. |
| **ResponseInterceptor** | `src/libs/interceptors/` | فرمت‌دهی یکسان تمام response ها به ساختار `{ meta, data }` یا `{ meta, error }` |
| **LoggerMiddleware** | `src/libs/logger/` | لاگ تمام request ها با timestamp، method و URL |

### کدهای مشترک (`src/common/`)

| فایل | مسیر | توضیح |
|------|------|-------|
| **BaseTimestampEntity** | `src/common/abstracts/base.entity.ts` | کلاس abstract پایه برای entity ها — شامل `id`, `created_at`, `updated_at` |
| **@Public()** | `src/common/decorators/public.decorator.ts` | دکوریتور برای علامت‌گذاری مسیرهای عمومی (بدون نیاز به توکن) |
| **UserRole** | `src/common/enums/user-role.enum.ts` | Enum نقش‌های کاربری: `USER`, `ADMIN`, `OPERATOR` |

---

## ۱۶. API Endpoints موجود

| Method | Path | Auth | توضیح |
|--------|------|------|-------|
| `GET` | `/` | ❌ | Health check — نام اپلیکیشن |
| `POST` | `/auth/otp` | ❌ | درخواست کد OTP |
| `POST` | `/auth/otp/verify` | ❌ | تأیید OTP و دریافت JWT |
| `GET` | `/users/:id` | ❌ | دریافت اطلاعات کاربر |
| `POST` | `/users` | ❌ | ساخت کاربر جدید |
| `POST` | `/files` | ✅ | آپلود فایل به S3 |
| `GET` | `/files/*path` | ❌ | دریافت فایل از S3 |

---

## ۱۷. نکات مهم برای LLM

1. **همیشه** قبل از ساخت سرویس جدید، لیست بخش ۱۵ را بررسی کنید.
2. **هرگز** سرویس‌های موجود را از صفر بازنویسی نکنید — از همان‌ها import کنید.
3. هر ماژول جدید باید شامل ۵ فایل باشد: `module`, `controller`, `service`, `entity`, `dto`.
4. Entity ها از `BaseTimestampEntity` ارث‌بری کنند.
5. DTO ها با `class-validator` و `@ApiProperty` مستند شوند.
6. مسیرهای محافظت‌شده: `@UseGuards(AuthGuard)` + `@ApiBearerAuth('access-token')`.
7. مسیرهای عمومی: `@Public()`.
8. برای دسترسی به کاربر فعلی: `@Auth() user: User`.
9. خطاها با `HttpException` و پیام فارسی throw شوند.
10. نیازی به فرمت‌دهی response نیست — interceptor این کار را انجام می‌دهد.
11. تنظیمات جدید: `.env.example` → `configuration.ts` → `configService.get()`.
12. ماژول جدید حتماً در `app.module.ts` ثبت شود.
13. اگر service در ماژول‌های دیگر لازم است، در `exports` ماژول قرار بگیرد.
14. از `forwardRef()` برای circular dependencies استفاده کنید.
