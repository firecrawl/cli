import {
  autoUpdateBlocker,
  setAutoUpdateEnabled,
  updateNow,
  rollbackUpdate,
  updateHint,
  updatesAutomatically,
} from '../utils/auto-update';
import { detectInstallChannel } from '../utils/install-channel';

export interface UpdateOptions {
  enableAuto?: boolean;
  disableAuto?: boolean;
  rollback?: boolean;
}

export async function handleUpdateCommand(
  options: UpdateOptions = {}
): Promise<void> {
  if (
    [options.enableAuto, options.disableAuto, options.rollback].filter(Boolean)
      .length > 1
  ) {
    console.error(
      'Pass only one of --enable-auto, --disable-auto, and --rollback.'
    );
    process.exitCode = 1;
    return;
  }

  if (options.rollback) {
    if (!(await rollbackUpdate())) process.exitCode = 1;
    return;
  }
  if (options.enableAuto && !updatesAutomatically(detectInstallChannel())) {
    console.error(
      `Automatic updates are not supported for this installation. ${updateHint(detectInstallChannel())}`
    );
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
      `Automatic updates are off for this user. ${updateHint(detectInstallChannel())}`
    );
    return;
  }

  if (options.enableAuto) {
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
