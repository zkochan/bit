import { ComponentContext } from '@teambit/generator';

type FragmentGenerator = (componentContext: ComponentContext) => string;

export type MainRuntimeFragments = {
  imports: FragmentGenerator;
  slots: FragmentGenerator;
  dependencies: FragmentGenerator;
  constructorGen: FragmentGenerator;
  provider: FragmentGenerator;
};

export type PartialMainRuntimeFragments = Partial<MainRuntimeFragments>;

const defaultFragments: MainRuntimeFragments = {
  imports: () => '\n',
  slots: () => '[]\n',
  dependencies: () => '[]\n',
  constructorGen: () => `//constructor(){}\n`,
  provider: (context) => `static async provider() {
    return new ${context.namePascalCase}Main();
  }\n`,
};

export function mainRuntime(componentContext: ComponentContext, fragments?: PartialMainRuntimeFragments) {
  const actualFragments = Object.assign({}, defaultFragments, fragments || {});
  return `import { MainRuntime } from '@teambit/cli';
import { ${componentContext.namePascalCase}Aspect } from './${componentContext.name}.aspect';
${actualFragments.imports(componentContext)}

export class ${componentContext.namePascalCase}Main {
  ${actualFragments.constructorGen(componentContext)}
  static slots = ${actualFragments.slots(componentContext)};
  static dependencies = ${actualFragments.dependencies(componentContext)};
  static runtime = MainRuntime;
  ${actualFragments.provider(componentContext)}
}

${componentContext.namePascalCase}Aspect.addRuntime(${componentContext.namePascalCase}Main);
`;
}
