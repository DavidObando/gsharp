// <copyright file="GSharpProjectTransformer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Pipeline;

/// <summary>Transforms a C# project document for use by the G# SDK.</summary>
internal static class GSharpProjectTransformer
{
    private static readonly Regex CSharpSpecSuffix = new Regex(
        "\\.cs(?=\\s*(?:;|$))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>
    /// Loads a source project while preserving whitespace and rewrites only
    /// the portions that differ for its generated G# project.
    /// </summary>
    /// <param name="sourceProjectPath">The source <c>.csproj</c> path.</param>
    /// <param name="destinationProjectDirectory">The directory that will contain the generated project.</param>
    /// <param name="gsharpSdk">The complete G# SDK value, including any version suffix.</param>
    /// <param name="generatedProjectPaths">
    /// Canonical source-project paths mapped to their generated project paths.
    /// </param>
    /// <returns>The transformed project document.</returns>
    internal static XDocument Transform(
        string sourceProjectPath,
        string destinationProjectDirectory,
        string gsharpSdk,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (sourceProjectPath is null)
        {
            throw new ArgumentNullException(nameof(sourceProjectPath));
        }

        if (destinationProjectDirectory is null)
        {
            throw new ArgumentNullException(nameof(destinationProjectDirectory));
        }

        if (gsharpSdk is null)
        {
            throw new ArgumentNullException(nameof(gsharpSdk));
        }

        string projectXml = File.ReadAllText(sourceProjectPath);
        if (NerdbankGitVersioningPolicy.TryBumpProjectXml(projectXml, out string bumpedProjectXml))
        {
            projectXml = bumpedProjectXml;
        }

        XDocument document = XDocument.Parse(projectXml, LoadOptions.PreserveWhitespace);
        document.Root.SetAttributeValue("Sdk", gsharpSdk);

        string sourceProjectDirectory = Path.GetDirectoryName(Path.GetFullPath(sourceProjectPath));
        string fullDestinationDirectory = Path.GetFullPath(destinationProjectDirectory);

        RewriteProjectReferences(
            document,
            sourceProjectDirectory,
            fullDestinationDirectory,
            generatedProjectPaths);
        RewriteOutputType(document);
        RewriteCompileItems(document);
        RewriteCSharpMetadata(document);

        return document;
    }

    private static void RewriteProjectReferences(
        XDocument document,
        string sourceProjectDirectory,
        string destinationProjectDirectory,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (generatedProjectPaths is null || generatedProjectPaths.Count == 0)
        {
            return;
        }

        foreach (XElement projectReference in ElementsNamed(document, "ProjectReference"))
        {
            XAttribute include = AttributeNamed(projectReference, "Include");
            if (include is null ||
                string.IsNullOrWhiteSpace(include.Value))
            {
                continue;
            }

            if (TryRewriteExpression(include))
            {
                continue;
            }

            string sourceReferencePath = Path.GetFullPath(
                Path.Combine(sourceProjectDirectory, NormalizeDirectorySeparators(include.Value)));
            if (!generatedProjectPaths.TryGetValue(sourceReferencePath, out string generatedProjectPath))
            {
                continue;
            }

            include.Value = Path.GetRelativePath(
                    destinationProjectDirectory,
                    Path.GetFullPath(generatedProjectPath))
                .Replace('\\', '/');
        }
    }

    private static void RewriteOutputType(XDocument document)
    {
        foreach (XElement outputType in ElementsNamed(document, "OutputType"))
        {
            if (outputType.Value.Trim().Equals("WinExe", StringComparison.OrdinalIgnoreCase))
            {
                outputType.Value = "Exe";
            }
        }
    }

    private static void RewriteCompileItems(XDocument document)
    {
        foreach (XElement compile in ElementsNamed(document, "Compile"))
        {
            foreach (string attributeName in new[] { "Include", "Update", "Remove" })
            {
                XAttribute attribute = AttributeNamed(compile, attributeName);
                if (attribute is not null)
                {
                    attribute.Value = RewriteCSharpSpecs(attribute.Value);
                }
            }
        }
    }

    private static void RewriteCSharpMetadata(XDocument document)
    {
        foreach (XElement metadata in document.Descendants().Where(
            element =>
                element.Name.LocalName.Equals("LastGenOutput", StringComparison.OrdinalIgnoreCase) ||
                element.Name.LocalName.Equals("DependentUpon", StringComparison.OrdinalIgnoreCase)))
        {
            metadata.Value = RewriteCSharpSpecs(metadata.Value);
        }
    }

    private static IEnumerable<XElement> ElementsNamed(XDocument document, string localName) =>
        document.Descendants().Where(
            element => element.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));

    private static XAttribute AttributeNamed(XElement element, string localName) =>
        element.Attributes().FirstOrDefault(
            attribute => attribute.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));

    private static string RewriteCSharpSpecs(string value) =>
        CSharpSpecSuffix.Replace(value, ".gs");

    private static bool TryRewriteExpression(XAttribute include)
    {
        string value = include.Value;
        if (!value.Contains("$(", StringComparison.Ordinal) &&
            !value.Contains("@(", StringComparison.Ordinal) &&
        !value.Contains(';'))
        {
            return false;
        }

        string[] specs = value.Split(';');
        bool changed = false;
        for (int i = 0; i < specs.Length; i++)
        {
            string rewritten = RewriteExpressionSpec(specs[i]);
            changed |= !string.Equals(specs[i], rewritten, StringComparison.Ordinal);
            specs[i] = rewritten;
        }

        if (changed)
        {
            include.Value = string.Join(";", specs);
        }

        return changed;
    }

    private static string RewriteExpressionSpec(string spec)
    {
        int start = 0;
        while (start < spec.Length && char.IsWhiteSpace(spec[start]))
        {
            start++;
        }

        if (start == spec.Length)
        {
            return spec;
        }

        int end = spec.Length - 1;
        while (end >= start && char.IsWhiteSpace(spec[end]))
        {
            end--;
        }

        string leading = spec.Substring(0, start);
        string trailing = spec.Substring(end + 1);
        string value = spec.Substring(start, end - start + 1);
        if (value.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            value = value.Substring(0, value.Length - ".csproj".Length) + ".gsproj";
        }
        else if (value.StartsWith("@(", StringComparison.Ordinal) &&
            value.EndsWith(")", StringComparison.Ordinal))
        {
            value = value.Substring(0, value.Length - 1) +
                "->'%(RootDir)%(Directory)%(Filename).gsproj')";
        }
        else if (value.StartsWith("$(", StringComparison.Ordinal) &&
            value.EndsWith(")", StringComparison.Ordinal))
        {
            value = "$([System.IO.Path]::ChangeExtension('" + value + "', '.gsproj'))";
        }

        return leading + value + trailing;
    }

    private static string NormalizeDirectorySeparators(string path) =>
        path.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
}
