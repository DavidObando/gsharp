// <copyright file="TranslateStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 1 (ADR-0115 §C): load the C# project, translate each document to
/// canonical G#, write the <c>.gs</c> set, and round-trip-parse every emitted
/// file with the real G# parser. Pass gate: every file parses AND zero
/// <see cref="TranslationSeverity.Unsupported"/> diagnostics. On failure the
/// category is <c>translation-unsupported</c> and the app short-circuits.
/// </summary>
public sealed class TranslateStage : IMigrationStage
{
    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.Translate;

    /// <inheritdoc/>
    public async Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        IReadOnlyList<LoadedCSharpProject> projects = context.Options.CompileViaSdk
            ? new[]
            {
                await CSharpProjectLoader.LoadProjectAsync(context.App.ProjectPath, cancellationToken)
                    .ConfigureAwait(false),
            }
            : await CSharpProjectLoader
                .LoadProjectWithReferencesAsync(context.App.ProjectPath, cancellationToken)
                .ConfigureAwait(false);
        LoadedCSharpProject project = projects[0];

        var artifacts = new List<TriageArtifact>();
        Directory.CreateDirectory(context.AppRunDir);

        // Issue #1742: a project that does not even bind in C# (missing SDK/
        // targets, an unresolved project reference, an unsupported TFM, ...)
        // must stop here — proceeding to translate produces only confusing
        // downstream binding errors instead of the real load failure. This is
        // scoped to the MSBuild workspace load failure signal specifically
        // (not every C# semantic error), since some corpus fixtures carry a
        // deliberate C# error to exercise a later stage (e.g. CompileGap-Library).
        if (project.WorkspaceLoadFailed)
        {
            artifacts.Add(context.Triage.ProjectLoadFailure(
                MigrationStageKind.Translate,
                TriageCategory.TranslationUnsupported,
                project.WorkspaceLoadErrors));
            return StageOutcome.Failed(artifacts);
        }

        var usedOutputPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CopyProjectFiles(project.ProjectDirectory, context.AppRunDir, usedOutputPaths);
        CopyCentralPackageManagementFile(project.ProjectDirectory, context.AppRunDir);
        context.PackageReferences.AddRange(
            DeclaredProjectItems.Read(context.App.ProjectPath, "PackageReference"));
        context.ProjectReferences.AddRange(
            DeclaredProjectItems.Read(context.App.ProjectPath, "ProjectReference"));

