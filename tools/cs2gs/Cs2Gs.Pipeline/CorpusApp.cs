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
    public CorpusApp(
        string id,
        string projectPath,
        TargetKind targetKind,
        string stdoutGolden = null,
        IReadOnlyList<string> referencedAssemblies = null)
    {
        this.Id = id ?? throw new ArgumentNullException(nameof(id));
        this.ProjectPath = projectPath ?? throw new ArgumentNullException(nameof(projectPath));
        this.TargetKind = targetKind;
        this.StdoutGolden = stdoutGolden;
        this.ReferencedAssemblies = referencedAssemblies ?? ImmutableArray<string>.Empty;
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
}
