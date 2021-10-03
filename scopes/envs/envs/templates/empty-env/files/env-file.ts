import { ComponentContext } from '@teambit/generator';

export function envFile({ namePascalCase }: ComponentContext) {
  return `import { Aspect } from '@teambit/harmony';

export class ${namePascalCase}Env
  implements TesterEnv, CompilerEnv, LinterEnv, DevEnv, BuilderEnv, DependenciesEnv, PackageEnv, FormatterEnv
{
  constructor(){}
  /**
   * returns a component tester.
   */
  getTester(): Tester {}
}`;
}
