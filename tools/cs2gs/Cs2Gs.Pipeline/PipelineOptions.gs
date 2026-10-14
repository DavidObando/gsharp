// <copyright file="PipelineOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic

/// Controls how migration output is arranged on disk.
enum MigrationOutputLayout {
    Repository,
    DiagnosticRun
}

/// Whole-run options for a (cref:MigrationPipeline) execution: the
/// optional `gsc` override, the runs-root output directory, and the build
/// configuration used to discover the default compiler (ADR-0115 §C).
class PipelineOptions {
    init() {
        ExcludeAppIdPrefixes = List[string]()
        PassthroughAppIdPrefixes = List[string]()
        ExcludedProjectPaths = List[string]()
        PassthroughProjectPaths = List[string]()
    }

    /// Gets or sets the explicit `gsc.dll` path. When `null`
    /// the pipeline discovers `out/bin/<Config>/Compiler/gsc.dll` by
    /// walking up from the working directory.
    prop GscPath string?

    /// Gets or sets the explicit `gsgen.dll` path (issue #2215), forwarded
    /// to gsc via `/gsgentool:` whenever an app has analyzer references.
    /// When `null` the pipeline discovers
    /// `out/bin/<Config>/Gsgen.Cli/gsgen.dll` the same way it
    /// discovers (cref:GscPath).
    prop GsgenPath string?

    /// Gets or sets the destination repository in repository layout, or the
    /// runs-root directory in diagnostic layout.
    prop OutputRoot string?

    /// Gets or sets the runs-root used for logs, triage records, reports, and
    /// build intermediates in repository layout. Ignored in diagnostic layout.
    prop ArtifactRoot string?

    /// Gets or sets the output layout. Programmatic pipeline callers retain
    /// diagnostic layout unless they explicitly request repository mirroring.
    private var _outputLayout MigrationOutputLayout = MigrationOutputLayout.DiagnosticRun

    prop OutputLayout MigrationOutputLayout {
        get {
            return _outputLayout
        }
        set {
            _outputLayout = value
        }
    }

    /// Gets or sets the source directory being migrated.
    prop SourceRoot string?

    /// Gets repository-relative app-id prefixes excluded from repository
    /// migration (issue #3501 corpus hygiene: e2e fixtures such as
    /// `samples/ProjectRef/CSharpApp` are not migration targets).
    /// Matched with an ordinal prefix comparison against the discovered
    /// app id.
    prop ExcludeAppIdPrefixes List[string] {
        get;
    }

    /// Gets repository-relative app-id prefixes excluded from translation but
    /// preserved as their original C# projects in a repository mirror.
    prop PassthroughAppIdPrefixes List[string] {
        get;
    }

    /// Gets the absolute `.csproj` paths of the apps that
    /// (cref:ExcludeAppIdPrefixes) filtered out of this run (issue
    /// #3580). The orphan-mirror step skips checked-in sources these projects
    /// compile — files under their directories and their explicit
    /// `<Compile Include>` links (e.g. `test/Shared/*`): they
    /// are out of the run's scope, not repository orphans, and standalone
    /// translation of them is not meaningful.
    prop ExcludedProjectPaths List[string] {
        get;
    }

    /// Gets the absolute `.csproj` paths excluded from translation but
    /// copied into the mirror with their checked-in C# sources.
    prop PassthroughProjectPaths List[string] {
        get;
    }

    /// Gets or sets the build configuration used to locate the default compiler
    /// (`Release` by default).
    private var _config string = "Release"

    prop Config string {
        get {
            return _config
        }
        set {
            _config = value
        }
    }

    /// Gets or sets the exact `Gsharp.NET.Sdk` version a repository
    /// migration pins (`--sdk-version`). When `null` the
    /// newest locally-built nupkg is pinned. An explicit version is never
    /// displaced by a newer local build: it is how a migration is pinned to a
    /// published release (for example the compiler's own cut-over translation,
    /// which must build against the released bootstrap compiler).
    prop SdkVersion string?

    /// Gets or sets where a repository migration writes the SDK pin
    /// (`--sdk-pin`). (cref:SdkPinLocation.GlobalJson) pins the
    /// version once in the mirror's `global.json` and leaves every
    /// generated project's `Sdk` attribute bare. `validate` ignores
    /// this and follows the migrated tree: a tree whose `global.json`
    /// pins `Gsharp.NET.Sdk` is validated in that mode.
    private var _sdkPinLocation SdkPinLocation = SdkPinLocation.ProjectFile

    prop SdkPinLocation SdkPinLocation {
        get {
            return _sdkPinLocation
        }
        set {
            _sdkPinLocation = value
        }
    }

    /// Gets or sets a value indicating whether stage 2 compiles the emitted G#
    /// via `dotnet build` against the locally-built `Gsharp.NET.Sdk`
    /// instead of invoking `gsc` directly (issue #2261). The SDK build
    /// runs Roslyn source generators (e.g. CommunityToolkit.Mvvm's
    /// `[ObservableProperty]`/`[RelayCommand]`) through its gsgen
    /// MSBuild targets, which the direct-gsc path does not — the dominant
    /// remaining Oahu-migration blocker. Defaults to `true`;
    /// callers can explicitly disable it to use the legacy gsc-direct path.
    private var _compileViaSdk bool = true

