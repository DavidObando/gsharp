// <copyright file="PortablePdbEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // a struct should not follow a class — paired by design
#pragma warning disable SA1202 // public members before private — language-guid constant intentionally grouped with private state
#pragma warning disable SA1611 // documentation for parameter is missing — internal helper APIs
#pragma warning disable SA1615 // element return value should be documented — internal helper APIs

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Security.Cryptography;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Owns the Portable PDB <see cref="MetadataBuilder"/> and the per-method
/// sequence-point collections gathered during IL emit. Lives only when the
/// caller requested <see cref="DebugInformationFormat.Portable"/>; otherwise
/// the <see cref="ReflectionMetadataEmitter"/> never instantiates one.
/// </summary>
/// <remarks>
/// Phases 4–5 cover <c>Document</c>, <c>MethodDebugInformation</c>,
/// <c>LocalScope</c>, <c>LocalVariable</c>, and a single root
/// <c>ImportScope</c>. Phase 6 adds <c>CustomDebugInformation</c> blobs:
/// <c>EmbeddedSource</c> (per document), <c>SourceLink</c> (one per module),
/// and <c>CompilationOptions</c> (one per module). PE-side
/// <c>DebugDirectory</c> entries land in Phase 7.
/// </remarks>
internal sealed class PortablePdbEmitter
{
    // ECMA-335 / Portable PDB hash algorithm GUIDs (spec § "Document").
    private static readonly Guid HashAlgorithmSha256 = new Guid("8829D00F-11B8-4213-878B-770E8597AC16");

    // Portable PDB CustomDebugInformation kind GUIDs
    // (spec § "CustomDebugInformation").
    private static readonly Guid EmbeddedSourceKind = new Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE");
    private static readonly Guid SourceLinkKind = new Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A");
    private static readonly Guid CompilationOptionsKind = new Guid("B5FEEC05-8CD0-4A83-96DA-466284BB4BD8");

    /// <summary>
    /// Stable GSharp language GUID. Once a tool keys off this value (debugger,
    /// symbol server, source indexer) it must never be reissued — see
    /// <c>docs/debug-info.md</c>. Generated specifically for this language and
    /// not shared with any other compiler.
    /// </summary>
    public static readonly Guid GSharpLanguageGuid = new Guid("4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00");

    private readonly MetadataBuilder pdbMetadata = new MetadataBuilder();
    private readonly Dictionary<SyntaxTree, DocumentHandle> documentsByTree = new Dictionary<SyntaxTree, DocumentHandle>();
    private readonly Dictionary<int, RecordedMethod> recordedMethods = new Dictionary<int, RecordedMethod>();
    private readonly DebugInformationOptions options;

    public PortablePdbEmitter(DebugInformationOptions options)
    {
        this.options = options ?? new DebugInformationOptions();
    }

    /// <summary>
    /// Returns the <see cref="DocumentHandle"/> for <paramref name="tree"/>,
    /// adding a fresh <c>Document</c> row the first time the tree is seen.
    /// Returns <c>default</c> when the tree is <c>null</c> (synthesized code
    /// with no source anchor).
    /// </summary>
    public DocumentHandle GetOrAddDocument(SyntaxTree tree)
    {
        if (tree is null)
        {
            return default;
        }

        if (this.documentsByTree.TryGetValue(tree, out var existing))
        {
            return existing;
        }

        var path = tree.Text?.FileName ?? string.Empty;
        var sourceBytes = Encoding.UTF8.GetBytes(tree.Text?.ToString() ?? string.Empty);

        byte[] hash;
        using (var sha = SHA256.Create())
        {
            hash = sha.ComputeHash(sourceBytes);
        }

        var handle = this.pdbMetadata.AddDocument(
            name: this.pdbMetadata.GetOrAddDocumentName(path),
            hashAlgorithm: this.pdbMetadata.GetOrAddGuid(HashAlgorithmSha256),
            hash: this.pdbMetadata.GetOrAddBlob(hash),
            language: this.pdbMetadata.GetOrAddGuid(GSharpLanguageGuid));

        this.documentsByTree[tree] = handle;

        // Phase 6: embed the source file as a CustomDebugInformation row
        // anchored on this Document. Format per spec § "EmbeddedSource":
        //   4-byte little-endian int formatMarker, then bytes.
        // formatMarker == 0  → raw, no compression.
        // formatMarker  > 0  → uncompressed size of deflate-compressed payload.
        // Phase 6 always emits uncompressed; deflate compression is a
        // size-only optimisation we can layer in later without breaking
        // readers.
        if (this.options.EmbedAllSources && sourceBytes.Length > 0)
        {
            var embedBlob = new BlobBuilder();
            embedBlob.WriteInt32(0);
            embedBlob.WriteBytes(sourceBytes);
            this.pdbMetadata.AddCustomDebugInformation(
                parent: handle,
                kind: this.pdbMetadata.GetOrAddGuid(EmbeddedSourceKind),
                value: this.pdbMetadata.GetOrAddBlob(embedBlob));
        }

        return handle;
    }

