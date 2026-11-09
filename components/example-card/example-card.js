import { defineComponent } from '../../compose/component.js';
import { use } from '../../runtime/index.js';

/**
 * <hf-example-card> — a user component assembled from two foundations:
 * `disclosure` (details) and `radio-group` (density), plus a slotted body.
 *
 *   <hf-example-card title="Actions" density="comfortable">
 *     Any HTML here lands in the default slot.
 *   </hf-example-card>
 */
export default defineComponent({
  name: 'example-card',
  baseUrl: import.meta.url,
  styles: './example-card.css',
  props: {
    title: 'Example card',
    density: 'compact',
    open: false,
  },
  template: /* html */ `
    <section class="example-card" data-hf-part="root">
      <header class="example-card__header">
        <h3 class="example-card__title">{{ title }}</h3>

        <div class="example-card__density" data-hf="radio-group" data-hf-part="density">
          <button data-hf-part="radio" data-value="compact">Compact</button>
          <button data-hf-part="radio" data-value="comfortable">Comfortable</button>
        </div>
      </header>

      <div class="example-card__details" data-hf="disclosure" data-hf-part="details">
        <button class="example-card__trigger" data-hf-part="trigger">Show details</button>
        <div class="example-card__panel" data-hf-part="panel">
          <div data-hf-slot="default"></div>
        </div>
      </div>
    </section>`,
  setup({ root, props }) {
    const details = use(root.querySelector('[data-hf="disclosure"]'));
    const density = use(root.querySelector('[data-hf="radio-group"]'));

    density.select(props.density);
    if (props.open) details.setOpen(true, 'prop');

    return {
      update(next) {
        if (next.open !== details.isOpen) details.setOpen(next.open, 'prop');
        if (next.density !== density.value) density.select(next.density);
      },
      destroy() {
        details.destroy();
        density.destroy();
      },
    };
  },
});
