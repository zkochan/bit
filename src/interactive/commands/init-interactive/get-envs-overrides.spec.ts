import { expect } from 'chai';
import getCompilerByFrameworkAndTypingSystem, { getOverrides } from './get-envs-overrides';

describe.only('get env and overrides', () => {
  describe('react', () => {
    describe('compiler', () => {
      let compiler;
      describe('react, plain', () => {
        before(() => {
          compiler = getCompilerByFrameworkAndTypingSystem('react', 'plain');
        });
        it('should identify compiler correctly', () => {
          expect(compiler).to.equal('bit.envs/compilers/react');
        });
      });
      describe('react, flow', () => {
        before(() => {
          compiler = getCompilerByFrameworkAndTypingSystem('react', 'flow');
        });
        it('should identify compiler correctly', () => {
          expect(compiler).to.be.undefined;
        });
      });
      describe('react, typescript', () => {
        before(() => {
          compiler = getCompilerByFrameworkAndTypingSystem('react', 'typescript');
        });
        it('should identify compiler correctly', () => {
          expect(compiler).to.equal('bit.envs/compilers/react-typescript');
        });
      });
    });
    describe('overrides', () => {
      let overrides;
      describe('react, plain, no styling', () => {
        before(() => {
          overrides = getOverrides('react', 'plain', undefined);
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
        });
      });
      describe('react, plain, styled components', () => {
        before(() => {
          overrides = getOverrides('react', 'plain', 'styled-components');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('styled-components', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('styled-components', '+');
        });
      });
      describe('react, plain, emotion', () => {
        before(() => {
          overrides = getOverrides('react', 'plain', 'emotion');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('emotion', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('emotion', '+');
        });
      });
      describe('react, flow, no styling', () => {
        before(() => {
          overrides = getOverrides('react', 'flow', undefined);
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
        });
      });
      describe('react, flow, styled components', () => {
        before(() => {
          overrides = getOverrides('react', 'flow', 'styled-components');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('styled-components', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('styled-components', '+');
        });
      });
      describe('react, flow, emotion', () => {
        before(() => {
          overrides = getOverrides('react', 'flow', 'emotion');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('emotion', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('emotion', '+');
        });
      });
      describe('react, typescript, no styling', () => {});
      describe('react, typescript, styled components', () => {});
      describe('react, typescript, emotion', () => {
        before(() => {
          overrides = getOverrides('react', 'typescript', 'emotion');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('emotion', '-');
          expect(overrides.devDependencies).to.have.property('@types/node', '+');
          expect(overrides.devDependencies).to.have.property('@types/react', '+');
          expect(overrides.devDependencies).to.have.property('@types/react-dom', '+');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('emotion', '+');
        });
      });
    });
  });
  describe('angular', () => {
    describe('compiler', () => {
      let compiler;
      describe('angular, plain', () => {
        before(() => {
          compiler = getCompilerByFrameworkAndTypingSystem('angular');
        });
        it('should identify compiler correctly', () => {
          expect(compiler).to.equal('bit.envs/compilers/angular');
        });
      });
    });
    describe('overrides', () => {
      let overrides;
      describe('angular, no styling', () => {
        before(() => {
          overrides = getOverrides('angular', undefined, undefined);
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('@angular/core', '-');
          expect(overrides.dependencies).to.have.property('@angular/common', '-');
          expect(overrides.devDependencies).to.have.property('@types/node', '+');
          expect(overrides.peerDependencies).to.have.property('@angular/core', '>=8.0.0');
          expect(overrides.peerDependencies).to.have.property('@angular/common', '>=8.0.0');
        });
      });
      describe('angular, styled components', () => {
        before(() => {
          overrides = getOverrides('angular', undefined, 'styled-components');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('styled-components', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('styled-components', '+');
        });
      });
      describe('angular, emotion', () => {
        before(() => {
          overrides = getOverrides('angular', undefined, 'emotion');
        });
        it('should identify overrides correctly', () => {
          expect(overrides.dependencies).to.have.property('react', '-');
          expect(overrides.dependencies).to.have.property('react-dom', '-');
          expect(overrides.dependencies).to.have.property('emotion', '-');
          expect(overrides.peerDependencies).to.have.property('react', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('react-dom', '^16.9.0');
          expect(overrides.peerDependencies).to.have.property('emotion', '+');
        });
      });
    });
  });
});