    /// <summary>
    /// Records the sequence-point list collected for a single method by the
    /// <c>BodyEmitter</c>. Call after <c>AddMethodDefinition</c> returns the
    /// handle for that method; the row number embedded in
    /// <paramref name="methodHandle"/> is what later pairs it with its
    /// <c>MethodDebugInformation</c> row in <see cref="Serialize"/>.
    /// </summary>
    public void RecordMethod(
        MethodDefinitionHandle methodHandle,
        IReadOnlyList<SequencePoint> sequencePoints,
        IReadOnlyList<LocalInfo> locals,
        int ilCodeSize,
        StandaloneSignatureHandle localSignatureToken)
    {
        if (methodHandle.IsNil)
        {
            return;
        }

        var hasUsableDocument = false;
        if (sequencePoints != null)
        {
            foreach (var p in sequencePoints)
            {
                if (!p.Document.IsNil)
                {
                    hasUsableDocument = true;
                    break;
                }
            }
        }

        var hasLocals = locals != null && locals.Count > 0;

        // Nothing for a debugger to anchor — skip the row entirely so Serialize
        // falls through to writing an empty MethodDebugInformation slot.
        if (!hasUsableDocument && !hasLocals)
        {
            return;
        }

        var row = MetadataTokens.GetRowNumber(methodHandle);
        this.recordedMethods[row] = new RecordedMethod(
            sequencePoints ?? System.Array.Empty<SequencePoint>(),
            locals ?? System.Array.Empty<LocalInfo>(),
            ilCodeSize,
            localSignatureToken);
    }

