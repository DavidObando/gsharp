// <copyright file="DebugInformationOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

/// PDB-related emit options consumed by the (cref:ReflectionMetadataEmitter).
/// Hung off (cref:Compilation.Compilation.DebugInformation) so embedders
/// (gsc, the SDK `BuildTask`, language-service hosts) can configure debug
/// emit in one place.
/// @remarks Phase 3 of the ADR-0027 §7.7a Portable PDB plan: defines the option surface
/// only. The actual PDB stream production lands across Phases 4 (Document /
/// MethodDebugInformation), 5 (LocalScope / LocalVariable / LocalConstant /
/// ImportScope), 6 (CustomDebugInformation: EmbeddedSource, SourceLink,
/// CompilationOptions, CompilationMetadataReferences), and 7 (PE
/// `DebugDirectory` entries: CodeView, PdbChecksum, Reproducible,
/// EmbeddedPortablePdb).
class DebugInformationOptions {
    /// Initializes a new instance of the (cref:DebugInformationOptions)
    /// class with sensible defaults: (cref:DebugInformationFormat.None),
    /// non-deterministic output, no Source Link file.
    init() { }

    /// Gets or sets the requested debug information format. Defaults to
    /// (cref:DebugInformationFormat.None) so existing emit paths that
    /// do not opt in remain bit-for-bit identical with Phase 1/2 output.
    private var _format DebugInformationFormat = DebugInformationFormat.None

    prop Format DebugInformationFormat {
        get {
            return _format
        }
        set {
            _format = value
        }
    }

    /// Gets or sets the explicit sidecar PDB path. Only meaningful when
    /// (cref:Format) is (cref:DebugInformationFormat.Portable).
    /// When `null`, the emitter chooses a default of
    /// `{PE}.pdb` next to the PE; when set, this value is recorded
    /// verbatim into the PE's `CodeView` debug-directory entry as
    /// the PDB path string.
    prop PdbFilePath string?

    /// Gets or sets the path of a Source Link JSON file (
    /// [https://github.com/dotnet/sourcelink](https://github.com/dotnet/sourcelink)). When set, the
    /// file's bytes are read at emit time and recorded as the PDB
    /// `SourceLink` `CustomDebugInformation` blob, enabling
    /// debuggers to fetch matching source from the URL substitution map.
    prop SourceLinkFilePath string?

    /// Gets or sets a value indicating whether the emit must be
    /// deterministic. When `true`, the emitter writes a
    /// content-derived `Mvid` and `PdbId` instead of fresh GUIDs
    /// and adds a `Reproducible` debug-directory entry to the PE.
    prop Deterministic bool

    /// Gets or sets a value indicating whether all primary source files
    /// referenced by the compilation are embedded inside the Portable PDB
    /// as `EmbeddedSource` `CustomDebugInformation` blobs. Defaults
    /// to `false`. Enabling this lets debuggers reconstruct
    /// source even when the original files have moved on disk, at the cost of
    /// a larger PDB. The Portable PDB spec recommends pairing this with
    /// (cref:DebugInformationFormat.Embedded) for fully self-contained
    /// binaries.
    prop EmbedAllSources bool
}
