// The known AI identities: the product's precision. A wrong entry puts human code in the `ai`
// cohort and nothing downstream catches it; a missing one costs recall, which the eval gate
// measures. Rules for the list:
//
// - An entry means the tool wrote the commit, not that it touched it. A trailer a tool adds for
//   any assistance, such as one accepted completion, does not qualify.
// - Each entry's source comment points to the vendor's docs, forum or own repositories, or to this
//   repository's own commits. A stranger's commit is not a source.
// - Deliberate exclusions go in LEFT_OUT, and a test proves each one stays out of `ai`.
//   Candidates nobody has confirmed yet go in UNVERIFIED, untested, so confirming one later is a
//   one-line move plus its source.
//
// Entries are keyed by email: both signals match on it alone, without regard to case. The name
// only goes into evidence, since one email carries many names (Claude Code writes `Claude` and
// `Claude Opus 5.5 (1M context)`) and a name alone proves nothing.

export interface AiIdentity {
  /** As the tool writes it. Evidence keeps this spelling. */
  email: string;
  /** The name the tool writes. Used only to build evidence. */
  name: string;
  /** The attribution's tool slug. */
  tool: string;
}

export const AI_IDENTITIES: readonly AiIdentity[] = [
  // Claude Code's default trailer. This repository's own commits are made by Claude Code and carry
  // it, and Anthropic's agent-approval-check treats the address as agent-authored:
  // https://github.com/anthropics/claude-code-action/blob/cab360f6565aa35a51d6ce9e43f1f4287c0a32ea/agent-approval-check/action.yml
  { email: 'noreply@anthropic.com', name: 'Claude', tool: 'claude' },
  // The git identity Anthropic's CI auto-fix example gives the commits Claude makes:
  // https://github.com/anthropics/claude-code-action/blob/cab360f6565aa35a51d6ce9e43f1f4287c0a32ea/examples/ci-failure-auto-fix.yml
  { email: 'claude[bot]@users.noreply.github.com', name: 'claude[bot]', tool: 'claude' },
  // GitHub's Copilot coding agent, as author, in GitHub's own repository:
  // https://github.com/github/github-mcp-server/commit/7fd6a92cef38f0ab4796bae53716f510d3d4c8b3
  { email: '198982749+Copilot@users.noreply.github.com', name: 'copilot-swe-agent[bot]', tool: 'copilot' },
  // Cursor's cloud and background agents commit under this identity and add the user as a
  // co-author, per a Cursor moderator:
  // https://forum.cursor.com/t/commit-attribution-opt-out-ignored/164034
  { email: 'cursoragent@cursor.com', name: 'Cursor Agent', tool: 'cursor' },
  // Google's Jules agent, as author, in a Google Labs repository:
  // https://github.com/google-labs-code/stitch-sdk/commit/389480d8fa6c255c550ef7befc4b1cec02ba2e1c
  {
    email: '161369871+google-labs-jules[bot]@users.noreply.github.com',
    name: 'google-labs-jules[bot]',
    tool: 'jules',
  },
  // OpenHands' default git identity, and the trailer its system prompt adds to the agent's commits:
  // https://github.com/OpenHands/OpenHands/blob/35dc8aafaad2d883cf0c6629dea857eb2235895e/src/services/settings.ts
  // https://github.com/OpenHands/software-agent-sdk/blob/b66c724361571aa5c982883173c71b04739b247d/clients/typescript/src/prompts/system-prompt.ts
  { email: 'openhands@all-hands.dev', name: 'openhands', tool: 'openhands' },
];

export interface LeftOut {
  /** As it appears in a commit: a trailer line, a message line or a `Name <email>` identity. */
  text: string;
  why: string;
}

/** Looks like AI attribution, kept out on purpose. Each one has a test. */
export const LEFT_OUT: readonly LeftOut[] = [
  {
    text: 'Co-authored-by: Copilot <copilot@github.com>',
    why: "VS Code's git.addAICoAuthor writes it whenever any Copilot feature touched the change, including one accepted inline completion, so it does not mean Copilot wrote the commit",
  },
  {
    text: 'Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>',
    why: "GitHub's Copilot account as a co-author. No source shows that this trailer means Copilot wrote the commit rather than assisted with it",
  },
  {
    text: 'Made with Cursor',
    why: "a message marker Cursor's local IDE and CLI agent add, not a Co-Authored-By trailer. Markers wait for the eval gate",
  },
  {
    text: 'GitHub <noreply@github.com>',
    why: "GitHub's web committer: it commits squash merges, web edits and the Copilot agent's pushes alike, so it says nothing about who wrote the change",
  },
];

export interface Unverified {
  candidate: string;
  tool: string;
  /** What a source still has to show before the candidate joins AI_IDENTITIES. */
  missing: string;
}

/** Candidates without a source yet. Not tested: confirming one moves it to AI_IDENTITIES. */
export const UNVERIFIED: readonly Unverified[] = [
  {
    candidate: 'claude[bot] <ID+claude[bot]@users.noreply.github.com>',
    tool: 'claude',
    missing:
      "the numeric ID. claude-code-action builds this address from the app's bot user ID (its test uses 42), and no Anthropic source gives the real one",
  },
  {
    candidate: 'devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>',
    tool: 'devin',
    missing: "a Cognition source. The address has only been seen in other people's pull requests",
  },
  {
    candidate: "aider's Co-authored-by trailer",
    tool: 'aider',
    missing:
      'the email. The docs describe the opt-in --attribute-co-authored-by trailer without giving its address. By default aider only appends "(aider)" to the author and committer names, which email matching cannot use',
  },
];
