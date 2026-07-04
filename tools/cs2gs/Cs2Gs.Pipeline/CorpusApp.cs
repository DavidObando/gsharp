// <copyright file="CorpusApp.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;

namespace Cs2Gs.Pipeline;

/// <summary>
/// An immutable descriptor of one corpus app the pipeline migrates: its stable
/// id (e.g. <c>corpus/L1-Console</c>), the C# <c>.csproj</c> to load, the G#
/// target kind, an optional captured-stdout golden, and any sibling corpus
/// assemblies it references (ADR-0115 §C/§E).
/// </summary>
public sealed class CorpusApp
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CorpusApp"/> class.
    /// </summary>
    /// <param name="id">The stable corpus app id (e.g. <c>corpus/L1-Console</c>).</param>
    /// <param name="projectPath">The absolute path to the app's C# <c>.csproj</c>.</param>
    /// <param name="targetKind">The G# output kind (exe or library).</param>
    /// <param name="stdoutGolden">The optional captured-stdout golden file path.</param>
    /// <param name="referencedAssemblies">The optional sibling assemblies passed via <c>/reference:</c>.</param>
    /// <param name="testsProjectPath">The optional sibling C# <c>.Tests</c> project (library xUnit parity).</param>
    /// <param name="testsBaselinePath">The optional sibling <c>baseline.tests.json</c> oracle path.</param>
    /// <param name="allowUnsafeIl">
    /// Whether stage 3 (ilverify) should treat this app's known-unverifiable
    /// unsafe IL (pointer writes, <c>fixed</c>, <c>stackalloc</c>) as an
    /// expected, non-gating result rather than an <c>ilverify-failure</c>
    /// (issue #1933). Mirrors <see cref="IlVerifyRunner.KnownIlVerifyFalsePositives"/>
    /// but is opt-in per app since unverifiable-by-design unsafe IL, unlike a
    /// verifier false positive, is not universally true of every corpus app.
    /// </param>
    /// <param name="allowUnsafeIlTypes">
    /// The fixture type names (from the marker file's non-blank lines) whose
    /// unverifiable IL is expected (issue #1985). Empty means "whole app" —
    /// back-compat with the original per-app marker for apps (e.g. G12,
    /// wholly unsafe by design) where every fixture may legitimately produce
    /// unverifiable IL.
    /// </param>
    public CorpusApp(
        string id,
        string projectPath,
        TargetKind targetKind,
        string stdoutGolden = null,
        IReadOnlyList<string> referencedAssemblies = null,
        string testsProjectPath = null,
        string testsBaselinePath = null,
        bool allowUnsafeIl = false,
        IReadOnlyList<string> allowUnsafeIlTypes = null)
    {
        this.Id = id ?? throw new ArgumentNullException(nameof(id));
        this.ProjectPath = projectPath ?? throw new ArgumentNullException(nameof(projectPath));
        this.TargetKind = targetKind;
        this.StdoutGolden = stdoutGolden;
        this.ReferencedAssemblies = referencedAssemblies ?? ImmutableArray<string>.Empty;
        this.TestsProjectPath = testsProjectPath;
        this.TestsBaselinePath = testsBaselinePath;
        this.AllowUnsafeIl = allowUnsafeIl;
        this.AllowUnsafeIlTypes = allowUnsafeIlTypes ?? ImmutableArray<string>.Empty;
    }

    /// <summary>Gets the stable corpus app id.</summary>
    public string Id { get; }

    /// <summary>Gets the absolute path to the app's C# <c>.csproj</c>.</summary>
    public string ProjectPath { get; }

    /// <summary>Gets the G# output kind (exe or library).</summary>
    public TargetKind TargetKind { get; }

    /// <summary>Gets the optional captured-stdout golden file path.</summary>
    public string StdoutGolden { get; }

    /// <summary>Gets the sibling assemblies to pass via <c>/reference:</c>.</summary>
    public IReadOnlyList<string> ReferencedAssemblies { get; }

    /// <summary>
    /// Gets the sibling C# <c>.Tests</c> project path used for stage-4 library
    /// xUnit parity, or <see langword="null"/> when the app has no test oracle
    /// (e.g. an executable verified by stdout parity).
    /// </summary>
    public string TestsProjectPath { get; }

    /// <summary>
    /// Gets the sibling <c>baseline.tests.json</c> oracle path used for stage-4
    /// library xUnit parity, or <see langword="null"/> when absent.
    /// </summary>
    public string TestsBaselinePath { get; }

    /// <summary>
    /// Gets a value indicating whether stage 3 (ilverify) should treat this
    /// app's known-unverifiable unsafe IL as expected rather than gating
    /// (issue #1933). Set from a sibling <c>ilverify.allow-unsafe</c> marker
    /// file (see <see cref="CorpusDiscovery"/>).
    /// </summary>
    public bool AllowUnsafeIl { get; }

    /// <summary>
    /// Gets the fixture type names the <c>ilverify.allow-unsafe</c> marker
    /// scopes <see cref="AllowUnsafeIl"/> to (one per non-blank marker-file
    /// line), or empty for the whole-app allowance (issue #1985).
    /// </summary>
    public IReadOnlyList<string> AllowUnsafeIlTypes { get; }
}
