// <copyright file="HostAdditionalText.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Threading

/// ADR-0145 §C: a file-backed (cref:AdditionalText) forwarded to the
/// generator driver so generators that consume non-source inputs (e.g.
/// Avalonia's `.axaml` XAML → `InitializeComponent` generator, issue
/// #2223) can read them. Each instance also carries the MSBuild item metadata
/// (`build_metadata.AdditionalFiles.*`) the generator's
/// (cref:Microsoft.CodeAnalysis.Diagnostics.AnalyzerConfigOptions) lookup
/// needs — most importantly `SourceItemGroup` (e.g. `AvaloniaXaml`),
/// which is how such a generator recognizes a file as its own input.
class HostAdditionalText : AdditionalText {
    private let resolvedPath string

    /// Initializes a new instance of the (cref:HostAdditionalText) class.
    /// @param path The path to the additional file on disk.
    /// @param metadata The `build_metadata.AdditionalFiles.*` pairs for this file (case-insensitive keys).
    init(path string, metadata IReadOnlyDictionary[string, string]? = nil) {
        ArgumentNullException.ThrowIfNull(path, paramName: "path")
        this.resolvedPath = Path.GetFullPath(path)
        this.Metadata = metadata ?? Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Path string -> this.resolvedPath

    /// Gets the `build_metadata.AdditionalFiles.*` pairs for this file.
    prop Metadata IReadOnlyDictionary[string, string] {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetText(cancellationToken CancellationToken = default(CancellationToken)) SourceText {
        using let stream = File.OpenRead(this.resolvedPath)
        return SourceText.From(stream)
    }
}
