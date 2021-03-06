// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as fsx from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import readPackageTree = require('read-package-tree');
import {
  JsonFile,
  RushConstants,
  RushConfiguration,
  IRushLinkJson,
  RushConfigurationProject,
  Utilities,
  Stopwatch
} from '@microsoft/rush-lib';

import Package, { IResolveOrCreateResult, PackageDependencyKind } from './Package';
import PackageLookup from './PackageLookup';

interface IQueueItem {
  // A project from somewhere under "common/temp/node_modules"
  commonPackage: Package;

  // A symlinked virtual package that we will create somewhere under "this-project/node_modules"
  localPackage: Package;

  // If we encounter a dependency listed in cyclicDependencyProjects, this will be set to the root
  // of the localPackage subtree where we will stop creating local links.
  cyclicSubtreeRoot: Package;
}

enum SymlinkKind {
  File,
  Directory
}

export default class LinkManager {
  private _rushConfiguration: RushConfiguration;

  private static _createSymlink(linkTarget: string, linkSource: string, symlinkKind: SymlinkKind): void {
    if (symlinkKind === SymlinkKind.Directory) {
      // For directories, we use a Windows "junction".  On Unix, this produces a regular symlink.
      fsx.symlinkSync(linkTarget, linkSource, 'junction');
    } else {
      if (process.platform === 'win32') {
        // For files, we use a Windows "hard link", because creating a symbolic link requires
        // administrator permission.
        fsx.linkSync(linkTarget, linkSource);
      } else {
        // However hard links seem to cause build failures on Mac, so for all other operating systems
        // we use symbolic links for this case.
        fsx.symlinkSync(linkTarget, linkSource, 'file');
      }
    }
  }

  /**
   * This is a helper function used by createSymlinksForTopLevelProject().
   * It will recursively creates symlinked folders corresponding to each of the
   * Package objects in the provided tree.
   */
  private static _createSymlinksForDependencies(localPackage: Package): void {
    const localModuleFolder: string = path.join(localPackage.folderPath, 'node_modules');

    if (!localPackage.symlinkTargetFolderPath) {
      // Program bug
      throw Error('localPackage.symlinkTargetFolderPath was not assigned');
    }

    // This is special case for when localPackage.name has the form '@scope/name',
    // in which case we need to create the '@scope' folder first.
    const parentFolderPath: string = path.dirname(localPackage.folderPath);
    if (parentFolderPath && parentFolderPath !== localPackage.folderPath) {
      if (!fsx.existsSync(parentFolderPath)) {
        Utilities.createFolderWithRetry(parentFolderPath);
      }
    }

    if (localPackage.children.length === 0) {
      // If there are no children, then we can symlink the entire folder
      LinkManager._createSymlink(localPackage.symlinkTargetFolderPath, localPackage.folderPath, SymlinkKind.Directory);
    } else {
      // If there are children, then we need to symlink each item in the folder individually
      Utilities.createFolderWithRetry(localPackage.folderPath);

      for (const filename of fsx.readdirSync(localPackage.symlinkTargetFolderPath)) {
        if (filename.toLowerCase() !== 'node_modules') {
          // Create the symlink
          let symlinkKind: SymlinkKind = SymlinkKind.File;

          const linkSource: string = path.join(localPackage.folderPath, filename);
          let linkTarget: string = path.join(localPackage.symlinkTargetFolderPath, filename);

          const linkStats: fsx.Stats = fsx.lstatSync(linkTarget);

          if (linkStats.isSymbolicLink()) {
            const targetStats: fsx.Stats = fsx.statSync(linkTarget);
            if (targetStats.isDirectory()) {
              // Neither a junction nor a directory-symlink can have a directory-symlink
              // as its target; instead, we must obtain the real physical path.
              // A junction can link to another junction.  Unfortunately, the node 'fs' API
              // lacks the ability to distinguish between a junction and a directory-symlink
              // (even though it has the ability to create them both), so the safest policy
              // is to always make a junction and always to the real physical path.
              linkTarget = fsx.realpathSync(linkTarget);
              symlinkKind = SymlinkKind.Directory;
            }
          } else if (linkStats.isDirectory()) {
            symlinkKind = SymlinkKind.Directory;
          }

          LinkManager._createSymlink(linkTarget, linkSource, symlinkKind);
        }
      }
    }

    if (localPackage.children.length > 0) {
      Utilities.createFolderWithRetry(localModuleFolder);

      for (const child of localPackage.children) {
        LinkManager._createSymlinksForDependencies(child);
      }
    }
  }

