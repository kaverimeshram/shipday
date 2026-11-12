// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const seen: Record<string, unknown>[] = [];
let crash = false;
vi.mock('@bryntum/gantt-react', () => ({
  BryntumGantt: (props: Record<string, unknown>) => {
    if (crash) throw new Error('Id b-gantt-1-lockedSubgrid already in use');
    seen.push(props);
    return React.createElement('div', { className: 'b-gantt' });
  },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { GanttPanel } = await import('../web/src/gantt-panel');

const tasks: unknown[] = [];
const dependencies: unknown[] = [];
const shipDates = ['2026-12-03'];

async function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (draft: string) => act(async () => {
    root.render(React.createElement('section', null,
      React.createElement('textarea', { value: draft, readOnly: true }),
      // New callbacks on every render, as the merchant page passes them.
      React.createElement(GanttPanel, { tasks, dependencies, shipDates, onDrop: () => {}, nameCell: (_id: string, value: unknown) => String(value), tooltip: () => draft, dragTooltip: () => draft })));
  });
  return { host, render };
}

describe('Gantt panel', () => {
  it('passes Bryntum the same config objects when the merchant page re-renders', async () => {
    const { render } = await mount();
    await render('');
    await render('a');
    const [first, last] = [seen[0]!, seen.at(-1)!];
    expect(seen.length).toBeGreaterThan(1);
    // Stable config objects still call the latest page callbacks.
    expect((last.taskTooltipFeature as { template: (a: unknown) => string }).template({ taskRecord: { id: 'x' } })).toBe('a');
    for (const key of ['subGridConfigs', 'columns', 'startDate', 'endDate', 'onTaskDrop', 'timeRanges', 'timeRangesFeature', 'taskTooltipFeature', 'taskDragFeature']) expect(last[key], key).toBe(first[key]);
  });

  it('keeps the rest of the page when the Gantt throws', async () => {
    crash = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host, render } = await mount();
    await render('typed');
    crash = false;
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.textContent).toContain('The shipping timeline stopped drawing');
  });
});
