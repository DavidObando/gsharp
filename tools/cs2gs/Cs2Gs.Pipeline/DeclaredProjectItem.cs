// <copyright file="DeclaredProjectItem.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Pipeline;

/// <summary>
/// A declared MSBuild item copied from a source project into its generated
/// G# project, including item-group conditions and all item metadata.
/// </summary>
public sealed class DeclaredProjectItem
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DeclaredProjectItem"/> class.
    /// </summary>
    /// <param name="itemGroupCondition">The containing ItemGroup condition.</param>
    /// <param name="element">The namespace-free item XML.</param>
    /// <param name="sourceInclude">The absolute source ProjectReference target.</param>
    public DeclaredProjectItem(string itemGroupCondition, XElement element, string sourceInclude = null)
    {
        this.ItemGroupCondition = itemGroupCondition;
        this.Element = element ?? throw new ArgumentNullException(nameof(element));
        this.SourceInclude = sourceInclude;
    }

    /// <summary>Gets the containing ItemGroup condition, or <see langword="null"/>.</summary>
    public string ItemGroupCondition { get; }

    /// <summary>Gets the namespace-free item XML.</summary>
    public XElement Element { get; }

    /// <summary>Gets the absolute source ProjectReference target, when applicable.</summary>
    public string SourceInclude { get; }
}

/// <summary>Reads and rewrites declared project dependency items.</summary>
internal static class DeclaredProjectItems
{
    internal static IReadOnlyList<DeclaredProjectItem> Read(string projectPath, string itemName)
    {
        if (string.IsNullOrEmpty(projectPath) || !File.Exists(projectPath))
        {
            return Array.Empty<DeclaredProjectItem>();
        }

        XDocument document = XDocument.Load(projectPath, LoadOptions.PreserveWhitespace);
        string projectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectPath));
        var items = new List<DeclaredProjectItem>();
        foreach (XElement itemGroup in document.Descendants().Where(
            e => e.Name.LocalName.Equals("ItemGroup", StringComparison.OrdinalIgnoreCase)))
        {
            string groupCondition = itemGroup.Attribute("Condition")?.Value;
            foreach (XElement item in itemGroup.Elements().Where(
                e => e.Name.LocalName.Equals(itemName, StringComparison.OrdinalIgnoreCase)))
            {
                XElement clone = StripNamespaces(item);
                string sourceInclude = null;
                if (itemName.Equals("ProjectReference", StringComparison.OrdinalIgnoreCase))
                {
                    string include = item.Attribute("Include")?.Value;
                    if (!string.IsNullOrEmpty(include) && !include.Contains("$(", StringComparison.Ordinal))
                    {
                        sourceInclude = Path.GetFullPath(Path.Combine(projectDirectory, include));
                    }
                }

                items.Add(new DeclaredProjectItem(groupCondition, clone, sourceInclude));
            }
        }

        return items;
    }

    internal static IReadOnlyList<string> ProjectReferencePaths(string projectPath) =>
        Read(projectPath, "ProjectReference")
            .Select(item => item.SourceInclude)
            .Where(path => !string.IsNullOrEmpty(path))
            .ToList();

    /// <summary>
    /// Bumps a below-floor literal <c>Version</c> attribute on a declared
    /// <c>Nerdbank.GitVersioning</c> <c>PackageReference</c> item (issue #2319,
    /// following #2225/#2267). When the source project's own <c>.csproj</c>
    /// declares nbgv directly — rather than via an ancestor
    /// <c>Directory.Build.props</c>/<c>Directory.Packages.props</c> split, the
    /// shape <see cref="TranslateStage.EmitNerdbankGitVersioningBumps"/>'s
    /// <see cref="StageExecutionContext.BuildOnlyPackageReferences"/> path
    /// exists to recover — this same declared item is what
    /// <c>SdkCompileRunner.BuildProjectXml</c>'s declared-item passthrough
    /// re-emits <b>verbatim</b> into the generated <c>.gsproj</c>. Without this
    /// rewrite the below-floor version silently survives into the isolated
    /// build and nbgv never emits the G# <c>ThisAssembly</c> source. Every
    /// other declared <c>PackageReference</c> item (including nbgv items that
    /// are already at or above the floor, or carry a non-literal version this
    /// policy cannot safely reason about) is returned unchanged — this never
    /// touches ordinary package references, and a CPM project's own
    /// versionless nbgv <c>PackageReference</c> has no <c>Version</c> attribute
    /// to bump in the first place, so CPM behavior is unaffected.
    /// </summary>
    /// <param name="items">The declared <c>PackageReference</c> items read from the source project.</param>
    /// <returns>
    /// <paramref name="items"/> unchanged when no item needs bumping, otherwise
    /// an equivalent list with the nbgv item's <c>Version</c> attribute bumped.
    /// </returns>
    internal static IReadOnlyList<DeclaredProjectItem> BumpNerdbankGitVersioningVersion(
        IReadOnlyList<DeclaredProjectItem> items)
    {
        if (items is null || items.Count == 0)
        {
            return items ?? Array.Empty<DeclaredProjectItem>();
        }

        List<DeclaredProjectItem> rewritten = null;
        for (int i = 0; i < items.Count; i++)
        {
            DeclaredProjectItem item = items[i];
            string include = item.Element.Attribute("Include")?.Value;
            string version = item.Element.Attribute("Version")?.Value;
            bool isNbgv = string.Equals(
                include, NerdbankGitVersioningPolicy.PackageId, StringComparison.OrdinalIgnoreCase);
            if (!isNbgv || !NerdbankGitVersioningPolicy.TryGetRequiredBump(version, out string bumped))
            {
                rewritten?.Add(item);
                continue;
            }

            // First bump found: materialize the prefix of untouched items so
            // the returned list mirrors the input verbatim up to this point.
            rewritten ??= new List<DeclaredProjectItem>(items.Take(i));
            var element = new XElement(item.Element);
            element.SetAttributeValue("Version", bumped);
            rewritten.Add(new DeclaredProjectItem(item.ItemGroupCondition, element, item.SourceInclude));
        }

        return rewritten ?? items;
    }

    internal static IReadOnlyList<DeclaredProjectItem> RewriteProjectReferences(
        IReadOnlyList<DeclaredProjectItem> items,
        string generatedProjectDirectory,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        var rewritten = new List<DeclaredProjectItem>();
        foreach (DeclaredProjectItem item in items ?? Array.Empty<DeclaredProjectItem>())
        {
            XElement element = new XElement(item.Element);
            string targetPath = item.SourceInclude;
            if (!string.IsNullOrEmpty(targetPath) &&
                generatedProjectPaths is not null &&
                generatedProjectPaths.TryGetValue(Path.GetFullPath(targetPath), out string generatedPath))
            {
                targetPath = generatedPath;
            }

            if (!string.IsNullOrEmpty(targetPath))
            {
                element.SetAttributeValue("Include", Path.GetRelativePath(generatedProjectDirectory, targetPath));
            }

            rewritten.Add(new DeclaredProjectItem(item.ItemGroupCondition, element, item.SourceInclude));
        }

        return rewritten;
    }

    private static XElement StripNamespaces(XElement element) =>
        new XElement(
            element.Name.LocalName,
            element.Attributes()
                .Where(attribute => !attribute.IsNamespaceDeclaration)
                .Select(attribute => new XAttribute(attribute.Name.LocalName, attribute.Value)),
            element.Nodes().Select(node => node is XElement child ? StripNamespaces(child) : node));
}