    /// <summary>
    /// Walks every MethodDef row in token order and emits a
    /// <c>MethodDebugInformation</c> row for each — rich for methods that
    /// recorded sequence points, empty otherwise. Then assembles the Portable
    /// PDB blob and writes it to <paramref name="pdbStream"/>.
    /// </summary>
    public void Serialize(
        Stream pdbStream,
        ImmutableArray<int> peRowCounts,
        MethodDefinitionHandle entryPoint,
        Func<IEnumerable<Blob>, BlobContentId> idProvider)
    {
        var methodDefRowCount = peRowCounts[(int)TableIndex.MethodDef];

        // Step 1 — write MethodDebugInformation rows in MethodDef order (Phase 4
        // contract: one row per MethodDef, lockstep).
        for (var rid = 1; rid <= methodDefRowCount; rid++)
        {
            if (this.recordedMethods.TryGetValue(rid, out var rec) && rec.Points.Count > 0)
            {
                var primaryDoc = FindPrimaryDocument(rec.Points);
                var blobBuilder = new BlobBuilder();
                EncodeSequencePoints(blobBuilder, rec.Points, primaryDoc, rec.LocalSignatureToken);
                var blobHandle = this.pdbMetadata.GetOrAddBlob(blobBuilder);
                this.pdbMetadata.AddMethodDebugInformation(primaryDoc, blobHandle);
            }
            else
            {
                this.pdbMetadata.AddMethodDebugInformation(default, default);
            }
        }

        // Step 2 — Phase 5: root ImportScope (currently always empty; per-file
        // import information lands once the binder exposes it on the symbol
        // model). Every LocalScope must reference an ImportScope, so we always
        // need at least the root row.
        var rootImportScope = this.pdbMetadata.AddImportScope(
            parentScope: default,
            imports: this.pdbMetadata.GetOrAddBlob(EmptyBlob));

        // Step 3 — Phase 5: LocalVariable + LocalScope rows. The reader walks
        // LocalScope sorted by method, then by startOffset. Within a method,
        // each scope's variable list is implied by the *next* scope's variable
        // handle, so we MUST add LocalVariable rows in the same order we add
        // LocalScope rows. Since Phase 5 only emits a single scope per method
        // covering the full method body, the ordering is trivially correct.
        for (var rid = 1; rid <= methodDefRowCount; rid++)
        {
            if (!this.recordedMethods.TryGetValue(rid, out var rec) || rec.Locals.Count == 0)
            {
                continue;
            }

            // Add LocalVariable rows for this method. The handle returned by
            // the *first* AddLocalVariable call becomes the scope's variable
            // list anchor.
            LocalVariableHandle firstLocal = default;
            for (var i = 0; i < rec.Locals.Count; i++)
            {
                var l = rec.Locals[i];
                var handle = this.pdbMetadata.AddLocalVariable(
                    attributes: l.IsCompilerGenerated
                        ? LocalVariableAttributes.DebuggerHidden
                        : LocalVariableAttributes.None,
                    index: l.SlotIndex,
                    name: this.pdbMetadata.GetOrAddString(l.Name));
                if (i == 0)
                {
                    firstLocal = handle;
                }
            }

            this.pdbMetadata.AddLocalScope(
                method: MetadataTokens.MethodDefinitionHandle(rid),
                importScope: rootImportScope,
                variableList: firstLocal,
                constantList: MetadataTokens.LocalConstantHandle(1),
                startOffset: 0,
                length: rec.IlCodeSize);
        }

        // Step 4 — Phase 6: module-level CustomDebugInformation rows. These
        // are written *before* the PortablePdbBuilder consumes the metadata
        // builder. Parent is the singleton Module row (RID 1); this is the
        // anchor that debuggers and symbol servers query against the module
        // identity rather than any particular method.
        var moduleHandle = MetadataTokens.EntityHandle(TableIndex.Module, 1);

        if (!string.IsNullOrEmpty(this.options.SourceLinkFilePath) &&
            File.Exists(this.options.SourceLinkFilePath))
        {
            // SourceLink blob is the raw bytes of the JSON file as-is; the
            // PDB spec does not transform it.
            var sourceLinkBytes = File.ReadAllBytes(this.options.SourceLinkFilePath);
            this.pdbMetadata.AddCustomDebugInformation(
                parent: moduleHandle,
                kind: this.pdbMetadata.GetOrAddGuid(SourceLinkKind),
                value: this.pdbMetadata.GetOrAddBlob(sourceLinkBytes));
        }

        // CompilationOptions: name/value UTF-8 pairs, each terminated by a
        // null byte. Always emit so that downstream tooling can identify how
        // a binary was produced; the set is intentionally minimal in Phase 6
        // and may grow as more compiler knobs become observable.
        var optionsBlob = new BlobBuilder();
        var compilerVersion = typeof(PortablePdbEmitter).Assembly.GetName().Version?.ToString() ?? "0.0.0.0";
        WriteCompilationOption(optionsBlob, "compiler-name", "gsc");
        WriteCompilationOption(optionsBlob, "compiler-version", compilerVersion);
        WriteCompilationOption(optionsBlob, "language", "GSharp");
        WriteCompilationOption(optionsBlob, "language-version", "1.0");
        this.pdbMetadata.AddCustomDebugInformation(
            parent: moduleHandle,
            kind: this.pdbMetadata.GetOrAddGuid(CompilationOptionsKind),
            value: this.pdbMetadata.GetOrAddBlob(optionsBlob));

        var pdbBuilder = new PortablePdbBuilder(
            tablesAndHeaps: this.pdbMetadata,
            typeSystemRowCounts: peRowCounts,
            entryPoint: entryPoint,
            idProvider: idProvider);

        var pdbBlob = new BlobBuilder();
        pdbBuilder.Serialize(pdbBlob);
        pdbBlob.WriteContentTo(pdbStream);
    }

    private static readonly byte[] EmptyBlob = System.Array.Empty<byte>();

    /// <summary>
    /// Writes a single <c>CompilationOptions</c> key/value pair using the
    /// spec's null-terminated UTF-8 layout: <c>name \0 value \0</c>.
    /// </summary>
    private static void WriteCompilationOption(BlobBuilder builder, string name, string value)
    {
        builder.WriteUTF8(name);
        builder.WriteByte(0);
        builder.WriteUTF8(value ?? string.Empty);
        builder.WriteByte(0);
    }

