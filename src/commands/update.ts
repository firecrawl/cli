import {
  autoUpdateBlocker,
  setAutoUpdateEnabled,
  updateNow,
  updatesAutomatically,
} from '../utils/auto-update';
import { detectInstallChannel } from '../utils/install-channel';

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

  if (
    (options.enableAuto || options.disableAuto) &&
    !setAutoUpdateEnabled(!!options.enableAuto)
  ) {
    console.error(
      'Could not save the setting to ~/.firecrawl/auto-update.json.'
    );
    process.exitCode = 1;
    return;
  }

  if (options.disableAuto) {
    console.log(
      'Automatic updates are off. Run firecrawl update to update manually.'
    );
    return;
  }

  if (options.enableAuto) {
    if (!updatesAutomatically(detectInstallChannel())) {
      console.log(
        'Automatic updates are on, but only the standalone binary updates itself. This install shows a notice when a release is out; run firecrawl update to install it.'
      );
      return;
    }
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
