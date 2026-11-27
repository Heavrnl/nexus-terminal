type AnchorRect = { left: number; right: number; top: number; bottom: number };

const EDGE_PADDING = 8;
const GAP = 4;
const MAX_HEIGHT = 320;

/** Fixed, viewport-relative placement for the host folder move popover. */
export function getFolderMoveMenuPosition(
  anchor: AnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  contentHeight: number,
  preferAbove: boolean,
): Record<string, string> {
  // Retain the single (w-44) and batch (w-48) menu widths and alignments.
  const width = Math.min(preferAbove ? 176 : 192, Math.max(0, viewportWidth - EDGE_PADDING * 2));
  const preferredLeft = preferAbove ? anchor.left : anchor.right - width;
  const left = Math.max(EDGE_PADDING, Math.min(preferredLeft, viewportWidth - EDGE_PADDING - width));
  const spaceAbove = Math.max(0, anchor.top - GAP - EDGE_PADDING);
  const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - GAP - EDGE_PADDING);
  const desiredHeight = Math.min(MAX_HEIGHT, contentHeight);
  const flipUp = preferAbove
    ? desiredHeight <= spaceAbove || spaceAbove >= spaceBelow
    : desiredHeight > spaceBelow && spaceAbove > spaceBelow;
  const maxHeight = Math.min(MAX_HEIGHT, flipUp ? spaceAbove : spaceBelow);

  return {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    top: flipUp ? 'auto' : `${anchor.bottom + GAP}px`,
    bottom: flipUp ? `${viewportHeight - anchor.top + GAP}px` : 'auto',
  };
}
