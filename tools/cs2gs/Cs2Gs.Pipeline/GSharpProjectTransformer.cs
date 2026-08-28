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
    // ADR-0169: the MSBuild expression that anchors a compiler-hosted
    // reference (an assembly supplied at runtime by the gsc host, never copied
    // to the app's own output) at the compiler's directory. Kept as the single
    // source of truth for both the injection (RewriteAnalyzerProject) and the
    // stage-3 resolution (ResolveCompilerHostedReferences, issue #3608).
    private const string CompilerDirectoryExpression =
        "$([System.IO.Path]::GetDirectoryName('$(GsharpCompilerFullPath)'))";

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
        string sourceSdk = document.Root.Attribute("Sdk")?.Value;
        document.Root.SetAttributeValue("Sdk", gsharpSdk);
        AddSourceSdkDefaults(document, sourceSdk);

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
        RewriteAnalyzerProject(document);
        RewriteAnalyzerConsumerReferences(document);

        return document;
    }

    /// <summary>
    /// Resolves a transformed project's compiler-hosted <c>Reference</c>
    /// entries — those whose <c>HintPath</c> is anchored at the compiler's
    /// directory via <see cref="CompilerDirectoryExpression"/> (e.g. the
    /// G# analyzer API assembly injected by <c>RewriteAnalyzerProject</c>) —
    /// against a concrete <c>gsc</c> path. Issue #3608: these assemblies are
    /// supplied at runtime by the gsc host with <c>Private=false</c>, so they
    /// appear in neither the app's build output nor the C# source project's
    /// own reference closure; stage 3 must add them to ilverify's reference
    /// set explicitly or the verifier cannot resolve them.
    /// </summary>
    /// <param name="projectPath">The transformed <c>.gsproj</c> path.</param>
    /// <param name="gscPath">The <c>gsc.dll</c> path whose directory hosts the referenced assemblies.</param>
    /// <returns>The resolved absolute paths of existing compiler-hosted reference assemblies.</returns>
    internal static IReadOnlyList<string> ResolveCompilerHostedReferences(string projectPath, string gscPath)
    {
        if (string.IsNullOrEmpty(projectPath)
            || string.IsNullOrEmpty(gscPath)
            || !File.Exists(projectPath))
        {
            return Array.Empty<string>();
        }

        string compilerDirectory = Path.GetDirectoryName(Path.GetFullPath(gscPath));
        if (string.IsNullOrEmpty(compilerDirectory))
        {
            return Array.Empty<string>();
        }

        XDocument document = XDocument.Load(projectPath);
        var resolved = new List<string>();
        foreach (XElement hintPath in ElementsNamed(document, "HintPath"))
        {
            string value = hintPath.Value.Trim();
            if (!value.StartsWith(CompilerDirectoryExpression, StringComparison.Ordinal))
            {
                continue;
            }

            string relative = value
                .Substring(CompilerDirectoryExpression.Length)
                .TrimStart('/', '\\');
            string candidate = Path.GetFullPath(Path.Combine(compilerDirectory, relative));
            if (File.Exists(candidate))
            {
                resolved.Add(candidate);
            }
        }

        return resolved;
    }

    private static void AddSourceSdkDefaults(XDocument document, string sourceSdk)
    {
        bool isWeb = HasSdk(sourceSdk, "Microsoft.NET.Sdk.Web");
        bool isWorker = HasSdk(sourceSdk, "Microsoft.NET.Sdk.Worker");
        if ((isWeb || isWorker) && !ElementsNamed(document, "OutputType").Any())
        {
            XElement propertyGroup = ElementsNamed(document, "PropertyGroup").FirstOrDefault();
            if (propertyGroup == null)
            {
                propertyGroup = new XElement("PropertyGroup");
                document.Root.Add(propertyGroup);
            }

            propertyGroup.Add(new XElement("OutputType", "Exe"));
        }

        if (isWeb
            && !ElementsNamed(document, "FrameworkReference").Any(reference =>
                string.Equals(
                    AttributeNamed(reference, "Include")?.Value,
                    "Microsoft.AspNetCore.App",
                    StringComparison.OrdinalIgnoreCase)))
        {
            document.Root.Add(
                new XElement(
                    "ItemGroup",
                    new XElement(
                        "FrameworkReference",
                        new XAttribute("Include", "Microsoft.AspNetCore.App"))));
        }
    }

    private static bool HasSdk(string sdkList, string sdk) =>
        sdkList?.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(candidate => string.Equals(candidate, sdk, StringComparison.OrdinalIgnoreCase)) == true;

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

    // ADR-0169 (docs/cs2gs-analyzer-translation.md §Project transform): a
    // Roslyn analyzer project — recognized by its Microsoft.CodeAnalysis
    // compiler package or EnforceExtendedAnalyzerRules — becomes a G# analyzer
    // project: it retargets netstandard2.0 to $(NetCoreAppTargetFramework)'s
    // value (the in-proc gsc host is net10; the VS/old-host rationale for
    // netstandard2.0 does not exist for G#), drops the Roslyn compiler
    // packages and Roslyn-analyzer-authoring properties, and references the
    // G# analyzer API assembly loaded by the compiler host.
    private static void RewriteAnalyzerProject(XDocument document)
    {
        // Issue #3501: a plain Microsoft.CodeAnalysis dependency is not enough
        // (Cs2Gs.Translator needs Roslyn at runtime). Analyzer packages use
        // PrivateAssets=all; that marker also survives the pipeline's evaluated
        // project projection when EnforceExtendedAnalyzerRules does not.
        bool isAnalyzerProject = ElementsNamed(document, "EnforceExtendedAnalyzerRules").Any()
            || ElementsNamed(document, "PackageReference").Any(reference =>
                AttributeNamed(reference, "Include")?.Value?.StartsWith(
                    "Microsoft.CodeAnalysis",
                    StringComparison.OrdinalIgnoreCase) == true
                && string.Equals(
                    AttributeNamed(reference, "PrivateAssets")?.Value?.Trim(),
                    "all",
                    StringComparison.OrdinalIgnoreCase));
        if (!isAnalyzerProject)
        {
            return;
        }

        foreach (XElement targetFramework in ElementsNamed(document, "TargetFramework"))
        {
            if (targetFramework.Value.Trim().StartsWith("netstandard", StringComparison.OrdinalIgnoreCase))
            {
                targetFramework.Value = "net10.0";
            }
        }

        foreach (XElement stale in ElementsNamed(document, "EnforceExtendedAnalyzerRules").ToList())
        {
            stale.Remove();
        }

        foreach (XElement reference in ElementsNamed(document, "PackageReference").ToList())
        {
            if (AttributeNamed(reference, "Include")?.Value?.StartsWith("Microsoft.CodeAnalysis", StringComparison.OrdinalIgnoreCase) == true)
            {
                reference.Remove();
            }
        }

        foreach (XElement noWarn in ElementsNamed(document, "NoWarn").ToList())
        {
            string[] kept = noWarn.Value
                .Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(id => !id.StartsWith("RS", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            if (kept.Length == 0)
            {
                noWarn.Remove();
            }
            else
            {
                noWarn.Value = string.Join(";", kept);
            }
        }

        var itemGroup = new XElement(
            "ItemGroup",
            new XElement(
                "Reference",
                new XAttribute("Include", "GSharp.Core"),
                new XElement(
                    "HintPath",
                    CompilerDirectoryExpression + "/GSharp.Core.dll"),
                new XElement("Private", "false")));
        document.Root.Add(itemGroup);
    }

    // ADR-0169: retain analyzer project references while changing Roslyn's
    // analyzer item type to the G# SDK item type.
    private static void RewriteAnalyzerConsumerReferences(XDocument document)
    {
        foreach (XElement projectReference in ElementsNamed(document, "ProjectReference"))
        {
            XAttribute outputItemType = AttributeNamed(projectReference, "OutputItemType");
            if (outputItemType is not null
                && string.Equals(outputItemType.Value.Trim(), "Analyzer", StringComparison.OrdinalIgnoreCase))
            {
                outputItemType.Value = "GsharpCodeAnalyzer";
            }
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
