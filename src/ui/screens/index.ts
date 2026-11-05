import './screens.css';
import type { IScreen, ScreenId } from '../../engine/ports';
import { createBootScreen } from './boot';
import { createCreditsScreen } from './credits';
import { createLoadingScreen } from './loading';
import { createMenuScreen } from './menu';
import { createResultScreen } from './result';
import { createSetupScreen } from './setup';
import { createTitleScreen } from './title';

export { createBootScreen } from './boot';
export { createCreditsScreen } from './credits';
export { createLoadingScreen } from './loading';
export { createMenuScreen } from './menu';
export { createResultScreen } from './result';
export { createSetupScreen } from './setup';
export { createTitleScreen } from './title';

/** Every screen except settings, which is supplied by the settings worker. */
export function createScreens(): Record<Exclude<ScreenId, 'settings'>, IScreen> {
  return {
    boot: createBootScreen(),
    title: createTitleScreen(),
    menu: createMenuScreen(),
    setup: createSetupScreen(),
    loading: createLoadingScreen(),
    result: createResultScreen(),
    credits: createCreditsScreen(),
  };
}
