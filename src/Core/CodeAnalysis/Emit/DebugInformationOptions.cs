// <copyright file="DebugInformationOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PDB-related emit options consumed by the <see cref="ReflectionMetadataEmitter"/>.
/// Hung off <see cref="Compilation.Compilation.DebugInformation"/> so embedders
/// (gsc, the SDK <c>BuildTask</c>, language-service hosts) can configure debug
/// emit in one place.
/// </summary>
/// <remarks>
/// Phase 3 of the ADR-0027 §7.7a Portable PDB plan: defines the option surface
/// only. The actual PDB stream production lands across Phases 4 (Document /
/// MethodDebugInformation), 5 (LocalScope / LocalVariable / LocalConstant /
/// ImportScope), 6 (CustomDebugInformation: EmbeddedSource, SourceLink,
/// CompilationOptions, CompilationMetadataReferences), and 7 (PE
/// <c>DebugDirectory</c> entries: CodeView, PdbChecksum, Reproducible,
/// EmbeddedPortablePdb).
/// </remarks>
public sealed class DebugInformationOptions
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DebugInformationOptions"/>
    /// class with sensible defaults: <see cref="DebugInformationFormat.None"/>,
    /// non-deterministic output, no Source Link file.
    /// </summary>
    public DebugInformationOptions()
    {
    }

    /// <summary>
    /// Gets or sets the requested debug information format. Defaults to
    /// <see cref="DebugInformationFormat.None"/> so existing emit paths that
    /// do not opt in remain bit-for-bit identical with Phase 1/2 output.
    /// </summary>
    public DebugInformationFormat Format { get; set; } = DebugInformationFormat.None;

    /// <summary>
    /// Gets or sets the explicit sidecar PDB path. Only meaningful when
    /// <see cref="Format"/> is <see cref="DebugInformationFormat.Portable"/>.
    /// When <see langword="null"/>, the emitter chooses a default of
    /// <c>{PE}.pdb</c> next to the PE; when set, this value is recorded
    /// verbatim into the PE's <c>CodeView</c> debug-directory entry as
    /// the PDB path string.
    /// </summary>
    public string PdbFilePath { get; set; }

    /// <summary>
    /// Gets or sets the path of a Source Link JSON file (
    /// <see href="https://github.com/dotnet/sourcelink"/>). When set, the
    /// file's bytes are read at emit time and recorded as the PDB
    /// <c>SourceLink</c> <c>CustomDebugInformation</c> blob, enabling
    /// debuggers to fetch matching source from the URL substitution map.
    /// </summary>
    public string SourceLinkFilePath { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the emit must be
    /// deterministic. When <see langword="true"/>, the emitter writes a
    /// content-derived <c>Mvid</c> and <c>PdbId</c> instead of fresh GUIDs
    /// and adds a <c>Reproducible</c> debug-directory entry to the PE.
    /// </summary>
    public bool Deterministic { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether all primary source files
    /// referenced by the compilation are embedded inside the Portable PDB
    /// as <c>EmbeddedSource</c> <c>CustomDebugInformation</c> blobs. Defaults
    /// to <see langword="false"/>. Enabling this lets debuggers reconstruct
    /// source even when the original files have moved on disk, at the cost of
    /// a larger PDB. The Portable PDB spec recommends pairing this with
    /// <see cref="DebugInformationFormat.Embedded"/> for fully self-contained
    /// binaries.
    /// </summary>
    public bool EmbedAllSources { get; set; }
}
