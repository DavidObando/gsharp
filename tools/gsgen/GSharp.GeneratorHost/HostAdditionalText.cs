// <copyright file="HostAdditionalText.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §C: a file-backed <see cref="AdditionalText"/> forwarded to the
/// generator driver so generators that consume non-source inputs (e.g.
/// Avalonia's <c>.axaml</c> XAML → <c>InitializeComponent</c> generator, issue
/// #2223) can read them. Each instance also carries the MSBuild item metadata
/// (<c>build_metadata.AdditionalFiles.*</c>) the generator's
/// <see cref="Microsoft.CodeAnalysis.Diagnostics.AnalyzerConfigOptions"/> lookup
/// needs — most importantly <c>SourceItemGroup</c> (e.g. <c>AvaloniaXaml</c>),
/// which is how such a generator recognizes a file as its own input.
/// </summary>
public sealed class HostAdditionalText : AdditionalText
{
    private readonly string resolvedPath;

    /// <summary>
    /// Initializes a new instance of the <see cref="HostAdditionalText"/> class.
    /// </summary>
    /// <param name="path">The path to the additional file on disk.</param>
    /// <param name="metadata">The <c>build_metadata.AdditionalFiles.*</c> pairs for this file (case-insensitive keys).</param>
    public HostAdditionalText(string path, IReadOnlyDictionary<string, string> metadata = null)
    {
        ArgumentNullException.ThrowIfNull(path);
        this.resolvedPath = System.IO.Path.GetFullPath(path);
        this.Metadata = metadata ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    /// <inheritdoc/>
    public override string Path => this.resolvedPath;

    /// <summary>Gets the <c>build_metadata.AdditionalFiles.*</c> pairs for this file.</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; }

    /// <inheritdoc/>
    public override SourceText GetText(System.Threading.CancellationToken cancellationToken = default)
    {
        using var stream = File.OpenRead(this.resolvedPath);
        return SourceText.From(stream);
    }
}
