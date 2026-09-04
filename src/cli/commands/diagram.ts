import { parseArgs } from '../args.js';
import { printJson, readJsonInput } from '../util.js';
import { buildDiagram } from '../../core/diagram-layout.js';
import { prepareElement } from '../../core/normalize.js';
import { batchCreateElementsStrict } from '../../core/canvas-client.js';
import { ensureCanvasRunning } from '../../core/spawn.js';

// diagram [file|-]: semantic {nodes, edges, groups} -> laid-out elements.
export async function diagram(argv: string[]): Promise<void> {
  const { positionals } = parseArgs(argv, {});
  const input = await readJsonInput(positionals[0], 'diagram');
  const elements = buildDiagram(input);
  await ensureCanvasRunning();
  const created = await batchCreateElementsStrict(elements.map(el => prepareElement(el as any)));
  const xs = created.map(e => e.x);
  const ys = created.map(e => e.y);
  printJson({
    success: true,
    created: created.length,
    nodes: (input.nodes ?? []).length,
    edges: (input.edges ?? []).length,
    bbox: [Math.round(Math.min(...xs)), Math.round(Math.min(...ys))]
  });
}