    prop CompileViaSdk bool {
        get {
            return _compileViaSdk
        }
        set {
            _compileViaSdk = value
        }
    }

    /// Gets or sets a value indicating whether emitted G# is passed through
    /// the ADR-0179 canonical formatter. Enabled by default since phase 7b:
    /// the formatter, not (cref:Cs2Gs.CodeModel.Printing.GSharpPrinter),
    /// owns where a line breaks. Formatter failures preserve the printer output
    /// and produce a `CS2GS-ROUNDTRIP` triage artifact, so the file is
    /// never lost and the defect is never silent; measured over the whole
    /// self-migration corpus (3,905 `.gs` files) the failure count is 0.
    /// `--no-format` restores the printer layout for A/B measurement.
    private var _formatOutput bool = true

    prop FormatOutput bool {
        get {
            return _formatOutput
        }
        set {
            _formatOutput = value
        }
    }

    /// Gets or sets how the translator treats C# `#if`/`#elif`
    /// directives. The default rejects them, which fails the Translate stage.
    /// `--allow-conditional-compilation` downgrades each one to a
    /// forwarded `CS2GS-CONDITIONAL-COMPILATION` warning; it exists only
    /// for a pinned external corpus that this repository cannot edit.
    /// It applies to the Translate stage's project sources only. Every other
    /// translation (a library's `.Tests` project in test parity, an
    /// orphan source, an analyzer test snippet) still rejects `#if`, so
    /// no path keeps one arm without a diagnostic.
    prop ConditionalCompilation ConditionalCompilationPolicy

    /// Gets or sets the test-parity failure allow-list (issue #3885): the
    /// individually-named migrated tests whose failure is a policy exclusion
    /// rather than a defect, so an app whose failing set is a SUBSET of it still
    /// reports green. `null` is treated as
    /// (cref:TestParityAllowList.Empty) — every failure fails the app.
    prop TestParityAllowList TestParityAllowList?

    /// Gets or sets the directory holding one (cref:CSharpTestOracle)
    /// per mirrored test project (issue #4633). When set, a mirrored test
    /// project must match its C# original NAME FOR NAME, and a missing oracle
    /// file fails the app. When `null`, the stage keeps the
    /// count-only check and records `count-only` in the run record;
    /// `cs2gs validate` refuses to run that way unless explicitly told to.
    prop CSharpTestOracleDirectory string?

    /// Gets or sets the justified per-test-name differences (issue #4633).
    /// `null` is treated as (cref:TestNameParityBaseline.Empty).
    prop TestNameParityBaseline TestNameParityBaseline?

    /// Gets or sets a value indicating whether the run stops before the final stage, so a passing app is
    /// recorded as unverified instead of green (issue #4853).
    prop PartialRun bool

    /// Gets or sets the canonical source-project to generated-project mapping
    /// established before migration starts.
    internal prop GeneratedProjectPaths IReadOnlyDictionary[string, string]?

    /// Gets or sets the inventoried checked-in C# source paths.
    internal prop RepositorySourceFiles IReadOnlyCollection[string]?

    /// Gets or sets repository source paths and their emitted G# text.
    internal prop RepositoryTranslations IDictionary[string, string]?

    /// Gets or sets source projects loaded once for repository-wide analysis.
    internal prop RepositoryLoadedProjects IReadOnlyDictionary[string, LoadedCSharpProject]?

    /// Gets or sets the pinned SDK moniker (the generated projects' `Sdk`
    /// attribute value) used by repository project transforms. Resolved once
    /// per run by (cref:MigrationPipeline) (migrate and validate alike)
    /// and consumed unchanged by every stage.
    internal prop RepositorySdkMoniker string?

    /// Gets or sets the resolved repository SDK version used by isolated parity projects.
    internal prop RepositorySdkVersion string?

    /// Gets or sets the resolved version of the locally-built
    /// `GSharp.CodeAnalysis.Analyzers.Testing` package (issue #3780),
    /// used as the `PackageReference` version for any repository project
    /// that turns out to be an analyzer test project. `null`
    /// when no local nupkg was found; that is only an error if a project
    /// actually needs it (checked at the point of use).
    internal prop RepositoryAnalyzerVerifierPackageVersion string?

    /// Gets or sets extra G# files required when one C# file declares multiple namespaces.
    internal prop RepositoryAdditionalFiles ISet[string]?

    /// Gets or sets the translated `.gs` paths this repository run already wrote, with their source and
    /// text (issue #4850).
    internal prop RepositoryEmittedOutputs IDictionary[string, (Source string, Text string)]?

    /// Gets or sets the absolute project paths that another app in this run
    /// declares a compile `ProjectReference` to (issue #3645). An
    /// executable app in this set keeps its entry-point class as a real G#
    /// class instead of flattening it to top-level statements — a referencing
    /// project consumes the entry class as an ordinary CLR type, and
    /// flattening would erase it from the migrated assembly (GS0157 at every
    /// cross-project use site).
    internal prop ProjectsReferencedByOtherApps IReadOnlyCollection[string]?
}
