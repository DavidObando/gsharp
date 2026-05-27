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
/// Phase 4 of the ADR-0027 §7.7a Portable PDB plan. This phase covers the
/// <c>Document</c> table and one <c>MethodDebugInformation</c> row per
/// <c>MethodDef</c>. Local-scope rows, custom debug information, and PE-side
/// <c>DebugDirectory</c> entries are deferred to Phases 5, 6, and 7.
/// </remarks>
internal sealed class PortablePdbEmitter
{
    // ECMA-335 / Portable PDB hash algorithm GUIDs (spec § "Document").
    private static readonly Guid HashAlgorithmSha256 = new Guid("8829D00F-11B8-4213-878B-770E8597AC16");

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
        return handle;
    }

    /// <summary>
    /// Records the sequence-point list collected for a single method by the
    /// <c>BodyEmitter</c>. Call after <c>AddMethodDefinition</c> returns the
    /// handle for that method; the row number embedded in
    /// <paramref name="methodHandle"/> is what later pairs it with its
    /// <c>MethodDebugInformation</c> row in <see cref="Serialize"/>.
    /// </summary>
    public void RecordMethod(MethodDefinitionHandle methodHandle, IReadOnlyList<SequencePoint> sequencePoints)
    {
        if (methodHandle.IsNil || sequencePoints is null || sequencePoints.Count == 0)
        {
            return;
        }

        // If every captured point is hidden / document-less, there's nothing
        // for a debugger to do with this row — fall through to the default
        // empty MethodDebugInformation row written by Serialize. Phase 5 will
        // revisit this once local-scope rows give debuggers a reason to anchor
        // hidden points (e.g. for stepping out of synthesized prologue code).
        var hasUsableDocument = false;
        foreach (var p in sequencePoints)
        {
            if (!p.Document.IsNil)
            {
                hasUsableDocument = true;
                break;
            }
        }

        if (!hasUsableDocument)
        {
            return;
        }

        var row = MetadataTokens.GetRowNumber(methodHandle);
        this.recordedMethods[row] = new RecordedMethod(sequencePoints);
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

        for (var rid = 1; rid <= methodDefRowCount; rid++)
        {
            if (this.recordedMethods.TryGetValue(rid, out var rec) && rec.Points.Count > 0)
            {
                var primaryDoc = FindPrimaryDocument(rec.Points);
                var blobBuilder = new BlobBuilder();
                EncodeSequencePoints(blobBuilder, rec.Points, primaryDoc);
                var blobHandle = this.pdbMetadata.GetOrAddBlob(blobBuilder);
                this.pdbMetadata.AddMethodDebugInformation(primaryDoc, blobHandle);
            }
            else
            {
                this.pdbMetadata.AddMethodDebugInformation(default, default);
            }
        }

        var pdbBuilder = new PortablePdbBuilder(
            tablesAndHeaps: this.pdbMetadata,
            typeSystemRowCounts: peRowCounts,
            entryPoint: entryPoint,
            idProvider: idProvider);

        var pdbBlob = new BlobBuilder();
        pdbBuilder.Serialize(pdbBlob);
        pdbBlob.WriteContentTo(pdbStream);
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
        DocumentHandle primaryDocument)
    {
        // LocalSignatureToken — 0 means "no locals signature recorded".
        blob.WriteCompressedInteger(0);

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
        public RecordedMethod(IReadOnlyList<SequencePoint> points)
        {
            this.Points = points;
        }

        public IReadOnlyList<SequencePoint> Points { get; }
    }
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
