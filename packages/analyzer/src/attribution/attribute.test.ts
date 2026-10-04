import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttributionSchema, EVIDENCE_MAX_LENGTH } from '@code-trust/shared';
import { attributionFixtures } from '@code-trust/shared/fixtures';
import { afterAll, describe, expect, test } from 'vitest';
import { removeTempDirs, ScriptedRepo, textLines } from '../history/testing.ts';
import type { GitIdentity } from '../history/types.ts';
import { seededRandom } from '../seeded-random.ts';
import { attributeCommit, type CommitAttribution } from './attribute.ts';
import { AI_IDENTITIES, LEFT_OUT } from './identities.ts';

afterAll(removeTempDirs);

// Made up, as in history/testing.ts: the repository is public.
const ADA: GitIdentity = { name: 'Ada Example', email: 'ada@example.com' };
const GRACE: GitIdentity = { name: 'Grace Example', email: 'grace@example.com' };

const COPILOT_AGENT: GitIdentity = {
  name: 'copilot-swe-agent[bot]',
  email: '198982749+Copilot@users.noreply.github.com',
};
const CURSOR_AGENT: GitIdentity = { name: 'Cursor Agent', email: 'cursoragent@cursor.com' };
const DEPENDABOT: GitIdentity = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };
const RENOVATE: GitIdentity = { name: 'renovate[bot]', email: '29139614+renovate[bot]@users.noreply.github.com' };
const GITHUB_WEB: GitIdentity = { name: 'GitHub', email: 'noreply@github.com' };

const CLAUDE_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const CLAUDE = { signal: 'co_author_trailer', tool: 'claude', confidence: 1, evidence: CLAUDE_TRAILER } as const;
const COPILOT_IDENTITY = {
  signal: 'author_identity',
  tool: 'copilot',
  confidence: 1,
  evidence: 'copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>',
} as const;

const HUMAN: CommitAttribution = { cohort: 'human', attributions: [] };

function commit(message: string, author: GitIdentity = ADA, committer: GitIdentity = author) {
  return { author, committer, message };
}

/** The identity a LEFT_OUT text or a trailer names, if it names one. */
function identityIn(text: string): GitIdentity | null {
  const match = /(?:^|: )([^<>:]+) <([^<>\s]+)>$/.exec(text);
  return match ? { name: match[1] as string, email: match[2] as string } : null;
}

describe('attribution', () => {
  test.each(['Co-Authored-By', 'Co-authored-by', 'co-authored-by', 'CO-AUTHORED-BY'])(
    'an AI trailer with the key written %s is ai',
    (key) => {
      expect(attributeCommit(commit(`fix: rounding\n\n${key}: Claude <noreply@anthropic.com>\n`))).toEqual({
        cohort: 'ai',
        attributions: [CLAUDE],
      });
    },
  );

  test.each([
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
  ])("this repository's own trailer %s maps to tool claude", (trailer) => {
    expect(attributeCommit(commit(`feat(analyzer): blame walker\n\nBody.\n\n${trailer}\n`))).toEqual({
      cohort: 'ai',
      attributions: [CLAUDE],
    });
  });

  test('an AI agent as author is ai, with the evidence the shared fixture stores', () => {
    const result = attributeCommit(commit('Fix the flaky test\n', COPILOT_AGENT, GITHUB_WEB));
    expect(result).toEqual({ cohort: 'ai', attributions: [COPILOT_IDENTITY] });
    expect(result.attributions[0]?.evidence).toBe(attributionFixtures[2]?.evidence);
  });

  test('an AI agent as committer only is ai', () => {
    expect(attributeCommit(commit('Add retries\n', ADA, CURSOR_AGENT))).toEqual({
      cohort: 'ai',
      attributions: [
        { signal: 'author_identity', tool: 'cursor', confidence: 1, evidence: 'Cursor Agent <cursoragent@cursor.com>' },
      ],
    });
  });

  test('a commit with both signals yields both attributions', () => {
    expect(attributeCommit(commit(`Add retries\n\n${CLAUDE_TRAILER}\n`, COPILOT_AGENT))).toEqual({
      cohort: 'ai',
      attributions: [CLAUDE, COPILOT_IDENTITY],
    });
    // Same tool on both signals: still one per (signal, tool), so two.
    const claudeBot: GitIdentity = { name: 'claude[bot]', email: 'claude[bot]@users.noreply.github.com' };
    expect(attributeCommit(commit(`Fix CI\n\n${CLAUDE_TRAILER}\n`, claudeBot)).attributions).toEqual([
      CLAUDE,
      {
        signal: 'author_identity',
        tool: 'claude',
        confidence: 1,
        evidence: 'claude[bot] <claude[bot]@users.noreply.github.com>',
      },
    ]);
  });

  test('two trailers for the same tool yield one attribution', () => {
    const message = `Merge two fixes\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Claude Opus 5.5 (1M context) <NoReply@Anthropic.com>\n`;
    expect(attributeCommit(commit(message))).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
  });

  test('an agent that is both author and committer yields one attribution', () => {
    expect(attributeCommit(commit('Fix\n', COPILOT_AGENT, COPILOT_AGENT)).attributions).toEqual([COPILOT_IDENTITY]);
  });

  test('a CRLF message still matches', () => {
    expect(attributeCommit(commit(`fix: rounding\r\n\r\n${CLAUDE_TRAILER}\r\n`)).cohort).toBe('ai');
  });
});

