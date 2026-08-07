import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import OwnBoardView from './OwnBoardView.vue';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  getBoard: vi.fn(),
}));

describe('OwnBoardView.vue', () => {
  it('fetches board data and renders ships, hits, and misses', async () => {
    // Mock API response
    (api.getBoard as any).mockResolvedValue({
      ships: [
        { coordinates: [[0, 0], [0, 1]] },
      ],
      hits: [[0, 0]],
      misses: [[1, 1]],
    });

    const wrapper = mount(OwnBoardView, {
      props: {
        size: 2,
        gameId: '1',
        playerId: '1',
      },
    });

    // Wait for onMounted async call to resolve and component to re-render
    await nextTick(); // first tick after mount
    await nextTick(); // second tick after promise resolution

    // Verify API called with correct parameters
    expect(api.getBoard).toHaveBeenCalledWith('1', '1');

    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell01 = wrapper.find('[data-cell="0-1"]');
    const cell11 = wrapper.find('[data-cell="1-1"]');

    expect(cell00.classes()).toContain('ship');
    expect(cell00.classes()).toContain('hit');
    expect(cell01.classes()).toContain('ship');
    expect(cell01.classes()).not.toContain('hit');
    expect(cell11.classes()).toContain('miss');
  });
});
