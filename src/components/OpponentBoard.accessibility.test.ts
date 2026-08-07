import { mount } from '@vue/test-utils';
import OpponentBoard from './OpponentBoard.vue';

describe('OpponentBoard.vue accessibility', () => {
  it('renders cells with tabindex for keyboard navigation', () => {
    const wrapper = mount(OpponentBoard, {
      props: { size: 3 },
    });
    const cells = wrapper.findAll('[role="button"]');
    expect(cells.length).toBe(9);
    cells.forEach((cell) => {
      expect(cell.attributes('tabindex')).toBe('0');
    });
  });
});
