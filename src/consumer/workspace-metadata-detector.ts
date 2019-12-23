import { PathOsBasedAbsolute } from '../utils/path';
import PackageJsonFile from './component/package-json-file';

export type Framework = 'react' | 'angular' | 'vue' | 'node';
export type StylingFrameworks = 'styled-components' | 'emotion' | 'sass' | 'scss' | 'less' | 'none';
export type TypingsSystem = 'plain' | 'flow' | 'typescript';
export type AutoDetectedFrameworks = {
  framework: Framework;
  typeSystem: TypingsSystem;
  stylingFramework: StylingFrameworks;
};

const frameworkRules = {
  rules: [
    { name: 'react', packages: ['react', 'react-dom'] },
    { name: 'angular', packages: ['@angular/core', '@angular/common'] },
    { name: 'vue', packages: ['vue'] }
  ],
  default: 'node'
};

const typeSystemRules = {
  rules: [
    { name: 'typescript', packages: ['typescript', '@babel/preset-typescript'] },
    { name: 'flow', packages: ['@babel/preset-flow'] }
  ],
  default: 'plain'
};

const stylingFrameworkRules = {
  rules: [
    {
      name: 'styled-components',
      packages: [
        'styled-components',
        'babel-plugin-styled-components',
        'typescript-plugin-styled-components',
        'stylelint-config-styled-components'
      ]
    },
    { name: 'emotion', packages: ['emotion', '@emotion/core', 'babel-plugin-emotion'] },
    { name: 'sass', packages: ['sass', 'sass-loader', 'node-sass', 'rollup-plugin-sass'] },
    { name: 'scss', packages: ['rollup-plugin-scss'] },
    { name: 'less', packages: ['less', 'less-loader'] }
  ],
  default: 'none'
};

export default class WorkspaceMetadataDetector {
  private _packageJson: PackageJsonFile;

  constructor(packageJson: PackageJsonFile) {
    this._packageJson = packageJson;
  }

  static async load(workspaceDir: PathOsBasedAbsolute): Promise<WorkspaceMetadataDetector> {
    const packageJson = await PackageJsonFile.load(workspaceDir);
    return new WorkspaceMetadataDetector(packageJson);
  }

  detectFramework(): Framework {
    return _matchRule(frameworkRules, this._packageJson);
  }
  detectTypeSystem(): TypingsSystem {
    return _matchRule(typeSystemRules, this._packageJson);
  }
  detectStylingFramework(): StylingFrameworks {
    return _matchRule(stylingFrameworkRules, this._packageJson);
  }

  detectAll(): AutoDetectedFrameworks {
    return {
      framework: this.detectFramework(),
      typeSystem: this.detectTypeSystem(),
      stylingFramework: this.detectStylingFramework()
    };
  }
}

function _matchRule(rulesObject, packageJson: PackageJsonFile) {
  let res = rulesObject.default;
  rulesObject.rules.forEach(rule => {
    if (packageJson.isAtLeastOneDependencyExistInAnyType(rule.packages)) {
      res = rule.name;
      return res;
    }
  });
  return res;
}