describe('no false match', () => {
  test.each([
    [
      'a human co-author named Claude Dupont',
      commit('Fix\n\nCo-Authored-By: Claude Dupont <claude.dupont@example.com>\n'),
    ],
    [
      'a human co-author named exactly Claude, with their own email',
      commit('Fix\n\nCo-Authored-By: Claude <claude@example.org>\n'),
    ],
    [
      'an email that only contains a listed one, in a trailer',
      commit('Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com.example.org>\n'),
    ],
    [
      'an email that only contains a listed one, as author',
      commit('Fix\n', { name: 'Claude', email: 'noreply@anthropic.com.example.org' }),
    ],
    [
      'the words "Co-Authored-By: Claude" inside a sentence',
      commit('Fix\n\nDrop the Co-Authored-By: Claude line we pasted by mistake.\n'),
    ],
    [
      'a whole AI trailer inside a sentence',
      commit(`Docs\n\nClaude Code adds ${CLAUDE_TRAILER} to every commit it makes.\n`),
    ],
    ['a quoted AI trailer', commit(`Docs\n\n> ${CLAUDE_TRAILER}\n`)],
    ["GitHub's web committer", commit('Update README.md\n', ADA, GITHUB_WEB)],
  ])('%s stays human', (_why, input) => {
    expect(attributeCommit(input)).toEqual(HUMAN);
  });

  test.each([
    ['no space after the colon', 'Co-Authored-By:Claude <noreply@anthropic.com>'],
    ['no name', 'Co-Authored-By: <noreply@anthropic.com>'],
    ['no angle brackets', 'Co-Authored-By: Claude noreply@anthropic.com'],
    ['text after the identity', `${CLAUDE_TRAILER} and Ada`],
    ['a second identity on the line', `${CLAUDE_TRAILER}, Ada Example <ada@example.com>`],
    ['a different key', 'Signed-off-by: Claude <noreply@anthropic.com>'],
  ])('a line that is not one complete trailer does not count: %s', (_why, line) => {
    expect(attributeCommit(commit(`Fix\n\n${line}\n`))).toEqual(HUMAN);
  });
});

describe('left out on purpose', () => {
  test.each(LEFT_OUT.map((item) => [item.text, item] as const))(
    '%s is not ai and has no attributions',
    (_text, item) => {
      const identity = identityIn(item.text);
      const commits = [
        commit(`Fix\n\n${item.text}\n`),
        ...(identity ? [commit('Fix\n', identity, ADA), commit('Fix\n', ADA, identity)] : []),
      ];
      for (const input of commits) {
        const result = attributeCommit(input);
        expect(result.attributions).toEqual([]);
        // Rule 1, not an assumption of `human`: a bot-named author is automation.
        expect(result.cohort).toBe(input.author.name.endsWith('[bot]') ? 'automation' : 'human');
      }
    },
  );
});

