import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ShipPlacement from './ShipPlacement.vue';
import { vi } from 'vitest';

vi.mock('@/services/api', () => {
  return {
    placeShip: vi.fn(() => Promise.resolve({ status: 'ships placed' })),
    type: {
      Coordinate: class {}
    }
  };
});

import { placeShip } from '@/services/api';

describe('ShipPlacement.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('places a ship of selected size successfully and marks cells', async () => {
    const wrapper = mount(ShipPlacement);
    // select ship size 3
    const sizeButton = wrapper.findAll('[data-test="size-button"]').filter(btn => btn.text() === '3')[0];
    await sizeButton.trigger('click');
    // click start and end cells for vertical ship size 3 (0,0) to (0,2)
    await wrapper.find('[data-cell="0-0"]').trigger('click');
    await wrapper.find('[data-cell="0-2"]').trigger('click');
    // wait for async updates
    await nextTick();
    // ensure API called with correct payload
    expect(placeShip).toHaveBeenCalledWith({
      size: 3,
      coordinates: [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 2 }
      ]
    });
    // after promise resolves, cells should have ship class
    await nextTick();
    const shipCells = wrapper.findAll('.cell.ship');
    const ids = shipCells.map(c => c.attributes('data-cell'));
    expect(ids).toEqual(expect.arrayContaining(['0-0', '0-1', '0-2']));
    // no error message
    expect(wrapper.find('[data-test="error-msg"]').exists()).toBe(false);
  });

  it('shows error for diagonal placement', async () => {
    const wrapper = mount(ShipPlacement);
    const sizeButton = wrapper.findAll('[data-test="size-button"]').filter(btn => btn.text() === '2')[0];
    await sizeButton.trigger('click');
    await wrapper.find('[data-cell="0-0"]').trigger('click');
    await wrapper.find('[data-cell="1-1"]').trigger('click');
    await nextTick();
    const error = wrapper.find('[data-test="error-msg"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe('Diagonal placement is not allowed');
    expect(placeShip).not.toHaveBeenCalled();
  });

  it('prevents overlapping ship placements', async () => {
    const wrapper = mount(ShipPlacement);
    // place first ship size 2 at (0,0)-(0,1)
    let sizeButton = wrapper.findAll('[data-test="size-button"]').filter(btn => btn.text() === '2')[0];
    await sizeButton.trigger('click');
    await wrapper.find('[data-cell="0-0"]').trigger('click');
    await wrapper.find('[data-cell="0-1"]').trigger('click');
    await nextTick();
    // second ship overlapping same cells
    sizeButton = wrapper.findAll('[data-test="size-button"]').filter(btn => btn.text() === '2')[0];
    await sizeButton.trigger('click');
    await wrapper.find('[data-cell="0-0"]').trigger('click');
    await wrapper.find('[data-cell="0-1"]').trigger('click');
    await nextTick();
    const error = wrapper.find('[data-test="error-msg"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe('Ship placement overlaps an existing ship.');
    // API should have been called only for the first successful placement
    expect(placeShip).toHaveBeenCalledTimes(1);
  });
});
