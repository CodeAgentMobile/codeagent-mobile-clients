import { describe, it, expect } from 'vitest';
import {
  textReferencesInternal,
  pathIsInternal,
  toolCallReferencesInternal,
  internalPathPermissionOutcome,
} from '../../../src/agents/acp/internal-paths';

const HOME = '/home/box';

describe('internal-paths — CodeAgent internals guard predicates', () => {
  describe('textReferencesInternal (bash command / tool input)', () => {
    it('flags references to ~/.codeam and house-claude', () => {
      expect(textReferencesInternal('cat ~/.codeam/host-agent.json')).toBe(true);
      expect(textReferencesInternal('cat ~/.codeam/house-claude/x/.claude.json')).toBe(true);
      // Relative mentions resolve against the session cwd: the host log is internal when the
      // session runs AT home, and a same-named file in a project is the project's.
      expect(textReferencesInternal('cat .codeam-host.log', HOME, HOME)).toBe(true);
      expect(textReferencesInternal('cat .codeam-host.log', HOME, '/workspaces/app')).toBe(false);
      expect(textReferencesInternal('cat $HOME/.codeam/host-agent.json', HOME, '/workspaces/app')).toBe(true);
      expect(textReferencesInternal('cat ${HOME}/.codeam/config.json', HOME, '/workspaces/app')).toBe(true);
    });
    // 2026-11-23 (Antigravity on a Box): writing the PROJECT's documented Preview override was
    // auto-blocked as "CodeAgent's own runtime files (~/.codeam)" — a bare ".codeam" substring match.
    it("does NOT flag the project's own .codeam/ (preview override, provision)", () => {
      const cwd = '/home/box/workspace/pasito';
      expect(textReferencesInternal('File .codeam/preview.json', HOME, cwd)).toBe(false);
      expect(textReferencesInternal('mkdir -p .codeam && cat > .codeam/preview.json', HOME, cwd)).toBe(false);
      expect(textReferencesInternal(`${cwd}/.codeam/preview.json`, HOME, cwd)).toBe(false);
      expect(textReferencesInternal('ls .codeam/provision/', HOME, cwd)).toBe(false);
      // …while the HOME dir stays off-limits from the same cwd.
      expect(textReferencesInternal('cat ~/.codeam/config.json', HOME, cwd)).toBe(true);
      expect(textReferencesInternal('cat ../../.codeam/host-agent.json', HOME, cwd)).toBe(true);
    });
    it('a repo cloned AT home: only the documented project files under .codeam/ pass', () => {
      expect(textReferencesInternal('File .codeam/preview.json', HOME, HOME)).toBe(false);
      expect(textReferencesInternal('cat .codeam/provision/compose.generated.yaml', HOME, HOME)).toBe(false);
      expect(textReferencesInternal('cat .codeam/config.json', HOME, HOME)).toBe(true);
      expect(textReferencesInternal('cat .codeam/preview-ports.json', HOME, HOME)).toBe(true);
      expect(textReferencesInternal('ls .codeam', HOME, HOME)).toBe(true);
    });
    it('does NOT flag the self-hosted workspace subtree (the user\'s cloned project)', () => {
      // Rafael 2026-08-05: warm-codespace/self-hosted repos live at
      // ~/.codeam/self-hosted/<deployId>/ — that path contains ".codeam" but is
      // the USER's project, not an internal. Every tool call inside it (git,
      // edits, reads) was denied in manual permission mode before this fix.
      expect(textReferencesInternal('git commit -m "x" (cwd /home/box/.codeam/self-hosted/dep-1)')).toBe(false);
      expect(textReferencesInternal('/home/box/.codeam/self-hosted/dep-1/src/app.ts')).toBe(false);
      expect(textReferencesInternal('ls /home/box/.codeam/self-hosted')).toBe(false);
      // …but a REAL internal referenced alongside the workspace still trips it.
      expect(
        textReferencesInternal('cd /home/box/.codeam/self-hosted/dep-1 && cat ~/.codeam/host-agent.json'),
      ).toBe(true);
    });
    it('does NOT flag the bootstrap node dir or normal commands', () => {
      expect(textReferencesInternal('/tmp/codeam-node20/bin/node')).toBe(false); // no leading dot
      expect(textReferencesInternal('bd ready')).toBe(false);
      expect(textReferencesInternal('bd remember "did the thing"')).toBe(false);
      expect(textReferencesInternal('npm test')).toBe(false);
      expect(textReferencesInternal(undefined)).toBe(false);
    });
  });

  describe('pathIsInternal (fs read/write seam, absolute paths)', () => {
    it('flags home-anchored internal paths', () => {
      expect(pathIsInternal(`${HOME}/.codeam/host-agent.json`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.beads/shared-server/dolt`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam-host.log`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam/house-claude/dep/x`, HOME)).toBe(true);
    });
    it('does NOT flag the project or its own ./.beads', () => {
      // The self-hosted workspace (a cloned repo at ~/.codeam/self-hosted/<id>/)
      // is the USER's project, NOT an internal — must be allowed even though its
      // path contains ".codeam" (Rafael 2026-08-05: manual-mode tool calls denied).
      expect(pathIsInternal(`${HOME}/.codeam/self-hosted/dep/repo/src/index.ts`, HOME)).toBe(false);
      expect(pathIsInternal(`${HOME}/.codeam/self-hosted`, HOME)).toBe(false);
      expect(pathIsInternal('/workspaces/project/.beads/config.yaml', HOME)).toBe(false); // project beads, not home
      expect(pathIsInternal('/workspaces/project/src/index.ts', HOME)).toBe(false);
      expect(pathIsInternal(null, HOME)).toBe(false);
    });
    it('STILL flags real internals even when the home has a self-hosted subtree', () => {
      expect(pathIsInternal(`${HOME}/.codeam/host-agent.json`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam/house-claude/dep/x`, HOME)).toBe(true);
    });
    it("does NOT flag the project's .codeam/preview.json, relative or absolute", () => {
      const cwd = '/workspaces/pasito';
      expect(pathIsInternal('.codeam/preview.json', HOME, cwd)).toBe(false);
      expect(pathIsInternal(`${cwd}/.codeam/preview.json`, HOME, cwd)).toBe(false);
      expect(pathIsInternal(`${HOME}/.codeam/config.json`, HOME, cwd)).toBe(true);
    });
    it('a repo cloned AT home: preview.json + provision/ pass, every other ~/.codeam file stays internal', () => {
      expect(pathIsInternal('.codeam/preview.json', HOME, HOME)).toBe(false);
      expect(pathIsInternal(`${HOME}/.codeam/preview.json`, HOME, HOME)).toBe(false);
      expect(pathIsInternal(`${HOME}/.codeam/provision/compose.generated.yaml`, HOME, HOME)).toBe(false);
      expect(pathIsInternal(`${HOME}/.codeam/preview-ports.json`, HOME, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam/host-agent.json`, HOME, HOME)).toBe(true);
      // The exemption is the SESSION's project, not any repo's: from another cwd, home stays internal.
      expect(pathIsInternal(`${HOME}/.codeam/preview.json`, HOME, '/workspaces/app')).toBe(true);
    });
    it('is not fooled by a sibling prefix (.codeam-extra)', () => {
      expect(pathIsInternal(`${HOME}/.codeam-extra/x`, HOME)).toBe(false);
    });
  });

  describe('toolCallReferencesInternal (ACP permission request)', () => {
    it('flags a bash tool call touching an internal path', () => {
      expect(
        toolCallReferencesInternal({ title: 'Bash', rawInput: { command: 'cat ~/.codeam/config.json' } }),
      ).toBe(true);
    });
    it('flags via the title too', () => {
      expect(toolCallReferencesInternal({ title: 'Read ~/.codeam/host-agent.json' })).toBe(true);
    });
    it("does not flag a write of the project's .codeam/preview.json (the 2026-11-23 Antigravity block)", () => {
      const cwd = '/home/box/workspace/pasito';
      expect(
        toolCallReferencesInternal(
          {
            title: 'File .codeam/preview.json',
            kind: 'edit',
            rawInput: { path: '.codeam/preview.json', content: '{"framework":"Expo"}' },
            locations: [{ path: `${cwd}/.codeam/preview.json` }],
          },
          HOME,
          cwd,
        ),
      ).toBe(false);
    });
    it('does not flag a normal tool call', () => {
      expect(
        toolCallReferencesInternal({ title: 'Bash', rawInput: { command: 'npm run build' } }),
      ).toBe(false);
    });
    it('flags via the structured locations[].path field (any kind)', () => {
      expect(
        toolCallReferencesInternal(
          { title: 'Read file', kind: 'read', locations: [{ path: `${HOME}/.codeam/host-agent.json` }] },
          HOME,
        ),
      ).toBe(true);
      expect(
        toolCallReferencesInternal(
          { title: 'Read file', kind: 'read', locations: [{ path: '/workspaces/project/src/app.ts' }] },
          HOME,
        ),
      ).toBe(false);
    });

    // 2026-08-19 P0 (user yunduanmianliu): the agent's ExitPlanMode PLAN TEXT
    // merely PRINTED its own cwd (`/home/box/.codeam/house-claude/…`); the
    // free-text scan matched it and the plan-approval prompt was silently
    // auto-rejected — the user was never asked, the agent said the USER
    // rejected it, plan mode wedged, and a source file was destroyed. Prose
    // kinds (switch_mode / think) must never be free-text scanned.
    describe('prose-only kinds (switch_mode / think) — never free-text scanned', () => {
      const planWithInternalMention = {
        title: 'Ready to code?', // claude-agent-acp's ExitPlanMode title
        kind: 'switch_mode',
        rawInput: {
          plan: 'Fix the bug in WorldBookEntry.swift. Note: the session runs from /home/box/.codeam/house-claude/workspace.',
        },
      };
      it('an ExitPlanMode plan MENTIONING an internal path is NOT flagged', () => {
        expect(toolCallReferencesInternal(planWithInternalMention, HOME)).toBe(false);
      });
      it('a think block mentioning ~/.codeam is NOT flagged', () => {
        expect(
          toolCallReferencesInternal(
            { title: 'Thinking', kind: 'think', rawInput: { thought: 'config lives in ~/.codeam' } },
            HOME,
          ),
        ).toBe(false);
      });
      it('a prose-kind call DECLARING an internal file location is still flagged', () => {
        expect(
          toolCallReferencesInternal(
            { ...planWithInternalMention, locations: [{ path: `${HOME}/.codeam/host-agent.json` }] },
            HOME,
          ),
        ).toBe(true);
      });
      it('real file-access kinds still get the free-text scan', () => {
        expect(
          toolCallReferencesInternal(
            { title: 'Read', kind: 'read', rawInput: { file_path: `${HOME}/.codeam/host-agent.json` } },
            HOME,
          ),
        ).toBe(true);
        expect(
          toolCallReferencesInternal(
            { title: 'Bash', kind: 'execute', rawInput: { command: 'cat ~/.codeam/host-agent.json' } },
            HOME,
          ),
        ).toBe(true);
      });
    });
  });

  // The REAL decision the runner's onRequestPermission uses (verbatim).
  describe('internalPathPermissionOutcome (the enforced deny decision)', () => {
    const internalCall = { title: 'Bash', rawInput: { command: 'cat ~/.codeam/host-agent.json' } };
    const cleanCall = { title: 'Bash', rawInput: { command: 'npm run build' } };

    it('returns null for a clean tool call (caller proceeds to auto-approve)', () => {
      expect(
        internalPathPermissionOutcome({ toolCall: cleanCall, options: [{ optionId: 'a', kind: 'allow_always' }] }),
      ).toBeNull();
    });
    it('DENIES an internal-path call preferring reject_ONCE (a reject_always would poison the tool for the whole session — the 2026-08-19 plan-mode wedge)', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [
          { optionId: 'a', kind: 'allow_always' },
          { optionId: 'r1', kind: 'reject_once' },
          { optionId: 'r2', kind: 'reject_always' },
        ],
      });
      expect(out).toEqual({ outcome: { outcome: 'selected', optionId: 'r1' } });
    });
    it('falls back to reject_always when reject_once is absent', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [
          { optionId: 'a', kind: 'allow_once' },
          { optionId: 'r2', kind: 'reject_always' },
        ],
      });
      expect(out).toEqual({ outcome: { outcome: 'selected', optionId: 'r2' } });
    });
    it('returns null for an ExitPlanMode approval whose plan text mentions an internal path (must surface to the user)', () => {
      expect(
        internalPathPermissionOutcome({
          toolCall: {
            title: 'Ready to code?',
            kind: 'switch_mode',
            rawInput: { plan: 'The box cwd is /home/box/.codeam/house-claude/ws — now edit src/app.ts' },
          },
          options: [
            { optionId: 'auto', kind: 'allow_always' },
            { optionId: 'default', kind: 'allow_once' },
            { optionId: 'plan', kind: 'reject_once' },
          ],
        }),
      ).toBeNull();
    });
    it('CANCELS the tool when the agent offers no reject option', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [{ optionId: 'a', kind: 'allow_always' }],
      });
      expect(out).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });
});
