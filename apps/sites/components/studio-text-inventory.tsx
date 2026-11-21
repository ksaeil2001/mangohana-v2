"use client";

import { useEffect, useRef, useState } from 'react';
import { readTextInventory, reviewCandidateLabels, type TextInventory } from '@/lib/studio-engine';

type Props = { jobId: string; image: string };
type Box = [number, number, number, number];

function SourceExcerpt({ image, box, width, height }: { image: string; box: Box; width: number; height: number }) {
  const [left, top, right, bottom] = box;
  const margin = Math.min(40, Math.max(8, Math.ceil(Math.max(right - left, bottom - top) * .12)));
  const x = Math.max(0, left - margin), y = Math.max(0, top - margin);
  const cropWidth = Math.min(width, right + margin) - x, cropHeight = Math.min(height, bottom + margin) - y;
  return <div className="source-excerpt">
    <svg role="img" aria-label="선택한 원문 확대" viewBox={[x, y, cropWidth, cropHeight].join(' ')}
      width={cropWidth * 2} height={cropHeight * 2} className="source-excerpt-crop">
      <image href={image} width={width} height={height} preserveAspectRatio="none" />
    </svg>
    <details className="source-excerpt-overview">
      <summary>원고 전체에서 위치 보기</summary>
      <div className="source-excerpt-map">
        <img src={image} alt="선택한 글줄이 있는 원고" />
        <span aria-hidden="true" style={{ left: `${100 * left / width}%`, top: `${100 * top / height}%`,
          width: `${100 * (right - left) / width}%`, height: `${100 * (bottom - top) / height}%` }} />
      </div>
    </details>
  </div>;
}

export default function StudioTextInventory({ jobId, image }: Props) {
  const [inventory, setInventory] = useState<TextInventory | null | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function open() {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setError('');
    try {
      const value = await readTextInventory(jobId, current.signal);
      if (!current.signal.aborted) setInventory(value);
    } catch (error) {
      if (!current.signal.aborted) {
        setInventory(undefined);
        setSelectedId(null);
        setError(error instanceof Error ? error.message : '글줄을 읽지 못했어요.');
      }
    } finally {
      controller.current = null;
    }
  }

  const read = inventory?.lines.filter(line => line.status === 'read').length ?? 0;
  const notes = new Map(inventory?.notes?.lines.map(line => [line.lineId, line.translation]));
  const held = new Map(inventory?.reviewCandidates?.lines.map(line => [line.lineId, line]));
  const rows = [
    ...(inventory?.lines.map(line => ({ key: 'line-' + line.lineId, box: line.pixelBox,
      label: line.status === 'read' ? line.source : '보류 · 판독한 글이 비어 있어요',
      note: notes.get(line.lineId), candidate: held.get(line.lineId) })) ?? []),
    ...(inventory?.uncoveredBubbles.map(bubble => ({ key: 'bubble-' + bubble.observationId, box: bubble.pixelBox,
      label: bubble.pixelBox ? '보류 · 말풍선에 연결된 글이 없어요' : '보류 · 말풍선 좌표를 확인하지 못했어요',
      note: undefined, candidate: undefined })) ?? []),
    ...(inventory?.independentSearch?.unsearchedPixelBoxes.map((box, index) => ({ key: 'unsearched-' + index, box,
      label: '미탐색 위치 ' + (index + 1), note: undefined, candidate: undefined })) ?? []),
  ];
  const selected = rows.find(row => row.key === selectedId);
  return <details className="inspector-section text-inventory" onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open) void open();
  }}>
    <summary>원문 글줄과 보류 위치</summary>
    {inventory === undefined && !error && <p role="status">글줄을 불러오는 중이에요.</p>}
    {inventory === null && <><p>이 작업에는 저장된 글줄 목록이 없어요.</p><button type="button" onClick={() => void open()}>다시 확인</button></>}
    {error && <><p role="alert">{error}</p><button type="button" onClick={() => void open()}>다시 읽기</button></>}
    {inventory && <>
      <p>판독 {read}줄 · 보류 {inventory.lines.length - read}줄 · 글이 연결되지 않은 말풍선 {inventory.uncoveredBubbles.length}개</p>
      <ol className="text-inventory-lines">
        {rows.map(row => <li key={row.key}>
          {row.box ? <button type="button" onClick={() => setSelectedId(row.key)} aria-pressed={selectedId === row.key}>
            {row.label}
          </button> : row.label}
          {row.note && <p>{row.note}</p>}
          {row.candidate && <p className="text-inventory-candidate">
            <span>{reviewCandidateLabels[row.candidate.reason]}</span>
            <strong>{row.candidate.translation}</strong>
          </p>}
          {selected?.key === row.key && row.box && image &&
            <SourceExcerpt image={image} box={row.box} width={inventory.width} height={inventory.height} />}
        </li>)}
      </ol>
    </>}
  </details>;
}
