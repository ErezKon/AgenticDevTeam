import { mount } from '@vue/test-utils';
import OpponentBoard from './OpponentBoard.vue';

describe('OpponentBoard.vue', () => {
  it('emits fire event with correct coordinates when a cell is clicked', async () => {
    const wrapper = mount(OpponentBoard, {
      props: { size: 5 },
    });
    const cell = wrapper.find('[data-cell="2-3"]');
    await cell.trigger('click');
    const emitted = wrapper.emitted('fire');
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0];
    expect(payload).toEqual({ x: 2, y: 3 });
  });
});
