// The domain contract. Each schema encodes a rule from the Metric definitions section of
// docs/architecture.md; change the two together.
import { z } from 'zod';

/** The headline survival horizons, in days. */
export const SURVIVAL_HORIZON_DAYS = [30, 90, 180] as const;

/** A commit is in the `ai` cohort when one of its attributions reaches this confidence. */
export const AI_CONFIDENCE_THRESHOLD = 0.5;

export const EVIDENCE_MAX_LENGTH = 200;

// One fixed format, the one Date#toISOString() emits, so timestamps compare and sort as strings.
export const IsoTimestampSchema = z.iso.datetime({
  precision: 3,
  error: 'expected a UTC ISO timestamp with milliseconds, like 2026-10-02T09:30:00.000Z',
});
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

const SHA_MESSAGE = 'expected a full commit SHA: 40 lowercase hex characters';
// The message is on the string check too, so a missing field says what belongs there.
export const CommitShaSchema = z.string(SHA_MESSAGE).regex(/^[0-9a-f]{40}$/, SHA_MESSAGE);
export type CommitSha = z.infer<typeof CommitShaSchema>;

// GitHub's numeric ids. z.int() also rejects anything past Number.MAX_SAFE_INTEGER.
export const GithubIdSchema = z.int('expected a GitHub numeric id').positive('expected a GitHub numeric id');
export type GithubId = z.infer<typeof GithubIdSchema>;

// These end up in clone URLs and log lines, so the character set is closed.
const repoPathSegment = (what: string) => {
  const message = `expected a GitHub ${what}: 1 to 100 letters, digits, dots, dashes or underscores`;
  return z.string(message).regex(/^[A-Za-z0-9._-]{1,100}$/, message);
};

/** `automation` is a non-AI bot such as dependabot. Its lines are in neither survival curve. */
export const CohortSchema = z.enum(['ai', 'human', 'automation']);
export type Cohort = z.infer<typeof CohortSchema>;

/** The cohorts that get a survival curve. `human` is the baseline. */
export const MeasuredCohortSchema = z.enum(['ai', 'human']);
export type MeasuredCohort = z.infer<typeof MeasuredCohortSchema>;

/** The signals that count. Message markers and PR labels are not here until the eval gate scores them. */
export const AttributionSignalSchema = z.enum(['co_author_trailer', 'author_identity']);
export type AttributionSignal = z.infer<typeof AttributionSignalSchema>;

const repoFields = z.object({
  /** GitHub's repository id. Stable across renames and transfers. */
  id: GithubIdSchema,
  owner: repoPathSegment('owner'),
  name: repoPathSegment('repository name'),
  defaultBranch: z.string().min(1, 'expected a branch name').max(255),
  /** Null once the GitHub App is uninstalled; the repo's data can outlive the installation. */
  installationId: GithubIdSchema.nullable(),
  /** The mainline head the stored metrics describe. Null until the first analysis finishes. */
  headSha: CommitShaSchema.nullable(),
  /** Committer date of `headSha`: the repo's last activity, shown next to every curve. */
  headCommittedAt: IsoTimestampSchema.nullable(),
  /** When the worker fetched `headSha`. The censoring time for lines still alive. */
  observedAt: IsoTimestampSchema.nullable(),
});

type HeadFields = Pick<z.infer<typeof repoFields>, 'headSha' | 'headCommittedAt' | 'observedAt'>;

const headIsAllOrNothing = (repo: HeadFields) =>
  (repo.headSha === null) === (repo.headCommittedAt === null) && (repo.headSha === null) === (repo.observedAt === null);

const HEAD_RULE = {
  path: ['headSha'],
  error: 'headSha, headCommittedAt and observedAt are set together: all null before the first analysis, all set after',
};

export const RepoSchema = repoFields.refine(headIsAllOrNothing, HEAD_RULE);
export type Repo = z.infer<typeof RepoSchema>;

/** What the API exposes of a repo: everything but the installation. */
export const ApiRepoSchema = repoFields.omit({ installationId: true }).refine(headIsAllOrNothing, HEAD_RULE);
export type ApiRepo = z.infer<typeof ApiRepoSchema>;

/** How a queue message names a repo. Workers fetch the rest. */
export const RepoRefSchema = repoFields.pick({ id: true, owner: true, name: true });
export type RepoRef = z.infer<typeof RepoRefSchema>;

// No author name or email: the metric needs neither, and they are personal data.
export const CommitSchema = z.object({
  repoId: GithubIdSchema,
  sha: CommitShaSchema,
  authoredAt: IsoTimestampSchema,
  committedAt: IsoTimestampSchema,
  /** Committer date of the mainline commit that brought this commit in. The survival clock starts here. */
  landedAt: IsoTimestampSchema,
  cohort: CohortSchema,
});
export type Commit = z.infer<typeof CommitSchema>;

// Exactly one `Name <email>` on one line. A second identity or a whole trailer block cannot match,
// so evidence can never carry a human co-author along with the AI one.
const TRAILER_KEY = /^co-authored-by: /i;
const ONE_IDENTITY = /^[^<>\r\n]+ <[^<>\s]+>$/;

