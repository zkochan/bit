import inquirer from 'inquirer';
import format from 'string-format';
import chalk from 'chalk';
import { init, listScope } from '../../../api/consumer';
import logger from '../../../logger/logger';
import getInitQuestions, { TOP_MESSAGE } from './init-questions';
import WorkspaceMetadataDetector from '../../../consumer/workspace-metadata-detector';

inquirer.registerPrompt('fuzzypath', require('inquirer-fuzzy-path'));

export default (async function initInteractive(path: string = process.cwd()) {
  const workspaceMetadataDetector = await WorkspaceMetadataDetector.load(path);
  const autoDetectedFrameworks = workspaceMetadataDetector.detectAll();
  const ui = new inquirer.ui.BottomBar();

  ui.log.write(TOP_MESSAGE);
  const questions = getInitQuestions(
    false,
    autoDetectedFrameworks.framework,
    autoDetectedFrameworks.typeSystem,
    autoDetectedFrameworks.stylingFramework
  );
  const answers = await inquirer.prompt(questions);
  // answers.compiler = actualCompiler;
  return init(undefined, false, false, false, false, answers).then(({ created, addedGitHooks, existingGitHooks }) => {
    return {
      created,
      addedGitHooks,
      existingGitHooks,
      reset: false,
      resetHard: false
    };
  });
});
