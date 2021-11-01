import { expect } from 'chai';
import NpmCiRegistry, { supportNpmCiRegistryTesting } from '../npm-ci-registry';
import Helper from '../../src/e2e-helper/e2e-helper';
import { generateRandomStr } from '../../src/utils';

(supportNpmCiRegistryTesting ? describe : describe.skip)('deduplication', function () {
  let helper: Helper;
  this.timeout(0);
  before(() => {
    helper = new Helper();
  });
  it('should install the dependency from the workspace policy to the root modules directory', async function () {
    let npmCiRegistry: NpmCiRegistry;
    let randomStr;
    helper.scopeHelper.setNewLocalAndRemoteScopesHarmony();
    helper.bitJsonc.setupDefault();

    npmCiRegistry = new NpmCiRegistry(helper);
    randomStr = generateRandomStr(4); // to avoid publishing the same package every time the test is running
    const name = `@ci/${randomStr}.{name}`;
    npmCiRegistry.configureCustomNameInPackageJsonHarmony(name);
    await npmCiRegistry.init();

    helper.fixtures.populateComponents(2);
    helper.fs.outputFile(`comp1/index.js`, `const comp2 = require("@ci/${randomStr}.comp2");`);
    helper.command.tagAllComponents('--patch');
    helper.command.export();
    const scopeWithoutOwner = helper.scopes.remoteWithoutOwner;

    helper.scopeHelper.reInitLocalScopeHarmony();
    npmCiRegistry.configureCustomNameInPackageJsonHarmony(name);
    helper.bitJsonc.addKeyValToWorkspace('defaultScope', scopeWithoutOwner);
    helper.scopeHelper.addRemoteScope();
    helper.command.importComponent(`comp2`);
    helper.fs.outputFile(`${scopeWithoutOwner}/comp2/foo.js`, '');
    helper.command.tagComponent('comp2', 'tag2', '--ver=0.0.2');
    helper.command.export();

    helper.scopeHelper.reInitLocalScopeHarmony();
    npmCiRegistry.configureCustomNameInPackageJsonHarmony(name);
    helper.bitJsonc.addKeyValToWorkspace('defaultScope', scopeWithoutOwner);
    helper.scopeHelper.addRemoteScope();
    helper.command.importComponent(`comp1`);
    helper.command.install(`@ci/${randomStr}.comp2@0.0.2`);

    expect(
      helper.fixtures.fs.readJsonFile(`node_modules/@ci/${randomStr}.comp2/package.json`).componentId.version
    ).to.equal('0.0.2');
  });
});
