import { parseArgs } from '../args.js';
import { printJson } from '../util.js';
import { lintScene } from '../../core/lint.js';
import { getElements } from '../../core/canvas-client.js';
import { ensureCanvasRunning } from '../../core/spawn.js';

export async function lint(argv: string[]): Promise<void> {
  parseArgs(argv, {});
  await ensureCanvasRunning();
  const warnings = lintScene(await getElements());
  printJson({ success: true, warnings, count: warnings.length });
}
