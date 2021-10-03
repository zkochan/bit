import { aspectTemplate, PartialMainRuntimeTemplateFragments } from '@teambit/aspect';
import { ComponentContext, ComponentTemplate } from '@teambit/generator';
import { envFile } from './files/env-file';

const mainRuntimeFragments: PartialMainRuntimeTemplateFragments = {
  imports: (context) => {
    return `import { ${context.nameCamelCase}Env } from './${context.name}.env';
import { EnvsAspect, EnvsMain, EnvTransformer, Environment } from '@teambit/envs';
`;
  },
  dependencies: () => {
    return `[EnvsAspect]\n`;
  },
  constructorGen: (context) => {
    return `constructor(readonly ${context.nameCamelCase}Env, private envs: EnvsMain){}\n`;
  },
  provider: (context) => {
    return `const ${context.nameCamelCase}Env = new ${context.namePascalCase}Env();
    const ${context.nameCamelCase} = new ${context.namePascalCase}Main(${context.nameCamelCase}Env, envs);
    envs.registerEnv(${context.nameCamelCase}Env);`;
  },
};

export const emptyEnvTemplate: ComponentTemplate = {
  name: 'empty env',
  description: 'new empty env',
  generateFiles: (context: ComponentContext) => {
    // @ts-ignore - TODO: fix
    const aspectFiles = aspectTemplate.generateFiles(context, mainRuntimeFragments);
    return [
      ...aspectFiles,
      {
        relativePath: `${context.name}.env.ts`,
        content: envFile(context),
      },
    ];
  },
};
