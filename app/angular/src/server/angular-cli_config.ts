import { CompilerOptions } from 'typescript';
import { Path } from '@angular-devkit/core';
import path from 'path';
import fs from 'fs';
import { logger } from '@storybook/node-logger';
import { TsconfigPathsPlugin } from 'tsconfig-paths-webpack-plugin';
import stripJsonComments from 'strip-json-comments';
import {
  isBuildAngularInstalled,
  normalizeAssetPatterns,
  filterOutStylingRules,
  getAngularCliParts,
} from './angular-cli_utils';

// todo add more accurate typings
interface BasicOptions {
  options: {
    baseUrl?: string | undefined;
  };
  raw: object;
  fileNames: string[];
  errors: any[];
}

function getTsConfigOptions(tsConfigPath: Path) {
  const basicOptions: BasicOptions = {
    options: {},
    raw: {},
    fileNames: [],
    errors: [],
  };

  if (!fs.existsSync(tsConfigPath)) {
    return basicOptions;
  }

  const tsConfig = JSON.parse(stripJsonComments(fs.readFileSync(tsConfigPath, 'utf8')));

  const { baseUrl } = tsConfig.compilerOptions as CompilerOptions;

  if (baseUrl) {
    const tsConfigDirName = path.dirname(tsConfigPath);
    basicOptions.options.baseUrl = path.resolve(tsConfigDirName, baseUrl);
  }

  return basicOptions;
}

export function getAngularCliConfig(dirToSearch: string) {
  const possibleConfigNames = ['angular.json', 'workspace.json'];
  const possibleConfigPaths = possibleConfigNames
    .map(name => path.join(dirToSearch, name))

  const validIndex = possibleConfigPaths
    .findIndex(configPath => fs.existsSync(configPath));

  if (validIndex === -1) {
    logger.error(`Could not find angular.json using ${possibleConfigPaths[0]}`);
    return undefined;
  }

  return JSON.parse(stripJsonComments(fs.readFileSync(possibleConfigPaths[validIndex], 'utf8')));
}

export function getLeadingAngularCliProject(ngCliConfig: any) {
  if (!ngCliConfig) {
    return null;
  }

  const { defaultProject } = ngCliConfig;
  const { projects } = ngCliConfig;
  if (!projects || !Object.keys(projects).length) {
    throw new Error('angular.json must have projects entry.');
  }

  let projectName;
  const firstProjectName = Object.keys(projects)[0];
  if (projects.storybook) {
    projectName = 'storybook';
  } else if (defaultProject && projects[defaultProject]) {
    projectName = defaultProject;
  } else if (projects[firstProjectName]) {
    projectName = firstProjectName;
  }

  const project = projects[projectName];
  if (!project) {
    logger.error(`Could not find angular project '${projectName}' in angular.json.`);
  } else {
    logger.info(`=> Using angular project '${projectName}' for configuring Storybook.`);
  }
  if (project && !project.architect.build) {
    logger.error(`architect.build is not defined for project '${projectName}'.`);
  }
  return project;
}

export function getAngularCliWebpackConfigOptions(dirToSearch: Path) {
  const angularCliConfig = getAngularCliConfig(dirToSearch);
  const project = getLeadingAngularCliProject(angularCliConfig);

  if (!angularCliConfig || !project.architect.build) {
    return null;
  }

  const { options: projectOptions } = project.architect.build;
  const normalizedAssets = normalizeAssetPatterns(
    projectOptions.assets,
    dirToSearch,
    project.sourceRoot
  );
  const projectRoot = path.resolve(dirToSearch, project.root);
  const tsConfigPath = path.resolve(dirToSearch, projectOptions.tsConfig) as Path;
  const tsConfig = getTsConfigOptions(tsConfigPath);
  const budgets = projectOptions.budgets || [];
  const scripts = projectOptions.scripts || [];
  const outputPath = projectOptions.outputPath || 'dist/storybook-angular';
  const styles = projectOptions.styles || [];

  return {
    root: dirToSearch,
    projectRoot,
    tsConfigPath,
    tsConfig,
    supportES2015: false,
    buildOptions: {
      sourceMap: false,
      optimization: {},
      ...projectOptions,
      assets: normalizedAssets,
      budgets,
      scripts,
      styles,
      outputPath,
    },
  };
}

// todo add types
export function applyAngularCliWebpackConfig(baseConfig: any, cliWebpackConfigOptions: any) {
  if (!cliWebpackConfigOptions) {
    return baseConfig;
  }

  if (!isBuildAngularInstalled()) {
    logger.info('=> Using base config because @angular-devkit/build-angular is not installed.');
    return baseConfig;
  }

  const cliParts = getAngularCliParts(cliWebpackConfigOptions);

  if (!cliParts) {
    logger.warn('=> Failed to get angular-cli webpack config.');
    return baseConfig;
  }

  logger.info('=> Get angular-cli webpack config.');

  const { cliCommonConfig, cliStyleConfig } = cliParts;

  // Don't use storybooks styling rules because we have to use rules created by @angular-devkit/build-angular
  // because @angular-devkit/build-angular created rules have include/exclude for global style files.
  const rulesExcludingStyles = filterOutStylingRules(baseConfig);

  // cliStyleConfig.entry adds global style files to the webpack context
  // todo add type for acc
  const entry = [
    ...baseConfig.entry,
    ...Object.values(cliStyleConfig.entry).reduce((acc: any, item) => acc.concat(item), []),
  ];

  const module = {
    ...baseConfig.module,
    rules: [...cliStyleConfig.module.rules, ...rulesExcludingStyles],
  };

  // We use cliCommonConfig plugins to serve static assets files.
  const plugins = [...cliStyleConfig.plugins, ...cliCommonConfig.plugins, ...baseConfig.plugins];

  const resolve = {
    ...baseConfig.resolve,
    modules: Array.from(
      new Set([...baseConfig.resolve.modules, ...cliCommonConfig.resolve.modules])
    ),
    plugins: [
      new TsconfigPathsPlugin({
        configFile: cliWebpackConfigOptions.buildOptions.tsConfig,
        // After ng build my-lib the default value of 'main' in the package.json is 'umd'
        // This causes that you cannot import components directly from dist
        // https://github.com/angular/angular-cli/blob/9f114aee1e009c3580784dd3bb7299bdf4a5918c/packages/angular_devkit/build_angular/src/angular-cli-files/models/webpack-configs/browser.ts#L68
        mainFields: [
          ...(cliWebpackConfigOptions.supportES2015 ? ['es2015'] : []),
          'browser',
          'module',
          'main',
        ],
      }),
    ],
  };

  return {
    ...baseConfig,
    entry,
    module,
    plugins,
    resolve,
    resolveLoader: cliCommonConfig.resolveLoader,
  };
}
