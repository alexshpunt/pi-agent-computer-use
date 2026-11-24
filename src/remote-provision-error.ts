/** The transport ended after dispatch; a remote preparation step may still be running or may have completed. */
export class RemotePreparationUncertain extends Error {}
/** The caller stopped waiting while a remote preparation kept running; the next caller joins it. */
export class RemotePreparationPending extends Error {}