        // Translate the app itself (index 0) plus its transitively referenced
        // sibling projects (Refs #914). Sibling G# is emitted so the app's uses
        // of sibling types resolve at the gsc compile stage; those files are
        // flagged IsFromReferencedProject so the Compile stage attributes errors
        // only to the app's own files (a sibling's own gaps are measured in its
        // own run, not charged against every dependent).
        for (int projectIndex = 0; projectIndex < projects.Count; projectIndex++)
        {
            LoadedCSharpProject currentProject = projects[projectIndex];
            bool isReferencedProject = projectIndex > 0;

            // Capture the external (NuGet package) assemblies each project
            // resolved against so the Compile stage can add them to gsc's
            // reference set. Only on-disk file-backed references are recorded
            // here; the Compile stage further excludes any whose file name
            // collides with a framework assembly (ref-pack / runtime
            // double-identity) and stripped sibling outputs are already absent
            // from disk (Refs #914).
            foreach (PortableExecutableReference peReference in currentProject.Compilation.References
                .OfType<PortableExecutableReference>())
            {
                string referencePath = peReference.FilePath;
                if (!string.IsNullOrEmpty(referencePath) && File.Exists(referencePath))
                {
                    context.ExternalReferencePaths.Add(referencePath);
                }
            }

            // Issue #2215: only the app's OWN analyzer/generator references
            // (not a referenced sibling project's) drive gsc's /analyzer: —
            // a sibling's generators already ran in that sibling's own
            // migration run, so re-running them here would just duplicate
            // (or, worse, collide with) output that belongs to the sibling.
            if (!isReferencedProject)
            {
                context.RootNamespace = currentProject.RootNamespace;

                foreach (string analyzerPath in currentProject.AnalyzerReferencePaths)
                {
                    context.AnalyzerReferencePaths.Add(analyzerPath);
                }

                // Issue #2223: forward the app's non-source generator inputs
                // (.axaml) and project options so gsc's gsgen run materializes
                // file-driven generator output (e.g. Avalonia's InitializeComponent).
                foreach (string additionalFile in currentProject.AdditionalFiles)
                {
                    string copiedPath = MirroredPath(
                        additionalFile,
                        currentProject.ProjectDirectory,
                        context.AppRunDir);
                    string spec = File.Exists(copiedPath) ? copiedPath : additionalFile;
                    string ext = Path.GetExtension(additionalFile);
                    if (ext.Equals(".axaml", StringComparison.OrdinalIgnoreCase) ||
                        ext.Equals(".xaml", StringComparison.OrdinalIgnoreCase) ||
                        ext.Equals(".paml", StringComparison.OrdinalIgnoreCase))
                    {
                        spec += ";SourceItemGroup=AvaloniaXaml";
                    }

                    context.AdditionalGeneratorFiles.Add(spec);
                }

                if (context.AdditionalGeneratorFiles.Count > 0)
                {
                    if (!string.IsNullOrEmpty(currentProject.RootNamespace))
                    {
                        context.GeneratorGlobalOptions.Add("RootNamespace=" + currentProject.RootNamespace);
                    }

                    if (!string.IsNullOrEmpty(currentProject.ProjectDirectory))
                    {
                        context.GeneratorGlobalOptions.Add("ProjectDir=" + context.AppRunDir);
                    }
                }
            }

            // Issue #2215: a project with analyzer references may have had a
            // generator-produced partial part excluded from `Documents` (it is
            // recognized as generated, per `CSharpProjectLoader.
            // IsGeneratedSource`, so BuildDocuments never translates it on its
            // own) — so the translator must (a) keep the merged type `partial`
            // (gsc's own gsgen run adds the missing part back) and (b) NOT
            // merge that excluded part's members in here too (that would just
            // duplicate what gsgen produces, causing a GS0102 collision). Every
            // project with no analyzer references gets the exact prior
            // (unfiltered, non-partial-marking) translator behavior.
            bool hasAnalyzerReferences = currentProject.AnalyzerReferencePaths.Count > 0;
            List<string> retainedFilePaths = hasAnalyzerReferences
                ? currentProject.Documents.Select(d => d.FilePath).ToList()
                : null;
            var translator = new CSharpToGSharpTranslator(markMergedTypePartial: hasAnalyzerReferences, retainedFilePaths: retainedFilePaths);

            foreach (LoadedDocument document in currentProject.Documents)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var translationContext = new TranslationContext(
                    currentProject.Compilation,
                    document.SemanticModel,
                    document.FilePath);

                CompilationUnit unit = translator.TranslateDocument(document, translationContext);
                string printed = GSharpPrinter.Print(unit);

                string gsRelativePath = OutputPathForSource(
                    document.FilePath,
                    currentProject,
                    isReferencedProject,
                    usedOutputPaths);
                string gsPath = Path.Combine(context.AppRunDir, gsRelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(gsPath));
                File.WriteAllText(gsPath, printed);

                var declaredTypeNames = new List<string>();
                var baseClassNames = new List<string>();
                CollectTypeGraph(unit.Members, declaredTypeNames, baseClassNames);

                string relativeGsPath = MigrationPipeline.SanitizeAppId(context.App.Id) + "/" +
                    gsRelativePath.Replace(Path.DirectorySeparatorChar, '/');
                var emitted = new EmittedGsFile(
                    gsPath,
                    relativeGsPath,
                    document.FilePath,
                    printed,
                    declaredTypeNames,
                    baseClassNames)
                {
                    IsFromReferencedProject = isReferencedProject,
                };
                context.EmittedFiles.Add(emitted);

                // Only the app's own files gate the Translate stage and produce
                // triage artifacts; a referenced sibling's translation issues are
                // its own run's concern.
                if (isReferencedProject)
                {
                    continue;
                }

                foreach (TranslationDiagnostic diagnostic in translationContext.Diagnostics
                    .Where(d => d.Severity == TranslationSeverity.Unsupported))
                {
                    artifacts.Add(context.Triage.TranslationUnsupported(diagnostic));
                }

                RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
                if (!roundTrip.Success)
                {
                    artifacts.Add(context.Triage.RoundTripFailure(
                        emitted,
                        roundTrip.Errors.FirstOrDefault() ?? "unknown parse error"));
                }
            }

