// <copyright file="RepositoryExcludedScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Xml.Linq

/// Issue #3580: the checked-in sources a targeted run's `--exclude`
/// removed from scope. The repository-mirror completeness contract (orphan
/// translation and (cref:RepositoryMirror.ValidateCompleted)) applies
/// only to in-scope files — out-of-scope sources are not orphans and have no
/// mirrors to validate. Project files require explicit membership.
/// The source scope is each excluded project's own directory
/// plus any explicit non-wildcard `<Compile Include>` item
/// resolving inside the repository (shared linked sources such as
/// `test/Shared/*` live outside every project directory).
internal class RepositoryExcludedScope {
    private let directories List[string]
    private let compileFiles HashSet[string]

    private init(directories List[string], compileFiles HashSet[string]) {
        this.directories = directories
        this.compileFiles = compileFiles
    }

    /// Returns whether a repository-relative ('/'-separated) source path is
    /// out of the run's scope.
    /// @param relativePath The repository-relative source path.
    /// @returns `true` when the file belongs to an excluded project.
    internal func IsExcluded(relativePath string?) bool {
        if this.compileFiles.Contains(relativePath!!) {
            return true
        }
        // Sibling projects own their project files independently of source-directory ownership.
        if string.Equals(Path.GetExtension(relativePath), ".csproj", StringComparison.OrdinalIgnoreCase) {
            return false
        }
        for directory in this.directories {
            if relativePath!!.StartsWith(directory + "/", StringComparison.OrdinalIgnoreCase) {
                return true
            }
        }
        return false
    }

    shared {
        /// An empty scope: every repository file is in scope.
        internal let None RepositoryExcludedScope = RepositoryExcludedScope(
            List[string](),
            HashSet[string](StringComparer.OrdinalIgnoreCase)
        )

        /// Computes the excluded scope for the given projects.
        /// @param sourceRoot The migrated repository's source root.
        /// @param excludedProjectPaths Absolute `.csproj` paths excluded from the run, or `null`.
        /// @param evaluatedCompileSources Evaluated compile-source paths keyed by project path.
        /// @returns The derived scope; (cref:None) when nothing was excluded.
        internal func Compute(
            sourceRoot string?,
            excludedProjectPaths IReadOnlyCollection[string]?,
            evaluatedCompileSources IReadOnlyDictionary[string, IReadOnlyList[string]]? = nil
        ) RepositoryExcludedScope {
            if excludedProjectPaths == nil || excludedProjectPaths.Count == 0 {
                return None
            }
            let directories = List[string]()
            let compileFiles = HashSet[string](StringComparer.OrdinalIgnoreCase)
            let fullSourceRoot = Path.GetFullPath(sourceRoot!!)
            let AddFileWithinRoot = func (path string) {
                let relativePath = Path.GetRelativePath(fullSourceRoot, Path.GetFullPath(path)).Replace('\\', '/')
                if !relativePath.StartsWith("..", StringComparison.Ordinal) {
                    compileFiles.Add(relativePath)
                }
            }
            for projectPath in excludedProjectPaths {
                let fullProjectPath = Path.GetFullPath(projectPath)
                let projectDirectory string? = Path.GetDirectoryName(fullProjectPath)
                AddFileWithinRoot(fullProjectPath)
                let relativeDirectory = Path.GetRelativePath(fullSourceRoot, projectDirectory!!).Replace('\\', '/')
                if relativeDirectory.Length > 0 && relativeDirectory != "." && !relativeDirectory.StartsWith(
                    "..",
                    StringComparison.Ordinal
                ) {
                    directories.Add(relativeDirectory)
                }
                for item in DeclaredProjectItems.Read(projectPath, "Compile") {
                    let include string? = item.Element.Attribute(XName?("Include")!!)?.Value
                    if string.IsNullOrEmpty(include) || DeclaredProjectItems.HasMsbuildExpressionInclude(item) ||
                        include!!.Contains('*', StringComparison.Ordinal) {
                        continue
                    }
                    let fullInclude = Path.GetFullPath(
                        Path.Combine(
                            projectDirectory!!,
                            include!!.Replace('\\', Path.DirectorySeparatorChar).Replace(
                                '/',
                                Path.DirectorySeparatorChar
                            )
                        )
                    )
                    let relativeInclude = Path.GetRelativePath(fullSourceRoot, fullInclude).Replace('\\', '/')
                    if !relativeInclude.StartsWith("..", StringComparison.Ordinal) {
                        compileFiles.Add(relativeInclude)
                    }
                }
                if evaluatedCompileSources != nil && evaluatedCompileSources.TryGetValue(
                    fullProjectPath,
                    out var evaluatedSources
                ) {
                    for evaluatedSource in evaluatedSources {
                        AddFileWithinRoot(evaluatedSource)
                    }
                }
            }
            return RepositoryExcludedScope(directories, compileFiles)
        }
    }
}
