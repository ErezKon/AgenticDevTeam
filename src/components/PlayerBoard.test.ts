import { mount } from '@vue/test-utils';
import PlayerBoard from './PlayerBoard.vue';

describe('PlayerBoard.vue', () => {
  it('emits place-ship with correct coordinates for horizontal placement', async () => {
    const wrapper = mount(PlayerBoard, {
      props: { size: 5 },
    });
    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell20 = wrapper.find('[data-cell="2-0"]');
    await cell00.trigger('click');
    await cell20.trigger('click');
    const emitted = wrapper.emitted('place-ship');
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0];
    expect(payload.coordinates).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('emits place-ship with correct coordinates for vertical placement', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell02 = wrapper.find('[data-cell="0-2"]');
    await cell00.trigger('click');
    await cell02.trigger('click');
    const emitted = wrapper.emitted('place-ship');
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0];
    expect(payload.coordinates).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
    ]);
  });

  it('does not emit place-ship for diagonal placement and emits invalid-placement', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell11 = wrapper.find('[data-cell="1-1"]');
    await cell00.trigger('click');
    await cell11.trigger('click');
    const placeEmitted = wrapper.emitted('place-ship');
    const invalidEmitted = wrapper.emitted('invalid-placement');
    expect(placeEmitted).toBeFalsy();
    expect(invalidEmitted).toBeTruthy();
    const payload = invalidEmitted![0][0];
    expect(payload.message).toBe('Diagonal placement is not allowed');
  });
});