            // Issue #2200: generate each .resx's strongly-typed codebehind via the
            // shared GSharp.Core.Resx generator instead of translating a
            // hand-authored Resources.Designer.cs (which BuildDocuments already
            // skips above as generated source, via its <auto-generated> header).
            // Without this, a `using R = ...Resources;` alias in the migrated
            // source cannot resolve (GS0157), cascading into GS0159 errors.
            foreach (string resxPath in currentProject.ResxFiles)
            {
                cancellationToken.ThrowIfCancellationRequested();

                string generated;
                try
                {
                    generated = GSharp.Core.Resx.ResxCodeGenerator.GenerateFromFile(
                        resxPath,
                        currentProject.ProjectDirectory,
                        currentProject.RootNamespace);
                }
                catch (Exception ex) when (ex is IOException or System.Xml.XmlException or UnauthorizedAccessException)
                {
                    // A malformed/unreadable .resx must not crash the whole
                    // Translate stage; report it (for the app's own project
                    // only, mirroring the translation-diagnostics gate below)
                    // and move on to the remaining files.
                    if (!isReferencedProject)
                    {
                        artifacts.Add(context.Triage.StageCrash(
                            MigrationStageKind.Translate, TriageCategory.TranslationUnsupported, "CS2GS0003", ex));
                    }

                    continue;
                }

                string className = Path.GetFileNameWithoutExtension(resxPath);

                string gsRelativePath = OutputPathForResx(
                    resxPath,
                    currentProject,
                    isReferencedProject,
                    usedOutputPaths);
                string gsPath = Path.Combine(context.AppRunDir, gsRelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(gsPath));
                File.WriteAllText(gsPath, generated);

                string relativeGsPath = MigrationPipeline.SanitizeAppId(context.App.Id) + "/" +
                    gsRelativePath.Replace(Path.DirectorySeparatorChar, '/');
                var emittedResx = new EmittedGsFile(
                    gsPath,
                    relativeGsPath,
                    resxPath,
                    generated,
                    new[] { className },
                    Array.Empty<string>())
                {
                    IsFromReferencedProject = isReferencedProject,
                };
                context.EmittedFiles.Add(emittedResx);

                if (isReferencedProject)
                {
                    continue;
                }

                RoundTripResult resxRoundTrip = GSharpRoundTrip.Validate(generated);
                if (!resxRoundTrip.Success)
                {
                    artifacts.Add(context.Triage.RoundTripFailure(
                        emittedResx,
                        resxRoundTrip.Errors.FirstOrDefault() ?? "unknown parse error"));
                }
            }
        }

        // Issue #2225: nbgv only generates the `ThisAssembly` source for the
        // languages its MSBuild `<Language>` switch supports; G# first shipped in
        // 3.11.13-beta. If the migrated project references an older nbgv it would
        // silently drop `ThisAssembly`. Emit a bumped copy of whichever project /
        // props file pins a below-floor nbgv literal (source is never mutated).
        EmitNerdbankGitVersioningBumps(context);

        return artifacts.Count == 0 ? StageOutcome.Passed() : StageOutcome.Failed(artifacts);
    }

    private static void CopyProjectFiles(
        string projectDirectory,
        string outputDirectory,
        ISet<string> usedOutputPaths)
    {
        if (string.IsNullOrEmpty(projectDirectory) || !Directory.Exists(projectDirectory))
        {
            return;
        }

        foreach (string sourcePath in Directory.EnumerateFiles(projectDirectory, "*", SearchOption.AllDirectories))
        {
            string relativePath = Path.GetRelativePath(projectDirectory, sourcePath);
            if (HasExcludedDirectory(relativePath) ||
                Path.GetExtension(sourcePath).Equals(".cs", StringComparison.OrdinalIgnoreCase) ||
                Path.GetExtension(sourcePath).Equals(".csproj", StringComparison.OrdinalIgnoreCase) ||
                IsUnderDirectory(sourcePath, outputDirectory))
            {
                continue;
            }

            string destinationPath = Path.Combine(outputDirectory, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath));
            File.Copy(sourcePath, destinationPath, overwrite: true);
            usedOutputPaths.Add(relativePath);
        }
    }

    private static void CopyCentralPackageManagementFile(string projectDirectory, string outputDirectory)
    {
        string directory = projectDirectory;
        while (!string.IsNullOrEmpty(directory))
        {
            string sourcePath = Path.Combine(directory, "Directory.Packages.props");
            if (File.Exists(sourcePath))
            {
                File.Copy(
                    sourcePath,
                    Path.Combine(outputDirectory, "Directory.Packages.props"),
                    overwrite: true);
                return;
            }

            directory = Directory.GetParent(directory)?.FullName;
        }
    }

    private static string OutputPathForSource(
        string sourcePath,
        LoadedCSharpProject project,
        bool isReferencedProject,
        ISet<string> usedOutputPaths)
    {
        string relativePath = RelativeSourcePath(sourcePath, project.ProjectDirectory);
        relativePath = Path.ChangeExtension(relativePath, ".gs");
        return UniqueOutputPath(PrefixReferencedProject(relativePath, project, isReferencedProject), usedOutputPaths);
    }

    private static string OutputPathForResx(
        string sourcePath,
        LoadedCSharpProject project,
        bool isReferencedProject,
        ISet<string> usedOutputPaths)
    {
        string relativePath = RelativeSourcePath(sourcePath, project.ProjectDirectory);
        string directory = Path.GetDirectoryName(relativePath);
        string fileName = Path.GetFileNameWithoutExtension(relativePath) +
            GSharp.Core.Resx.ResxCodeGenerator.DesignerFileSuffix;
        relativePath = string.IsNullOrEmpty(directory) ? fileName : Path.Combine(directory, fileName);
        return UniqueOutputPath(PrefixReferencedProject(relativePath, project, isReferencedProject), usedOutputPaths);
    }

    private static string PrefixReferencedProject(
        string relativePath,
        LoadedCSharpProject project,
        bool isReferencedProject)
    {
        if (!isReferencedProject)
        {
            return relativePath;
        }

        string projectName = project.Compilation.AssemblyName ?? "ReferencedProject";
        foreach (char invalid in Path.GetInvalidFileNameChars())
        {
            projectName = projectName.Replace(invalid, '_');
        }

        return Path.Combine(".references", projectName, relativePath);
    }

    private static string RelativeSourcePath(string sourcePath, string projectDirectory)
    {
        string relativePath = Path.GetRelativePath(projectDirectory, sourcePath);
        return IsOutsideDirectory(relativePath) ? Path.GetFileName(sourcePath) : relativePath;
    }

    private static string UniqueOutputPath(string relativePath, ISet<string> usedOutputPaths)
    {
        if (usedOutputPaths.Add(relativePath))
        {
            return relativePath;
        }

        string directory = Path.GetDirectoryName(relativePath);
        string extension = Path.GetExtension(relativePath);
        string baseName = Path.GetFileNameWithoutExtension(relativePath);
        for (int suffix = 2; ; suffix++)
        {
            string fileName = baseName + "." + suffix + extension;
            string candidate = string.IsNullOrEmpty(directory) ? fileName : Path.Combine(directory, fileName);
            if (usedOutputPaths.Add(candidate))
            {
                return candidate;
            }
        }
    }

    private static string MirroredPath(string sourcePath, string projectDirectory, string outputDirectory)
    {
        string relativePath = Path.GetRelativePath(projectDirectory, sourcePath);
        return IsOutsideDirectory(relativePath) ? sourcePath : Path.Combine(outputDirectory, relativePath);
    }

    private static bool HasExcludedDirectory(string relativePath)
    {
        string[] segments = relativePath.Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
            StringSplitOptions.RemoveEmptyEntries);
        return segments.Any(s =>
            s.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
            s.Equals("obj", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsOutsideDirectory(string relativePath) =>
        Path.IsPathRooted(relativePath) ||
        relativePath.Equals("..", StringComparison.Ordinal) ||
        relativePath.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
        relativePath.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal);

    private static bool IsUnderDirectory(string path, string directory)
    {
        string relativePath = Path.GetRelativePath(directory, path);
        return !IsOutsideDirectory(relativePath);
    }

    /// <summary>
    /// Scans the app's own <c>.csproj</c> plus every ancestor
    /// <c>Directory.Packages.props</c>/<c>Directory.Build.props</c> for a literal
    /// <c>Nerdbank.GitVersioning</c> version below
    /// <see cref="NerdbankGitVersioningPolicy.MinimumGSharpVersion"/> and, when
    /// found, writes a bumped copy into <c>&lt;AppRunDir&gt;/nbgv-bump/</c> alongside
    /// a manifest recording the source path. The original files are never touched
    /// (the corpus tree is read-only); the migrated project can adopt the bumped
    /// file so nbgv produces the G# <c>ThisAssembly</c> source (issue #2225).
    /// Also resolves, across the same candidate set, the nbgv package's effective
    /// id/version/<c>PrivateAssets</c>/<c>IncludeAssets</c> declaration and — when
    /// found — records it on <see cref="StageExecutionContext.BuildOnlyPackageReferences"/>
    /// so the <c>--via-sdk</c> compile path can re-declare it in the isolated
    /// gsproj (issue #2267): nbgv is a build/dev-only dependency that contributes
    /// no compile-time reference DLL, so it would otherwise be silently dropped
    /// and its <c>ThisAssembly</c> source generator would never run.
    /// </summary>
    private static void EmitNerdbankGitVersioningBumps(StageExecutionContext context)
    {
        var candidates = new List<string>();
        string projectPath = context.App.ProjectPath;
        if (!string.IsNullOrEmpty(projectPath) && File.Exists(projectPath))
        {
            candidates.Add(projectPath);
        }

        string dir = Path.GetDirectoryName(projectPath);
        while (!string.IsNullOrEmpty(dir))
        {
            foreach (string name in new[] { "Directory.Packages.props", "Directory.Build.props" })
            {
                string candidate = Path.Combine(dir, name);
                if (File.Exists(candidate))
                {
                    candidates.Add(candidate);
                }
            }

            DirectoryInfo parent = Directory.GetParent(dir);
            dir = parent?.FullName;
        }

        string outputDir = null;
        var manifest = new List<string>();
        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool nbgvFound = false;
        string rawVersion = null;
        string privateAssets = null;
        string includeAssets = null;
        foreach (string candidate in candidates)
        {
            string original;
            try
            {
                original = File.ReadAllText(candidate);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            // Issue #2267: combine the nbgv declaration across every candidate
            // file — CPM commonly splits it between a versionless
            // <PackageReference PrivateAssets="all"> (project/Directory.Build.props)
            // and the actual <PackageVersion Version="..."> (Directory.Packages.props).
            if (NerdbankGitVersioningPolicy.TryFindDeclaration(
                original, out string candidateVersion, out string candidatePrivateAssets, out string candidateIncludeAssets))
            {
                nbgvFound = true;
                rawVersion ??= candidateVersion;
                privateAssets ??= candidatePrivateAssets;
                includeAssets ??= candidateIncludeAssets;
            }

            if (!NerdbankGitVersioningPolicy.TryBumpProjectXml(original, out string bumped))
            {
                continue;
            }

            if (outputDir is null)
            {
                outputDir = Path.Combine(context.AppRunDir, "nbgv-bump");
                Directory.CreateDirectory(outputDir);
            }

            string baseName = Path.GetFileName(candidate);
            string outName = baseName;
            int suffix = 1;
            while (!usedNames.Add(outName))
            {
                outName = Path.GetFileNameWithoutExtension(baseName) + "." + suffix + Path.GetExtension(baseName);
                suffix++;
            }

            File.WriteAllText(Path.Combine(outputDir, outName), bumped);
            manifest.Add(outName + " <- " + candidate);
        }

        if (outputDir is not null && manifest.Count > 0)
        {
            string manifestText =
                "# Nerdbank.GitVersioning bumped to " + NerdbankGitVersioningPolicy.MinimumGSharpVersion
                + " for G# ThisAssembly support (issue #2225)." + Environment.NewLine
                + "# Each line: <emitted file> <- <original source file>." + Environment.NewLine
                + string.Join(Environment.NewLine, manifest) + Environment.NewLine;
            File.WriteAllText(Path.Combine(outputDir, "manifest.txt"), manifestText);
        }

        if (nbgvFound)
        {
            context.BuildOnlyPackageReferences.Add(new DeclaredPackageReference(
                NerdbankGitVersioningPolicy.PackageId,
                NerdbankGitVersioningPolicy.ResolveEffectiveVersion(rawVersion),
                privateAssets ?? "all",
                includeAssets));
        }
    }

    /// <summary>
    /// Walks the emitted declarations of one file, recording the simple names of
    /// the types declared (including nested types) and the simple names of the
    /// base classes they extend. This drives the base-before-subclass compile
    /// ordering in <see cref="CompileStage"/>.
    /// </summary>
    private static void CollectTypeGraph(
        IReadOnlyList<GNode> members,
        List<string> declaredTypeNames,
        List<string> baseClassNames)
    {
        if (members is null)
        {
            return;
        }

        foreach (GNode member in members)
        {
            if (member is TypeDeclaration type)
            {
                declaredTypeNames.Add(type.Name);
                if (type.BaseType is NamedTypeReference baseRef)
                {
                    baseClassNames.Add(SimpleName(baseRef.Name));
                }

                // Implemented interfaces are dependencies too: gsc's interface-
                // satisfaction binding is order-sensitive, so a type must be
                // compiled after the interfaces it declares (CompileStage ordering).
                foreach (GTypeReference iface in type.Interfaces)
                {
                    if (iface is NamedTypeReference ifaceRef)
                    {
                        baseClassNames.Add(SimpleName(ifaceRef.Name));
                    }
                }

                CollectTypeGraph(type.Members, declaredTypeNames, baseClassNames);
            }
        }
    }

    /// <summary>Returns the last dotted segment of a (possibly qualified) name.</summary>
    private static string SimpleName(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        int dot = name.LastIndexOf('.');
        return dot >= 0 ? name.Substring(dot + 1) : name;
    }
}
