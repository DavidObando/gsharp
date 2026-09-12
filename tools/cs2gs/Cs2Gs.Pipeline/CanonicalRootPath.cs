// <copyright file="CanonicalRootPath.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Resolves a migration root to its real, symlink-free absolute path
/// (issue #3732).
/// <para>
/// <see cref="Path.GetFullPath(string)"/> normalizes <c>.</c>/<c>..</c> and
/// makes a path absolute, but it does NOT follow symbolic links, so a root
/// given as <c>/tmp/…</c> on macOS (where <c>/tmp</c> and <c>$TMPDIR</c> are
/// both links) stays spelled through the link. Every path the pipeline derives
/// from that root — the mirrored <c>.gsproj</c> files and the
/// <c>ProjectReference</c> paths between them — then inherits that spelling,
/// while MSBuild/NuGet reach the same files through their real path. NuGet
/// keys restore graph nodes by absolute path, so the two spellings become two
/// nodes: the referencing project's <c>project.assets.json</c> comes back with
/// an EMPTY <c>projectReferences</c>/<c>libraries</c> set and none of the
/// referenced project's packages flow to it.
/// </para>
/// <para>
/// C# survives that silently — <c>csc</c> only needs the assemblies a
/// compilation actually names — but <c>gsc</c> reads referenced assemblies
/// through a <see cref="System.Reflection.MetadataLoadContext"/>, which must
/// resolve the whole <c>AssemblyRef</c> closure of every reference. A package
/// that a referenced project uses only inside a method body is therefore
/// mandatory for gsc and absent from csc's needs, and the split root surfaces
/// as <c>GS9997 Could not find assembly '&lt;package&gt;'</c> on exactly the
/// projects whose only route to that package is a <c>ProjectReference</c>.
/// </para>
/// <para>
/// The gate scripts already canonicalize their work root with <c>pwd -P</c>
/// (<c>build/run-cs2gs-selfmig-migrate.sh</c>); this does the same for a
/// hand-run <c>cs2gs migrate --out /tmp/…</c> / <c>cs2gs validate
/// --migrated /tmp/…</c>, which is the documented reproduction recipe.
/// </para>
/// </summary>
public static class CanonicalRootPath
{
    /// <summary>
    /// Returns <paramref name="path"/> as an absolute path with every existing
    /// directory/file component resolved through its symbolic links.
    /// Components that do not exist yet (a not-yet-created <c>--out</c>
    /// destination) are appended verbatim, and any resolution failure degrades
    /// to <see cref="Path.GetFullPath(string)"/> — a root that cannot be
    /// canonicalized must not fail the run.
    /// </summary>
    /// <param name="path">The user-supplied root, absolute or relative.</param>
    /// <returns>The canonical absolute path, or <paramref name="path"/> unchanged when it is null or empty.</returns>
    public static string Resolve(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return path;
        }

        string full = Path.GetFullPath(path);
        try
        {
            string root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root))
            {
                return full;
            }

            string current = root;
            foreach (string segment in full.Substring(root.Length).Split(
                new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                current = ResolveComponent(current);
            }

            return current;
        }
        catch (Exception exception) when (
            exception is IOException
                or UnauthorizedAccessException
                or NotSupportedException
                or ArgumentException)
        {
            return full;
        }
    }

    private static string ResolveComponent(string component)
    {
        // ResolveLinkTarget throws when the component does not exist, and
        // returns null when it exists but is not a link — both mean "keep the
        // spelling we already have".
        FileSystemInfo target = null;
        if (Directory.Exists(component))
        {
            target = Directory.ResolveLinkTarget(component, returnFinalTarget: true);
        }
        else if (File.Exists(component))
        {
            target = File.ResolveLinkTarget(component, returnFinalTarget: true);
        }

        if (target is null)
        {
            return component;
        }

        return Path.IsPathRooted(target.FullName)
            ? target.FullName
            : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(component) ?? string.Empty, target.FullName));
    }
}
