/** Wait for all writes to finish, including when either installation or a remote refresh fails. */
export async function runInstallTasks<T>(install: () => Promise<T>, tasks: Array<() => Promise<void>>): Promise<T> {
  const [installation, ...background] = await Promise.allSettled([
    Promise.resolve().then(install),
    ...tasks.map((task) => Promise.resolve().then(task)),
  ]);
  if (installation.status === 'rejected') throw installation.reason;
  for (const result of background) {
    if (result.status === 'rejected') throw result.reason;
  }
  return installation.value;
}
