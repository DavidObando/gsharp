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

    // ADR-0169 M5 / issue #3686: the assembly holding GSharpAnalyzerVerifier,
    // which a migrated Roslyn analyzer test harness delegates to.
    private const string AnalyzerVerifierAssemblyName = "GSharp.CodeAnalysis.Analyzers.Testing";

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

        // ADR-0169 M5 / issue #3686: read while the ProjectReference includes
        // still point at the SOURCE .csproj files — RewriteProjectReferences
        // below repoints them at the generated .gsproj paths.
        bool referencesAnalyzerProject = ReferencesAnAnalyzerProject(document, sourceProjectDirectory);

        RewriteProjectReferences(
            document,
            sourceProjectDirectory,
            fullDestinationDirectory,
            generatedProjectPaths);
        RewriteNestedProjectPaths(
            document,
            sourceProjectDirectory,
            fullDestinationDirectory,
            generatedProjectPaths);
        RewriteGeneratePackageOnBuild(document);
        RewriteOutputType(document);
        RewriteCompileItems(document);
        RewriteCSharpMetadata(document);
        RewriteAnalyzerProject(document, referencesAnalyzerProject);
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
                // Issue #3772: the run translated no project here, so the mirror
                // carries the ORIGINAL project (when it had nothing to
                // translate) or nothing at all. Either way its output is not
                // this project's reference: the pinned SDK already supplies the
                // assembly, and taking a second copy from the mirrored build
                // hands gsc two assemblies with one identity (GS9200). Keep the
                // reference so the project still gets BUILT — repository code
                // looks for the built assembly on disk — and drop only its
                // contribution to the reference set.
                projectReference.SetAttributeValue("ReferenceOutputAssembly", "false");
                continue;
            }

            include.Value = Path.GetRelativePath(
                    destinationProjectDirectory,
                    Path.GetFullPath(generatedProjectPath))
                .Replace('\\', '/');
        }
    }

    // Issue #3674: a project can name sibling projects outside
    // ProjectReference — the <MSBuild Projects="…"/> task and the
    // PropertyGroup properties that feed it (this repo's own
    // Gsharp.NET.Sdk.csproj does both in its Pack* targets). Those specs are
    // relative to the SOURCE repository, so in a mirror they resolve to a
    // project that is either absent or present only as .gsproj, and the
    // nested build dies with MSB3202 for a reason unrelated to translation.
    //
    // The rewrite is deliberately narrow: a spec is redirected to its
    // generated counterpart only when it resolves to a project that is in
    // the migration set. Anything else is left verbatim. In particular an
    // unmapped project (excluded from the run, or simply outside it) is NOT
    // re-anchored at the real repository: doing so would make a mirror build
    // write into the source tree's obj/bin and would compile unmigrated C#
    // inside a run whose whole purpose is to exercise migrated code.
    private static void RewriteNestedProjectPaths(
        XDocument document,
        string sourceProjectDirectory,
        string destinationProjectDirectory,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (generatedProjectPaths is null || generatedProjectPaths.Count == 0)
        {
            return;
        }

        foreach (XElement task in ElementsNamed(document, "MSBuild"))
        {
            XAttribute projects = AttributeNamed(task, "Projects");
            if (projects is null || string.IsNullOrWhiteSpace(projects.Value))
            {
                continue;
            }

            string rewritten = RewriteProjectPathList(
                projects.Value,
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths);
            if (!string.Equals(rewritten, projects.Value, StringComparison.Ordinal))
            {
                projects.Value = rewritten;
            }
        }

        foreach (XElement propertyGroup in ElementsNamed(document, "PropertyGroup"))
        {
            foreach (XElement property in propertyGroup.Elements())
            {
                if (property.HasElements)
                {
                    continue;
                }

                string rewritten = RewriteProjectPathList(
                    property.Value,
                    sourceProjectDirectory,
                    destinationProjectDirectory,
                    generatedProjectPaths);
                if (!string.Equals(rewritten, property.Value, StringComparison.Ordinal))
                {
                    property.Value = rewritten;
                }
            }
        }
    }

    private static string RewriteProjectPathList(
        string value,
        string sourceProjectDirectory,
        string destinationProjectDirectory,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (value.IndexOf(".csproj", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return value;
        }

        string[] specs = value.Split(';');
        bool changed = false;
        for (int i = 0; i < specs.Length; i++)
        {
            if (TryMapProjectPathSpec(
                specs[i],
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                out string mapped))
            {
                specs[i] = mapped;
                changed = true;
            }
        }

        return changed ? string.Join(";", specs) : value;
    }

    // Maps one path spec to its generated counterpart, preserving the leading
    // MSBuild directory expression (the only two that can be expanded without
    // evaluating the project) and any surrounding whitespace. Returns false —
    // leaving the spec untouched — for anything that cannot be resolved
    // statically or that is not part of the migration set.
    private static bool TryMapProjectPathSpec(
        string spec,
        string sourceProjectDirectory,
        string destinationProjectDirectory,
        IReadOnlyDictionary<string, string> generatedProjectPaths,
        out string mapped)
    {
        mapped = null;
        string value = spec.Trim();
        if (value.Length == 0 || !value.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        int start = 0;
        while (char.IsWhiteSpace(spec[start]))
        {
            start++;
        }

        string leading = spec.Substring(0, start);
        string trailing = spec.Substring(start + value.Length);

        string prefix = string.Empty;
        string remainder = value;
        if (value.StartsWith("$(", StringComparison.Ordinal))
        {
            int close = value.IndexOf(')');
            if (close < 0)
            {
                return false;
            }

            prefix = value.Substring(0, close + 1);
            if (!IsAnchorExpression(prefix))
            {
                return false;
            }

            remainder = value.Substring(close + 1).TrimStart('/', '\\');
        }

        // Anything still holding an unexpanded expression or a wildcard
        // cannot be resolved to a single project path here.
        if (remainder.Length == 0
            || remainder.Contains("$(", StringComparison.Ordinal)
            || remainder.Contains("@(", StringComparison.Ordinal)
            || remainder.Contains('*'))
        {
            return false;
        }

        string sourceReferencePath = Path.GetFullPath(
            Path.Combine(sourceProjectDirectory, NormalizeDirectorySeparators(remainder)));
        if (!generatedProjectPaths.TryGetValue(sourceReferencePath, out string generatedProjectPath))
        {
            return false;
        }

        string relative = Path.GetRelativePath(
                destinationProjectDirectory,
                Path.GetFullPath(generatedProjectPath))
            .Replace('\\', '/');

        // $(MSBuildThisFileDirectory) already expands with a trailing
        // separator; $(MSBuildProjectDirectory) does not.
        string separator = prefix.Equals("$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase)
            ? "/"
            : string.Empty;
        mapped = leading + prefix + separator + relative + trailing;
        return true;
    }

    private static bool IsAnchorExpression(string expression) =>
        expression.Equals("$(MSBuildThisFileDirectory)", StringComparison.OrdinalIgnoreCase)
        || expression.Equals("$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase);

    // Issue #3674, the other half of the MSB3202 story: packaging is
    // repository infrastructure a mirror cannot reproduce. Pack targets reach
    // for projects outside the migration set and for repository assets
    // (READMEs, icons, prebuilt output directories) that the mirror does not
    // carry, and a mirrored build has no reason to produce a NuGet package at
    // all. Neutralize pack-on-build in the emitted project so the mirror is
    // self-consistent for anyone building it directly — the compile stage
    // additionally passes the same property globally
    // (SdkCompileRunner.BuildMirroredBuildArguments).
    private static void RewriteGeneratePackageOnBuild(XDocument document)
    {
        foreach (XElement generatePackageOnBuild in ElementsNamed(document, "GeneratePackageOnBuild"))
        {
            generatePackageOnBuild.Value = "false";
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
    private static void RewriteAnalyzerProject(XDocument document, bool referencesAnalyzerProject)
    {
        bool isAnalyzerProject = IsAnalyzerProjectXml(document);

        // ADR-0169 M5 / issue #3686: the analyzer's TEST project gets the same
        // treatment — it too translates in analyzer-API mode, so its Roslyn
        // packages are gone and it binds the G# analyzer API plus the verifier.
        // It is recognized structurally: it project-references an analyzer
        // project. (The translator's own detector is semantic; the transformer
        // has no compilation, which is why the two live apart — see
        // docs/cs2gs-analyzer-translation.md §Detection.)
        bool isAnalyzerTestProject = !isAnalyzerProject && referencesAnalyzerProject;
        if (!isAnalyzerProject && !isAnalyzerTestProject)
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

        // An analyzer assembly is LOADED BY gsc, which already has GSharp.Core
        // in its own directory — copying it would risk a second, divergent
        // copy. A test assembly is loaded by the test host instead, with no
        // gsc in the picture, so it must carry both assemblies into its output
        // or the analyzer's own types fail to load at run time (#3686).
        var itemGroup = new XElement(
            "ItemGroup",
            new XElement(
                "Reference",
                new XAttribute("Include", "GSharp.Core"),
                new XElement(
                    "HintPath",
                    CompilerDirectoryExpression + "/GSharp.Core.dll"),
                new XElement("Private", isAnalyzerTestProject ? "true" : "false")));
        if (isAnalyzerTestProject)
        {
            itemGroup.Add(new XElement(
                "Reference",
                new XAttribute("Include", AnalyzerVerifierAssemblyName),
                new XElement(
                    "HintPath",
                    CompilerDirectoryExpression + "/" + AnalyzerVerifierAssemblyName + ".dll"),
                new XElement("Private", "true")));
        }

        document.Root.Add(itemGroup);
    }

    // Issue #3501: a plain Microsoft.CodeAnalysis dependency is not enough
    // (Cs2Gs.Translator needs Roslyn at runtime). Analyzer packages use
    // PrivateAssets=all; that marker also survives the pipeline's evaluated
    // project projection when EnforceExtendedAnalyzerRules does not.
    private static bool IsAnalyzerProjectXml(XDocument document)
        => ElementsNamed(document, "EnforceExtendedAnalyzerRules").Any()
            || ElementsNamed(document, "PackageReference").Any(reference =>
                AttributeNamed(reference, "Include")?.Value?.StartsWith(
                    "Microsoft.CodeAnalysis",
                    StringComparison.OrdinalIgnoreCase) == true
                && string.Equals(
                    AttributeNamed(reference, "PrivateAssets")?.Value?.Trim(),
                    "all",
                    StringComparison.OrdinalIgnoreCase));

    // MSBuild item metadata may be written as an attribute or a child element;
    // read either.
    private static string Metadata(XElement item, string name)
        => AttributeNamed(item, name)?.Value?.Trim()
            ?? item.Elements().FirstOrDefault(child =>
                string.Equals(child.Name.LocalName, name, StringComparison.OrdinalIgnoreCase))?.Value?.Trim();

    private static bool ReferencesAnAnalyzerProject(XDocument document, string sourceProjectDirectory)
    {
        if (string.IsNullOrEmpty(sourceProjectDirectory))
        {
            return false;
        }

        foreach (XElement reference in ElementsNamed(document, "ProjectReference"))
        {
            string include = AttributeNamed(reference, "Include")?.Value;
            if (string.IsNullOrWhiteSpace(include))
            {
                continue;
            }

            // An analyzer's CONSUMER (src/Core: OutputItemType="Analyzer",
            // ReferenceOutputAssembly="false") references the analyzer to RUN
            // it, not to compile against it — it is ordinary C# and must keep
            // its own Roslyn packages. Only a reference that pulls the
            // analyzer's assembly in as a library marks a test project.
            if (string.Equals(Metadata(reference, "OutputItemType"), "Analyzer", StringComparison.OrdinalIgnoreCase)
                || string.Equals(Metadata(reference, "ReferenceOutputAssembly"), "false", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string referencedPath = Path.GetFullPath(Path.Combine(
                sourceProjectDirectory,
                include.Trim().Replace('\\', Path.DirectorySeparatorChar)));
            if (!File.Exists(referencedPath))
            {
                continue;
            }

            if (IsAnalyzerProjectXml(XDocument.Parse(File.ReadAllText(referencedPath))))
            {
                return true;
            }
        }

        return false;
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
