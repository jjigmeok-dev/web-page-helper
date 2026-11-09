import { KEY, emit, isDisabled, options, part, parts, roving, setState } from './core.js';

/**
 * Radio group: exclusive selection with roving tabindex.
 *
 * <div data-hf="radio-group" data-hf-options='{"value":"a"}'>
 *   <button data-hf-part="radio" data-value="a">A</button>
 *   <button data-hf-part="radio" data-value="b">B</button>
 * </div>
 */
export const meta = {
  name: 'radio-group',
  file: import.meta.url,
  summary: 'Exclusive choice with arrow-key selection.',
  parts: { radio: 'button', label: 'any' },
  // Parts mount() throws without. `parts` alone is the full list,
  // including optional slots the caller may leave out.
  required: ['radio'],
  options: { value: '', orientation: 'horizontal', loop: true },
  events: ['hf:change'],
};

export function mount(root) {
  const radios = parts(root, 'radio');
  if (!radios.length) throw new Error('[hf] radio-group needs [data-hf-part="radio"] elements');
  const opts = options(root, meta.options);
  const vertical = opts.orientation === 'vertical';

  if (!root.hasAttribute('role')) root.setAttribute('role', 'radiogroup');

  let index = radios.findIndex((radio) => radio.dataset.value === opts.value || radio.id === opts.value);
  if (index === -1) index = 0;

  radios.forEach((radio, i) => {
    if (!radio.hasAttribute('role')) radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-checked', String(i === index));
    if (!radio.hasAttribute('data-value')) radio.dataset.value = radio.id || String(i);
  });

  function select(next, reason) {
    if (next < 0 || next >= radios.length) return;
    if (isDisabled(radios[next])) return;
    const changed = next !== index;
    index = next;
    paint();
    if (changed) emit(root, 'hf:change', { value: radios[index].dataset.value, index, reason });
    if (reason === 'keyboard' || reason === 'click') radios[index].focus({ preventScroll: true });
  }

  function paint() {
    radios.forEach((radio, i) => {
      const on = i === index;
      radio.setAttribute('aria-checked', String(on));
      setState(radio, on ? 'checked' : 'unchecked');
    });
    roving(radios, index);
    setState(root, 'checked');
  }

  const onClick = (event) => {
    const radio = event.target.closest('[data-hf-part="radio"]');
    if (radio && root.contains(radio)) select(radios.indexOf(radio), 'click');
  };

  const onKey = (event) => {
    const prev = vertical ? KEY.ARROW_UP : KEY.ARROW_LEFT;
    const next = vertical ? KEY.ARROW_DOWN : KEY.ARROW_RIGHT;
    if (event.key === prev) {
      event.preventDefault();
      select(index === 0 ? (opts.loop ? radios.length - 1 : 0) : index - 1, 'keyboard');
    } else if (event.key === next) {
      event.preventDefault();
      select(index === radios.length - 1 ? (opts.loop ? 0 : index) : index + 1, 'keyboard');
    } else if (event.key === KEY.SPACE || event.key === KEY.ENTER) {
      const radio = event.target.closest('[data-hf-part="radio"]');
      if (radio) {
        event.preventDefault();
        select(radios.indexOf(radio), 'keyboard');
      }
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  paint();

  return {
    get value() {
      return radios[index].dataset.value;
    },
    get index() {
      return index;
    },
    select(value) {
      const next = typeof value === 'number' ? value : radios.findIndex((radio) => radio.dataset.value === value || radio.id === value);
      if (next !== -1) select(next, 'api');
    },
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
    },
  };
}
