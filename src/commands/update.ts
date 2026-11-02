import {
  autoUpdateBlocker,
  setAutoUpdateEnabled,
  updateNow,
} from '../utils/auto-update';

export interface UpdateOptions {
  enableAuto?: boolean;
  disableAuto?: boolean;
}

export async function handleUpdateCommand(
  options: UpdateOptions = {}
): Promise<void> {
  if (options.enableAuto && options.disableAuto) {
    console.error('Pass only one of --enable-auto and --disable-auto.');
    process.exitCode = 1;
    return;
  }

  if (options.disableAuto) {
    setAutoUpdateEnabled(false);
    console.log(
      'Automatic updates are off. Run firecrawl update to update manually.'
    );
    return;
  }

  if (options.enableAuto) {
    setAutoUpdateEnabled(true);
    const blocker = autoUpdateBlocker();
    console.log(
      blocker
        ? `Automatic updates are on, but stay paused while ${blocker}.`
        : 'Automatic updates are on.'
    );
    return;
  }

  if (!(await updateNow())) process.exitCode = 1;
}
