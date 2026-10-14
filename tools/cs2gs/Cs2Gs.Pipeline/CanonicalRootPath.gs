// <copyright file="CanonicalRootPath.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.IO

/// Resolves a migration root to its real, symlink-free absolute path
/// (issue #3732).
///
/// (cref:Path.GetFullPath(string)) normalizes `.`/`..` and
/// makes a path absolute, but it does NOT follow symbolic links, so a root
/// given as `/tmp/…` on macOS (where `/tmp` and `$TMPDIR` are
/// both links) stays spelled through the link. Every path the pipeline derives
/// from that root — the mirrored `.gsproj` files and the
/// `ProjectReference` paths between them — then inherits that spelling,
/// while MSBuild/NuGet reach the same files through their real path. NuGet
/// keys restore graph nodes by absolute path, so the two spellings become two
/// nodes: the referencing project's `project.assets.json` comes back with
/// an EMPTY `projectReferences`/`libraries` set and none of the
/// referenced project's packages flow to it.
///
/// C# survives that silently — `csc` only needs the assemblies a
/// compilation actually names — but `gsc` reads referenced assemblies
/// through a (cref:System.Reflection.MetadataLoadContext), which must
/// resolve the whole `AssemblyRef` closure of every reference. A package
/// that a referenced project uses only inside a method body is therefore
/// mandatory for gsc and absent from csc's needs, and the split root surfaces
/// as `GS9997 Could not find assembly '<package>'` on exactly the
/// projects whose only route to that package is a `ProjectReference`.
///
/// The gate scripts already canonicalize their work root with `pwd -P`
/// (`build/run-cs2gs-selfmig-migrate.sh`); this does the same for a
/// hand-run `cs2gs migrate --out /tmp/…` / `cs2gs validate
/// --migrated /tmp/…`, which is the documented reproduction recipe.
shared class CanonicalRootPath {
    /// Returns [`path`](paramref) as an absolute path with every existing
    /// directory/file component resolved through its symbolic links.
    /// Components that do not exist yet (a not-yet-created `--out`
    /// destination) are appended verbatim, and any resolution failure degrades
    /// to (cref:Path.GetFullPath(string)) — a root that cannot be
    /// canonicalized must not fail the run.
    /// @param path The user-supplied root, absolute or relative.
    /// @returns The canonical absolute path, or [`path`](paramref) unchanged when it is null or empty.
    func Resolve(path string?) string? {
        if string.IsNullOrEmpty(path) {
            return path
        }
        let full = Path.GetFullPath(path)
        try {
            let root = Path.GetPathRoot(full)
            if string.IsNullOrEmpty(root) {
                return full
            }
            var current = root
            for segment in full.Substring(root.Length).Split(
                []char{Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar},
                StringSplitOptions.RemoveEmptyEntries
            ) {
                current = Path.Combine(current, segment)
                current = ResolveComponent(current)
            }
            return current
        } catch (exception Exception) when exception is IOException ||
            exception is UnauthorizedAccessException ||
            exception is NotSupportedException ||
            exception is ArgumentException {
            return full
        }
    }

    private func ResolveComponent(component string) string {
        // ResolveLinkTarget throws when the component does not exist, and
        // returns null when it exists but is not a link — both mean "keep the
        // spelling we already have".
        var target FileSystemInfo? = nil
        if Directory.Exists(component) {
            target = Directory.ResolveLinkTarget(component, returnFinalTarget: true)
        } else if File.Exists(component) {
            target = File.ResolveLinkTarget(component, returnFinalTarget: true)
        }
        if target == nil {
            return component
        }
        return if Path.IsPathRooted(target.FullName) {
            target.FullName
        } else {
            Path.GetFullPath(Path.Combine(Path.GetDirectoryName(component) ?? string.Empty, target.FullName))
        }
    }
}
