import { mount } from '@vue/test-utils';
import PlayerBoard from './PlayerBoard.vue';

describe('PlayerBoard.vue additional behavior', () => {
  it('emits invalid-placement when the same cell is selected twice', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    const cell = wrapper.find('[data-cell="1-1"]');
    await cell.trigger('click');
    await cell.trigger('click'); // duplicate selection
    const invalid = wrapper.emitted('invalid-placement');
    expect(invalid).toBeTruthy();
    const payload = invalid![0][0];
    expect(payload.message).toBe('Duplicate cell selection is not allowed');
  });

  it('emits invalid-placement for diagonal placement and does not add ship class', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    const start = wrapper.find('[data-cell="0-0"]');
    const diagonal = wrapper.find('[data-cell="1-1"]');
    await start.trigger('click');
    await diagonal.trigger('click');
    // wait for Vue to process emission
    await wrapper.vm.$nextTick();
    const invalid = wrapper.emitted('invalid-placement');
    expect(invalid).toBeTruthy();
    const payload = invalid![0][0];
    expect(payload.message).toBe('Diagonal placement is not allowed');
    // ensure no ship class added
    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell11 = wrapper.find('[data-cell="1-1"]');
    expect(cell00.classes()).not.toContain('ship');
    expect(cell11.classes()).not.toContain('ship');
  });

  it('adds ship class to placed cells after successful placement', async () => {
    const wrapper = mount(PlayerBoard, { props: { size: 5 } });
    const start = wrapper.find('[data-cell="0-0"]');
    const end = wrapper.find('[data-cell="0-2"]');
    await start.trigger('click');
    await end.trigger('click');
    // wait for Vue to update DOM
    await wrapper.vm.$nextTick();
    const cell00 = wrapper.find('[data-cell="0-0"]');
    const cell01 = wrapper.find('[data-cell="0-1"]');
    const cell02 = wrapper.find('[data-cell="0-2"]');
    expect(cell00.classes()).toContain('ship');
    expect(cell01.classes()).toContain('ship');
    expect(cell02.classes()).toContain('ship');
  });
});