// <copyright file="DeclaredProjectItem.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

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
