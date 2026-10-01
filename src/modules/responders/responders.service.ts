import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ResponderRepository } from './responders.repository';
import { AuthService } from '../auth/auth.service';
import { Role } from '../../common/enums/role-enum';
import { AgencyTypeEnum } from './enums/agency-type.enum';
import { PoliceRank } from './enums/police-rank.enum';
import { CreateResponderDto } from './dto/create-responder.dto';
import { CreateNewResponderUserAccount } from './types/create-new-user.types';
import { CreateResponderProfileData } from './types/create-responder-profile.type';
import { UserIdType } from './types/user-id.types';

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class ResponderService {
  private readonly logger = new Logger(ResponderService.name);

  constructor(
    private readonly responderRepository: ResponderRepository,
    private readonly authService: AuthService,
  ) {}

  /**
   * Provisions an account in `pending_activation` (no password), then
   * issues an activation token and emails the link. Despite the
   * method name, this now creates either a responder OR an admin —
   * dto.role picks which, defaulting to Role.RESPONDER when omitted.
   * `super` can never reach this method: CreateResponderDto's @IsIn
   * rejects it at the validation layer before the request body is
   * even parsed into a class instance.
   *
   * agency/call_sign/rank (r_profile data) only apply on the
   * responder branch — an admin account gets no r_profile row at all,
   * see ResponderRepository.
   *
   * The two steps (DB write, then email) are deliberately NOT one
   * transaction. The account must be committed before a token can
   * reference it, and an email can't be rolled back anyway. If the
   * email step fails the account still exists and stays pending, so
   * the caller is told exactly that and can resend the link instead
   * of re-creating the account.
   *
   * @param dto Validated, normalized request body.
   * @param commandCenterId The calling admin's own command center, from
   *   their JWT. Never taken from the request body.
   * @returns The new account's id.
   * @throws {BadRequestException} If agency-specific rules aren't met
   *   for a responder, or agency is missing on a responder request.
   * @throws {ConflictException} If the email is already registered.
   * @throws {InternalServerErrorException} If creation fails, or the
   *   account was created but the activation email couldn't be sent.
   */
  async createResponder(
    dto: CreateResponderDto,
    commandCenterId: string,
  ): Promise<UserIdType> {
    const role = dto.role ?? Role.RESPONDER;

    const profileData = this.buildProfileDataIfResponder(role, dto);

    const userData: CreateNewResponderUserAccount = {
      f_name: dto.f_name,
      l_name: dto.l_name,
      m_name: dto.m_name ?? null,
      email: dto.email,
      role,
      command_center_id: commandCenterId,
    };

    let created: UserIdType;
    try {
      created = await this.responderRepository.createResponderProfile(
        userData,
        profileData,
      );
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          'An account with this email already exists.',
        );
      }
      this.logger.error(
        'Failed to create account',
        err instanceof Error ? err.stack : err,
      );
      throw new InternalServerErrorException('Failed to create account.');
    }

    try {
      await this.authService.createActivationToken(created.id, dto.email);
    } catch (err: unknown) {
      this.logger.error(
        `Account ${created.id} was created but the activation email failed`,
        err instanceof Error ? err.stack : err,
      );
      throw new InternalServerErrorException(
        'The account was created, but the activation email could not be sent. Resend the activation link instead of creating the account again.',
      );
    }

    return created;
  }

  /**
   * Only responders get r_profile data. Returns undefined for admin,
   * so the repository skips the r_profile insert entirely rather than
   * writing agency/call_sign/rank that wouldn't mean anything for that
   * role.
   *
   * dto.agency is re-checked here (not just trusted from DTO
   * validation) so a missing value produces this method's own
   * readable 400 rather than depending solely on the DTO layer having
   * run correctly — same defensive-in-depth reasoning as
   * assertAgencyRules below.
   */
  private buildProfileDataIfResponder(
    role: Role,
    dto: CreateResponderDto,
  ): CreateResponderProfileData | undefined {
    if (role !== Role.RESPONDER) {
      return undefined;
    }

    const agency = dto.agency;
    if (!agency) {
      throw new BadRequestException(
        'agency is required when creating a responder.',
      );
    }

    const rank = dto.rank ?? PoliceRank.NONE;
    this.assertAgencyRules(agency, dto.call_sign, rank);

    return {
      agency,
      call_sign: dto.call_sign ?? null,
      rank,
    };
  }

  /**
   * Cross-field rules that mirror chck_agency_requirements in the
   * schema, checked here so the caller gets a readable 400 instead of
   * a raw constraint violation:
   *   - police: call sign required, and rank must be a real rank
   *   - mdrrmo: call sign required
   *   - barangay_tanod: neither required
   */
  private assertAgencyRules(
    agency: AgencyTypeEnum,
    callSign: string | undefined,
    rank: PoliceRank,
  ): void {
    if (
      agency === AgencyTypeEnum.POLICE &&
      (!callSign || rank === PoliceRank.NONE)
    ) {
      throw new BadRequestException(
        'Police responders require a call sign and a rank.',
      );
    }
    if (agency === AgencyTypeEnum.MDRRMO && !callSign) {
      throw new BadRequestException('MDRRMO responders require a call sign.');
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === PG_UNIQUE_VIOLATION
    );
  }
}
