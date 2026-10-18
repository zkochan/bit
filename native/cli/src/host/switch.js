/** ComponentWriter.finalizeWrite compiles once more after installPackagesGracefully. */
async function switchCompile({ installationSucceeded }) {
  if (!laneSwitchCommand) throw new Error('switch compiler adapter outside lane adoption');
  const loaded = await loadHarmony();
  const workspace = loaded.get('teambit.workspace/workspace');
  captureBootstrapProgress(workspace);
  const loader = bitRequire('@teambit/legacy.loader').loader;
  // Pnpm turns the loader off before its engine and restores it only on success.
  // Rust ran that engine; preserve its failed-install loader state for the real compiler.
  if (!installationSucceeded) loader.off();
  const previous = snapshotBootstrapProgress;
  snapshotBootstrapProgress = loader.isStarted;
  try {
    await loaded.get('teambit.compilation/compiler').compileOnWorkspace();
    return { error: null };
  } catch (error) {
    return { error: error.message };
  } finally {
    snapshotBootstrapProgress = previous;
  }
}
/** Policy aggregation stays native; the published lookup still loads actual aspect classes. */
async function switchConfiguredAspectClasses() {
  if (!laneSwitchCommand) throw new Error('switch policy adapter outside lane adoption');
  const workspace = (await loadHarmony()).get('teambit.workspace/workspace');
  captureBootstrapProgress(workspace);
  const previous = snapshotBootstrapProgress;
  snapshotBootstrapProgress = true;
  try {
    await workspace.getConfiguredUserAspectsPackages({ externalsOnly: true });
    return null;
  } finally {
    snapshotBootstrapProgress = previous;
  }
}

let switchSubscriberContext;
/** Rust owns the package operation; subscribers receive the actual retained receiver/classes. */
async function switchInstallSubscribers(request) {
  if (!laneSwitchCommand) throw new Error('switch subscriber adapter outside lane adoption');
  const loaded = await loadHarmony();
  const resolver = loaded.get('teambit.dependencies/dependency-resolver');
  if (request.phase === 'pre') switchSubscriberContext = await switchSubscriberInputs(request, loaded, resolver);
  const context = switchSubscriberContext;
  if (!context || !['pre', 'post'].includes(request.phase)) throw new Error('switch subscriber phase');
  const subscribers = request.phase === 'pre' ? context.installer.preInstallSubscriberList : context.installer.postInstallSubscriberList;
  for (const subscriber of subscribers) await subscriber(context.installer, context.args);
  if (request.phase === 'pre') return switchSubscriberEffective(context);
  if (request.phase === 'post') switchSubscriberContext = undefined;
  return null;
}

async function switchSubscriberInputs(request, loaded, resolver) {
  const workspace = loaded.get('teambit.workspace/workspace');
  const { ComponentID } = bitRequire('@teambit/component-id');
  const { ComponentMap } = bitRequire('@teambit/component');
  const { WorkspacePolicy } = bitRequire('@teambit/dependency-resolver');
  const entries = request.components.map(row => {
    const component = workspace.componentLoader.getFromCache(ComponentID.fromString(row.id), {
      loadExtensions: false, executeLoadSlot: false, loadSeedersAsAspects: false, resolveExtensionsVersions: false
    });
    if (!component) throw new Error(`switch subscriber class missing: ${row.id}`);
    return [component.id.toString(), [component, row.directory]];
  });
  const rootPolicy = new WorkspacePolicy(request.rootPolicy.map(row => ({
    dependencyId: row.name, lifecycleType: row.lifecycle,
    value: {version: row.version, ...(row.preserve == null ? {} : {preserve: row.preserve})}
  })));
  const args = {componentDirectoryMap: new ComponentMap(new Map(entries)), options: request.options,
    packageManagerOptions: request.packageManagerOptions, rootDir: request.rootDir, rootPolicy};
  const installer = resolver.getInstaller({});
  const originals = {componentDirectoryMap: args.componentDirectoryMap, options: args.options,
    packageManagerOptions: args.packageManagerOptions, rootDir: args.rootDir, rootPolicy};
  return {installer, args, originals,
    initialOptions: JSON.parse(JSON.stringify(originals.options)),
    initialManager: installer.packageManager,
    initialManagerName: installer.packageManager.name,
    initialManagerInstall: installer.packageManager.install,
    initialInstallingContext: JSON.stringify(installer.installingContext),
    initialPatchResolver: installer.resolvePatchPaths,
    initialExtensions: installer.withBuiltInPackageExtensions,
    initialPackageOptions: JSON.parse(JSON.stringify(originals.packageManagerOptions)),
    initialReceiver: JSON.parse(JSON.stringify(switchSubscriberReceiver(installer)))};
}

function switchSubscriberReceiver(installer) {
  return Object.fromEntries(['cacheRootDir','nodeLinker','packageImportMethod','sideEffectsCache',
    'nodeVersion','engineStrict','peerDependencyRules','neverBuiltDependencies','allowScripts',
    'dangerouslyAllowAllScripts','preferOffline','minimumReleaseAge','minimumReleaseAgeExclude',
    'patchedDependencies','packageExtensions'].map(key => [key, installer[key]]));
}

function switchSubscriberEffective(context) {
  const { originals, installer, initialPackageOptions, initialReceiver } = context;
  if (installer.packageManager !== context.initialManager || installer.packageManager.name !== context.initialManagerName
      || installer.packageManager.install !== context.initialManagerInstall
      || JSON.stringify(installer.installingContext) !== context.initialInstallingContext
      || installer.resolvePatchPaths !== context.initialPatchResolver
      || installer.withBuiltInPackageExtensions !== context.initialExtensions) {
    throw new Error('native lane installation subscriber receiver replacement is not yet supported');
  }
  for (const key of new Set([...Object.keys(context.initialOptions), ...Object.keys(originals.options)])) {
    if (!['linkedDependencies', 'forcedHarmonyVersion'].includes(key)
        && JSON.stringify(context.initialOptions[key]) !== JSON.stringify(originals.options[key])) {
      throw new Error(`native lane installation subscriber option mutation is not yet supported: ${key}`);
    }
  }
  const packageManagerChanges = {};
  const receiver = switchSubscriberReceiver(installer);
  for (const key of new Set([...Object.keys(initialPackageOptions), ...Object.keys(originals.packageManagerOptions)])) {
    const value = originals.packageManagerOptions[key];
    if (typeof value === 'function') throw new Error(`native lane installation subscriber function option is not yet supported: ${key}`);
    if (JSON.stringify(value) !== JSON.stringify(initialPackageOptions[key])) {
      const effective = value === undefined ? receiver[key] : value;
      if (effective !== undefined) packageManagerChanges[key] = effective;
    }
  }
  for (const [key, value] of Object.entries(receiver)) {
    if (!Object.hasOwn(originals.packageManagerOptions, key) && JSON.stringify(value) !== JSON.stringify(initialReceiver[key])) {
      packageManagerChanges[key] = value;
    }
  }
  return {options: originals.options, packageManagerChanges,
    cleanComponents: !originals.packageManagerOptions.rootComponents && !originals.packageManagerOptions.keepExistingModulesDir,
    componentDirectories: originals.componentDirectoryMap.toArray().map(([component, directory]) => ({id: component.id.toString(), directory}))};
}
