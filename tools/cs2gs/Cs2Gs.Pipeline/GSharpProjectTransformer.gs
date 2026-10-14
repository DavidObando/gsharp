// <copyright file="GSharpProjectTransformer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Xml.Linq
import Cs2Gs.Translator.Loading

/// Transforms a C# project document for use by the G# SDK.
internal shared class GSharpProjectTransformer {
    // ADR-0169 M5 / issue #3686 (packaged per issue #3780): the assembly
    // holding GSharpAnalyzerVerifier, which a migrated Roslyn analyzer test
    // harness delegates to. Also the package's PackageId (internal so
    // SdkCompileRunner can resolve a locally-built version of it).
    internal const AnalyzerVerifierAssemblyName string = "GSharp.CodeAnalysis.Analyzers.Testing"

    // ADR-0169: the MSBuild expression that anchors a compiler-hosted
    // reference (an assembly supplied at runtime by the gsc host, never copied
    // to the app's own output) at the compiler's directory. Kept as the single
    // source of truth for both the injection (RewriteAnalyzerProject) and the
    // stage-3 resolution (ResolveCompilerHostedReferences, issue #3608).
    private const CompilerDirectoryExpression string = "$$([System.IO.Path]::GetDirectoryName('$$(GsharpCompilerFullPath)'))"

    private let CSharpSpecSuffix Regex = Regex(
        "\\.cs(?=\\s*(?:;|$$))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
    )

    /// Loads a source project while preserving whitespace and rewrites only
    /// the portions that differ for its generated G# project.
    /// @param sourceProjectPath The source `.csproj` path.
    /// @param destinationProjectDirectory The directory that will contain the generated project.
    /// @param gsharpSdk The complete G# SDK value, including any version suffix.
    /// @param generatedProjectPaths Canonical source-project paths mapped to their generated project paths.
    /// @param isAnalyzerTestProject The translate-stage detector's analyzer-test-project verdict.
    /// @param analyzerVerifierPackageVersion The version of the locally-built
    /// (cref:AnalyzerVerifierAssemblyName)
    /// package to reference (issue #3780). Required when
    /// [`isAnalyzerTestProject`](paramref) is `true`;
    /// ignored otherwise.
    /// @returns The transformed project document.
    internal func Transform(
        sourceProjectPath string?,
        destinationProjectDirectory string?,
        gsharpSdk string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        isAnalyzerTestProject bool = false,
        analyzerVerifierPackageVersion string? = nil
    ) XDocument {
        if sourceProjectPath == nil {
            throw ArgumentNullException("sourceProjectPath")
        }
        if destinationProjectDirectory == nil {
            throw ArgumentNullException("destinationProjectDirectory")
        }
        if gsharpSdk == nil {
            throw ArgumentNullException("gsharpSdk")
        }
        var projectXml = File.ReadAllText(sourceProjectPath)
        if NerdbankGitVersioningPolicy.TryBumpProjectXml(projectXml, out var bumpedProjectXml) {
            projectXml = bumpedProjectXml
        }
        let document = XDocument.Parse(projectXml, LoadOptions.PreserveWhitespace)
        let sourceSdk = string.Join(";", SdkPin.ProjectSdkNames(document.Root))
        SdkPin.RebindProjectSdk(document.Root, gsharpSdk, migrateCSharpSdk: true)
        AddSourceSdkDefaults(document, sourceSdk)
        let sourceProjectDirectory string? = Path.GetDirectoryName(Path.GetFullPath(sourceProjectPath))
        let fullDestinationDirectory = Path.GetFullPath(destinationProjectDirectory)
        RewriteProjectReferences(document, sourceProjectDirectory, fullDestinationDirectory, generatedProjectPaths)
        RewriteNestedProjectPaths(document, sourceProjectDirectory, fullDestinationDirectory, generatedProjectPaths)
        RewriteGeneratePackageOnBuild(document)
        RewriteOutputType(document)
        RewriteCompileItems(document)
        RewriteCSharpMetadata(document)
        RewriteAnalyzerProject(document, isAnalyzerTestProject, analyzerVerifierPackageVersion)
        RewriteAnalyzerConsumerReferences(document)
        return document
    }

    internal func RewriteDeclaredProjectPathExpressions(
        document XDocument,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) HashSet[string] -> RewriteDeclaredProjectPathExpressionsCore(
        document,
        sourceProjectDirectory,
        destinationProjectDirectory,
        generatedProjectPaths
    )

    internal func TryRewriteExpression(
        include XAttribute?,
        mappedExpressions IReadOnlySet[string],
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) bool -> TryRewriteExpressionCore(
        include,
        mappedExpressions,
        sourceProjectDirectory,
        destinationProjectDirectory,
        generatedProjectPaths
    )

    internal func SplitMixedProjectReferencesForMirror(
        document XDocument,
        mappedExpressions IReadOnlySet[string],
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) -> SplitMixedProjectReferences(
        document,
        mappedExpressions,
        sourceProjectDirectory,
        destinationProjectDirectory,
        generatedProjectPaths
    )

    /// Resolves a transformed project's compiler-hosted `Reference`
    /// entries — those whose `HintPath` is anchored at the compiler's
    /// directory via (cref:CompilerDirectoryExpression) (e.g. the
    /// G# analyzer API assembly injected by `RewriteAnalyzerProject`) —
    /// against a concrete `gsc` path. Issue #3608: these assemblies are
    /// supplied at runtime by the gsc host with `Private=false`, so they
    /// appear in neither the app's build output nor the C# source project's
    /// own reference closure; stage 3 must add them to ilverify's reference
    /// set explicitly or the verifier cannot resolve them.
    /// @param projectPath The transformed `.gsproj` path.
    /// @param gscPath The `gsc.dll` path whose directory hosts the referenced assemblies.
    /// @returns The resolved absolute paths of existing compiler-hosted reference assemblies.
    internal func ResolveCompilerHostedReferences(projectPath string, gscPath string) IReadOnlyList[string] {
        if string.IsNullOrEmpty(projectPath) || string.IsNullOrEmpty(gscPath) || !File.Exists(projectPath) {
            return Array.Empty[string]()
        }
        let compilerDirectory string? = Path.GetDirectoryName(Path.GetFullPath(gscPath))
        if string.IsNullOrEmpty(compilerDirectory) {
            return Array.Empty[string]()
        }
        let document = XDocument.Load(projectPath)
        let resolved = List[string]()
        for hintPath in ElementsNamed(document, "HintPath") {
            let value = hintPath.Value.Trim()
            if !value.StartsWith(CompilerDirectoryExpression, StringComparison.Ordinal) {
                continue
            }
            let relative = value.Substring(CompilerDirectoryExpression.Length).TrimStart('/', '\\')
            let candidate = Path.GetFullPath(Path.Combine(compilerDirectory, relative))
            if File.Exists(candidate) {
                resolved.Add(candidate)
            }
        }
        return resolved
    }

    internal func RewriteProjectItemPaths(
        document XDocument,
        sourceFileDirectory string?,
        destinationFileDirectory string?,
        sourceRoot string,
        destinationRoot string,
        generatedProjectPaths IReadOnlyDictionary[string, string]
    ) bool {
        let repositoryRootExpressions = FindRepositoryRootExpressions(document, sourceFileDirectory, sourceRoot)
        var changed = false
        for itemGroup in ElementsNamed(document, "ItemGroup") {
            for item in itemGroup.Elements() {
                let include XAttribute? = AttributeNamed(item, "Include")
                if include == nil || string.IsNullOrWhiteSpace(include.Value) {
                    continue
                }
                let rewritten string? = RewriteProjectPathList(
                    include.Value,
                    sourceFileDirectory,
                    destinationFileDirectory,
                    generatedProjectPaths,
                    sourceRoot,
                    destinationRoot,
                    repositoryRootExpressions
                )
                if !string.Equals(rewritten, include.Value, StringComparison.Ordinal) {
                    include.Value = rewritten!!
                    changed = true
                }
            }
        }
        return changed
    }

    internal func RewriteNestedProjectPathsForMirror(
        document XDocument,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) -> RewriteNestedProjectPaths(document, sourceProjectDirectory, destinationProjectDirectory, generatedProjectPaths)

    private func FindRepositoryRootExpressions(
        document XDocument,
        sourceFileDirectory string?,
        sourceRoot string
    ) IReadOnlySet[string] {
        let expressions = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for propertyGroup in ElementsNamed(document, "PropertyGroup") {
            for property in propertyGroup.Elements() {
                let value = property.Value.Trim()
                const anchor = "$$(MSBuildThisFileDirectory)"
                if property.HasElements || !value.StartsWith(anchor, StringComparison.OrdinalIgnoreCase) {
                    continue
                }
                let remainder = value.Substring(anchor.Length)
                if remainder.Contains("$$(", StringComparison.Ordinal) || remainder.Contains(
                    "@(",
                    StringComparison.Ordinal
                ) ||
                    remainder.Contains('*') {
                    continue
                }
                let resolved = Path.GetFullPath(
                    Path.Combine(sourceFileDirectory!!, NormalizeDirectorySeparators(remainder))
                )
                if string.Equals(
                    Path.TrimEndingDirectorySeparator(resolved),
                    Path.TrimEndingDirectorySeparator(sourceRoot),
                    StringComparison.OrdinalIgnoreCase
                ) {
                    expressions.Add("$$(" + property.Name.LocalName + ")")
                }
            }
        }
        return expressions
    }

    private func AddSourceSdkDefaults(document XDocument, sourceSdk string) {
        let isWeb = HasSdk(sourceSdk, "Microsoft.NET.Sdk.Web")
        let isWorker = HasSdk(sourceSdk, "Microsoft.NET.Sdk.Worker")
        if (isWeb || isWorker) && !ElementsNamed(document, "OutputType").Any() {
            var propertyGroup XElement? = ElementsNamed(document, "PropertyGroup").FirstOrDefault()
            if propertyGroup == nil {
                propertyGroup = XElement(XName?("PropertyGroup")!!)
                document.Root!!.Add(propertyGroup)
            }
            propertyGroup.Add(XElement(XName?("OutputType")!!, "Exe"))
        }
        if isWeb && !ElementsNamed(document, "FrameworkReference").Any(
            (reference XElement) -> string.Equals(
                AttributeNamed(reference, "Include")?.Value,
                "Microsoft.AspNetCore.App",
                StringComparison.OrdinalIgnoreCase
            )
        ) {
            document.Root!!.Add(
                XElement(
                    XName?("ItemGroup")!!,
                    XElement(
                        XName?("FrameworkReference")!!,
                        XAttribute(XName?("Include")!!, "Microsoft.AspNetCore.App")
                    )
                )
            )
        }
    }

    private func HasSdk(sdkList string?, sdk string) bool -> sdkList?.Split(
        ';',
        StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
    )
        .Any((candidate string) -> string.Equals(candidate, sdk, StringComparison.OrdinalIgnoreCase)) == true

    private func RewriteProjectReferences(
        document XDocument,
        sourceProjectDirectory string?,
        destinationProjectDirectory string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) {
        if generatedProjectPaths == nil || generatedProjectPaths.Count == 0 {
            return
        }
        let mappedExpressions = RewriteDeclaredProjectPathExpressions(
            document,
            sourceProjectDirectory,
            destinationProjectDirectory,
            generatedProjectPaths
        )
        SplitMixedProjectReferences(
            document,
            mappedExpressions,
            sourceProjectDirectory,
            destinationProjectDirectory,
            generatedProjectPaths
        )
        for projectReference in ElementsNamed(document, "ProjectReference").ToList() {
            let include XAttribute? = AttributeNamed(projectReference, "Include")
            if include == nil || string.IsNullOrWhiteSpace(include.Value) {
                continue
            }
            if TryRewriteExpression(
                include,
                mappedExpressions,
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths
            ) {
                continue
            }
            let sourceReferencePath = Path.GetFullPath(
                Path.Combine(sourceProjectDirectory!!, NormalizeDirectorySeparators(include.Value))
            )
            if !generatedProjectPaths.TryGetValue(sourceReferencePath, out var generatedProjectPath) {
                // Issue #3772: the run translated no project here, so the mirror
                // carries the ORIGINAL project (when it had nothing to
                // translate) or nothing at all. Either way its output is not
                // this project's reference: the pinned SDK already supplies the
                // assembly, and taking a second copy from the mirrored build
                // hands gsc two assemblies with one identity (GS9200). Keep the
                // reference so the project still gets BUILT — repository code
                // looks for the built assembly on disk — and drop only its
                // contribution to the reference set.
                projectReference.SetAttributeValue(XName?("ReferenceOutputAssembly")!!, "false")
                continue
            }
            include.Value = Path.GetRelativePath(destinationProjectDirectory, Path.GetFullPath(generatedProjectPath))
                .Replace('\\', '/')
        }
    }

    private func SplitMixedProjectReferences(
        document XDocument,
        mappedExpressions IReadOnlySet[string],
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) {
        for reference in ElementsNamed(document, "ProjectReference").ToList() {
            let include XAttribute? = AttributeNamed(reference, "Include")
            let specs = include?.Value.Split(';') ?? Array.Empty[string]()
            if specs.Length < 2 {
                continue
            }
            var hasHandled = false
            var hasUnmappedLiteral = false
            for spec in specs {
                let expression = spec.Contains("$$(", StringComparison.Ordinal) || spec.Contains(
                    "@(",
                    StringComparison.Ordinal
                )
                let mapped = mappedExpressions.Contains(spec.Trim()) ||
                    TryRewriteDeclaredProjectPathSpec(
                    spec,
                    sourceProjectDirectory,
                    destinationProjectDirectory,
                    generatedProjectPaths,
                    out _
                ) ||
                    TryMapProjectPathSpec(
                    spec,
                    sourceProjectDirectory,
                    destinationProjectDirectory,
                    generatedProjectPaths,
                    sourceRoot: nil,
                    destinationRoot: nil,
                    repositoryRootExpressions: nil,
                    out _
                )
                hasHandled |= expression || mapped
                hasUnmappedLiteral |= !expression && !mapped
            }
            if !hasHandled || !hasUnmappedLiteral {
                continue
            }
            for spec in specs {
                let split = XElement(reference)
                split.SetAttributeValue(XName?("Include")!!, spec.Trim())
                reference.AddBeforeSelf(split)
            }
            reference.Remove()
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
    private func RewriteNestedProjectPaths(
        document XDocument,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) {
        if generatedProjectPaths == nil || generatedProjectPaths.Count == 0 {
            return
        }
        for task in ElementsNamed(document, "MSBuild") {
            let projects XAttribute? = AttributeNamed(task, "Projects")
            if projects == nil || string.IsNullOrWhiteSpace(projects.Value) {
                continue
            }
            let rewritten string? = RewriteProjectPathList(
                projects.Value,
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths
            )
            if !string.Equals(rewritten, projects.Value, StringComparison.Ordinal) {
                projects.Value = rewritten!!
            }
        }
        for propertyGroup in ElementsNamed(document, "PropertyGroup") {
            for property in propertyGroup.Elements() {
                if property.HasElements {
                    continue
                }
                let rewritten string? = RewriteProjectPathList(
                    property.Value,
                    sourceProjectDirectory,
                    destinationProjectDirectory,
                    generatedProjectPaths
                )
                if !string.Equals(rewritten, property.Value, StringComparison.Ordinal) {
                    property.Value = rewritten!!
                }
            }
        }
    }

    private func RewriteProjectPathList(
        value string?,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        sourceRoot string? = nil,
        destinationRoot string? = nil,
        repositoryRootExpressions IReadOnlySet[string]? = nil
    ) string? {
        if value!!.IndexOf(".csproj", StringComparison.OrdinalIgnoreCase) < 0 {
            return value
        }
        let specs = value!!.Split(';')
        var changed = false
        for var i = 0; i < specs.Length; i++ {
            if TryMapProjectPathSpec(
                specs[i],
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                sourceRoot,
                destinationRoot,
                repositoryRootExpressions,
                out var mapped
            ) {
                specs[i] = mapped!!
                changed = true
            }
        }
        return if changed {
            string.Join(";", specs)
        } else {
            value
        }
    }

    // Maps one path spec to its generated counterpart, preserving the leading
    // MSBuild directory expression and any surrounding whitespace. Project
    // transforms recognize only the two expressions that can be resolved from
    // their location. Shared item files may additionally match an expression's
    // literal suffix against the repository-rooted migration map. Returns false
    // for anything unresolved or outside the migration set.
    private func TryMapProjectPathSpec(
        spec string,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        sourceRoot string?,
        destinationRoot string?,
        repositoryRootExpressions IReadOnlySet[string]?,
        out mapped string?
    ) bool {
        mapped = nil
        let value = spec.Trim()
        if value.Length == 0 || !value.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) {
            return false
        }
        var start = 0
        while char.IsWhiteSpace(spec[start]) {
            start++
        }
        let leading = spec.Substring(0, start)
        let trailing = spec.Substring(start + value.Length)
        var prefix = string.Empty
        var remainder = value
        var rootRelativeExpression = false
        if value.StartsWith("$$(", StringComparison.Ordinal) {
            let close = value.IndexOf(')')
            if close < 0 {
                return false
            }
            prefix = value.Substring(0, close + 1)
            if prefix.Equals("$$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase) && sourceRoot != nil {
                return false
            }
            if !IsAnchorExpression(prefix) {
                if string.IsNullOrEmpty(sourceRoot) || string.IsNullOrEmpty(destinationRoot) ||
                    repositoryRootExpressions?.Contains(prefix) != true {
                    return false
                }
                rootRelativeExpression = true
            }
            remainder = value.Substring(close + 1).TrimStart('/', '\\')
        }
        // Anything still holding an unexpanded expression or a wildcard
        // cannot be resolved to a single project path here.
        if remainder.Length == 0 || remainder.Contains("$$(", StringComparison.Ordinal) || remainder.Contains(
            "@(",
            StringComparison.Ordinal
        ) ||
            remainder.Contains('*') {
            return false
        }
        let sourceReferencePath = Path.GetFullPath(
            Path.Combine(
                if rootRelativeExpression {
                    sourceRoot
                } else {
                    sourceProjectDirectory
                },
                NormalizeDirectorySeparators(remainder)
            )
        )
        if !generatedProjectPaths!!.TryGetValue(sourceReferencePath, out var generatedProjectPath) {
            return false
        }
        if rootRelativeExpression {
            let generatedRelative = Path.GetRelativePath(destinationRoot!!, generatedProjectPath).Replace('\\', '/')
            mapped = leading + prefix + "/" + generatedRelative + trailing
            return true
        }
        let relative = Path.GetRelativePath(destinationProjectDirectory!!, Path.GetFullPath(generatedProjectPath))
            .Replace('\\', '/')
        // $(MSBuildThisFileDirectory) already expands with a trailing
        // separator; $(MSBuildProjectDirectory) does not.
        let separator = if prefix.Equals("$$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase) {
            "/"
        } else {
            string.Empty
        }
        mapped = leading + prefix + separator + relative + trailing
        return true
    }

    private func IsAnchorExpression(expression string) bool -> expression.Equals(
        "$$(MSBuildThisFileDirectory)",
        StringComparison.OrdinalIgnoreCase
    ) ||
        expression.Equals("$$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase)

    // Issue #3674, the other half of the MSB3202 story: packaging is
    // repository infrastructure a mirror cannot reproduce. Pack targets reach
    // for projects outside the migration set and for repository assets
    // (READMEs, icons, prebuilt output directories) that the mirror does not
    // carry, and a mirrored build has no reason to produce a NuGet package at
    // all. Neutralize pack-on-build in the emitted project so the mirror is
    // self-consistent for anyone building it directly — the compile stage
    // additionally passes the same property globally
    // (SdkCompileRunner.BuildMirroredBuildArguments).
    private func RewriteGeneratePackageOnBuild(document XDocument) {
        for generatePackageOnBuild in ElementsNamed(document, "GeneratePackageOnBuild") {
            generatePackageOnBuild.Value = "false"
        }
    }

    private func RewriteOutputType(document XDocument) {
        for outputType in ElementsNamed(document, "OutputType") {
            if outputType.Value.Trim().Equals("WinExe", StringComparison.OrdinalIgnoreCase) {
                outputType.Value = "Exe"
            }
        }
    }

    private func RewriteCompileItems(document XDocument) {
        for compile in ElementsNamed(document, "Compile") {
            for attributeName in[]string{"Include", "Update", "Remove"} {
                let attribute XAttribute? = AttributeNamed(compile, attributeName)
                if attribute != nil {
                    attribute.Value = RewriteCSharpSpecs(attribute.Value)
                }
            }
        }
    }

    private func RewriteCSharpMetadata(document XDocument) {
        for metadata in document.Descendants().Where(
            (element XElement) -> element
                .Name
                .LocalName
                .Equals("LastGenOutput", StringComparison.OrdinalIgnoreCase) ||
                element
                .Name
                .LocalName
                .Equals("DependentUpon", StringComparison.OrdinalIgnoreCase)
        ) {
            metadata.Value = RewriteCSharpSpecs(metadata.Value)
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
    private func RewriteAnalyzerProject(
        document XDocument,
        isAnalyzerTestProject bool,
        analyzerVerifierPackageVersion string?
    ) {
        let isAnalyzerProject = IsAnalyzerProjectXml(document)
        // ADR-0169 M5 / issue #3686: the analyzer's TEST project gets the same
        // treatment — it too translates in analyzer-API mode, so its Roslyn
        // packages are gone and it binds the G# analyzer API plus the verifier.
        // Issue #3791: consume the semantic detector's verdict rather than
        // re-deriving test-project status from a ProjectReference.
        if !isAnalyzerProject && !isAnalyzerTestProject {
            return
        }
        for targetFramework in ElementsNamed(document, "TargetFramework") {
            if targetFramework.Value.Trim().StartsWith("netstandard", StringComparison.OrdinalIgnoreCase) {
                targetFramework.Value = "net10.0"
            }
        }
        for stale in ElementsNamed(document, "EnforceExtendedAnalyzerRules").ToList() {
            stale.Remove()
        }
        for reference in ElementsNamed(document, "PackageReference").ToList() {
            if AttributeNamed(reference, "Include")?.Value?.StartsWith(
                "Microsoft.CodeAnalysis",
                StringComparison.OrdinalIgnoreCase
            ) == true {
                reference.Remove()
            }
        }
        for noWarn in ElementsNamed(document, "NoWarn").ToList() {
            let kept = noWarn
                .Value
                .Split([]char{';', ','}, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where((id string) -> !id.StartsWith("RS", StringComparison.OrdinalIgnoreCase))
                .ToArray()
            if kept.Length == 0 {
                noWarn.Remove()
            } else {
                noWarn.Value = string.Join(";", kept)
            }
        }
        // An analyzer assembly is LOADED BY gsc, which already has GSharp.Core
        // in its own directory — copying it would risk a second, divergent
        // copy. A test assembly is loaded by the test host instead, with no
        // gsc in the picture, so it must carry GSharp.Core into its output or
        // the analyzer's own types fail to load at run time (#3686).
        let itemGroup = XElement(
            XName?("ItemGroup")!!,
            XElement(
                XName?("Reference")!!,
                XAttribute(XName?("Include")!!, "GSharp.Core"),
                XElement(XName?("HintPath")!!, CompilerDirectoryExpression + "/GSharp.Core.dll"),
                XElement(
                    XName?("Private")!!,
                    if isAnalyzerTestProject {
                        "true"
                    } else {
                        "false"
                    }
                )
            )
        )
        document.Root!!.Add(itemGroup)
        // Issue #3780: the verifier itself is no longer resolved by directory
        // adjacency to gsc — it is a real NuGet package
        // (GSharp.CodeAnalysis.Analyzers.Testing) that a migrated test project
        // takes an ordinary PackageReference to, same as any other dependency.
        if isAnalyzerTestProject {
            if string.IsNullOrEmpty(analyzerVerifierPackageVersion) {
                throw InvalidOperationException(
                    "An analyzer test project requires a version of the " +
                        AnalyzerVerifierAssemblyName +
                        " package (issue #3780), but none was resolved. Build and " +
                        "pack src/Analyzers/GSharp.CodeAnalysis.Analyzers.Testing " +
                        "(dotnet pack -c Release) so a local nupkg exists under " +
                        "out/bin/<Config>/nupkgs/ or .nugs/."
                )
            }
            document.Root!!.Add(
                XElement(
                    XName?("ItemGroup")!!,
                    XElement(
                        XName?("PackageReference")!!,
                        XAttribute(XName?("Include")!!, AnalyzerVerifierAssemblyName),
                        XAttribute(XName?("Version")!!, analyzerVerifierPackageVersion)
                    )
                )
            )
        }
    }

    // Issue #3501: a plain Microsoft.CodeAnalysis dependency is not enough
    // (Cs2Gs.Translator needs Roslyn at runtime). Analyzer packages use
    // PrivateAssets=all; that marker also survives the pipeline's evaluated
    // project projection when EnforceExtendedAnalyzerRules does not.
    private func IsAnalyzerProjectXml(document XDocument) bool -> ElementsNamed(
        document,
        "EnforceExtendedAnalyzerRules"
    ).Any() || ElementsNamed(document, "PackageReference").Any(
        (reference XElement) -> AttributeNamed(reference, "Include")?.Value?.StartsWith(
            "Microsoft.CodeAnalysis",
            StringComparison.OrdinalIgnoreCase
        ) == true &&
            string.Equals(
            AttributeNamed(reference, "PrivateAssets")?.Value?.Trim(),
            "all",
            StringComparison.OrdinalIgnoreCase
        )
    )

    // ADR-0169: retain analyzer project references while changing Roslyn's
    // analyzer item type to the G# SDK item type.
    private func RewriteAnalyzerConsumerReferences(document XDocument) {
        for projectReference in ElementsNamed(document, "ProjectReference") {
            let outputItemType XAttribute? = AttributeNamed(projectReference, "OutputItemType")
            if outputItemType != nil && string.Equals(
                outputItemType.Value.Trim(),
                "Analyzer",
                StringComparison.OrdinalIgnoreCase
            ) {
                outputItemType.Value = "GsharpCodeAnalyzer"
            }
        }
    }

    private func ElementsNamed(document XDocument, localName string) IEnumerable[XElement] -> document.Descendants()
        .Where((element XElement) -> element.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase))

    private func AttributeNamed(element XElement, localName string) XAttribute? -> element.Attributes().FirstOrDefault(
        (attribute XAttribute) -> attribute.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase)
    )

    private func RewriteCSharpSpecs(value string?) string -> CSharpSpecSuffix.Replace(value!!, ".gs")

    private func RewriteDeclaredProjectPathExpressionsCore(
        document XDocument,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) HashSet[string] {
        let mappedExpressions = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for element in document.Descendants() {
            if element.Name.LocalName.Equals("ProjectReference", StringComparison.OrdinalIgnoreCase) {
                continue
            }
            if !element.HasElements &&
                TryRewriteDeclaredProjectPath(
                element.Value,
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                out var propertyValue
            ) {
                element.Value = propertyValue!!
                mappedExpressions.Add("$$(${element.Name.LocalName})")
            }
            let itemInclude XAttribute? = AttributeNamed(element, "Include")
            if itemInclude != nil &&
                TryRewriteDeclaredProjectPath(
                itemInclude.Value,
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                out var itemValue
            ) {
                itemInclude.Value = itemValue!!
                mappedExpressions.Add("@(${element.Name.LocalName})")
            }
        }
        return mappedExpressions
    }

    private func TryRewriteDeclaredProjectPath(
        value string?,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        out rewritten string?
    ) bool {
        let specs = value!!.Split(';')
        var changed = false
        for var i = 0; i < specs.Length; i++ {
            if TryRewriteDeclaredProjectPathSpec(
                specs[i],
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                out var rewrittenSpec
            ) {
                specs[i] = rewrittenSpec
                changed = true
            }
        }
        rewritten = if changed {
            string.Join(";", specs)
        } else {
            value
        }
        return changed
    }

    private func TryRewriteDeclaredProjectPathSpec(
        value string,
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        out rewritten string
    ) bool {
        rewritten = value
        let trimmed = value.Trim()
        if trimmed.Length == 0 || trimmed.Contains("$$(", StringComparison.Ordinal) || trimmed.Contains(
            "@(",
            StringComparison.Ordinal
        ) {
            return false
        }
        let sourcePath = Path.GetFullPath(Path.Combine(sourceProjectDirectory!!, NormalizeDirectorySeparators(trimmed)))
        if !generatedProjectPaths!!.TryGetValue(sourcePath, out var generatedPath) {
            return false
        }
        let relative = Path.GetRelativePath(destinationProjectDirectory!!, Path.GetFullPath(generatedPath)).Replace(
            '\\',
            '/'
        )
        let start = value.IndexOf(trimmed, StringComparison.Ordinal)
        rewritten = value.Substring(0, start) + relative + value.Substring(start + trimmed.Length)
        return true
    }

    private func TryRewriteExpressionCore(
        include XAttribute?,
        mappedExpressions IReadOnlySet[string],
        sourceProjectDirectory string?,
        destinationProjectDirectory string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) bool {
        let value string? = include!!.Value
        if !value!!.Contains("$$(", StringComparison.Ordinal) && !value!!.Contains("@(", StringComparison.Ordinal) &&
            !value!!.Contains(';') {
            return false
        }
        let specs = value!!.Split(';')
        var handled = false
        for var i = 0; i < specs.Length; i++ {
            if mappedExpressions.Contains(specs[i].Trim()) {
                handled = true
                continue
            }
            if TryMapProjectPathSpec(
                specs[i],
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                sourceRoot: nil,
                destinationRoot: nil,
                repositoryRootExpressions: nil,
                out var anchored
            ) {
                specs[i] = anchored!!
                handled = true
                continue
            }
            if TryRewriteDeclaredProjectPathSpec(
                specs[i],
                sourceProjectDirectory,
                destinationProjectDirectory,
                generatedProjectPaths,
                out var mapped
            ) {
                specs[i] = mapped
                handled = true
                continue
            }
            if specs[i].Contains("$$(", StringComparison.Ordinal) || specs[i].Contains("@(", StringComparison.Ordinal) {
                let rewritten = RewriteExpressionSpec(specs[i])
                handled |= !string.Equals(specs[i], rewritten, StringComparison.Ordinal)
                specs[i] = rewritten
            }
        }
        if handled {
            include!!.Value = string.Join(";", specs)
        }
        return handled
    }

    private func RewriteExpressionSpec(spec string) string {
        var start = 0
        while start < spec.Length && char.IsWhiteSpace(spec[start]) {
            start++
        }
        if start == spec.Length {
            return spec
        }
        var end = spec.Length - 1
        while end >= start && char.IsWhiteSpace(spec[end]) {
            end--
        }
        let leading = spec.Substring(0, start)
        let trailing = spec.Substring(end + 1)
        var value = spec.Substring(start, end - start + 1)
        if value.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) {
            value = value.Substring(0, value.Length - ".csproj".Length) + ".gsproj"
        } else if value.StartsWith("@(", StringComparison.Ordinal) && value.EndsWith(")", StringComparison.Ordinal) {
            value = value.Substring(0, value.Length - 1) + "->'%(RootDir)%(Directory)%(Filename).gsproj')"
        } else if value.StartsWith("$$(", StringComparison.Ordinal) && value.EndsWith(")", StringComparison.Ordinal) {
            value = "$$([System.IO.Path]::ChangeExtension('" + value + "', '.gsproj'))"
        }
        return leading + value + trailing
    }

    private func NormalizeDirectorySeparators(path string?) string -> path!!.Replace('\\', Path.DirectorySeparatorChar)
        .Replace('/', Path.DirectorySeparatorChar)
}
