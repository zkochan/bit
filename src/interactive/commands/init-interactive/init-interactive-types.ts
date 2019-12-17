export type Framework = 'react' | 'angular' | 'vue' | 'node';
export type StylingFrameworks = 'styled-components' | 'emotion';
export type TypingsSystem = 'plain' | 'flow' | 'typescript';
export type DepsTypes = 'dependencies' | 'devDependencies' | 'peerDependencies';
export type DepsObject = {
  [T in DepsTypes]?: Record<string, string>;
};
