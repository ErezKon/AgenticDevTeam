import { mount } from '@vue/test-utils';
import PlayerBoard from './PlayerBoard.vue';

describe('PlayerBoard.vue overlap validation', () => {
  it('emits invalid-placement when new ship overlaps existing ship', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    // First ship placement vertical from (0,0) to (0,2)
    await wrapper.find('[data-cell="0-0"]').trigger('click');
    await wrapper.find('[data-cell="0-2"]').trigger('click');
    expect(wrapper.emitted('place-ship')).toBeTruthy();
    // Attempt overlapping ship starting at (0,1) to (0-3)
    await wrapper.find('[data-cell="0-1"]').trigger('click');
    await wrapper.find('[data-cell="0-3"]').trigger('click');
    const invalid = wrapper.emitted('invalid-placement');
    expect(invalid).toBeTruthy();
    const payload = invalid![0][0];
    expect(payload.message).toBe('Ship placement overlaps existing ship');
  });
});
