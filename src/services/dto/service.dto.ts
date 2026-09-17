import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ServiceStatus } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'maxGteMin', async: false })
export class MaxPriceGteMinPriceConstraint
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as CreateServiceDto;
    if (obj.minPrice == null || obj.maxPrice == null) {
      return true;
    }
    return Number(obj.maxPrice) >= Number(obj.minPrice);
  }

  defaultMessage(): string {
    return 'maxPrice must be greater than or equal to minPrice';
  }
}

export class CreateServiceDto {
  @ApiProperty({ example: 'HOROSCOPE_READING' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[A-Z0-9_]+$/)
  code!: string;

  @ApiProperty({ example: 'කේන්දර බැලීම' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameSi!: string;

  @ApiProperty({ example: 'Horoscope reading' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nameEn!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionSi?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ApiProperty({ example: 500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minPrice!: number;

  @ApiProperty({ example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Validate(MaxPriceGteMinPriceConstraint)
  maxPrice!: number;

  @ApiPropertyOptional({ enum: ServiceStatus })
  @IsOptional()
  @IsEnum(ServiceStatus)
  status?: ServiceStatus;
}

export class UpdateServiceDto extends PartialType(CreateServiceDto) {}