export const AttributionSchema = z
  .object({
    repoId: GithubIdSchema,
    commitSha: CommitShaSchema,
    signal: AttributionSignalSchema,
    /** Slug of the AI tool, such as `claude`. Free-form so a new tool needs no contract change. */
    tool: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'expected a tool slug: lowercase letters, digits and dashes'),
    confidence: z.number().min(0).max(1),
    /**
     * Built from the matched entry of the analyzer's AI list, not copied from the commit:
     * `Co-Authored-By: <name> <email>` for a trailer, `<name> <email>` for an identity. Never a
     * human name or email.
     */
    evidence: z
      .string()
      .max(EVIDENCE_MAX_LENGTH)
      .regex(
        ONE_IDENTITY,
        'expected exactly one identity on one line, like "Co-Authored-By: Claude <noreply@anthropic.com>"',
      ),
  })
  .refine((a) => TRAILER_KEY.test(a.evidence) === (a.signal === 'co_author_trailer'), {
    path: ['evidence'],
    error: 'co_author_trailer evidence is the Co-Authored-By trailer; author_identity evidence is the bare identity',
  });
export type Attribution = z.infer<typeof AttributionSchema>;

/** A run of consecutive lines in one file, as numbered in the introducing commit. Analyzer output; the database stores no spans. */
export const LineSpanSchema = z.object({
  path: z.string().min(1, 'expected a file path'),
  /** 1-based, as git numbers lines. */
  startLine: z.int().min(1),
  lineCount: z.int().min(1),
});
export type LineSpan = z.infer<typeof LineSpanSchema>;

/**
 * A group of lines that share a birth and a fate: introduced by one commit and either removed by
 * one mainline commit or still alive. Alive groups carry no end time: they are censored at the
 * repo's `observedAt`, so a new analysis never has to rewrite them.
 */
export const SurvivalObservationSchema = z
  .object({
    repoId: GithubIdSchema,
    introducedBy: CommitShaSchema,
    /** The mainline commit whose first-parent diff removed the lines. Null while they are alive. */
    removedBy: CommitShaSchema.nullable(),
    lineCount: z.int().min(1),
    /** When the lines landed on the mainline. */
    introducedAt: IsoTimestampSchema,
    removedAt: IsoTimestampSchema.nullable(),
  })
  .refine((o) => (o.removedBy === null) === (o.removedAt === null), {
    path: ['removedAt'],
    error: 'removedBy and removedAt are set together: both null while the lines are alive',
  });
export type SurvivalObservation = z.infer<typeof SurvivalObservationSchema>;

const ShareSchema = z.number().min(0).max(1);

export const SurvivalCurvePointSchema = z
  .object({
    day: z.int().min(0),
    /** S(day): the estimated share of lines that last at least `day` full days. */
    survival: ShareSchema,
    /** Lines at risk on `day`. 0 only on the point where survival reaches 0. */
    atRisk: z.int().min(0),
  })
  // Survival is 0 exactly when every line at risk was removed, which leaves nothing at risk. With
  // nothing at risk and survival above 0 the estimate is unknown, and an unknown has no point.
  .refine((point) => (point.survival === 0) === (point.atRisk === 0), {
    path: ['atRisk'],
    error:
      'atRisk is 0 exactly when survival is 0: where nothing is at risk and survival is above 0, there is no point',
  });
export type SurvivalCurvePoint = z.infer<typeof SurvivalCurvePointSchema>;

/**
 * A step function. Points ascend by day and start at day 0; a value holds until the next point.
 * A curve that reaches 0 ends on that point and stays 0 after it. Any other curve ends on the last
 * day with lines at risk, and survival past it is unknown.
 */
export const SurvivalCurvePointsSchema = z
  .array(SurvivalCurvePointSchema)
  .min(1, 'expected at least the day 0 point')
  .refine((points) => points[0]?.day === 0, { error: 'expected the first point at day 0' })
  .refine((points) => points.every((point, i) => i === 0 || point.day > (points[i - 1]?.day ?? -1)), {
    error: 'expected points in ascending day order with no repeated day',
  })
  .refine((points) => points.every((point, i) => point.survival > 0 || i === points.length - 1), {
    error: 'expected the point where survival reaches 0 to be the last one',
  });
export type SurvivalCurvePoints = z.infer<typeof SurvivalCurvePointsSchema>;

export const SurvivalCurveSchema = z.object({
  cohort: MeasuredCohortSchema,
  points: SurvivalCurvePointsSchema,
});
export type SurvivalCurve = z.infer<typeof SurvivalCurveSchema>;

/** One cohort's headline numbers for one repo at one analyzed head. */
export const SurvivalMetricSchema = z
  .object({
    repoId: GithubIdSchema,
    cohort: MeasuredCohortSchema,
    headSha: CommitShaSchema,
    observedAt: IsoTimestampSchema,
    linesTotal: z.int().min(0),
    linesRemoved: z.int().min(0),
    /** Lines still alive at `headSha`. */
    linesCensored: z.int().min(0),
    /**
     * Null means unknown: no line has been observed that long, and the lines observed longest are
     * still alive. 0 means every line was removed before that day. Never extrapolated.
     */
    survival30d: ShareSchema.nullable(),
    survival90d: ShareSchema.nullable(),
    survival180d: ShareSchema.nullable(),
  })
  .refine((m) => m.linesTotal === m.linesRemoved + m.linesCensored, {
    path: ['linesTotal'],
    error: 'linesTotal must equal linesRemoved + linesCensored',
  });
export type SurvivalMetric = z.infer<typeof SurvivalMetricSchema>;