describe('cohorts', () => {
  test.each([
    ['dependabot[bot]', DEPENDABOT],
    ['renovate[bot]', RENOVATE],
  ])('%s is automation', (_name, bot) => {
    expect(attributeCommit(commit('Bump zod from 4.6.4 to 4.6.5\n', bot, GITHUB_WEB))).toEqual({
      cohort: 'automation',
      attributions: [],
    });
  });

  test('a listed AI agent whose name ends in [bot] is ai', () => {
    expect(attributeCommit(commit('Fix\n', COPILOT_AGENT)).cohort).toBe('ai');
  });

  test('a bot commit with an AI trailer is ai', () => {
    expect(attributeCommit(commit(`Bump zod\n\n${CLAUDE_TRAILER}\n`, DEPENDABOT))).toEqual({
      cohort: 'ai',
      attributions: [CLAUDE],
    });
  });

  test('only the author decides automation: a bot committer leaves a person human', () => {
    expect(attributeCommit(commit('Fix\n', ADA, DEPENDABOT))).toEqual(HUMAN);
  });
});

describe('squash merges', () => {
  test('an AI trailer in the middle of the body, as GitHub writes a squash merge, is ai', () => {
    const message = [
      'Add billing export (#42)',
      '',
      '* feat: export invoices as CSV',
      '',
      CLAUDE_TRAILER,
      '',
      '* fix: escape commas in names',
      '',
      '---------',
      '',
      `Co-authored-by: ${GRACE.name} <${GRACE.email}>`,
      '',
    ].join('\n');
    const result = attributeCommit(commit(message, ADA, GITHUB_WEB));
    expect(result).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
    expect(JSON.stringify(result)).not.toMatch(/Grace|grace@/);
  });

  test('an AI trailer in the middle of the body, as git merge --squash writes it, is ai', () => {
    const repo = ScriptedRepo.create();
    repo.write({ 'a.txt': textLines('a', 2) });
    repo.commit('base\n');
    repo.switch('feature', { create: true });
    repo.write({ 'b.txt': 'b\n' });
    repo.commit('feat: one\n');
    repo.write({ 'c.txt': 'c\n' });
    repo.commit(`feat: two\n\n${CLAUDE_TRAILER}\n`);
    repo.write({ 'd.txt': 'd\n' });
    repo.commit('feat: three\n');
    repo.switch('main');
    repo.squash('feature');
    const message = readFileSync(resolve(repo.dir, repo.git(['rev-parse', '--git-path', 'SQUASH_MSG']).trim()), 'utf8');

    // git lists the squashed commits newest first, each indented by four spaces under its author,
    // so the trailer of the middle commit sits between the other two messages.
    const lines = message.split('\n');
    const at = lines.indexOf(`    ${CLAUDE_TRAILER}`);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(0, at)).toContain('    feat: three');
    expect(lines.slice(at)).toContain('    feat: one');
    expect(message).toContain(`Author: ${ADA.name} <${ADA.email}>`);

    const result = attributeCommit(commit(message));
    expect(result).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
    expect(JSON.stringify(result)).not.toContain(ADA.email);
  });
});

