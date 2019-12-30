export type DepsTypes = 'dependencies' | 'devDependencies' | 'peerDependencies';
export type DepsObject = {
  [T in DepsTypes]?: Record<string, string>;
};

export type RuledDepsObject = Record<string, DepsObject>;
