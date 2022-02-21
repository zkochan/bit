import chai, { expect } from 'chai';
import fs from 'fs-extra';
import path from 'path';
import { sync as resolveSync } from 'resolve';
import Helper from '../../src/e2e-helper/e2e-helper';

chai.use(require('chai-fs'));

describe('root components', function () {
  let helper: Helper;
  this.timeout(0);

  describe('pnpm isolated linker', function () {
    let virtualStoreDir!: string;
    let numberOfFilesInVirtualStore!: number;
    before(() => {
      helper = new Helper();
      helper.scopeHelper.setNewLocalAndRemoteScopesHarmony();
      helper.bitJsonc.setupDefault();
      helper.fixtures.populateComponents(4);
      helper.extensions.bitJsonc.addKeyValToDependencyResolver('rootComponentTypes', {
        apps: true,
      });
      helper.bitJsonc.addKeyVal(undefined, `${helper.scopes.remote}/comp3`, {});
      helper.bitJsonc.addKeyVal(undefined, `${helper.scopes.remote}/comp4`, {});
      helper.fs.outputFile(`comp1/index.js`, `const React = require("react")`);
      helper.fs.outputFile(
        `comp2/index.js`,
        `const React = require("react");const comp1 = require("@${helper.scopes.remote}/comp1");`
      );
      helper.fs.outputFile(
        `comp3/index.js`,
        `const React = require("react");const comp2 = require("@${helper.scopes.remote}/comp2");`
      );
      helper.fs.outputFile(
        `comp3/comp3.node-app.js`,
        `const React = require("react"); module.exports.default = { name: 'comp3' }`
      );
      helper.fs.outputFile(
        `comp4/index.js`,
        `const React = require("react");const comp2 = require("@${helper.scopes.remote}/comp2");`
      );
      helper.fs.outputFile(
        `comp4/comp4.node-app.js`,
        `const React = require("react");const comp1 = require("@${helper.scopes.remote}/comp1"); module.exports.default = { name: 'comp4' }`
      );
      helper.extensions.addExtensionToVariant('comp1', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16 || 17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp2', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16 || 17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp3', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp4', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp3', 'teambit.harmony/aspect');
      helper.extensions.addExtensionToVariant('comp4', 'teambit.harmony/aspect');
      helper.bitJsonc.addKeyValToDependencyResolver('policy', {
        dependencies: {
          react: '17',
        },
      });
      helper.command.install();
      // Only after the second install is bit able to detect apps
      helper.command.compile();
      helper.command.install();
      virtualStoreDir = path.join(helper.fixtures.scopes.localPath, 'node_modules/.pnpm');
      numberOfFilesInVirtualStore = fs.readdirSync(virtualStoreDir).length;
    });
    after(() => {
      helper.scopeHelper.destroy();
    });
    it('should install root components', () => {
      expect(
        path.join(helper.fixtures.scopes.localPath, `node_modules/@${helper.scopes.remote}/comp3__root`)
      ).to.be.a.path();
      expect(
        path.join(helper.fixtures.scopes.localPath, `node_modules/@${helper.scopes.remote}/comp4__root`)
      ).to.be.a.path();
    });
    it('should install the dependencies of the root component that has react 17 in the dependencies with react 17', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
    });
    it('should install the dependencies of the root component that has react 16 in the dependencies with react 16', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
    });
    it('should install the non-root components with their default React versions', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp1/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp2/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
    });
    it('should create package.json file in every variation of the component', () => {
      let pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp3__root`,
        `@${helper.scopes.remote}/comp2/package.json`,
      ]);
      expect(pkgJsonLoc).to.contain('.pnpm');
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp4__root`,
        `@${helper.scopes.remote}/comp2/package.json`,
      ]);
      expect(pkgJsonLoc).to.contain('.pnpm');
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp3__root`,
        `@${helper.scopes.remote}/comp2`,
        `@${helper.scopes.remote}/comp1/package.json`,
      ]);
      expect(pkgJsonLoc).to.contain('.pnpm');
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp4__root`,
        `@${helper.scopes.remote}/comp2`,
        `@${helper.scopes.remote}/comp1/package.json`,
      ]);
      expect(pkgJsonLoc).to.contain('.pnpm');
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);
    });
    describe('repeat install', () => {
      before(() => {
        helper.command.install();
      });
      it('should not add new or remove old deps', () => {
        expect(fs.readdirSync(virtualStoreDir).length).to.eq(numberOfFilesInVirtualStore);
      });
      it('should install the dependencies of the root component that has react 17 in the dependencies with react 17', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4__root`,
              `@${helper.scopes.remote}/comp2`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4__root`,
              `@${helper.scopes.remote}/comp2`,
              `@${helper.scopes.remote}/comp1`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
      });
      it('should install the dependencies of the root component that has react 16 in the dependencies with react 16', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3__root`,
              `@${helper.scopes.remote}/comp2`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3__root`,
              `@${helper.scopes.remote}/comp2`,
              `@${helper.scopes.remote}/comp1`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
      });
      it('should install the non-root components with their default React versions', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp1/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp2/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
      });
      it('should create package.json file in every variation of the component', () => {
        let pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp3__root`,
          `@${helper.scopes.remote}/comp2/package.json`,
        ]);
        expect(pkgJsonLoc).to.contain('.pnpm');
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp4__root`,
          `@${helper.scopes.remote}/comp2/package.json`,
        ]);
        expect(pkgJsonLoc).to.contain('.pnpm');
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp3__root`,
          `@${helper.scopes.remote}/comp2`,
          `@${helper.scopes.remote}/comp1/package.json`,
        ]);
        expect(pkgJsonLoc).to.contain('.pnpm');
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp4__root`,
          `@${helper.scopes.remote}/comp2`,
          `@${helper.scopes.remote}/comp1/package.json`,
        ]);
        expect(pkgJsonLoc).to.contain('.pnpm');
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);
      });
    });
    describe('compilation', () => {
      before(() => {
        helper.command.compile();
      });
      it('should create the dist folder in all the locations of the component', () => {
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp1/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp2/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp3/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp4/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp3__root/dist/index.js`])).to
          .exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2/dist/index.js`,
          ])
        ).to.exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1/dist/index.js`,
          ])
        ).to.exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp4__root/dist/index.js`])).to
          .exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2/dist/index.js`,
          ])
        ).to.exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1/dist/index.js`,
          ])
        ).to.exist;
      });
    });
  });

  describe('pnpm hoisted linker', function () {
    before(() => {
      helper = new Helper();
      helper.scopeHelper.setNewLocalAndRemoteScopesHarmony();
      helper.bitJsonc.setupDefault();
      helper.fixtures.populateComponents(4);
      helper.extensions.bitJsonc.addKeyValToDependencyResolver('nodeLinker', 'hoisted');
      helper.extensions.bitJsonc.addKeyValToDependencyResolver('rootComponentTypes', {
        apps: true,
      });
      helper.bitJsonc.addKeyVal(undefined, `${helper.scopes.remote}/comp3`, {});
      helper.bitJsonc.addKeyVal(undefined, `${helper.scopes.remote}/comp4`, {});
      helper.fs.outputFile(`comp1/index.js`, `const React = require("react")`);
      helper.fs.outputFile(
        `comp2/index.js`,
        `const React = require("react");const comp1 = require("@${helper.scopes.remote}/comp1");`
      );
      helper.fs.outputFile(
        `comp3/index.js`,
        `const React = require("react");const comp2 = require("@${helper.scopes.remote}/comp2");`
      );
      helper.fs.outputFile(
        `comp3/comp3.node-app.js`,
        `const React = require("react"); module.exports.default = { name: 'comp3' }`
      );
      helper.fs.outputFile(
        `comp4/index.js`,
        `const React = require("react");const comp2 = require("@${helper.scopes.remote}/comp2");`
      );
      helper.fs.outputFile(
        `comp4/comp4.node-app.js`,
        `const React = require("react");const comp1 = require("@${helper.scopes.remote}/comp1"); module.exports.default = { name: 'comp4' }`
      );
      helper.extensions.addExtensionToVariant('comp1', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16 || 17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp2', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16 || 17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp3', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '16',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp4', 'teambit.dependencies/dependency-resolver', {
        policy: {
          peerDependencies: {
            react: '17',
          },
        },
      });
      helper.extensions.addExtensionToVariant('comp3', 'teambit.harmony/aspect');
      helper.extensions.addExtensionToVariant('comp4', 'teambit.harmony/aspect');
      helper.bitJsonc.addKeyValToDependencyResolver('policy', {
        dependencies: {
          react: '17',
        },
      });
      helper.command.install();
      // Only after the second install is bit able to detect apps
      helper.command.compile();
      helper.command.install();
    });
    after(() => {
      helper.scopeHelper.destroy();
    });
    it('should install root components', () => {
      expect(
        path.join(helper.fixtures.scopes.localPath, `node_modules/@${helper.scopes.remote}/comp3__root`)
      ).to.be.a.path();
      expect(
        path.join(helper.fixtures.scopes.localPath, `node_modules/@${helper.scopes.remote}/comp4__root`)
      ).to.be.a.path();
    });
    it('should use a hoisted layout', () => {
      expect(
        path.join(
          helper.fixtures.scopes.localPath,
          `node_modules/@${helper.scopes.remote}/comp3__root/node_modules/@${helper.scopes.remote}/comp1`
        )
      ).to.be.a.path();
      expect(
        path.join(
          helper.fixtures.scopes.localPath,
          `node_modules/@${helper.scopes.remote}/comp3__root/node_modules/@${helper.scopes.remote}/comp2`
        )
      ).to.be.a.path();
      expect(
        path.join(
          helper.fixtures.scopes.localPath,
          `node_modules/@${helper.scopes.remote}/comp4__root/node_modules/@${helper.scopes.remote}/comp1`
        )
      ).to.be.a.path();
      expect(
        path.join(
          helper.fixtures.scopes.localPath,
          `node_modules/@${helper.scopes.remote}/comp4__root/node_modules/@${helper.scopes.remote}/comp2`
        )
      ).to.be.a.path();
    });
    it('should install the dependencies of the root component that has react 17 in the dependencies with react 17', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
    });
    it('should install the dependencies of the root component that has react 16 in the dependencies with react 16', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
    });
    it('should install the non-root components with their default React versions', () => {
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp1/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp2/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^16\./);
      expect(
        fs.readJsonSync(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4/index.js`,
            'react/package.json',
          ])
        ).version
      ).to.match(/^17\./);
    });
    it('should create package.json file in every variation of the component', () => {
      let pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp3__root`,
        `@${helper.scopes.remote}/comp2/package.json`,
      ]);
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp4__root`,
        `@${helper.scopes.remote}/comp2/package.json`,
      ]);
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp3__root`,
        `@${helper.scopes.remote}/comp2`,
        `@${helper.scopes.remote}/comp1/package.json`,
      ]);
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);

      pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
        `@${helper.scopes.remote}/comp4__root`,
        `@${helper.scopes.remote}/comp2`,
        `@${helper.scopes.remote}/comp1/package.json`,
      ]);
      expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);
    });
    describe('repeat install', () => {
      before(() => {
        helper.command.install();
      });
      it('should use a hoisted layout', () => {
        expect(
          path.join(
            helper.fixtures.scopes.localPath,
            `node_modules/@${helper.scopes.remote}/comp3__root/node_modules/@${helper.scopes.remote}/comp1`
          )
        ).to.be.a.path();
        expect(
          path.join(
            helper.fixtures.scopes.localPath,
            `node_modules/@${helper.scopes.remote}/comp3__root/node_modules/@${helper.scopes.remote}/comp2`
          )
        ).to.be.a.path();
        expect(
          path.join(
            helper.fixtures.scopes.localPath,
            `node_modules/@${helper.scopes.remote}/comp4__root/node_modules/@${helper.scopes.remote}/comp1`
          )
        ).to.be.a.path();
        expect(
          path.join(
            helper.fixtures.scopes.localPath,
            `node_modules/@${helper.scopes.remote}/comp4__root/node_modules/@${helper.scopes.remote}/comp2`
          )
        ).to.be.a.path();
      });
      it('should install the dependencies of the root component that has react 17 in the dependencies with react 17', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4__root`,
              `@${helper.scopes.remote}/comp2`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4__root`,
              `@${helper.scopes.remote}/comp2`,
              `@${helper.scopes.remote}/comp1`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
      });
      it('should install the dependencies of the root component that has react 16 in the dependencies with react 16', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3__root`,
              `@${helper.scopes.remote}/comp2`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3__root`,
              `@${helper.scopes.remote}/comp2`,
              `@${helper.scopes.remote}/comp1`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
      });
      it('should install the non-root components with their default React versions', () => {
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp1/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp2/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp3/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^16\./);
        expect(
          fs.readJsonSync(
            resolveFrom(helper.fixtures.scopes.localPath, [
              `@${helper.scopes.remote}/comp4/index.js`,
              'react/package.json',
            ])
          ).version
        ).to.match(/^17\./);
      });
      it('should create package.json file in every variation of the component', () => {
        let pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp3__root`,
          `@${helper.scopes.remote}/comp2/package.json`,
        ]);
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp4__root`,
          `@${helper.scopes.remote}/comp2/package.json`,
        ]);
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp2`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp3__root`,
          `@${helper.scopes.remote}/comp2`,
          `@${helper.scopes.remote}/comp1/package.json`,
        ]);
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);

        pkgJsonLoc = resolveFrom(helper.fixtures.scopes.localPath, [
          `@${helper.scopes.remote}/comp4__root`,
          `@${helper.scopes.remote}/comp2`,
          `@${helper.scopes.remote}/comp1/package.json`,
        ]);
        expect(fs.readJsonSync(pkgJsonLoc).name).to.eq(`@${helper.scopes.remote}/comp1`);
      });
    });
    describe('compilation', () => {
      before(() => {
        helper.command.compile();
      });
      it('should create the dist folder in all the locations of the component', () => {
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp1/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp2/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp3/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp4/dist/index.js`])).to
          .exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp3__root/dist/index.js`])).to
          .exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2/dist/index.js`,
          ])
        ).to.exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp3__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1/dist/index.js`,
          ])
        ).to.exist;
        expect(resolveFrom(helper.fixtures.scopes.localPath, [`@${helper.scopes.remote}/comp4__root/dist/index.js`])).to
          .exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2/dist/index.js`,
          ])
        ).to.exist;
        expect(
          resolveFrom(helper.fixtures.scopes.localPath, [
            `@${helper.scopes.remote}/comp4__root`,
            `@${helper.scopes.remote}/comp2`,
            `@${helper.scopes.remote}/comp1/dist/index.js`,
          ])
        ).to.exist;
      });
    });
  });
});

function resolveFrom(fromDir: string, moduleIds: string[]) {
  if (moduleIds.length === 0) return fromDir;
  const [moduleId, ...rest] = moduleIds;
  // We use the "resolve" library because the native "require.resolve" method uses a cache.
  // So with the native resolve method we cannot check the same path twice.
  return resolveFrom(resolveSync(moduleId, { basedir: fromDir, preserveSymlinks: false }), rest);
}
