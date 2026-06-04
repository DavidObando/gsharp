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
using GSharp.Core.CodeAnalysis.Symbols;
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
    private static readonly Guid CompilationMetadataReferencesKind = new Guid("7E4D4708-096E-4C5C-AEDA-CB10BA6A740D");

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
    private IReadOnlyDictionary<SyntaxTree, ImmutableArray<ImportSymbol>> importsPerTree;
    private ImmutableArray<ReferenceInfo> referenceInfos;

    public PortablePdbEmitter(DebugInformationOptions options)
    {
        this.options = options ?? new DebugInformationOptions();
    }

    /// <summary>
    /// Supplies the per-file explicit imports that will be encoded into
    /// <c>ImportScope</c> blobs during <see cref="Serialize"/>. Call before
    /// <see cref="Serialize"/>; may be called at most once. Keys are the
    /// <see cref="SyntaxTree"/> instances from which each import originates;
    /// only trees with at least one explicit (non-implicit) import need an
    /// entry. Implicit compiler-synthesized imports (e.g. the implicit
    /// <c>import System</c>) should be excluded from the lists — they carry
    /// a <see langword="null"/> <see cref="ImportSymbol.Declaration"/> and
    /// therefore have no source-tree anchor.
    /// </summary>
    public void SetImportsPerTree(IReadOnlyDictionary<SyntaxTree, ImmutableArray<ImportSymbol>> imports)
    {
        this.importsPerTree = imports;
    }

    /// <summary>
    /// Supplies the per-reference metadata that will be encoded into the
    /// <c>CompilationMetadataReferences</c> <c>CustomDebugInformation</c> blob
    /// during <see cref="Serialize"/>. Call before <see cref="Serialize"/>.
    /// </summary>
    public void SetReferenceInfos(ImmutableArray<ReferenceInfo> infos)
    {
        this.referenceInfos = infos;
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

        // Prefer the exact on-disk bytes for both the checksum and embedded
        // source. Debuggers (vsdbg/coreclr) compute the document checksum over
        // the raw file bytes — including any byte-order mark — and refuse to
        // bind breakpoints in an on-disk file whose hash does not match,
        // falling back to a source request that surfaces as a phantom tab.
        // Re-encoding the decoded text would drop the BOM and mismatch.
        var sourceBytes = tree.Text?.RawBytes
            ?? Encoding.UTF8.GetBytes(tree.Text?.ToString() ?? string.Empty);

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
    /// <param name="methodHandle">The MethodDef handle for this method.</param>
    /// <param name="sequencePoints">Sequence points collected during IL emit.</param>
    /// <param name="locals">Local-variable descriptors for the method.</param>
    /// <param name="constants">Compile-time constant descriptors for the method.</param>
    /// <param name="ilCodeSize">IL body size in bytes (used as <c>LocalScope.Length</c>).</param>
    /// <param name="localSignatureToken">The <c>StandaloneSignature</c> token for the locals blob.</param>
    /// <param name="syntaxTree">
    /// The <see cref="SyntaxTree"/> that declared this method, or <see langword="null"/>
    /// for fully synthesized methods (e.g. async kickoff stubs). The tree is used to
    /// select the per-file <c>ImportScope</c> when writing <c>LocalScope</c> rows.
    /// </param>
    public void RecordMethod(
        MethodDefinitionHandle methodHandle,
        IReadOnlyList<SequencePoint> sequencePoints,
        IReadOnlyList<LocalInfo> locals,
        IReadOnlyList<LocalConstantInfo> constants,
        int ilCodeSize,
        StandaloneSignatureHandle localSignatureToken,
        SyntaxTree syntaxTree = null)
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
        var hasConstants = constants != null && constants.Count > 0;

        // Nothing for a debugger to anchor — skip the row entirely so Serialize
        // falls through to writing an empty MethodDebugInformation slot.
        if (!hasUsableDocument && !hasLocals && !hasConstants)
        {
            return;
        }

        var row = MetadataTokens.GetRowNumber(methodHandle);
        this.recordedMethods[row] = new RecordedMethod(
            sequencePoints ?? System.Array.Empty<SequencePoint>(),
            locals ?? System.Array.Empty<LocalInfo>(),
            constants ?? System.Array.Empty<LocalConstantInfo>(),
            ilCodeSize,
            localSignatureToken,
            syntaxTree);
    }

    /// <summary>
    /// Walks every MethodDef row in token order and emits a
    /// <c>MethodDebugInformation</c> row for each — rich for methods that
    /// recorded sequence points, empty otherwise. Then assembles the Portable
    /// PDB blob and returns it together with the <see cref="BlobContentId"/>
    /// computed by <paramref name="idProvider"/>. The caller is responsible
    /// for writing the blob to a sidecar stream and/or embedding it in the PE
    /// debug directory.
    /// </summary>
    public (BlobBuilder Blob, BlobContentId ContentId) Serialize(
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

                // P2-12 (issue #421): When no point carries a usable document
                // (every record is the synthesised 0xfeefee hidden marker), we
                // cannot legally emit a sequence-points blob: the spec
                // requires either MethodDebugInformation.Document or an
                // InitialDocument prefix in the blob, and we have neither. A
                // blob without InitialDocument plus a nil Document column
                // causes Portable PDB readers to mis-parse the very first
                // record as a document-record (δIL=0 marker) and throw
                // "Invalid handle". Drop the blob — the method's LocalScope /
                // LocalVariable / LocalConstant rows still flow through Step 3
                // below so the debugger's locals window keeps working.
                if (primaryDoc.IsNil)
                {
                    this.pdbMetadata.AddMethodDebugInformation(default, default);
                }
                else
                {
                    var blobBuilder = new BlobBuilder();
                    EncodeSequencePoints(blobBuilder, rec.Points, primaryDoc, rec.LocalSignatureToken);
                    var blobHandle = this.pdbMetadata.GetOrAddBlob(blobBuilder);
                    this.pdbMetadata.AddMethodDebugInformation(primaryDoc, blobHandle);
                }
            }
            else
            {
                this.pdbMetadata.AddMethodDebugInformation(default, default);
            }
        }

        // Step 2 — Phase 5+: root ImportScope. Every LocalScope must reference
        // an ImportScope; the root (with no parent and an empty imports blob) is
        // the fallback for methods with no source-tree anchor. Per-file scopes
        // are parented here and carry the explicit namespace imports from each
        // syntax tree (issue #217).
        var rootImportScope = this.pdbMetadata.AddImportScope(
            parentScope: default,
            imports: this.pdbMetadata.GetOrAddBlob(EmptyBlob));

        // Build per-tree ImportScope rows from the explicit imports provided by
        // SetImportsPerTree. Each tree whose imports list is non-empty gets its
        // own row parented at rootImportScope; trees without explicit imports
        // (or not passed at all) fall back to rootImportScope.
        var importScopeByTree = new Dictionary<SyntaxTree, ImportScopeHandle>();
        if (this.importsPerTree != null)
        {
            foreach (var kv in this.importsPerTree)
            {
                var tree = kv.Key;
                var imports = kv.Value;
                if (tree is null || imports.IsDefaultOrEmpty)
                {
                    continue;
                }

                var importsBlob = BuildImportsBlob(imports);
                var treeScope = this.pdbMetadata.AddImportScope(
                    parentScope: rootImportScope,
                    imports: importsBlob);
                importScopeByTree[tree] = treeScope;
            }
        }

        // Step 3 — Phase 5+6: LocalVariable + LocalConstant + LocalScope rows.
        // The reader walks LocalScope sorted by method, then by startOffset.
        // Within a method, variable/constant lists are implied by the *next*
        // scope's handles, so we MUST add rows in the same order as scopes.
        // We maintain a running nextConstantRid so that empty-constant methods
        // still produce a correct constantList anchor.
        int nextConstantRid = 1;
        for (var rid = 1; rid <= methodDefRowCount; rid++)
        {
            if (!this.recordedMethods.TryGetValue(rid, out var rec))
            {
                continue;
            }

            var hasLocals = rec.Locals.Count > 0;
            var hasConstants = rec.Constants.Count > 0;
            if (!hasLocals && !hasConstants)
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

            // Add LocalConstant rows for this method. Track the first RID so
            // AddLocalScope gets a correct constantList anchor.
            var firstConstantRid = nextConstantRid;
            for (var i = 0; i < rec.Constants.Count; i++)
            {
                var c = rec.Constants[i];
                var sigBlob = EncodeLocalConstantSignature(c.Value);
                if (!sigBlob.IsNil)
                {
                    this.pdbMetadata.AddLocalConstant(
                        name: this.pdbMetadata.GetOrAddString(c.Name),
                        signature: sigBlob);
                    nextConstantRid++;
                }
            }

            // Use the per-tree ImportScope when one was built for this method's
            // source file; fall back to the root scope for synthesized methods.
            var importScope = rootImportScope;
            if (rec.SyntaxTree != null && importScopeByTree.TryGetValue(rec.SyntaxTree, out var treeImportScope))
            {
                importScope = treeImportScope;
            }

            this.pdbMetadata.AddLocalScope(
                method: MetadataTokens.MethodDefinitionHandle(rid),
                importScope: importScope,
                variableList: firstLocal,
                constantList: MetadataTokens.LocalConstantHandle(firstConstantRid),
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

        // CompilationMetadataReferences: one record per file-backed reference.
        // Blob layout per spec § "CompilationMetadataReferences":
        //   (FileName \0  Aliases \0  Flags:byte  TimeStamp:uint32  FileSize:uint32  MVID:guid)*
        if (!this.referenceInfos.IsDefaultOrEmpty)
        {
            var refsBlob = new BlobBuilder();
            foreach (var info in this.referenceInfos)
            {
                refsBlob.WriteUTF8(info.FileName);
                refsBlob.WriteByte(0);
                refsBlob.WriteUTF8(info.Aliases ?? string.Empty);
                refsBlob.WriteByte(0);
                refsBlob.WriteByte(info.Flags);
                refsBlob.WriteUInt32(info.TimeStamp);
                refsBlob.WriteUInt32(info.FileSize);
                refsBlob.WriteBytes(info.Mvid.ToByteArray());
            }

            this.pdbMetadata.AddCustomDebugInformation(
                parent: moduleHandle,
                kind: this.pdbMetadata.GetOrAddGuid(CompilationMetadataReferencesKind),
                value: this.pdbMetadata.GetOrAddBlob(refsBlob));
        }

        var pdbBuilder = new PortablePdbBuilder(
            tablesAndHeaps: this.pdbMetadata,
            typeSystemRowCounts: peRowCounts,
            entryPoint: entryPoint,
            idProvider: idProvider);

        var pdbBlob = new BlobBuilder();
        var contentId = pdbBuilder.Serialize(pdbBlob);
        return (pdbBlob, contentId);
    }

    private static readonly byte[] EmptyBlob = System.Array.Empty<byte>();

    /// <summary>
    /// Encodes an imports blob for an <c>ImportScope</c> row per the Portable PDB
    /// spec § "ImportScope". Each import becomes one record in the blob:
    /// <list type="bullet">
    ///   <item>Non-alias imports → kind 1 (<c>ImportNamespace</c>): a compressed
    ///   blob-heap offset of the UTF-8 namespace string.</item>
    ///   <item>Alias imports → kind 7 (<c>AliasNamespace</c>): compressed blob-heap
    ///   offset of the alias, then the namespace.</item>
    /// </list>
    /// Implicit (compiler-synthesized) imports are silently skipped because they
    /// have no user-visible declaration.
    /// </summary>
    private BlobHandle BuildImportsBlob(ImmutableArray<ImportSymbol> imports)
    {
        var blob = new BlobBuilder();
        foreach (var import in imports)
        {
            if (import.IsImplicit)
            {
                continue;
            }

            var nsBytes = Encoding.UTF8.GetBytes(import.Target);
            var nsHandle = this.pdbMetadata.GetOrAddBlob(nsBytes);
            var nsOffset = MetadataTokens.GetHeapOffset(nsHandle);

            if (import.IsAlias)
            {
                // Kind 7 = AliasNamespace
                blob.WriteCompressedInteger(7);
                var aliasBytes = Encoding.UTF8.GetBytes(import.Name);
                var aliasHandle = this.pdbMetadata.GetOrAddBlob(aliasBytes);
                blob.WriteCompressedInteger(MetadataTokens.GetHeapOffset(aliasHandle));
                blob.WriteCompressedInteger(nsOffset);
            }
            else
            {
                // Kind 1 = ImportNamespace
                blob.WriteCompressedInteger(1);
                blob.WriteCompressedInteger(nsOffset);
            }
        }

        return this.pdbMetadata.GetOrAddBlob(blob);
    }

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

        // P2-12 (issue #421): Debuggers (Visual Studio, Rider) reportedly bind
        // F5 breakpoints flakily when the first sequence-point record of a
        // method is hidden (the 0xfeefee marker). Skip any leading hidden
        // points so the first emitted record always carries a real
        // line/column. Methods that are entirely hidden still emit their full
        // (hidden-only) sequence, preserving prior behaviour where there is
        // nothing user-visible to anchor on.
        var startIndex = 0;
        var hasVisible = false;
        for (var i = 0; i < points.Count; i++)
        {
            if (!points[i].IsHidden)
            {
                hasVisible = true;
                startIndex = i;
                break;
            }
        }

        if (!hasVisible)
        {
            startIndex = 0;
        }

        for (var idx = startIndex; idx < points.Count; idx++)
        {
            var p = points[idx];

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

    /// <summary>
    /// Encodes a LocalConstant blob per Portable PDB spec §II.23.2.
    /// Returns a <see cref="BlobHandle"/> for the encoded signature, or
    /// <see langword="default"/> when the value type is unsupported.
    /// </summary>
    private BlobHandle EncodeLocalConstantSignature(object value)
    {
        var blob = new BlobBuilder();
        switch (value)
        {
            case bool b:
                blob.WriteByte(0x02); // ELEMENT_TYPE_BOOLEAN
                blob.WriteByte(b ? (byte)1 : (byte)0);
                break;
            case char ch:
                blob.WriteByte(0x03); // ELEMENT_TYPE_CHAR
                blob.WriteInt16((short)ch);
                break;
            case sbyte sb:
                blob.WriteByte(0x04); // ELEMENT_TYPE_I1
                blob.WriteSByte(sb);
                break;
            case byte by:
                blob.WriteByte(0x05); // ELEMENT_TYPE_U1
                blob.WriteByte(by);
                break;
            case short s:
                blob.WriteByte(0x06); // ELEMENT_TYPE_I2
                blob.WriteInt16(s);
                break;
            case ushort us:
                blob.WriteByte(0x07); // ELEMENT_TYPE_U2
                blob.WriteUInt16(us);
                break;
            case int i:
                blob.WriteByte(0x08); // ELEMENT_TYPE_I4
                blob.WriteInt32(i);
                break;
            case uint ui:
                blob.WriteByte(0x09); // ELEMENT_TYPE_U4
                blob.WriteUInt32(ui);
                break;
            case long l:
                blob.WriteByte(0x0A); // ELEMENT_TYPE_I8
                blob.WriteInt64(l);
                break;
            case ulong ul:
                blob.WriteByte(0x0B); // ELEMENT_TYPE_U8
                blob.WriteUInt64(ul);
                break;
            case float f:
                blob.WriteByte(0x0C); // ELEMENT_TYPE_R4
                blob.WriteUInt32(BitConverter.SingleToUInt32Bits(f));
                break;
            case double d:
                blob.WriteByte(0x0D); // ELEMENT_TYPE_R8
                blob.WriteUInt64(BitConverter.DoubleToUInt64Bits(d));
                break;
            case string str:
                blob.WriteByte(0x0E); // ELEMENT_TYPE_STRING
                if (str is null)
                {
                    blob.WriteByte(0xFF);
                }
                else
                {
                    blob.WriteBytes(Encoding.Unicode.GetBytes(str));
                }

                break;
            default:
                return default;
        }

        return this.pdbMetadata.GetOrAddBlob(blob);
    }

    private sealed class RecordedMethod
    {
        public RecordedMethod(
            IReadOnlyList<SequencePoint> points,
            IReadOnlyList<LocalInfo> locals,
            IReadOnlyList<LocalConstantInfo> constants,
            int ilCodeSize,
            StandaloneSignatureHandle localSignatureToken,
            SyntaxTree syntaxTree)
        {
            this.Points = points;
            this.Locals = locals;
            this.Constants = constants;
            this.IlCodeSize = ilCodeSize;
            this.LocalSignatureToken = localSignatureToken;
            this.SyntaxTree = syntaxTree;
        }

        public IReadOnlyList<SequencePoint> Points { get; }

        public IReadOnlyList<LocalInfo> Locals { get; }

        public IReadOnlyList<LocalConstantInfo> Constants { get; }

        public int IlCodeSize { get; }

        public StandaloneSignatureHandle LocalSignatureToken { get; }

        /// <summary>
        /// Gets the <see cref="Syntax.SyntaxTree"/> that contains this method's
        /// declaration, or <see langword="null"/> for synthesized methods.
        /// Used by <see cref="Serialize"/> to pick the per-file
        /// <c>ImportScope</c> for each <c>LocalScope</c> row.
        /// </summary>
        public SyntaxTree SyntaxTree { get; }
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
/// A compile-time constant binding handed to
/// <see cref="PortablePdbEmitter.RecordMethod"/>. The emitter encodes
/// <see cref="Value"/> into a <c>LocalConstant</c> signature blob per
/// Portable PDB spec §II.23.2.
/// </summary>
internal readonly struct LocalConstantInfo
{
    public LocalConstantInfo(string name, object value)
    {
        this.Name = name ?? string.Empty;
        this.Value = value;
    }

    public string Name { get; }

    public object Value { get; }
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
