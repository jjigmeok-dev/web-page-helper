import * as accordion from './accordion.js';
import * as combobox from './combobox.js';
import * as dialog from './dialog.js';
import * as disclosure from './disclosure.js';
import * as listbox from './listbox.js';
import * as menu from './menu.js';
import * as popover from './popover.js';
import * as radioGroup from './radio-group.js';
import * as tabs from './tabs.js';
import * as toast from './toast.js';
import * as toggle from './toggle.js';
import * as tooltip from './tooltip.js';

/**
 * The foundation registry. Every entry is behavior + ARIA only.
 * Consumers (and the studio) read `meta`; the loader calls `mount`.
 */
const modules = {
  disclosure,
  tabs,
  accordion,
  dialog,
  popover,
  menu,
  tooltip,
  toggle,
  switch: { meta: toggle.switchMeta, mount: toggle.mountSwitch },
  'radio-group': radioGroup,
  listbox,
  combobox,
  toast,
};

export const foundations = Object.freeze(
  Object.fromEntries(
    Object.entries(modules).map(([name, module]) => [
      name,
      Object.freeze({ name, meta: module.meta, mount: module.mount }),
    ]),
  ),
);

export const foundationNames = Object.freeze(Object.keys(foundations));

export default foundations;
