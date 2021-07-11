import { expect } from 'chai';
import Helper from '../../src/e2e-helper/e2e-helper';

const fixtureA = `const b = require('./b');
console.log('got ' + b() + ' and got A')`;
const fixtureB = `const a = require('./a');
console.log('got ' + a() + ' and got B')`;

describe('insights', function () {
  this.timeout(0);
  let helper: Helper;
  before(() => {
    helper = new Helper();
    helper.command.setFeatures('legacy-workspace-config');
  });
  after(() => {
    helper.scopeHelper.destroy();
  });
  describe('cyclic dependencies', () => {
    let output;
    before(() => {
      helper.scopeHelper.setNewLocalAndRemoteScopes();
      helper.fs.createFile('comp', 'a.js', fixtureA);
      helper.fs.createFile('comp', 'b.js', fixtureB);
      helper.command.addComponentAllowFiles('comp/a.js', { i: 'comp/a' });
      helper.command.addComponentAllowFiles('comp/b.js', { i: 'comp/b' });
      output = helper.command.tagAllComponentsLegacy();
    });
    it('should be able to tag both with no errors', () => {
      expect(output).to.have.string('2 component(s) tagged');
    });
  });
  describe('duplicate dependencies', () => {
    let output;
    before(() => {
      helper.scopeHelper.setNewLocalAndRemoteScopes();
      helper.fs.createFile('comp', 'dependency.js', ``);
      helper.fs.createFile('comp', 'dependent1.js', `require('./dependency.js');`);
      helper.fs.createFile('comp', 'dependent2.js', `require('./dependency.js');`);
      helper.command.addComponentAllowFiles('comp/dependency.js', { i: 'dependency' });
      helper.command.addComponentAllowFiles('comp/dependent1.js', { i: 'dependent1' });
      helper.command.tagAllComponents();
      helper.command.addComponentAllowFiles('comp/dependent2.js', { i: 'dependent2' });
      helper.fs.createFile('comp', 'dependency.js', `//blabla`);
      helper.command.tagAllComponents('--skip-auto-tag ');
      output = helper.command.runCmd('bit insights');
    });
    it.only('should be able to tag both with no errors', () => {
      expect(output).to.have.string('2 component(s) tagged');
    });
  });
});
