import { IsEnum, IsNotEmpty, IsString, Length } from 'class-validator';
import { CCEnum } from '../enums/cc.enum';
import { type GeoPoint } from '../../../common/interfaces/geo-location.interface';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCommandCenterDTO {
  @IsString()
  @Length(4, 256)
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    enum: CCEnum,
    description: 'Type of the command center',
    example: CCEnum.BARANGAY,
  })
  @IsNotEmpty()
  @IsEnum(CCEnum)
  type!: CCEnum;

  @IsString()
  @IsNotEmpty()
  @Length(4, 256)
  branch!: string;

  @IsNotEmpty()
  location!: GeoPoint;
}
