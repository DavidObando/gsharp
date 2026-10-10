// <copyright file="RepositoryVerbatimSources.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #4850: the single decision point for which checked-in <c>.cs</c>
/// files a repository mirror carries VERBATIM instead of translating.
/// </summary>
/// <remarks>
/// <para>
/// A <c>.cs</c> file is translated when a translated project compiles it, or,
/// failing that, as an orphan. That is wrong for a <c>.cs</c> file a project
/// references as DATA or as foreign input rather than as source it compiles:
/// a <c>None</c>/<c>Content</c>/<c>EmbeddedResource</c> item (translation-test
/// fixtures a test reads as text) or a <c>Compile</c> item of an already-G#
/// project (<c>ForeignCompile.gsproj</c> lists <c>ThisAssembly.cs</c> for the
/// SDK to translate at build time). Translating those silently rewrites the
/// data and leaves the project pointing at a file the mirror no longer has.
/// </para>
/// <para>
/// The rule: a <c>.cs</c> file matched by any item of a repository project file
/// other than a <c>Compile</c> item of a translated (<c>.csproj</c>, shared
/// <c>.props</c>/<c>.targets</c>) project is copied verbatim. A file that is
/// both (compiled by a translated project AND referenced as data) is
/// translated and ALSO copied. Item operations are applied in document order
/// per item type, as MSBuild does. Includes that cannot be resolved statically
/// (unknown MSBuild properties) and explicitly name <c>.cs</c> files are
/// reported as warnings rather than guessed at.
/// </para>
/// </remarks>
internal static class RepositoryVerbatimSources
{
    private static readonly string[] ProjectExtensions = { ".csproj", ".gsproj", ".props", ".targets" };

