import chai, { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import { Helper, DEFAULT_OWNER, NpmCiRegistry, supportNpmCiRegistryTesting } from '@teambit/legacy.e2e-helper';
import { ComponentNotFound } from '@teambit/legacy.scope';

chai.use(require('chai-fs'));

/**
 * different scenarios of when a component or a version is missing from the original scope.
 * in all e2-tests below, we're dealing with 3 components.
 * scopeA/comp1 -> scopeA/comp2 -> scopeB/comp3.
 * for comp1 perspective, the comp2 is a direct-dep, comp3 is an indirect-dep.
 */
describe('recovery after component/scope deletion', function () {
  this.timeout(0);
  let helper: Helper;
  let npmCiRegistry: NpmCiRegistry;
  before(() => {
    helper = new Helper({ scopesOptions: { remoteScopeWithDot: true } });
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  (supportNpmCiRegistryTesting ? describe : describe.skip)(
    'remote/comp1-> remote/comp2-> remote2/comp3. indirect-dep scope (remote2) has re-initiated',
    () => {
      let scopeWithoutOwner: string;
      let remote2Path: string;
      let remote2Name: string;
      let remoteScopeClone: string;
      let remote2Clone: string;
      let localClone: string;
      function runFetchMissingDepsAction(remote, ids: string[]) {
        const options = { ids };
        return helper.command.runCmd(`bit run-action FetchMissingDeps ${remote} '${JSON.stringify(options)}'`);
      }
      before(async () => {
        helper.scopeHelper.setWorkspaceWithRemoteScope();
        scopeWithoutOwner = helper.scopes.remoteWithoutOwner;
        npmCiRegistry = new NpmCiRegistry(helper);
        npmCiRegistry.configureCiInPackageJsonHarmony();
        await npmCiRegistry.init();
        const secondRemote = helper.scopeHelper.getNewBareScope(undefined, true);
        remote2Path = secondRemote.scopePath;
        remote2Name = secondRemote.scopeName;
        helper.scopeHelper.addRemoteScope(secondRemote.scopePath);
        helper.scopeHelper.addRemoteScope(secondRemote.scopePath, helper.scopes.remotePath);
        helper.scopeHelper.addRemoteScope(helper.scopes.remotePath, secondRemote.scopePath);
        helper.fs.outputFile('comp1/index.js', `require('@${DEFAULT_OWNER}/${scopeWithoutOwner}.comp2');`);
        helper.fs.outputFile('comp2/index.js', `require('@${DEFAULT_OWNER}/${secondRemote.scopeWithoutOwner}.comp3');`);
        helper.fs.outputFile('comp3/index.js', '');
        helper.command.addComponent('comp1');
        helper.command.addComponent('comp2');
        helper.workspaceJsonc.addToVariant('comp3', 'defaultScope', remote2Name);
        helper.command.addComponent('comp3');
        helper.command.linkAndCompile();
        helper.command.tagAllComponents();
        helper.command.export();
        runFetchMissingDepsAction(helper.scopes.remote, [
          `${helper.scopes.remote}/comp1@0.0.1`,
          `${helper.scopes.remote}/comp2@0.0.1`,
        ]);
        // helper.command.runCmd(`bit import ${helper.scopes.remote}/* ${remote2Name}/* --objects`);
        localClone = helper.scopeHelper.cloneWorkspace();
        helper.scopeHelper.reInitRemoteScope(remote2Path);
        remote2Clone = helper.scopeHelper.cloneScope(remote2Path);
        remoteScopeClone = helper.scopeHelper.cloneRemoteScope();
      });
      after(() => {
        npmCiRegistry.destroy();
      });
      describe('indirect dependency is missing (import comp1 while comp3 is missing)', () => {
        let scopeWithMissingDep: string;
        before(() => {
          helper.scopeHelper.reInitWorkspace();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.workspaceJsonc.disablePreview();
          npmCiRegistry.setResolver();
          helper.command.importComponent('comp1', '--fetch-deps');
          // delete the comp3 from the scope.
          const hashPath = helper.general.getHashPathOfComponent('comp3');
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
          scopeWithMissingDep = helper.scopeHelper.cloneWorkspace();
        });
        it('an intermediate check. the scope should not have the comp3 object', () => {
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.be.undefined;
        });
        describe('the indirect dependency exists as cache inside the dependent scope', () => {
          describe('bit tag without --rebuild-deps-graph', () => {
            let tagOutput;
            before(() => {
              tagOutput = helper.command.tagWithoutBuild('comp1', '--unmodified');
            });
            it('should succeed', () => {
              expect(tagOutput).to.have.string('1 component(s) tagged');
            });
            it('should not bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.be.undefined;
            });
          });
          describe('bit tag with --rebuild-deps-graph', () => {
            let tagOutput;
            before(() => {
              tagOutput = helper.command.tagWithoutBuild('comp1', '--unmodified --rebuild-deps-graph');
            });
            it('should succeed', () => {
              expect(tagOutput).to.have.string('1 component(s) tagged');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
          describe('bit import', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.import('--fetch-deps');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
          describe('bit export to another remote', () => {
            let compNewRemote;
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              runFetchMissingDepsAction(helper.scopes.remote, [
                `${helper.scopes.remote}/comp1@0.0.1`,
                `${helper.scopes.remote}/comp2@0.0.1`,
              ]);
              helper.fs.outputFile('comp-new/index.js', `require('@${DEFAULT_OWNER}/${scopeWithoutOwner}.comp1');`);
              compNewRemote = helper.scopeHelper.getNewBareScope('-remote3', true);
              helper.workspaceJsonc.addToVariant('comp-new', 'defaultScope', compNewRemote.scopeName);
              helper.command.addComponent('comp-new');
              helper.command.tagAllComponents();
              helper.scopeHelper.addRemoteScope(compNewRemote.scopePath);
              helper.scopeHelper.addRemoteScope(helper.scopes.remotePath, compNewRemote.scopePath);
              helper.scopeHelper.addRemoteScope(remote2Path, compNewRemote.scopePath);
              helper.command.export();
              runFetchMissingDepsAction(compNewRemote.scopeName, [`${compNewRemote.scopeName}/comp-new@0.0.1`]);
            });
            it('this new remote should bring the flattened dependency (comp3) from the dependent scope', () => {
              const scope = helper.command.catScope(true, compNewRemote.scopePath);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
        });
        describe('the indirect dependency is missing in the dependent scope as well', () => {
          before(() => {
            // delete the comp3 from the remote scope.
            const hashPath = helper.general.getHashPathOfComponent('comp3', helper.scopes.remotePath);
            fs.removeSync(path.join(helper.scopes.remotePath, 'objects', hashPath));
            fs.removeSync(path.join(helper.scopes.remotePath, 'index.json'));
            helper.scopeHelper.addRemoteScope(remote2Path, helper.scopes.remotePath);
          });
          it('an intermediate check. the scope should not have the comp3 object', () => {
            const scope = helper.command.catScope(true, helper.scopes.remotePath);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.be.undefined;
          });
          describe('bit import', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.importAllComponents();
            });
            it('should not throw an error and not bring the missing dep', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.be.undefined;
            });
          });
          describe('bit tag --rebuild-deps-graph', () => {
            it('should throw an error about missing dependencies', () => {
              expect(() => helper.command.tagWithoutBuild('comp1', '--unmodified --rebuild-deps-graph')).to.throw(
                'has the following dependencies missing'
              );
            });
          });
          // discussed this with Ran. in the past we used to throw. now that we reuse the deps-graph from the Version objects,
          // we don't go to the remote, so we don't know whether the dependency is missing or not.
          // it's ok to not throw because the user already failed in `bit install` due to the missing package.
          // and when the installation fails, bit-tag fails as well.
          describe('bit tag without --rebuild-deps-graph', () => {
            it('should succeed', () => {
              expect(() => helper.command.tagWithoutBuild('comp1', '--unmodified')).to.not.throw();
            });
          });
        });
      });
      describe('indirect dependency scope is down (import comp1 while remote2 is down)', () => {
        let scopeWithMissingDep: string;
        before(() => {
          helper.scopeHelper.getClonedRemoteScope(remoteScopeClone);
          helper.scopeHelper.reInitWorkspace();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.workspaceJsonc.disablePreview();
          npmCiRegistry.setResolver();
          helper.command.importComponent('comp1', '--fetch-deps');
          // delete the comp3 from the scope.
          const hashPath = helper.general.getHashPathOfComponent('comp3');
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
          scopeWithMissingDep = helper.scopeHelper.cloneWorkspace();
          remoteScopeClone = helper.scopeHelper.cloneRemoteScope();
          // delete the entire remote2
          fs.emptyDirSync(remote2Path);
        });
        it('an intermediate check. the scope should not have the comp3 object', () => {
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.be.undefined;
        });
        describe('the indirect dependency exists as cache inside the dependent scope', () => {
          describe('bit tag without --rebuild-deps-graph', () => {
            let tagOutput;
            before(() => {
              tagOutput = helper.command.tagWithoutBuild('comp1', '--unmodified');
            });
            it('should succeed', () => {
              expect(tagOutput).to.have.string('1 component(s) tagged');
            });
            it('should not bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.be.undefined;
            });
          });
          describe('bit tag with --rebuild-deps-graph', () => {
            let tagOutput;
            before(() => {
              tagOutput = helper.command.tagWithoutBuild('comp1', '--unmodified --rebuild-deps-graph');
            });
            it('should succeed', () => {
              expect(tagOutput).to.have.string('1 component(s) tagged');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
          describe('bit import', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.import('--fetch-deps');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
        });
        describe('the indirect dependency is missing in the dependent scope as well', () => {
          before(() => {
            // delete the comp3 from the remote scope.
            const hashPath = helper.general.getHashPathOfComponent('comp3', helper.scopes.remotePath);
            fs.removeSync(path.join(helper.scopes.remotePath, 'objects', hashPath));
            fs.removeSync(path.join(helper.scopes.remotePath, 'index.json'));
          });
          it('an intermediate check. the scope should not have the comp3 object', () => {
            const scope = helper.command.catScope(true, helper.scopes.remotePath);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.be.undefined;
          });
          describe('bit import', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.importAllComponents();
            });
            it('should not throw an error and not bring the missing dep', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.be.undefined;
            });
          });
          describe('bit tag --rebuild-deps-graph', () => {
            it('should throw an error about missing dependencies', () => {
              expect(() => helper.command.tagWithoutBuild('comp1', '--unmodified --rebuild-deps-graph')).to.throw(
                'has the following dependencies missing'
              );
            });
          });
          // discussed this with Ran. in the past we used to throw. now that we reuse the deps-graph from the Version objects,
          // we don't go to the remote, so we don't know whether the dependency is missing or not.
          // it's ok to not throw because the user already failed in `bit install` due to the missing package.
          // and when the installation fails, bit-tag fails as well.
          describe('bit tag without --rebuild-deps-graph', () => {
            it('should succeed', () => {
              expect(() => helper.command.tagWithoutBuild('comp1', '--unmodified')).to.not.throw();
            });
          });
        });
      });
      describe('direct dependency is missing (import comp2 while comp3 is missing)', () => {
        let scopeWithMissingDep: string;
        before(() => {
          helper.scopeHelper.getClonedRemoteScope(remoteScopeClone);
          helper.scopeHelper.reInitRemoteScope(remote2Path);
          helper.scopeHelper.reInitWorkspace();
          npmCiRegistry.setResolver({ [remote2Name]: remote2Path });
          helper.command.importComponent('comp2', '--fetch-deps');
          // delete the comp3 from the scope.
          const hashPath = helper.general.getHashPathOfComponent('comp3');
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/objects', hashPath));
          fs.removeSync(path.join(helper.scopes.localPath, '.bit/index.json'));
          scopeWithMissingDep = helper.scopeHelper.cloneWorkspace();
        });
        it('an intermediate check. the scope should not have the comp3 object', () => {
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.be.undefined;
        });
        describe('the direct dependency exists as cache inside the dependent scope', () => {
          describe('bit import', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.import('--fetch-deps');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
          describe('bit tag', () => {
            let tagOutput;
            before(() => {
              helper.command.importAllComponents(); // otherwise, it shows "your workspace has outdated objects" warning.
              tagOutput = helper.command.tagWithoutBuild('comp2', '--unmodified');
            });
            it('should succeed', () => {
              expect(tagOutput).to.have.string('1 component(s) tagged');
            });
            it('should bring the missing dep from the dependent', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.not.be.undefined;
            });
          });
        });
        describe('the direct dependency is missing in the dependent scope as well', () => {
          before(() => {
            helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
            // delete the comp3 from the remote scope.
            const hashPath = helper.general.getHashPathOfComponent('comp3', helper.scopes.remotePath);
            fs.removeSync(path.join(helper.scopes.remotePath, 'objects', hashPath));
            fs.removeSync(path.join(helper.scopes.remotePath, 'index.json'));
            helper.scopeHelper.addRemoteScope(remote2Path, helper.scopes.remotePath);
          });
          it('an intermediate check. the scope should not have the comp3 object', () => {
            const scope = helper.command.catScope(true, helper.scopes.remotePath);
            const comp3 = scope.find((item) => item.name === 'comp3');
            expect(comp3).to.be.undefined;
          });
          describe('bit import', () => {
            let importOutput: string;
            before(() => {
              importOutput = helper.command.import('--fetch-deps');
            });
            it('should not throw an error and not bring the missing dep', () => {
              const scope = helper.command.catScope(true);
              const comp3 = scope.find((item) => item.name === 'comp3');
              expect(comp3).to.be.undefined;
            });
            it('should indicate the dependencies are missing', () => {
              expect(importOutput).to.have.string(`missing dependencies: ${remote2Name}/comp3`);
            });
          });
          // again, without this flag, it's ok to not throw because the user already failed in `bit install` due to the missing package.
          describe('bit tag --rebuild-deps-graph', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(scopeWithMissingDep);
              helper.command.importAllComponents();
            });
            it('should throw ComponentNotFound error because it is a direct dependency', () => {
              const cmd = () => helper.command.tagWithoutBuild('comp2', '--rebuild-deps-graph --unmodified');
              const err = new ComponentNotFound(`${remote2Name}/comp3@0.0.1`);
              helper.general.expectToThrow(cmd, err);
            });
          });
        });
      });
      // comp3 exits with 0.0.1 as cache of comp2/comp1 but in its origin it has only 0.0.2
      describe('indirect dependency (comp3) has re-created with a different version', () => {
        let beforeImportScope: string;
        before(() => {
          helper.scopeHelper.getClonedRemoteScope(remoteScopeClone);
          helper.scopeHelper.reInitWorkspace();
          helper.workspaceJsonc.disablePreview();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.scopeHelper.addRemoteScope();
          runFetchMissingDepsAction(helper.scopes.remote, [
            `${helper.scopes.remote}/comp1@0.0.1`,
            `${helper.scopes.remote}/comp2@0.0.1`,
          ]);
          helper.fs.outputFile('comp3/index.js', '');
          helper.workspaceJsonc.addToVariant('comp3', 'defaultScope', remote2Name);
          helper.command.addComponent('comp3');
          helper.command.tagAllComponents('', '0.0.2');
          helper.command.export();
          helper.scopeHelper.reInitWorkspace();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.workspaceJsonc.disablePreview();
          npmCiRegistry.setResolver();
          beforeImportScope = helper.scopeHelper.cloneWorkspace();
        });
        it('should import comp1 successfully and bring comp3@0.0.1 from the cache of comp1', () => {
          helper.command.importComponent('comp1', '--fetch-deps');
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.not.be.undefined;
          expect(comp3.versions).to.have.property('0.0.1');
          expect(comp3.versions).to.not.have.property('0.0.2');
        });
        it('should import comp2 successfully and bring comp3@0.0.1 from the cache of comp2', () => {
          helper.scopeHelper.getClonedWorkspace(beforeImportScope);
          helper.command.importComponent('comp2', '--fetch-deps');
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.not.be.undefined;
          expect(comp3.versions).to.have.property('0.0.1');
          expect(comp3.versions).to.not.have.property('0.0.2');
        });
        function expectToImportProperly() {
          it('comp3: should save 0.0.1 of in the orphanedVersions prop', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            expect(comp3).to.have.property('orphanedVersions');
            expect(comp3.orphanedVersions).to.have.property('0.0.1');
          });
          it('comp3: should not have 0.0.1 in the versions object, only 0.0.2', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            expect(comp3.versions).not.to.have.property('0.0.1');
            expect(comp3.versions).to.have.property('0.0.2');
          });
          it('comp3: the head should be the same as 0.0.2 not as 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            const hash = comp3.versions['0.0.2'];
            expect(comp3.head === hash);
          });
          it('comp3: the remote ref hash should be the same as 0.0.2 not as 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            const hash = comp3.versions['0.0.2'];

            const remoteRefs = helper.general.getRemoteRefPath(undefined, remote2Name);
            expect(remoteRefs).to.be.a.file();
            const remoteRefContent = fs.readJsonSync(remoteRefs);
            expect(remoteRefContent).to.deep.include({
              id: { scope: remote2Name, name: 'comp3' },
              head: hash,
            });
          });
        }
        describe('importing both: comp1 and flatten-dep comp3 to the same workspace ', () => {
          before(() => {
            helper.scopeHelper.getClonedWorkspace(beforeImportScope);
          });
          // before, it was throwing NoCommonSnap in this case.
          describe('importing comp1 (comp3 as cached) first then comp3 (comp3 as direct)', () => {
            before(() => {
              helper.command.importComponent('comp1', '--fetch-deps');
              helper.command.import(`${remote2Name}/comp3`);
            });
            expectToImportProperly();
          });
          // before, it was merging 0.0.1 into the current comp3 incorrectly. (versions prop had both 0.0.1 and 0.0.2)
          describe('importing comp3 (comp3 as direct) first then comp1 (comp3 as cached)', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${remote2Name}/comp3`);
              helper.command.importComponent('comp1', '--fetch-deps');
            });
            expectToImportProperly();
          });
          // before, it was throwing NoCommonSnap in this case.
          describe('importing comp3 (comp3 as direct) and comp1 (comp3 as cached) at the same time', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${helper.scopes.remote}/comp1 ${remote2Name}/comp3 --fetch-deps`);
            });
            expectToImportProperly();
          });
        });
        describe('importing both: comp2 and direct-dep comp3 to the same workspace', () => {
          // before, it was throwing ComponentNotFound error of comp3@0.0.1.
          describe('importing comp2 (comp3 as cached) and then comp3', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.importComponent('comp2', '--fetch-deps');
              helper.command.import(`${remote2Name}/comp3`);
            });
            expectToImportProperly();
          });
          describe('importing comp3 and then comp2', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${remote2Name}/comp3`);
              helper.command.importComponent('comp2', '--fetch-deps');
            });
            expectToImportProperly();
          });
          describe('importing comp3 and comp2 at the same time', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${helper.scopes.remote}/comp2 ${remote2Name}/comp3 --fetch-deps`);
            });
            expectToImportProperly();
            it('should be able to tag', () => {
              expect(() => helper.command.tagAllComponents()).to.not.throw();
            });
          });
        });
        // comp1 scope has the old comp3 with 0.0.1, now with a new export of comp1, it imports
        // comp3 again, which now has only 0.0.2 in its origin.
        describe('the remote of comp1 imports the new version of comp3 (via importMany of exporting comp1)', () => {
          before(() => {
            helper.scopeHelper.getClonedWorkspace(beforeImportScope);
            helper.command.import(`${helper.scopes.remote}/comp2 ${remote2Name}/comp3`);
            helper.command.tagAllComponents('', '0.0.7'); // tag comp2 with the updated comp3 version - 0.0.7
            helper.command.export('--origin-directly');
            runFetchMissingDepsAction(helper.scopes.remote, [`${helper.scopes.remote}/comp2@0.0.7`]);
            helper.command.runCmd(`bit import ${helper.scopes.remote}/* ${remote2Name}/* --objects`);
          });
          it('comp3: should save 0.0.1 of in the orphanedVersions prop on the remote', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`, helper.scopes.remotePath);
            expect(comp3).to.have.property('orphanedVersions');
            expect(comp3.orphanedVersions).to.have.property('0.0.1');
          });
          it('comp3: should not have 0.0.1 in the versions object, only 0.0.2 on the remote', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`, helper.scopes.remotePath);
            expect(comp3.versions).not.to.have.property('0.0.1');
            expect(comp3.versions).to.have.property('0.0.2');
          });
          it('comp3: the head should be the same as 0.0.2 not as 0.0.1 on the remote', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`, helper.scopes.remotePath);
            const hash = comp3.versions['0.0.2'];
            expect(comp3.head === hash);
          });
          it('should not change the remote of comp3', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`, remote2Path);
            expect(comp3).to.not.have.property('orphanedVersions');
            expect(comp3.versions).not.to.have.property('0.0.1');
            expect(comp3.versions).to.have.property('0.0.2');
          });
          describe('importing comp3 and then comp1 which brings comp3 with orphaned', () => {
            let importComp1Output: string;
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${remote2Name}/comp3`);
              importComp1Output = helper.command.importComponent('comp1', '--fetch-deps');
            });
            it('should not indicate that dependencies are missing', () => {
              expect(importComp1Output).to.not.include('missing dependencies');
            });
            it('should save the orphaned version of comp3 locally', () => {
              const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
              expect(comp3).to.have.property('orphanedVersions');
              expect(comp3.orphanedVersions).to.have.property('0.0.1');
            });
            it('should not throw an error on bit-tag of comp1', () => {
              expect(() =>
                helper.command.tagWithoutBuild(`${helper.scopes.remote}/comp1`, '--unmodified')
              ).to.not.throw();
            });
          });
        });
        describe.skip('re-export comp3 when locally it has orphanedVersions prop', () => {
          before(() => {
            helper.scopeHelper.getClonedWorkspace(beforeImportScope);
            helper.command.import(`${helper.scopes.remote}/comp1 ${remote2Name}/comp3`);
            helper.command.tagComponent(`${remote2Name}/comp3@0.0.8`, undefined, '--unmodified');
            helper.command.export();
            helper.command.importAllComponents();
          });
          it('the remote of comp3 should not get this orphanedVersions prop', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`, remote2Path);
            expect(comp3).to.not.have.property('orphanedVersions');
            expect(comp3.versions).not.to.have.property('0.0.1');
            expect(comp3.versions).to.have.property('0.0.8');
          });
        });
      });
      describe.skip('dealing with snaps, indirect dependency (comp3) has re-created with a new snap', () => {
        let beforeImportScope: string;
        before(() => {
          helper.scopeHelper.getClonedScope(remote2Clone, remote2Path);
          helper.scopeHelper.getClonedRemoteScope(remoteScopeClone);
          helper.scopeHelper.getClonedWorkspace(localClone);
          helper.fs.modifyFile('comp1/index.js');
          helper.fs.modifyFile('comp2/index.js');
          helper.fs.modifyFile('comp3/index.js');
          helper.command.snapAllComponentsWithoutBuild();
          helper.command.export('--all-versions');
          helper.scopeHelper.reInitRemoteScope(remote2Path);

          helper.scopeHelper.reInitWorkspace();
          helper.workspaceJsonc.disablePreview();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.fs.outputFile('comp3/index.js', '');
          helper.workspaceJsonc.addToVariant('comp3', 'defaultScope', remote2Name);
          helper.command.addComponent('comp3');
          helper.command.snapAllComponentsWithoutBuild();

          helper.command.export();
          helper.command.runCmd(`bit import ${helper.scopes.remote}/* ${remote2Name}/* --objects`);
          helper.scopeHelper.reInitWorkspace();
          helper.scopeHelper.addRemoteScope(remote2Path);
          helper.workspaceJsonc.disablePreview();
          npmCiRegistry.setResolver();
          beforeImportScope = helper.scopeHelper.cloneWorkspace();
        });
        it('should import comp1 successfully and bring comp3@0.0.1 from the cache of comp1', () => {
          helper.command.importComponent('comp1');
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.not.be.undefined;
          expect(comp3.versions).to.have.property('0.0.1');
          expect(comp3.versions).to.not.have.property('0.0.2');
        });
        it('should import comp2 successfully and bring comp3@0.0.1 from the cache of comp2', () => {
          helper.scopeHelper.getClonedWorkspace(beforeImportScope);
          helper.command.importComponent('comp2');
          const scope = helper.command.catScope(true);
          const comp3 = scope.find((item) => item.name === 'comp3');
          expect(comp3).to.not.be.undefined;
          expect(comp3.versions).to.have.property('0.0.1');
          expect(comp3.versions).to.not.have.property('0.0.2');
        });
        function expectToImportProperly() {
          it('comp3: should save 0.0.1 of in the orphanedVersions prop', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            expect(comp3).to.have.property('orphanedVersions');
            expect(comp3.orphanedVersions).to.have.property('0.0.1');
          });
          it('comp3: should not have 0.0.1 in the versions object', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            expect(comp3.versions).not.to.have.property('0.0.1');
          });
          it('comp3: the head should be different than 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            const hash = comp3.orphanedVersions['0.0.1'];
            expect(comp3.head !== hash);
          });
          it('comp3: the remote ref hash should be the same as the current head, not as 0.0.1', () => {
            const comp3 = helper.command.catComponent(`${remote2Name}/comp3`);
            const hash = comp3.head;

            const remoteRefs = helper.general.getRemoteRefPath(undefined, remote2Name);
            expect(remoteRefs).to.be.a.file();
            const remoteRefContent = fs.readJsonSync(remoteRefs);
            expect(remoteRefContent).to.deep.include({
              id: { scope: remote2Name, name: 'comp3' },
              head: hash,
            });
          });
        }
        describe('importing both: comp1 and flatten-dep comp3 to the same workspace ', () => {
          before(() => {
            helper.scopeHelper.getClonedWorkspace(beforeImportScope);
          });
          describe('importing comp1 (comp3 as cached) first then comp3 (comp3 as direct)', () => {
            before(() => {
              helper.command.importComponent('comp1');
              helper.command.import(`${remote2Name}/comp3`);
            });
            expectToImportProperly();
          });
          describe('importing comp3 (comp3 as direct) first then comp1 (comp3 as cached)', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${remote2Name}/comp3`);
              helper.command.importComponent('comp1');
            });
            expectToImportProperly();
          });
          describe('importing comp3 (comp3 as direct) and comp1 (comp3 as cached) at the same time', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${helper.scopes.remote}/comp1 ${remote2Name}/comp3`);
            });
            expectToImportProperly();
          });
        });
        describe('importing both: comp2 and direct-dep comp3 to the same workspace', () => {
          // before, it was throwing ComponentNotFound error of comp3@0.0.1.
          describe('importing comp2 (comp3 as cached) and then comp3', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.importComponent('comp2');
              helper.command.import(`${remote2Name}/comp3`);
            });
            expectToImportProperly();
          });
          describe('importing comp3 and then comp2', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${remote2Name}/comp3`);
              helper.command.importComponent('comp2');
            });
            expectToImportProperly();
          });
          describe('importing comp3 and comp2 at the same time', () => {
            before(() => {
              helper.scopeHelper.getClonedWorkspace(beforeImportScope);
              helper.command.import(`${helper.scopes.remote}/comp2 ${remote2Name}/comp3`);
            });
            expectToImportProperly();
            it('should be able to tag', () => {
              expect(() => helper.command.tagAllWithoutBuild()).to.not.throw();
            });
          });
        });
      });
    }
  );
});
