import React, { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BryntumGantt = lazy(async () => ({ default: (await import('@bryntum/gantt-react')).BryntumGantt }));

// The Bryntum React wrapper re-applies any prop whose reference changes, and rebuilding
// the locked subgrid throws "Id ... already in use". Every object prop must stay stable.
const columns = [{ type: 'name', field: 'name', text: 'WAVE / MILESTONE', width: 220 }, { type: 'startdate', text: 'START', width: 108 }, { type: 'enddate', text: 'FINISH', width: 108 }];
const subGrids = { narrow: { locked: { width: 170 } }, wide: { locked: { width: 436 } } };
const day = 86_400_000;

export type GanttDrop = { id: string; startDate?: Date }[];
type Props = { tasks: unknown[]; dependencies: unknown[]; shipDates: string[]; onDrop: (records: GanttDrop) => void };
type DropEvent = { taskRecords: { id: unknown; startDate?: unknown }[] };

class GanttBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="gantt-failed" role="alert"><p className="kicker">TIMELINE PAUSED</p><p>The shipping timeline stopped drawing. Waves, charges and supply updates below still work.</p><button className="button secondary" type="button" onClick={() => this.setState({ failed: false })}>Redraw timeline</button></div>;
  }
}

function Gantt({ tasks, dependencies, shipDates, onDrop }: Props) {
  const [subGridConfigs] = useState(() => window.innerWidth < 700 ? subGrids.narrow : subGrids.wide);
  const span = shipDates.join(',');
  const [startDate, endDate] = useMemo(() => {
    const times = span.split(',').map(d => Date.parse(`${d}T00:00:00Z`));
    return [new Date(Math.min(...times) - 38 * day), new Date(Math.max(...times) + 45 * day)];
  }, [span]);
  const drop = useRef(onDrop);
  useEffect(() => { drop.current = onDrop; }, [onDrop]);
  const onTaskDrop = useCallback((event: DropEvent) => { drop.current(event.taskRecords.map(record => ({ id: String(record.id), startDate: record.startDate ? new Date(String(record.startDate)) : undefined }))); }, []);
  return <BryntumGantt ariaLabel="Campaign shipping plan" tasks={tasks as never[]} dependencies={dependencies as never[]} startDate={startDate} endDate={endDate} viewPreset="weekAndDayLetter" projectLinesFeature={false} subGridConfigs={subGridConfigs} rowHeight={48} barMargin={9} columns={columns as never}onTaskDrop={onTaskDrop as never} />;
}

export function GanttPanel(props: Props) {
  return <GanttBoundary><Suspense fallback={<div className="page-state" role="status">Loading shipping timeline…</div>}><Gantt {...props} /></Suspense></GanttBoundary>;
}
