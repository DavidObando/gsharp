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
    // G# analyzer API via the GsharpAnalyzerApiProject property the migration
    // host supplies.
    private static void RewriteAnalyzerProject(XDocument document)
    {
        // Issue #3501: classification keys on the analyzer-AUTHORING marker
        // only. Merely consuming Microsoft.CodeAnalysis as a library (e.g.
        // Cs2Gs.Translator itself) must NOT strip the Roslyn packages — that
        // erased the whole Roslyn surface from the migrated Translator and
        // produced 3,093 unresolved-type errors in the nightly.
        bool isAnalyzerProject = ElementsNamed(document, "EnforceExtendedAnalyzerRules").Any();
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
                "ProjectReference",
                new XAttribute("Include", "$(GsharpAnalyzerApiProject)"),
                new XAttribute("Condition", " '$(GsharpAnalyzerApiProject)' != '' ")));
        document.Root.Add(itemGroup);
    }

    // ADR-0169: a consumer wiring an analyzer project via
    // OutputItemType="Analyzer" (Roslyn's item) DROPS the reference for now.
    // The cs2gs analyzer-API translation (Roslyn syntax/symbol surface →
    // GSharpDiagnosticAnalyzer) is built for GSA0001-GSA0004 (#3536), but
    // GSA0005 (RewriterClonePreservationAnalyzer) still translates loud —
    // MethodKind/constructor-vs-static-factory detection has no G# analogue
    // yet (docs/cs2gs-analyzer-translation.md) — so InternalAnalyzers as a
    // whole does not compile, the migrated assembly carries no
    // [GSharpDiagnosticAnalyzer] types, and the SDK rejects it as an analyzer
    // input (GS9301) — wiring it via GsharpCodeAnalyzer would fail every
    // consumer build. Restore the rewrite to the G# item once GSA0005's
    // reviewed adaptation lands and InternalAnalyzers compiles clean.
    private static void RewriteAnalyzerConsumerReferences(XDocument document)
    {
        foreach (XElement projectReference in ElementsNamed(document, "ProjectReference").ToList())
        {
            XAttribute outputItemType = AttributeNamed(projectReference, "OutputItemType");
            if (outputItemType is not null
                && (string.Equals(outputItemType.Value.Trim(), "Analyzer", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(outputItemType.Value.Trim(), "GsharpCodeAnalyzer", StringComparison.OrdinalIgnoreCase)))
            {
                projectReference.Remove();
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
