import {
  GithubIdSchema,
  type ListReposResponse,
  ListReposResponseSchema,
  type RepoSummaryResponse,
  RepoSummaryResponseSchema,
  type SurvivalCurveResponse,
  SurvivalCurveResponseSchema,
} from '@code-trust/shared';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { ReposService } from './repos.service.ts';

// Digits only, no leading zero, so each repo has one URL: Number() alone would also take
// '0x10', '1e3', ' 12' and '012'.
const RepoIdParamSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(GithubIdSchema);

class RepoIdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const parsed = RepoIdParamSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('repoId must be a GitHub numeric id: a positive integer');
    return parsed.data;
  }
}

const repoIdPipe = new RepoIdPipe();

// The API has no auth, so no body may carry more than the contract: every 200 is parsed with its
// response schema on the way out. That strips installationId, and a body that breaks the contract
// throws, which Nest turns into a plain 500.
@Controller()
export class ReposController {
  constructor(@Inject(ReposService) private readonly repos: ReposService) {}

  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('repos')
  async listRepos(): Promise<ListReposResponse> {
    return ListReposResponseSchema.parse({ repos: await this.repos.listRepos() });
  }

  @Get('repos/:repoId')
  async getRepo(@Param('repoId', repoIdPipe) repoId: number): Promise<RepoSummaryResponse> {
    const summary = await this.repos.getSummary(repoId);
    if (summary === null) throw new NotFoundException(`No repo with id ${repoId}`);
    return RepoSummaryResponseSchema.parse(summary);
  }

  @Get('repos/:repoId/survival-curve')
  async getSurvivalCurve(@Param('repoId', repoIdPipe) repoId: number): Promise<SurvivalCurveResponse> {
    const response = await this.repos.getSurvivalCurve(repoId);
    if (response === null) throw new NotFoundException(`No analyzed repo with id ${repoId}`);
    return SurvivalCurveResponseSchema.parse(response);
  }
}
