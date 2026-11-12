import React, { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BryntumGantt = lazy(async () => ({ default: (await import('@bryntum/gantt-react')).BryntumGantt }));

// The Bryntum React wrapper re-applies any prop whose reference changes, and rebuilding
// the locked subgrid throws "Id ... already in use". Every object prop must stay stable:
// config objects are created once per mount and call the latest page callbacks through refs.
const subGrids = { narrow: { locked: { width: 150 } }, wide: { locked: { width: 300 } } };
const day = 86_400_000;

export type GanttDrop = { id: string; startDate?: Date }[];
export type GanttTip = { id: unknown; name?: unknown; startDate?: unknown; endDate?: unknown };
export type GanttDragTip = { taskRecord: { id: unknown }; startDate: Date };
type Props = {
  tasks: unknown[]; dependencies: unknown[]; shipDates: string[]; onDrop: (records: GanttDrop) => void;
  timeRanges?: unknown[];
  // Wave rows render their name plus a charge-state chip; other rows render their plain name.
  nameCell?: (id: string, value: unknown, narrow: boolean) => unknown;
  tooltip?: (task: GanttTip) => string;
  dragTooltip?: (drag: GanttDragTip) => string;
  // Bumped by the page after a server replan to redraw a fresh Gantt.
  revision?: number;
};
type DropEvent = { taskRecords: { id: unknown; startDate?: unknown }[] };
const noRanges: unknown[] = [];

class GanttBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="gantt-failed" role="alert"><p className="kicker">TIMELINE PAUSED</p><p>The shipping timeline stopped drawing. Waves, charges and supply updates below still work.</p><button className="button secondary" type="button" onClick={() => this.setState({ failed: false })}>Redraw timeline</button></div>;
  }
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref;
}

function Gantt({ tasks, dependencies, shipDates, onDrop, timeRanges, nameCell, tooltip, dragTooltip }: Props) {
  const [narrow] = useState(() => window.innerWidth < 700);
  const subGridConfigs = narrow ? subGrids.narrow : subGrids.wide;
  const span = shipDates.join(',');
  const [startDate, endDate] = useMemo(() => {
    const times = span.split(',').map(d => Date.parse(`${d}T00:00:00Z`)).filter(Number.isFinite);
    const now = Date.now();
    if (!times.length) return [new Date(now - 7 * day), new Date(now + 60 * day)];
    // Desktop opens on the plan (38 days before the earliest ship date, or a week before today if earlier);
    // phones open on the week containing today so the today line and an open charge window are in view.
    const start = narrow ? now - day : Math.min(now - 7 * day, ...times.map(t => t - 38 * day));
    return [new Date(start), new Date(Math.max(now + 42 * day, ...times.map(t => t + 45 * day)))];
  }, [span, narrow]);
  const drop = useLatest(onDrop); const name = useLatest(nameCell); const tip = useLatest(tooltip); const dragTip = useLatest(dragTooltip);
  const onTaskDrop = useCallback((event: DropEvent) => { drop.current(event.taskRecords.map(record => ({ id: String(record.id), startDate: record.startDate ? new Date(String(record.startDate)) : undefined }))); }, [drop]);
  const [columns] = useState(() => [{ type: 'name', field: 'name', text: 'WAVE / MILESTONE', width: narrow ? 150 : 300,
    renderer: ({ record, value }: { record: { id: unknown }; value: unknown }) => name.current ? name.current(String(record.id), value, narrow) : String(value ?? '') }]);
  const [timeRangesFeature] = useState(() => ({ showCurrentTimeLine: { name: 'Today' } }));
  const [taskTooltipFeature] = useState(() => ({ template: ({ taskRecord }: { taskRecord: GanttTip }) => tip.current ? tip.current(taskRecord) : String(taskRecord.name ?? '') }));
  const [taskDragFeature] = useState(() => ({ tooltipTemplate: (drag: GanttDragTip) => dragTip.current ? dragTip.current(drag) : '' }));
  return <BryntumGantt ariaLabel="Campaign shipping plan" tasks={tasks as never[]} dependencies={dependencies as never[]} timeRanges={(timeRanges || noRanges) as never[]} startDate={startDate} endDate={endDate}
    viewPreset="weekAndDayLetter" projectLinesFeature={false} subGridConfigs={subGridConfigs} rowHeight={48} barMargin={9} columns={columns as never}
    timeRangesFeature={timeRangesFeature as never} taskTooltipFeature={taskTooltipFeature as never} taskDragFeature={taskDragFeature as never} onTaskDrop={onTaskDrop as never} />;
}

export function GanttPanel(props: Props) {
  return <GanttBoundary><Suspense fallback={<div className="page-state" role="status">Loading shipping timeline…</div>}><Gantt key={props.revision ?? 0} {...props} /></Suspense></GanttBoundary>;
}
