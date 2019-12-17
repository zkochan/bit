import R from 'ramda';
import { Framework, StylingFrameworks, TypingsSystem, DepsObject, DepsTypes } from './init-interactive-types';

const COMPILERS_MAPPING = {
  react: {
    plain: 'bit.envs/compilers/react',
    typescript: 'bit.envs/compilers/react-typescript'
  },
  node: {
    plain: 'bit.envs/compilers/babel',
    flow: 'bit.envs/compilers/flow',
    typescript: 'bit.envs/compilers/typescript'
  },
  vue: {
    plain: 'bit.envs/compilers/vue',
    flow: 'bit.envs/compilers/vue',
    typescript: 'bit.envs/compilers/vue'
  },
  angular: {
    plain: 'not relevant',
    flow: 'not relevant',
    typescript: 'bit.envs/compilers/angular'
  }
};

const OVERRIDES_MAPPING = {
  react: {
    dependencies: {
      react: '-',
      'react-dom': '-'
    },
    peerDependencies: {
      react: '^16.9.0',
      'react-dom': '^16.9.0'
    },
    typescript: {
      devDependencies: {
        '@types/node': '+',
        '@types/react': '+',
        '@types/react-dom': '+'
      }
    }
  },
  angular: {
    dependencies: {
      '@angular/core': '-',
      '@angular/common': '-'
    },
    devDependencies: {
      '@types/node': '+'
    },
    peerDependencies: {
      '@angular/core': '>=8.0.0',
      '@angular/common': '>=8.0.0'
    }
  },
  vue: {
    typescript: {
      devDependencies: {
        '@types/node': '+'
      }
    }
  },
  node: {
    typescript: {
      devDependencies: {
        '@types/node': '+'
      }
    }
  },
  'styled-components': {
    react: {
      dependencies: {
        'styled-components': '-'
      },
      peerDependencies: {
        'styled-components': '+'
      },
      typescript: {
        devDependencies: {
          '@types/styled-components': '+'
        }
      }
    },
    vue: {
      dependencies: {
        'vue-styled-components': '-'
      },
      peerDependencies: {
        'vue-styled-components': '+'
      }
    },
    angular: {
      dependencies: {
        'styled-components': '-'
      },
      peerDependencies: {
        'styled-components': '+'
      },
      devDependencies: {
        '@types/node': '+',
        '@types/styled-components': '+'
      }
    },
    node: {
      dependencies: {
        'styled-components': '-'
      },
      peerDependencies: {
        'styled-components': '+'
      },
      typescript: {
        devDependencies: {
          '@types/node': '+',
          '@types/styled-components': '+'
        }
      }
    }
  },
  emotion: {
    dependencies: {
      emotion: '-'
    },
    peerDependencies: {
      emotion: '+'
    }
  }
};

export default function getCompilerByFrameworkAndTypingSystem(framework: Framework, typing?: TypingsSystem): string {
  return R.path([framework, typing], COMPILERS_MAPPING);
}

export function getOverrides(framework: Framework, typing?: TypingsSystem, styling?: StylingFrameworks): DepsObject {
  const frameworkDeps = R.path([framework], OVERRIDES_MAPPING);
  const frameworkTypedDeps = R.path([framework, typing], OVERRIDES_MAPPING);
  const stylingDeps = R.path([styling], OVERRIDES_MAPPING);
  const stylingFrameworkDeps = R.path([styling, framework], OVERRIDES_MAPPING);
  const stylingFrameworkTypedDeps = R.path([styling, framework, typing], OVERRIDES_MAPPING);
  const allDepsObjects = [
    frameworkDeps,
    frameworkTypedDeps,
    stylingDeps,
    stylingFrameworkDeps,
    stylingFrameworkTypedDeps
  ];
  const mergedDeps = mergeDepsByType(allDepsObjects, 'dependencies');
  const mergedDevDeps = mergeDepsByType(allDepsObjects, 'devDependencies');
  const mergedPeerDeps = mergeDepsByType(allDepsObjects, 'peerDependencies');
  const res = {
    dependencies: mergedDeps,
    devDependencies: mergedDevDeps,
    peerDependencies: mergedPeerDeps
  };
  return res;
}

function mergeDepsByType(depsObjects: DepsObject[], depType: DepsTypes) {
  const cleanDepsObjects = R.reject(R.isNil, depsObjects);
  const deps = R.pluck(depType, cleanDepsObjects);
  const merged = Object.assign({}, ...deps);
  return merged;
}