describe('evidence', () => {
  test('an AI trailer next to a human co-author yields evidence that holds the AI entry only', () => {
    const message = `Fix\n\nCo-Authored-By: ${GRACE.name} <${GRACE.email}>\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n`;
    const result = attributeCommit(commit(message));
    expect(result).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
    expect(JSON.stringify(result)).not.toMatch(/Grace|grace@|Opus/);
  });

  test("an AI trailer under a person's name is ai, with the list entry as evidence", () => {
    const result = attributeCommit(commit(`Fix\n\nCo-Authored-By: ${GRACE.name} <noreply@anthropic.com>\n`));
    expect(result).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
    expect(JSON.stringify(result)).not.toContain('Grace');
  });

  test('an AI trailer too long for EVIDENCE_MAX_LENGTH is ai, with the list entry as evidence', () => {
    const trailer = `Co-Authored-By: ${'Claude '.repeat(EVIDENCE_MAX_LENGTH)}<noreply@anthropic.com>`;
    expect(trailer.length).toBeGreaterThan(EVIDENCE_MAX_LENGTH);
    const result = attributeCommit(commit(`Fix\n\n${trailer}\n`));
    expect(result).toEqual({ cohort: 'ai', attributions: [CLAUDE] });
    expect(AttributionSchema.safeParse({ repoId: 1, commitSha: 'a'.repeat(40), ...CLAUDE }).success).toBe(true);
  });

  test('a line built to make a regex backtrack is rejected in linear time', () => {
    const hostile = [
      `Co-Authored-By: ${'a '.repeat(200_000)}`,
      `Co-Authored-By: ${' '.repeat(200_000)}x`,
      `Co-Authored-By: x${' <'.repeat(100_000)}`,
    ];
    const started = performance.now();
    for (const line of hostile) expect(attributeCommit(commit(`Fix\n\n${line}\n`))).toEqual(HUMAN);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the AI list', () => {
  test('emails are unique without regard to case', () => {
    const emails = AI_IDENTITIES.map((entry) => entry.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
  });

  test('every entry gives evidence the schema accepts, as a trailer and as an identity', () => {
    for (const entry of AI_IDENTITIES) {
      const identity = `${entry.name} <${entry.email}>`;
      for (const [signal, evidence] of [
        ['co_author_trailer', `Co-Authored-By: ${identity}`],
        ['author_identity', identity],
      ] as const) {
        const parsed = AttributionSchema.safeParse({
          repoId: 1,
          commitSha: 'a'.repeat(40),
          signal,
          tool: entry.tool,
          confidence: 1,
          evidence,
        });
        expect(parsed.error?.issues, identity).toBeUndefined();
      }
    }
  });

  test('no LEFT_OUT identity is on the list', () => {
    const listed = new Set(AI_IDENTITIES.map((entry) => entry.email.toLowerCase()));
    const leftOut = LEFT_OUT.map((item) => identityIn(item.text)).filter((identity) => identity !== null);
    expect(leftOut.length).toBeGreaterThan(0);
    for (const identity of leftOut) expect(listed.has(identity.email.toLowerCase()), identity.email).toBe(false);
  });
});

describe('rule: attribution emits only identities from the AI list', () => {
  // People, including near misses: AI-sounding names and emails that contain a listed one.
  const PEOPLE: readonly GitIdentity[] = [
    ADA,
    GRACE,
    { name: 'Claude Dupont', email: 'claude.dupont@example.com' },
    { name: 'Claude Martin', email: 'claude@example.org' },
    { name: 'Opus Lee', email: 'noreply@anthropic.com.example.org' },
    { name: 'Cursor Wong', email: 'xnoreply@anthropic.com' },
    { name: 'Jules Verne Example', email: 'cursoragent@cursor.com.example.net' },
    { name: 'Hands Example', email: 'openhands@all-hands.dev.example.org' },
  ];
  const BOTS: readonly GitIdentity[] = [DEPENDABOT, RENOVATE, GITHUB_WEB];
  const KEYS = ['Co-Authored-By', 'Co-authored-by', 'co-authored-by', 'CO-AUTHORED-BY'];
  const LISTED = new Set(AI_IDENTITIES.map((entry) => `${entry.name} <${entry.email}>`));

  // Everything an output can spell: if no person's name or email is inside it, a person's name or
  // email in the output can only have come from the input.
  const VOCABULARY = JSON.stringify([
    ['cohort', 'attributions', 'signal', 'tool', 'confidence', 'evidence', 'ai', 'human', 'automation'],
    ['co_author_trailer', 'author_identity', 'Co-Authored-By: '],
    AI_IDENTITIES.map((entry) => [entry.name, entry.email, entry.tool]),
  ]).toLowerCase();

  test('no person in the pool can be spelled by an output', () => {
    for (const person of PEOPLE) {
      expect(VOCABULARY.includes(person.name.toLowerCase()), person.name).toBe(false);
      expect(VOCABULARY.includes(person.email.toLowerCase()), person.email).toBe(false);
    }
  });

  test('over 2,000 seeded random commits: valid evidence, only listed identities, no person, the planted signals', () => {
    const random = seededRandom(20_261_004);
    const recase = (email: string): string =>
      random.pick([email, email.toLowerCase(), email.toUpperCase(), email.replace(/^./, (c) => c.toUpperCase())]);
    const aiNames = (entry: (typeof AI_IDENTITIES)[number]): string[] => [
      entry.name,
      'Claude Opus 5.5 (1M context)',
      random.pick(PEOPLE).name,
      `${random.pick(PEOPLE).name} `.repeat(30).trim(),
    ];

    for (let i = 0; i < 2_000; i++) {
      const planted = new Set<string>();
      const party = (): GitIdentity => {
        const kind = random.int(0, 5);
        if (kind <= 2) return random.pick(PEOPLE);
        if (kind === 3) return random.pick(BOTS);
        const entry = random.pick(AI_IDENTITIES);
        planted.add(`author_identity ${entry.tool}`);
        return { name: random.pick(aiNames(entry)), email: recase(entry.email) };
      };
      const author = party();
      const committer = party();

      const lines = ['fix: something', ''];
      for (let n = random.int(0, 8); n > 0; n--) {
        const person = random.pick(PEOPLE);
        const entry = random.pick(AI_IDENTITIES);
        const key = random.pick(KEYS);
        const indent = random.pick(['', '', '    ', '\t']);
        const kind = random.int(0, 7);
        if (kind === 0) {
          lines.push(`${indent}${key}: ${random.pick(aiNames(entry))} <${recase(entry.email)}>`);
          planted.add(`co_author_trailer ${entry.tool}`);
        } else if (kind === 1) lines.push(`${indent}${key}: ${person.name} <${person.email}>`);
        else if (kind === 2) lines.push(`We credit ${key}: ${entry.name} <${entry.email}> here.`);
        else if (kind === 3) lines.push(`${key}:${entry.name} <${entry.email}>`);
        else if (kind === 4) lines.push(`${key}: ${entry.name} <${entry.email}>, ${person.name} <${person.email}>`);
        else if (kind === 5) lines.push(random.pick(LEFT_OUT).text);
        else if (kind === 6) lines.push(`    commit ${'0'.repeat(40)}`, `    Author: ${person.name} <${person.email}>`);
        else lines.push('', `Reviewed by ${person.name}.`);
      }
      const message = lines.join(random.pick(['\n', '\r\n']));
      const result = attributeCommit({ author, committer, message });
      const context = `commit ${i}: ${JSON.stringify({ author, committer, message })}`;

      const expectedCohort = planted.size > 0 ? 'ai' : author.name.endsWith('[bot]') ? 'automation' : 'human';
      expect(result.cohort, context).toBe(expectedCohort);
      expect(result.attributions.map((a) => `${a.signal} ${a.tool}`).sort(), context).toEqual([...planted].sort());

      for (const attribution of result.attributions) {
        const parsed = AttributionSchema.safeParse({ repoId: 1, commitSha: 'a'.repeat(40), ...attribution });
        expect(parsed.error?.issues, context).toBeUndefined();
        const identity = attribution.evidence.replace(/^Co-Authored-By: /, '');
        expect(LISTED.has(identity), context).toBe(true);
      }
      const output = JSON.stringify(result).toLowerCase();
      for (const person of PEOPLE) {
        expect(output.includes(person.name.toLowerCase()), context).toBe(false);
        expect(output.includes(person.email.toLowerCase()), context).toBe(false);
      }
    }
  });
});
