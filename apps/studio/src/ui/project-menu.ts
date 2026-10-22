import type { UiElements } from './elements';

/**
 * Phone-width fallback for the transport's four project commands.
 *
 * The buttons themselves stay in the DOM (`#project-actions`) and keep their
 * own handlers; this module only adds a disclosure menu that forwards clicks
 * to them, so there is a single source of truth for each command. On desktop
 * both the toggle and the menu are `display: none` (see `app.css`), so this
 * module is inert there.
 */
export function installProjectMenu(ui: UiElements): void {
  const { projectMenu, projectMenuToggle } = ui;

  const targetFor = (action: string): HTMLButtonElement | null => {
    switch (action) {
      case 'new':
        return ui.projectNew;
      case 'edit':
        return ui.projectEdit;
      case 'open':
        return ui.projectOpen;
      case 'save':
        return ui.projectSave;
      default:
        return null;
    }
  };

  const close = (): void => {
    if (projectMenu.hidden) return;
    projectMenu.hidden = true;
    projectMenuToggle.setAttribute('aria-expanded', 'false');
  };

  const open = (): void => {
    projectMenu.hidden = false;
    projectMenuToggle.setAttribute('aria-expanded', 'true');
    projectMenu.querySelector('button')?.focus();
  };

  projectMenuToggle.addEventListener('click', () => {
    if (projectMenu.hidden) open();
    else close();
  });

  projectMenu.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-project-action]');
    if (button === null) return;
    const action = button.dataset.projectAction ?? '';
    close();
    // The file picker must stay synchronous with the user gesture, so `open`
    // clicks the hidden input directly rather than through a timer.
    targetFor(action)?.click();
  });

  projectMenu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    projectMenuToggle.focus();
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (projectMenu.hidden || !(target instanceof Node)) return;
    if (projectMenu.contains(target) || projectMenuToggle.contains(target)) return;
    close();
  });

  // A resize back to desktop hides the menu by CSS, but the toggle's
  // aria-expanded would stay `true`; keep the attribute honest.
  const narrow = window.matchMedia('(max-width: 680px)');
  narrow.addEventListener('change', (event) => {
    if (!event.matches) close();
  });
}
