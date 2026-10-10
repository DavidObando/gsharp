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
/// translated and ALSO copied. Includes that cannot be resolved statically
/// (unknown MSBuild properties) and could name <c>.cs</c> files are reported
/// as warnings rather than guessed at.
/// </para>
/// </remarks>
internal static class RepositoryVerbatimSources
{
    private static readonly string[] ProjectExtensions = { ".csproj", ".gsproj", ".props", ".targets" };

    /// <summary>Computes the repository-relative ('/'-separated) <c>.cs</c> files copied verbatim.</summary>
    /// <param name="sourceRoot">The repository source root.</param>
    /// <param name="inventory">The repository inventory ('/'-separated, root-relative).</param>
    /// <param name="warnings">Receives unresolvable-include warnings, or <see langword="null"/> to ignore them.</param>
    /// <returns>The set of <c>.cs</c> paths, case-insensitive.</returns>
    internal static ISet<string> Compute(
        string sourceRoot,
        IReadOnlyList<string> inventory,
        ICollection<string> warnings = null)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string[] csharpFiles = inventory
            .Where(path => Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (csharpFiles.Length == 0)
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
                document = XDocument.Load(Path.Combine(root, projectPath.Replace('/', Path.DirectorySeparatorChar)));
            }
            catch (Exception ex) when (ex is System.Xml.XmlException or IOException)
            {
                continue;
            }

            bool translatedProject = !Path.GetExtension(projectPath).Equals(".gsproj", StringComparison.OrdinalIgnoreCase);
            string directory = DirectoryOf(projectPath);
            var removed = new Dictionary<string, List<Regex>>(StringComparer.OrdinalIgnoreCase);
            var included = new List<(string ItemName, XElement Item, string Pattern)>();
            foreach (XElement item in document.Descendants().Where(e =>
                e.Parent is not null
                && e.Parent.Name.LocalName.Equals("ItemGroup", StringComparison.OrdinalIgnoreCase)))
            {
                string itemName = item.Name.LocalName;
                string removePattern = item.Attribute("Remove")?.Value;
                if (removePattern is not null)
                {
                    foreach (Regex remove in Patterns(removePattern, directory, null))
                    {
                        if (!removed.TryGetValue(itemName, out List<Regex> list))
                        {
                            removed[itemName] = list = new List<Regex>();
                        }

                        list.Add(remove);
                    }
                }

                foreach (string attribute in new[] { "Include", "Update" })
                {
                    string value = item.Attribute(attribute)?.Value;
                    if (value is not null)
                    {
                        included.Add((itemName, item, value));
                    }
                }
            }

            foreach ((string itemName, XElement item, string pattern) in included)
            {
                if (translatedProject && itemName.Equals("Compile", StringComparison.OrdinalIgnoreCase))
                {
                    // Compiled by a translated project: the translation owns it.
                    continue;
                }

                List<string> unresolved = warnings is null ? null : new List<string>();
                Regex[] includes = Patterns(pattern, directory, unresolved).ToArray();
                Regex[] excludes = Patterns(item.Attribute("Exclude")?.Value, directory, null).ToArray();
                removed.TryGetValue(itemName, out List<Regex> removes);
                foreach (string file in csharpFiles)
                {
                    if (includes.Any(r => r.IsMatch(file))
                        && !excludes.Any(r => r.IsMatch(file))
                        && removes?.Any(r => r.IsMatch(file)) != true)
                    {
                        result.Add(file);
                    }
                }

                if (unresolved is { Count: > 0 })
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
            string text = raw.Trim()
                .Replace("$(MSBuildThisFileDirectory)", projectDirectory.Length == 0 ? string.Empty : projectDirectory + "/", StringComparison.OrdinalIgnoreCase)
                .Replace("$(MSBuildProjectDirectory)", projectDirectory, StringComparison.OrdinalIgnoreCase)
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
}