    /// <summary>
    /// Encodes a method's sequence-point blob per Portable PDB spec § "Sequence
    /// points blob". The header writes a zero <c>LocalSignatureToken</c> in
    /// Phase 4 — real values land in Phase 5 when local-scope rows are
    /// populated. When every visible record shares
    /// <paramref name="primaryDocument"/> the <c>InitialDocument</c> field is
    /// omitted (single-document optimisation).
    /// </summary>
    private static void EncodeSequencePoints(
        BlobBuilder blob,
        IReadOnlyList<SequencePoint> points,
        DocumentHandle primaryDocument,
        StandaloneSignatureHandle localSignatureToken)
    {
        // LocalSignatureToken — full 32-bit metadata token (0 when the method
        // has no locals). Phase 5 wires the real value through so the
        // debugger's locals window can deserialise slot types.
        var tokenValue = localSignatureToken.IsNil ? 0 : MetadataTokens.GetToken(localSignatureToken);
        blob.WriteCompressedInteger(tokenValue);

        // InitialDocument is omitted because every visible point shares the
        // method's primary document (asserted by the caller). Records follow.
        var firstNonHidden = true;
        var prevIl = 0;
        var prevStartLine = 0;
        var prevStartColumn = 0;
        var firstRecord = true;

        foreach (var p in points)
        {
            // δIL — first record encodes the absolute IL offset, the rest the
            // delta from the previous record. The spec forbids two records
            // sharing the same IL offset; the BodyEmitter is responsible for
            // collapsing consecutive entries before reaching this point.
            var deltaIl = firstRecord ? p.IlOffset : p.IlOffset - prevIl;
            blob.WriteCompressedInteger(deltaIl);
            prevIl = p.IlOffset;
            firstRecord = false;

            if (p.IsHidden)
            {
                // ΔLines = 0, ΔColumns = 0 — flagged as hidden.
                blob.WriteCompressedInteger(0);
                blob.WriteCompressedInteger(0);
                continue;
            }

            var deltaLines = p.EndLine - p.StartLine;
            var deltaColumns = p.EndColumn - p.StartColumn;
            blob.WriteCompressedInteger(deltaLines);
            if (deltaLines == 0)
            {
                blob.WriteCompressedInteger(deltaColumns);
            }
            else
            {
                blob.WriteCompressedSignedInteger(deltaColumns);
            }

            if (firstNonHidden)
            {
                blob.WriteCompressedInteger(p.StartLine);
                blob.WriteCompressedInteger(p.StartColumn);
                firstNonHidden = false;
            }
            else
            {
                blob.WriteCompressedSignedInteger(p.StartLine - prevStartLine);
                blob.WriteCompressedSignedInteger(p.StartColumn - prevStartColumn);
            }

            prevStartLine = p.StartLine;
            prevStartColumn = p.StartColumn;
        }
    }

    private static DocumentHandle FindPrimaryDocument(IReadOnlyList<SequencePoint> points)
    {
        foreach (var p in points)
        {
            if (!p.Document.IsNil)
            {
                return p.Document;
            }
        }

        return default;
    }

    private sealed class RecordedMethod
    {
        public RecordedMethod(
            IReadOnlyList<SequencePoint> points,
            IReadOnlyList<LocalInfo> locals,
            int ilCodeSize,
            StandaloneSignatureHandle localSignatureToken)
        {
            this.Points = points;
            this.Locals = locals;
            this.IlCodeSize = ilCodeSize;
            this.LocalSignatureToken = localSignatureToken;
        }

        public IReadOnlyList<SequencePoint> Points { get; }

        public IReadOnlyList<LocalInfo> Locals { get; }

        public int IlCodeSize { get; }

        public StandaloneSignatureHandle LocalSignatureToken { get; }
    }
}

/// <summary>
/// One local-slot descriptor handed to <see cref="PortablePdbEmitter.RecordMethod"/>.
/// Compiler-generated locals (synthesized by lowering) flow through with
/// <see cref="IsCompilerGenerated"/> set so debuggers can hide them from the
/// locals window.
/// </summary>
internal readonly struct LocalInfo
{
    public LocalInfo(int slotIndex, string name, bool isCompilerGenerated)
    {
        this.SlotIndex = slotIndex;
        this.Name = name ?? string.Empty;
        this.IsCompilerGenerated = isCompilerGenerated;
    }

    public int SlotIndex { get; }

    public string Name { get; }

    public bool IsCompilerGenerated { get; }
}

/// <summary>
/// A single sequence-point record gathered during IL emit. One-based line and
/// column values follow Portable PDB conventions. Use <see cref="Hidden"/> to
/// construct a hidden marker (0xfeefee equivalent in encoded form).
/// </summary>
internal readonly struct SequencePoint
{
    /// <summary>
    /// Sentinel <c>StartLine</c> value used by the in-memory representation to
    /// mark a hidden record. The encoded form on disk uses ΔLines=0 ∧
    /// ΔColumns=0 per the Portable PDB spec — this constant only flows through
    /// the emitter's internal collections.
    /// </summary>
    public const int HiddenLine = 0xfeefee;

    public SequencePoint(
        int ilOffset,
        DocumentHandle document,
        int startLine,
        int startColumn,
        int endLine,
        int endColumn)
    {
        this.IlOffset = ilOffset;
        this.Document = document;
        this.StartLine = startLine;
        this.StartColumn = startColumn;
        this.EndLine = endLine;
        this.EndColumn = endColumn;
    }

    public int IlOffset { get; }

    public DocumentHandle Document { get; }

    public int StartLine { get; }

    public int StartColumn { get; }

    public int EndLine { get; }

    public int EndColumn { get; }

    public bool IsHidden => this.StartLine == HiddenLine;

    public static SequencePoint Hidden(int ilOffset, DocumentHandle document) =>
        new SequencePoint(ilOffset, document, HiddenLine, 0, HiddenLine, 0);
}
