import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getFolderMoveMenuPosition } from '../src/utils/folderMoveMenuPosition.ts';

test('batch menu aligns right and opens below the toolbar', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 450, right: 580, top: 190, bottom: 220 }, 800, 700, 300, false,
  ), { left: '388px', width: '192px', maxHeight: '320px', top: '224px', bottom: 'auto' });
});

test('single menu near the top flips below instead of being clipped', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 24, right: 68, top: 80, bottom: 108 }, 800, 700, 300, true,
  ), { left: '24px', width: '176px', maxHeight: '320px', top: '112px', bottom: 'auto' });
});

test('single menu normally opens above the card action', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 100, right: 144, top: 420, bottom: 448 }, 800, 700, 300, true,
  ), { left: '100px', width: '176px', maxHeight: '320px', top: 'auto', bottom: '284px' });
});

test('batch menu near the bottom flips upward', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 450, right: 580, top: 610, bottom: 640 }, 800, 700, 300, false,
  ), { left: '388px', width: '192px', maxHeight: '320px', top: 'auto', bottom: '94px' });
});

test('long folder lists remain scrollable and within the available height', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 250, right: 380, top: 140, bottom: 170 }, 400, 360, 1000, false,
  ), { left: '188px', width: '192px', maxHeight: '178px', top: '174px', bottom: 'auto' });
});

test('narrow viewports clamp width and horizontal placement', () => {
  assert.deepEqual(getFolderMoveMenuPosition(
    { left: 100, right: 155, top: 100, bottom: 130 }, 160, 500, 300, false,
  ), { left: '8px', width: '144px', maxHeight: '320px', top: '134px', bottom: 'auto' });
  assert.equal(getFolderMoveMenuPosition(
    { left: 390, right: 415, top: 300, bottom: 328 }, 420, 500, 100, true,
  ).left, '236px');
});