    /// <summary>Computes the <c>.cs</c> inventory entries copied verbatim.</summary>
    /// <param name="sourceRoot">The repository source root.</param>
    /// <param name="inventory">The repository inventory (root-relative paths).</param>
    /// <param name="warnings">Receives unresolvable-include warnings, or <see langword="null"/> to ignore them.</param>
    /// <returns>The matching inventory entries, spelled as in <paramref name="inventory"/>, case-insensitive.</returns>
    internal static ISet<string> Compute(
        string sourceRoot,
        IReadOnlyList<string> inventory,
        ICollection<string> warnings = null)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Matching runs over '/'-separated paths; the result keeps the inventory's
        // own spelling, which is what callers use for set membership.
        var csharpFiles = new List<(string Normalized, string Original)>();
        foreach (string path in inventory)
        {
            if (Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase))
            {
                csharpFiles.Add((path.Replace('\\', '/'), path));
            }
        }

        if (csharpFiles.Count == 0)
        {
            return result;
        }

        string root = Path.GetFullPath(sourceRoot);
        foreach (string projectPath in inventory.Where(path =>
            ProjectExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)))
        {
            XDocument document;
            try
            {
                document = XDocument.Load(Path.Combine(root, projectPath.Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar)));
            }
            catch (Exception ex) when (ex is System.Xml.XmlException or IOException)
            {
                continue;
            }

            bool translatedProject = !Path.GetExtension(projectPath).Equals(".gsproj", StringComparison.OrdinalIgnoreCase);
            string directory = DirectoryOf(projectPath.Replace('\\', '/'));

            // MSBuild evaluates item operations in document order per item
            // type, so a later Include can re-add what an earlier Remove took.
            var operations = new Dictionary<string, List<ItemOperation>>(StringComparer.OrdinalIgnoreCase);
            foreach (XElement item in document.Descendants().Where(e =>
                e.Parent is not null
                && e.Parent.Name.LocalName.Equals("ItemGroup", StringComparison.OrdinalIgnoreCase)))
            {
                string itemName = item.Name.LocalName;
                if (translatedProject && itemName.Equals("Compile", StringComparison.OrdinalIgnoreCase))
                {
                    // Compiled by a translated project: the translation owns it.
                    continue;
                }

                if (!operations.TryGetValue(itemName, out List<ItemOperation> list))
                {
                    operations[itemName] = list = new List<ItemOperation>();
                }

                string remove = item.Attribute("Remove")?.Value;
                if (remove is not null)
                {
                    list.Add(new ItemOperation(true, Patterns(remove, directory, null).ToArray(), Array.Empty<Regex>()));
                }

                foreach (string attribute in new[] { "Include", "Update" })
                {
                    string value = item.Attribute(attribute)?.Value;
                    if (value is null)
                    {
                        continue;
                    }

                    List<string> unresolved = warnings is null ? null : new List<string>();
                    list.Add(new ItemOperation(
                        false,
                        Patterns(value, directory, unresolved).ToArray(),
                        Patterns(item.Attribute("Exclude")?.Value, directory, null).ToArray()));
                    if (unresolved is not null)
                    {
                        foreach (string text in unresolved)
                        {
                            warnings.Add(
                                $"'{projectPath}' {itemName} item '{text}' uses an MSBuild expression this " +
                                "mirror cannot resolve; if it names .cs files they will be translated, not copied.");
                        }
                    }
                }
            }

            foreach (List<ItemOperation> list in operations.Values)
            {
                foreach ((string normalized, string original) in csharpFiles)
                {
                    bool referenced = false;
                    foreach (ItemOperation operation in list)
                    {
                        if (!operation.Matches.Any(r => r.IsMatch(normalized)))
                        {
                            continue;
                        }

                        // Exclude only stops THIS Include from adding the file; an
                        // earlier item that already added it still stands.
                        if (operation.Remove)
                        {
                            referenced = false;
                        }
                        else if (!operation.Excludes.Any(r => r.IsMatch(normalized)))
                        {
                            referenced = true;
                        }
                    }

                    if (referenced)
                    {
                        result.Add(original);
                    }
                }
            }
        }

        return result;
    }

    private static IEnumerable<Regex> Patterns(
        string itemValue,
        string projectDirectory,
        ICollection<string> unresolved)
    {
        if (string.IsNullOrWhiteSpace(itemValue))
        {
            yield break;
        }

        foreach (string raw in itemValue.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            // The two directory anchors resolve to the file's own directory,
            // which Resolve prepends once below; substituting the directory
            // here too would duplicate it.
            string text = raw.Trim()
                .Replace("$(MSBuildThisFileDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("$(MSBuildProjectDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace('\\', '/');
            if (text.Contains("$(", StringComparison.Ordinal)
                || text.Contains("@(", StringComparison.Ordinal)
                || text.Contains("%(", StringComparison.Ordinal))
            {
                // Only worth a warning when the text explicitly names C# sources;
                // a bare `$(PublishDir)**\*` payload glob is build output.
                if (unresolved is not null && text.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                {
                    unresolved.Add(raw.Trim());
                }

                continue;
            }

            string resolved = Resolve(projectDirectory, text);
            if (resolved is null)
            {
                continue;
            }

            yield return GlobToRegex(resolved);
        }
    }

    private static string Resolve(string projectDirectory, string path)
    {
        var segments = new List<string>(
            projectDirectory.Split('/', StringSplitOptions.RemoveEmptyEntries));
        foreach (string segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (segment == ".")
            {
                continue;
            }

            if (segment == "..")
            {
                if (segments.Count == 0)
                {
                    return null;
                }

                segments.RemoveAt(segments.Count - 1);
                continue;
            }

            segments.Add(segment);
        }

        return string.Join('/', segments);
    }

    private static Regex GlobToRegex(string glob)
    {
        var pattern = new StringBuilder("^");
        for (int i = 0; i < glob.Length; i++)
        {
            char c = glob[i];
            if (c == '*' && i + 1 < glob.Length && glob[i + 1] == '*')
            {
                bool followedBySlash = i + 2 < glob.Length && glob[i + 2] == '/';
                pattern.Append(followedBySlash ? "(?:.*/)?" : ".*");
                i += followedBySlash ? 2 : 1;
            }
            else if (c == '*')
            {
                pattern.Append("[^/]*");
            }
            else if (c == '?')
            {
                pattern.Append("[^/]");
            }
            else
            {
                pattern.Append(Regex.Escape(c.ToString()));
            }
        }

        pattern.Append('$');
        return new Regex(pattern.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static string DirectoryOf(string relativePath)
    {
        int separator = relativePath.LastIndexOf('/');
        return separator < 0 ? string.Empty : relativePath.Substring(0, separator);
    }

    private sealed record ItemOperation(bool Remove, Regex[] Matches, Regex[] Excludes);
}