  /**
   * For a Package object that represents a top-level Rush project folder
   * (i.e. with source code that we will be building), this clears out its
   * node_modules folder and then recursively creates all the symlinked folders.
   */
  private static _createSymlinksForTopLevelProject(localPackage: Package): void {
    const localModuleFolder: string = path.join(localPackage.folderPath, 'node_modules');

    // Sanity check
    if (localPackage.parent) {
      throw new Error('The provided package is not a top-level project');
    }

    // The root-level folder is the project itself, so we simply delete its node_modules
    // to start clean
    console.log('Purging ' + localModuleFolder);
    Utilities.dangerouslyDeletePath(localModuleFolder);

    if (localPackage.children.length > 0) {
      Utilities.createFolderWithRetry(localModuleFolder);

      for (const child of localPackage.children) {
        LinkManager._createSymlinksForDependencies(child);
      }
    }
  }

  constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;
  }

  /**
   * Creates node_modules symlinks for all Rush projects defined in the RushConfiguration.
   * @param force - Normally the operation will be skipped if the links are already up to date;
   *   if true, this option forces the links to be recreated.
   */
  public createSymlinksForProjects(force: boolean): Promise<void> {
    if (!force) {
      if (fsx.existsSync(this._rushConfiguration.rushLinkJsonFilename)) {
        console.log(colors.green(`Skipping "rush link" -- everything is already up to date.`));
        return;
      }
    }

    console.log('Starting "rush link"');
    const stopwatch: Stopwatch = Stopwatch.start();

    // Delete the flag file if it exists; if we get interrupted, this will ensure that
    // a full "rush link" is required next time
    Utilities.deleteFile(this._rushConfiguration.rushLinkJsonFilename);

    return new Promise<void>((resolve: () => void, reject: (reason: Error) => void): void => {
      readPackageTree(this._rushConfiguration.commonTempFolder,
        (error: Error, npmPackage: readPackageTree.PackageNode) => {

        if (error) {
          reject(error);
        } else {
          const commonRootPackage: Package = Package.createFromNpm(npmPackage);

          const commonPackageLookup: PackageLookup = new PackageLookup();
          commonPackageLookup.loadTree(commonRootPackage);

          const rushLinkJson: IRushLinkJson = { localLinks: {} };

          for (const rushProject of this._rushConfiguration.projects) {
            console.log(os.EOL + 'LINKING: ' + rushProject.packageName);
            this._linkProject(rushProject, commonRootPackage, commonPackageLookup, rushLinkJson);
          }

          console.log(`Writing "${this._rushConfiguration.rushLinkJsonFilename}"`);
          JsonFile.saveJsonFile(rushLinkJson, this._rushConfiguration.rushLinkJsonFilename);

          stopwatch.stop();
          console.log(os.EOL + colors.green(`Rush link finished successfully. (${stopwatch.toString()})`));
          console.log(os.EOL + 'Next you should probably run: "rush rebuild"');

          resolve();
        }
      });
    });
  }

  /**
   * This is called once for each local project from Rush.json.
   * @param project             The local project that we will create symlinks for
   * @param commonRootPackage   The common/temp/package.json package
   * @param commonPackageLookup A dictionary for finding packages under common/temp/node_modules
   * @param rushConfiguration   The rush.json file contents
   * @param rushLinkJson        The common/temp/rush-link.json output file
   * @param options             Command line options for "rush link"
   */
  private _linkProject(
    project: RushConfigurationProject,
    commonRootPackage: Package,
    commonPackageLookup: PackageLookup,
    rushLinkJson: IRushLinkJson): void {

    let commonProjectPackage: Package = commonRootPackage.getChildByName(project.tempProjectName);
    if (!commonProjectPackage) {
      // Normally we would expect the temp project to have been installed into the common\node_modules
      // folder.  However, if it was recently added, "rush install" doesn't technically require
      // this, as long as its dependencies can be found at the root of the NPM shrinkwrap file.
      // This avoids the need to run "rush generate" unnecessarily.

      // Example: "project1"
      const unscopedTempProjectName: string = Utilities.parseScopedPackageName(project.tempProjectName).name;

      // Example: "C:\MyRepo\common\temp\projects\project1\package.json"
      const packageJsonFilename: string = path.join(this._rushConfiguration.commonTempFolder,
        RushConstants.rushTempProjectsFolderName, unscopedTempProjectName, 'package.json');

      // Example: "C:\MyRepo\common\temp\node_modules\@rush-temp\project1"
      const installFolderName: string = path.join(this._rushConfiguration.commonTempFolder,
        RushConstants.nodeModulesFolderName, RushConstants.rushTempNpmScope, unscopedTempProjectName);

      commonProjectPackage = Package.createVirtualTempPackage(packageJsonFilename, installFolderName);
      commonRootPackage.addChild(commonProjectPackage);
    }

    // TODO: Validate that the project's package.json still matches the common folder
    const localProjectPackage: Package = Package.createLinkedPackage(
      project.packageJson.name,
      commonProjectPackage.version,
      commonProjectPackage.dependencies,
      project.projectFolder
    );

    const queue: IQueueItem[] = [];
    queue.push({
      commonPackage: commonProjectPackage,
      localPackage: localProjectPackage,
      cyclicSubtreeRoot: undefined
    });

    // tslint:disable-next-line:no-constant-condition
    while (true) {
      const queueItem: IQueueItem = queue.shift();
      if (!queueItem) {
        break;
      }

      // A project from somewhere under "common/temp/node_modules"
      const commonPackage: Package = queueItem.commonPackage;

      // A symlinked virtual package somewhere under "this-project/node_modules",
      // where "this-project" corresponds to the "project" parameter for linkProject().
      const localPackage: Package = queueItem.localPackage;

      // If we encounter a dependency listed in cyclicDependencyProjects, this will be set to the root
      // of the localPackage subtree where we will stop creating local links.
      const cyclicSubtreeRoot: Package = queueItem.cyclicSubtreeRoot;

      // NOTE: It's important that this traversal follows the dependencies in the Common folder,
      // because for Rush projects this will be the union of
      // devDependencies / dependencies / optionalDependencies.
      for (const dependency of commonPackage.dependencies) {
        let startingCyclicSubtree: boolean;

        // Should this be a "local link" to a top-level Rush project (i.e. versus a regular link
        // into the Common folder)?
        const matchedRushPackage: RushConfigurationProject = this._rushConfiguration.getProjectByName(dependency.name);

        if (matchedRushPackage) {
          const matchedVersion: string = matchedRushPackage.packageJson.version;

          // The dependency name matches an Rush project, but are there any other reasons not
          // to create a local link?
          if (cyclicSubtreeRoot) {
            // DO NOT create a local link, because this is part of an existing
            // cyclicDependencyProjects subtree
          } else if (project.cyclicDependencyProjects.has(dependency.name)) {
            // DO NOT create a local link, because we are starting a new
            // cyclicDependencyProjects subtree
            startingCyclicSubtree = true;
          } else if (dependency.kind !== PackageDependencyKind.LocalLink
            && !semver.satisfies(matchedVersion, dependency.versionRange)) {
            // DO NOT create a local link, because the local project's version isn't SemVer compatible.

            // (Note that in order to make version bumping work as expected, we ignore SemVer for
            // immediate dependencies of top-level projects, indicated by PackageDependencyKind.LocalLink.
            // Is this wise?)

            console.log(colors.yellow(`Rush will not locally link ${dependency.name} for ${localPackage.name}`
              + ` because the requested version "${dependency.versionRange}" is incompatible`
              + ` with the local version ${matchedVersion}`));
          } else {
            // Yes, it is compatible, so create a symlink to the Rush project.

            // If the link is coming from our top-level Rush project, then record a
            // build dependency in rush-link.json:
            if (localPackage === localProjectPackage) {
              let localLinks: string[] = rushLinkJson.localLinks[localPackage.name];
              if (!localLinks) {
                localLinks = [];
                rushLinkJson.localLinks[localPackage.name] = localLinks;
              }
              localLinks.push(dependency.name);
            }

            // Is the dependency already resolved?
            const resolution: IResolveOrCreateResult = localPackage.resolveOrCreate(dependency.name);

            if (!resolution.found || resolution.found.version !== matchedVersion) {
              // We did not find a suitable match, so place a new local package that
              // symlinks to the Rush project
              const newLocalFolderPath: string = path.join(
                resolution.parentForCreate.folderPath, 'node_modules', dependency.name);

              const newLocalPackage: Package = Package.createLinkedPackage(
                dependency.name,
                matchedVersion,
                // Since matchingRushProject does not have a parent, its dependencies are
                // guaranteed to be already fully resolved inside its node_modules folder.
                [],
                newLocalFolderPath
              );

              newLocalPackage.symlinkTargetFolderPath = matchedRushPackage.projectFolder;

              resolution.parentForCreate.addChild(newLocalPackage);

              // (There are no dependencies, so we do not need to push it onto the queue.)
            }

            continue;
          }
        }

        // We can't symlink to an Rush project, so instead we will symlink to a folder
        // under the "Common" folder
        const commonDependencyPackage: Package = commonPackage.resolve(dependency.name);
        if (commonDependencyPackage) {
          // This is the version that was chosen when "npm install" ran in the common folder
          const effectiveDependencyVersion: string = commonDependencyPackage.version;

          // Is the dependency already resolved?
          let resolution: IResolveOrCreateResult;
          if (!cyclicSubtreeRoot || !matchedRushPackage) {
            // Perform normal module resolution.
            resolution = localPackage.resolveOrCreate(dependency.name);
          } else {
            // We are inside a cyclicDependencyProjects subtree (i.e. cyclicSubtreeRoot != undefined),
            // and the dependency is a local project (i.e. matchedRushPackage != undefined), so
            // we use a special module resolution strategy that places everything under the
            // cyclicSubtreeRoot.
            resolution = localPackage.resolveOrCreate(dependency.name, cyclicSubtreeRoot);
          }

          if (!resolution.found || resolution.found.version !== effectiveDependencyVersion) {
            // We did not find a suitable match, so place a new local package

            const newLocalFolderPath: string = path.join(
              resolution.parentForCreate.folderPath, 'node_modules', commonDependencyPackage.name);

            const newLocalPackage: Package = Package.createLinkedPackage(
              commonDependencyPackage.name,
              commonDependencyPackage.version,
              commonDependencyPackage.dependencies,
              newLocalFolderPath
            );

            const commonPackageFromLookup: Package = commonPackageLookup.getPackage(newLocalPackage.nameAndVersion);
            if (!commonPackageFromLookup) {
              throw Error(`The ${localPackage.name}@${localPackage.version} package was not found`
                + ` in the common folder`);
            }
            newLocalPackage.symlinkTargetFolderPath = commonPackageFromLookup.folderPath;

            let newCyclicSubtreeRoot: Package = cyclicSubtreeRoot;
            if (startingCyclicSubtree) {
              // If we are starting a new subtree, then newLocalPackage will be its root
              // NOTE: cyclicSubtreeRoot is guaranteed to be undefined here, since we never start
              // a new tree inside an existing tree
              newCyclicSubtreeRoot = newLocalPackage;
            }

            resolution.parentForCreate.addChild(newLocalPackage);
            queue.push({
              commonPackage: commonDependencyPackage,
              localPackage: newLocalPackage,
              cyclicSubtreeRoot: newCyclicSubtreeRoot
            });
          }
        } else {
          if (dependency.kind !== PackageDependencyKind.Optional) {
            throw Error(`The dependency "${dependency.name}" needed by "${localPackage.name}"`
              + ` was not found the common folder -- do you need to run "rush generate"?`);
          } else {
            console.log(colors.yellow('Skipping optional dependency: ' + dependency.name));
          }
        }
      }
    }

    // When debugging, you can uncomment this line to dump the data structure
    // to the console:
    // localProjectPackage.printTree();

    LinkManager._createSymlinksForTopLevelProject(localProjectPackage);

    // Also symlink the ".bin" folder
    if (localProjectPackage.children.length > 0) {
      const commonBinFolder: string = path.join(this._rushConfiguration.commonTempFolder, 'node_modules', '.bin');
      const projectBinFolder: string = path.join(localProjectPackage.folderPath, 'node_modules', '.bin');

      if (fsx.existsSync(commonBinFolder)) {
        LinkManager._createSymlink(commonBinFolder, projectBinFolder, SymlinkKind.Directory);
      }
    }
  }
}
