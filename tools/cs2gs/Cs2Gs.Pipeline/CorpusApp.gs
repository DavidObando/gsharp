// <copyright file="CorpusApp.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Collections.Immutable

/// An immutable descriptor of one corpus app the pipeline migrates: its stable
/// id (e.g. `corpus/L1-Console`), the C# `.csproj` to load, the G#
/// target kind, an optional captured-stdout golden, and any sibling corpus
/// assemblies it references (ADR-0115 §C/§E).
class CorpusApp {
    /// Initializes a new instance of the (cref:CorpusApp) class.
    /// @param id The stable corpus app id (e.g. `corpus/L1-Console`).
    /// @param projectPath The absolute path to the app's C# `.csproj`.
    /// @param targetKind The G# output kind (exe or library).
    /// @param stdoutGolden The optional captured-stdout golden file path.
    /// @param referencedAssemblies The optional sibling assemblies passed via `/reference:`.
    /// @param testsProjectPath The optional sibling C# `.Tests` project (library xUnit parity).
    /// @param testsBaselinePath The optional sibling `baseline.tests.json` oracle path.
    /// @param allowUnsafeIl Whether stage 3 (ilverify) should treat this app's known-unverifiable
    /// unsafe IL (pointer writes, `fixed`, `stackalloc`) as an
    /// expected, non-gating result rather than an `ilverify-failure`
    /// (issue #1933). Mirrors (cref:IlVerifyRunner.KnownIlVerifyFalsePositives)
    /// but is opt-in per app since unverifiable-by-design unsafe IL, unlike a
    /// verifier false positive, is not universally true of every corpus app.
    /// @param allowUnsafeIlTypes The fixture type names (from the marker file's non-blank lines) whose
    /// unverifiable IL is expected (issue #1985). Empty means "whole app" —
    /// back-compat with the original per-app marker for apps (e.g. G12,
    /// wholly unsafe by design) where every fixture may legitimately produce
    /// unverifiable IL.
    /// @param relativeProjectPath The project path relative to the repository root, or `null`
    /// for legacy corpus descriptors.
    init(
        id string,
        projectPath string,
        targetKind TargetKind,
        stdoutGolden string? = nil,
        referencedAssemblies IReadOnlyList[string]? = nil,
        testsProjectPath string? = nil,
        testsBaselinePath string? = nil,
        allowUnsafeIl bool = false,
        allowUnsafeIlTypes IReadOnlyList[string]? = nil,
        relativeProjectPath string? = nil
    ) {
        this.Id = id ?? throw ArgumentNullException("id")
        this.ProjectPath = projectPath ?? throw ArgumentNullException("projectPath")
        this.TargetKind = targetKind
        this.StdoutGolden = stdoutGolden
        this.ReferencedAssemblies = referencedAssemblies ?? ImmutableArray[string].Empty
        this.TestsProjectPath = testsProjectPath
        this.TestsBaselinePath = testsBaselinePath
        this.AllowUnsafeIl = allowUnsafeIl
        this.AllowUnsafeIlTypes = allowUnsafeIlTypes ?? ImmutableArray[string].Empty
        this.RelativeProjectPath = relativeProjectPath
    }

    /// Gets the stable corpus app id.
    prop Id string {
        get;
    }

    /// Gets the absolute path to the app's C# `.csproj`.
    prop ProjectPath string {
        get;
    }

    /// Gets the G# output kind (exe or library).
    prop TargetKind TargetKind {
        get;
    }

    /// Gets the optional captured-stdout golden file path.
    prop StdoutGolden string? {
        get;
    }

    /// Gets the sibling assemblies to pass via `/reference:`.
    prop ReferencedAssemblies IReadOnlyList[string] {
        get;
    }

    /// Gets the sibling C# `.Tests` project path used for stage-4 library
    /// xUnit parity, or `null` when the app has no test oracle
    /// (e.g. an executable verified by stdout parity).
    prop TestsProjectPath string? {
        get;
    }

    /// Gets the sibling `baseline.tests.json` oracle path used for stage-4
    /// library xUnit parity, or `null` when absent.
    prop TestsBaselinePath string? {
        get;
    }

    /// Gets a value indicating whether stage 3 (ilverify) should treat this
    /// app's known-unverifiable unsafe IL as expected rather than gating
    /// (issue #1933). Set from a sibling `ilverify.allow-unsafe` marker
    /// file (see (cref:CorpusDiscovery)).
    prop AllowUnsafeIl bool {
        get;
    }

    /// Gets the fixture type names the `ilverify.allow-unsafe` marker
    /// scopes (cref:AllowUnsafeIl) to (one per non-blank marker-file
    /// line), or empty for the whole-app allowance (issue #1985).
    prop AllowUnsafeIlTypes IReadOnlyList[string] {
        get;
    }

    /// Gets the project path relative to the repository root in repository
    /// layout, or `null` for legacy corpus descriptors.
    prop RelativeProjectPath string? {
        get;
    }
}
