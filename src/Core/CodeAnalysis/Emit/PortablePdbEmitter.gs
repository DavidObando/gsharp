// <copyright file="PortablePdbEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Security.Cryptography
import System.Text

/// Owns the Portable PDB (cref:MetadataBuilder) and the per-method
/// sequence-point collections gathered during IL emit. Lives only when the
/// caller requested (cref:DebugInformationFormat.Portable); otherwise
/// the (cref:ReflectionMetadataEmitter) never instantiates one.
/// @remarks Phases 4–5 cover `Document`, `MethodDebugInformation`,
/// `LocalScope`, `LocalVariable`, and a single root
/// `ImportScope`. Phase 6 adds `CustomDebugInformation` blobs:
/// `EmbeddedSource` (per document), `SourceLink` (one per module),
/// and `CompilationOptions` (one per module). PE-side
/// `DebugDirectory` entries land in Phase 7.
internal class PortablePdbEmitter {
    private let pdbMetadata MetadataBuilder = MetadataBuilder()
    private let documentsByTree Dictionary[SyntaxTree, DocumentHandle] = Dictionary[SyntaxTree, DocumentHandle]()
    private let recordedMethods Dictionary[int32, RecordedMethod] = Dictionary[int32, RecordedMethod]()
    private let options DebugInformationOptions
    private var importsPerTree IReadOnlyDictionary[SyntaxTree, ImmutableArray[ImportSymbol]]?
    private var referenceInfos ImmutableArray[ReferenceInfo]

    init(options DebugInformationOptions) {
        this.options = options ?? DebugInformationOptions()
    }

    /// Supplies the per-file explicit imports that will be encoded into
    /// `ImportScope` blobs during (cref:Serialize). Call before
    /// (cref:Serialize); may be called at most once. Keys are the
    /// (cref:SyntaxTree) instances from which each import originates;
    /// only trees with at least one explicit (non-implicit) import need an
    /// entry. Implicit compiler-synthesized imports (e.g. the implicit
    /// `import System`) should be excluded from the lists — they carry
    /// a `null` (cref:ImportSymbol.Declaration) and
    /// therefore have no source-tree anchor.
    func SetImportsPerTree(imports IReadOnlyDictionary[SyntaxTree, ImmutableArray[ImportSymbol]]) {
        this.importsPerTree = imports
    }

    /// Supplies the per-reference metadata that will be encoded into the
    /// `CompilationMetadataReferences` `CustomDebugInformation` blob
    /// during (cref:Serialize). Call before (cref:Serialize).
    func SetReferenceInfos(infos ImmutableArray[ReferenceInfo]) {
        this.referenceInfos = infos
    }

    /// Returns the (cref:DocumentHandle) for [`tree`](paramref),
    /// adding a fresh `Document` row the first time the tree is seen.
    /// Returns `default` when the tree is `null` (synthesized code
    /// with no source anchor).
    func GetOrAddDocument(tree SyntaxTree?) DocumentHandle {
        if tree == nil {
            return default(DocumentHandle)
        }
        if this.documentsByTree.TryGetValue(tree, out var existing) {
            return existing
        }
        let path = tree.Text?.FileName ?? string.Empty
        // Prefer the exact on-disk bytes for both the checksum and embedded
        // source. Debuggers (vsdbg/coreclr) compute the document checksum over
        // the raw file bytes — including any byte-order mark — and refuse to
        // bind breakpoints in an on-disk file whose hash does not match,
        // falling back to a source request that surfaces as a phantom tab.
        // Re-encoding the decoded text would drop the BOM and mismatch.
        let sourceBytes = tree.Text?.RawBytes ?? Encoding.UTF8.GetBytes(tree.Text?.ToString() ?? string.Empty)
        var hash[]uint8
        {
            using let sha = SHA256.Create()
            hash = sha.ComputeHash(sourceBytes)
        }
        let handle = this.pdbMetadata.AddDocument(
            name: this.pdbMetadata.GetOrAddDocumentName(path),
            hashAlgorithm: this.pdbMetadata.GetOrAddGuid(HashAlgorithmSha256),
            hash: this.pdbMetadata.GetOrAddBlob(hash),
            language: this.pdbMetadata.GetOrAddGuid(GSharpLanguageGuid)
        )
        this.documentsByTree[tree] = handle
        // Phase 6: embed the source file as a CustomDebugInformation row
        // anchored on this Document. Format per spec § "EmbeddedSource":
        //   4-byte little-endian int formatMarker, then bytes.
        // formatMarker == 0  → raw, no compression.
        // formatMarker  > 0  → uncompressed size of deflate-compressed payload.
        // Phase 6 always emits uncompressed; deflate compression is a
        // size-only optimisation we can layer in later without breaking
        // readers.
        if this.options.EmbedAllSources && sourceBytes.Length > 0 {
            let embedBlob = BlobBuilder()
            embedBlob.WriteUInt32(0)
            embedBlob.WriteBytes(sourceBytes)
            this.pdbMetadata.AddCustomDebugInformation(
                parent: handle,
                kind: this.pdbMetadata.GetOrAddGuid(EmbeddedSourceKind),
                value: this.pdbMetadata.GetOrAddBlob(embedBlob)
            )
        }
        return handle
    }

    /// Records the sequence-point list collected for a single method by the
    /// `BodyEmitter`. Call after `AddMethodDefinition` returns the
    /// handle for that method; the row number embedded in
    /// [`methodHandle`](paramref) is what later pairs it with its
    /// `MethodDebugInformation` row in (cref:Serialize).
    /// @param methodHandle The MethodDef handle for this method.
    /// @param sequencePoints Sequence points collected during IL emit.
    /// @param locals Local-variable descriptors for the method.
    /// @param constants Compile-time constant descriptors for the method.
    /// @param ilCodeSize IL body size in bytes (used as `LocalScope.Length`).
    /// @param localSignatureToken The `StandaloneSignature` token for the locals blob.
    /// @param syntaxTree The (cref:SyntaxTree) that declared this method, or `null`
    /// for fully synthesized methods (e.g. async kickoff stubs). The tree is used to
    /// select the per-file `ImportScope` when writing `LocalScope` rows.
    /// @param asyncStepping ADR-0174 P3-8: the await yield/resume offsets of a state machine's `MoveNext`,
    /// or `null` for any other body.
    func RecordMethod(
        methodHandle MethodDefinitionHandle,
        sequencePoints IReadOnlyList[SequencePoint]?,
        locals IReadOnlyList[LocalInfo]?,
        constants IReadOnlyList[LocalConstantInfo]?,
        ilCodeSize int32,
        localSignatureToken StandaloneSignatureHandle,
        syntaxTree SyntaxTree? = nil,
        asyncStepping AsyncMethodSteppingInfo? = nil
    ) {
        if methodHandle.IsNil {
            return
        }
        var hasUsableDocument = false
        if sequencePoints != nil {
            for p in sequencePoints {
                if !p.Document.IsNil {
                    hasUsableDocument = true
                    break
                }
            }
        }
        let hasLocals = locals != nil && locals.Count > 0
        let hasConstants = constants != nil && constants.Count > 0
        // Nothing for a debugger to anchor — skip the row entirely so Serialize
        // falls through to writing an empty MethodDebugInformation slot.
        if !hasUsableDocument && !hasLocals && !hasConstants && asyncStepping == nil {
            return
        }
        let row = MetadataTokens.GetRowNumber(methodHandle)
        this.recordedMethods[row] = RecordedMethod(
            sequencePoints ?? Array.Empty[SequencePoint](),
            locals ?? Array.Empty[LocalInfo](),
            constants ?? Array.Empty[LocalConstantInfo](),
            ilCodeSize,
            localSignatureToken,
            syntaxTree,
            asyncStepping
        )
    }

    /// Walks every MethodDef row in token order and emits a
    /// `MethodDebugInformation` row for each — rich for methods that
    /// recorded sequence points, empty otherwise. Then assembles the Portable
    /// PDB blob and returns it together with the (cref:BlobContentId)
    /// computed by [`idProvider`](paramref). The caller is responsible
    /// for writing the blob to a sidecar stream and/or embedding it in the PE
    /// debug directory.
    func Serialize(
        peRowCounts ImmutableArray[int32],
        entryPoint MethodDefinitionHandle,
        idProvider(IEnumerable[Blob]) -> BlobContentId
    )(Blob BlobBuilder, ContentId BlobContentId) {
        using let measurement = CompilationMeasurements.BeginPhase("emit.pdb")
        let methodDefRowCount = peRowCounts[int32(TableIndex.MethodDef)]
        // Step 1 — write MethodDebugInformation rows in MethodDef order (Phase 4
        // contract: one row per MethodDef, lockstep).
        for var rid = 1; rid <= methodDefRowCount; rid++ {
            if this.recordedMethods.TryGetValue(rid, out var rec) && rec.Points is {Count: > 0} {
                let primaryDoc = FindPrimaryDocument(rec.Points!!)
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
                if primaryDoc.IsNil {
                    this.pdbMetadata.AddMethodDebugInformation(default(DocumentHandle), default(BlobHandle))
                } else {
                    let blobBuilder = BlobBuilder()
                    EncodeSequencePoints(blobBuilder, rec.Points!!, primaryDoc, rec.LocalSignatureToken)
                    let blobHandle = this.pdbMetadata.GetOrAddBlob(blobBuilder)
                    this.pdbMetadata.AddMethodDebugInformation(primaryDoc, blobHandle)
                }
            } else {
                this.pdbMetadata.AddMethodDebugInformation(default(DocumentHandle), default(BlobHandle))
            }
        }
        // Step 2 — Phase 5+: root ImportScope. Every LocalScope must reference
        // an ImportScope; the root (with no parent and an empty imports blob) is
        // the fallback for methods with no source-tree anchor. Per-file scopes
        // are parented here and carry the explicit namespace imports from each
        // syntax tree (issue #217).
        let rootImportScope = this.pdbMetadata.AddImportScope(
            parentScope: default(ImportScopeHandle),
            imports: this.pdbMetadata.GetOrAddBlob(EmptyBlob)
        )
        // Build per-tree ImportScope rows from the explicit imports provided by
        // SetImportsPerTree. Each tree whose imports list is non-empty gets its
        // own row parented at rootImportScope; trees without explicit imports
        // (or not passed at all) fall back to rootImportScope.
        let importScopeByTree = Dictionary[SyntaxTree, ImportScopeHandle]()
        if this.importsPerTree != nil {
            for kv in this.importsPerTree!! {
                let tree SyntaxTree? = kv.Key
                let imports = kv.Value
                if tree == nil || imports.IsDefaultOrEmpty {
                    continue
                }
                let importsBlob = BuildImportsBlob(imports)
                let treeScope = this.pdbMetadata.AddImportScope(parentScope: rootImportScope, imports: importsBlob)
                importScopeByTree[tree] = treeScope
            }
        }
        // Step 3 — Phase 5+6: LocalVariable + LocalConstant + LocalScope rows.
        // The reader walks LocalScope sorted by method, then by startOffset.
        // Within a method, variable/constant lists are implied by the *next*
        // scope's handles, so we MUST add rows in the same order as scopes.
        // We maintain a running nextConstantRid so that empty-constant methods
        // still produce a correct constantList anchor.
        var nextConstantRid = 1
        for var rid = 1; rid <= methodDefRowCount; rid++ {
            if !this.recordedMethods.TryGetValue(rid, out var rec) {
                continue
            }
            let hasLocals = rec.Locals is {Count: > 0}
            let hasConstants = rec.Constants is {Count: > 0}
            if !hasLocals && !hasConstants {
                continue
            }
            // Add LocalVariable rows for this method. The handle returned by
            // the *first* AddLocalVariable call becomes the scope's variable
            // list anchor.
            var firstLocal = default(LocalVariableHandle)
            let localList = rec.Locals ?? Array.Empty[LocalInfo]()
            for var i = 0; i < localList.Count; i++ {
                let l = localList[i]
                let handle = this.pdbMetadata.AddLocalVariable(
                    attributes: if l.IsCompilerGenerated {
                        LocalVariableAttributes.DebuggerHidden
                    } else {
                        LocalVariableAttributes.None
                    },
                    index: l.SlotIndex,
                    name: this.pdbMetadata.GetOrAddString(l.Name)
                )
                if i == 0 {
                    firstLocal = handle
                }
            }
            // Add LocalConstant rows for this method. Track the first RID so
            // AddLocalScope gets a correct constantList anchor.
            let firstConstantRid = nextConstantRid
            let constantList = rec.Constants ?? Array.Empty[LocalConstantInfo]()
            for var i = 0; i < constantList.Count; i++ {
                let c = constantList[i]
                let sigBlob = EncodeLocalConstantSignature(c.Value)
                if !sigBlob.IsNil {
                    this.pdbMetadata.AddLocalConstant(name: this.pdbMetadata.GetOrAddString(c.Name), signature: sigBlob)
                    nextConstantRid++
                }
            }
            // Use the per-tree ImportScope when one was built for this method's
            // source file; fall back to the root scope for synthesized methods.
            var importScope = rootImportScope
            if rec.SyntaxTree != nil && importScopeByTree.TryGetValue(rec.SyntaxTree, out var treeImportScope) {
                importScope = treeImportScope
            }
            this.pdbMetadata.AddLocalScope(
                method: MetadataTokens.MethodDefinitionHandle(rid),
                importScope: importScope,
                variableList: firstLocal,
                constantList: MetadataTokens.LocalConstantHandle(firstConstantRid),
                startOffset: 0,
                length: rec.IlCodeSize
            )
        }
        // Step 4 — Phase 6: module-level CustomDebugInformation rows. These
        // are written *before* the PortablePdbBuilder consumes the metadata
        // builder. Parent is the singleton Module row (RID 1); this is the
        // anchor that debuggers and symbol servers query against the module
        // identity rather than any particular method.
        // ADR-0174 P3-8: async method stepping information per MoveNext
        // (spec § "Async Method Stepping Information Blob"): the catch handler
        // offset + 1 (0 when none), then per await the yield offset, the resume
        // offset and the compressed row id of the resuming method (MoveNext
        // itself).
        for (rid, rec) in this.recordedMethods {
            if rec.AsyncStepping is not{} stepping {
                continue
            }
            let steppingBlob = BlobBuilder()
            steppingBlob.WriteUInt32(uint32((stepping.CatchHandlerOffset + 1)))
            for (yieldOffset, resumeOffset) in stepping.Awaits {
                steppingBlob.WriteUInt32(uint32(yieldOffset))
                steppingBlob.WriteUInt32(uint32(resumeOffset))
                steppingBlob.WriteCompressedInteger(rid)
            }
            this.pdbMetadata.AddCustomDebugInformation(
                parent: MetadataTokens.MethodDefinitionHandle(rid),
                kind: this.pdbMetadata.GetOrAddGuid(AsyncMethodSteppingInformationKind),
                value: this.pdbMetadata.GetOrAddBlob(steppingBlob)
            )
        }
        let moduleHandle = MetadataTokens.EntityHandle(TableIndex.Module, 1)
        if !string.IsNullOrEmpty(this.options.SourceLinkFilePath) && File.Exists(this.options.SourceLinkFilePath) {
            // SourceLink blob is the raw bytes of the JSON file as-is; the
            // PDB spec does not transform it.
            let sourceLinkBytes = File.ReadAllBytes(this.options.SourceLinkFilePath!!)
            this.pdbMetadata.AddCustomDebugInformation(
                parent: moduleHandle,
                kind: this.pdbMetadata.GetOrAddGuid(SourceLinkKind),
                value: this.pdbMetadata.GetOrAddBlob(sourceLinkBytes)
            )
        }
        // CompilationOptions: name/value UTF-8 pairs, each terminated by a
        // null byte. Always emit so that downstream tooling can identify how
        // a binary was produced; the set is intentionally minimal in Phase 6
        // and may grow as more compiler knobs become observable.
        let optionsBlob = BlobBuilder()
        let compilerVersion = typeof(PortablePdbEmitter).Assembly.GetName().Version?.ToString() ?? "0.0.0.0"
        WriteCompilationOption(optionsBlob, "compiler-name", "gsc")
        WriteCompilationOption(optionsBlob, "compiler-version", compilerVersion)
        WriteCompilationOption(optionsBlob, "language", "GSharp")
        WriteCompilationOption(optionsBlob, "language-version", "1.0")
        this.pdbMetadata.AddCustomDebugInformation(
            parent: moduleHandle,
            kind: this.pdbMetadata.GetOrAddGuid(CompilationOptionsKind),
            value: this.pdbMetadata.GetOrAddBlob(optionsBlob)
        )
        // CompilationMetadataReferences: one record per file-backed reference.
        // Blob layout per spec § "CompilationMetadataReferences":
        //   (FileName \0  Aliases \0  Flags:byte  TimeStamp:uint32  FileSize:uint32  MVID:guid)*
        if !this.referenceInfos.IsDefaultOrEmpty {
            let refsBlob = BlobBuilder()
            for info in this.referenceInfos {
                refsBlob.WriteUTF8(info.FileName)
                refsBlob.WriteByte(0)
                refsBlob.WriteUTF8(info.Aliases ?? string.Empty)
                refsBlob.WriteByte(0)
                refsBlob.WriteByte(info.Flags)
                refsBlob.WriteUInt32(info.TimeStamp)
                refsBlob.WriteUInt32(info.FileSize)
                refsBlob.WriteBytes(info.Mvid.ToByteArray())
            }
            this.pdbMetadata.AddCustomDebugInformation(
                parent: moduleHandle,
                kind: this.pdbMetadata.GetOrAddGuid(CompilationMetadataReferencesKind),
                value: this.pdbMetadata.GetOrAddBlob(refsBlob)
            )
        }
        let pdbBuilder = PortablePdbBuilder(
            tablesAndHeaps: this.pdbMetadata,
            typeSystemRowCounts: peRowCounts,
            entryPoint: entryPoint,
            idProvider: idProvider
        )
        let pdbBlob = BlobBuilder()
        let contentId = pdbBuilder.Serialize(pdbBlob)
        return (pdbBlob, contentId)
    }

    /// Encodes an imports blob for an `ImportScope` row per the Portable PDB
    /// spec § "ImportScope". Each import becomes one record in the blob:
    /// - Non-alias imports → kind 1 (`ImportNamespace`): a compressed blob-heap offset of the UTF-8
    /// namespace string.
    /// - Alias imports → kind 7 (`AliasNamespace`): compressed blob-heap offset of the alias, then the
    /// namespace.
    /// Implicit (compiler-synthesized) imports are silently skipped because they
    /// have no user-visible declaration.
    private func BuildImportsBlob(imports ImmutableArray[ImportSymbol]) BlobHandle {
        let blob = BlobBuilder()
        for import_ in imports {
            if import_.IsImplicit {
                continue
            }
            let nsBytes = Encoding.UTF8.GetBytes(import_.Target)
            let nsHandle = this.pdbMetadata.GetOrAddBlob(nsBytes)
            let nsOffset = MetadataTokens.GetHeapOffset(nsHandle)
            if import_.IsAlias {
                // Kind 7 = AliasNamespace
                blob.WriteCompressedInteger(7)
                let aliasBytes = Encoding.UTF8.GetBytes(import_.Name)
                let aliasHandle = this.pdbMetadata.GetOrAddBlob(aliasBytes)
                blob.WriteCompressedInteger(MetadataTokens.GetHeapOffset(aliasHandle))
                blob.WriteCompressedInteger(nsOffset)
            } else {
                // Kind 1 = ImportNamespace
                blob.WriteCompressedInteger(1)
                blob.WriteCompressedInteger(nsOffset)
            }
        }
        return this.pdbMetadata.GetOrAddBlob(blob)
    }

    /// Encodes a LocalConstant blob per Portable PDB spec §II.23.2.
    /// Returns a (cref:BlobHandle) for the encoded signature, or
    /// `default` when the value type is unsupported.
    private func EncodeLocalConstantSignature(value object) BlobHandle {
        let blob = BlobBuilder()
        switch value {
            case b is bool {
                blob.WriteByte(0x02) // ELEMENT_TYPE_BOOLEAN
                blob.WriteByte(
                    if b {
                        uint8(1)
                    } else {
                        uint8(0)
                    }
                )
            }
            case ch is char {
                blob.WriteByte(0x03) // ELEMENT_TYPE_CHAR
                blob.WriteInt16(int16(ch))
            }
            case sb is int8 {
                blob.WriteByte(0x04) // ELEMENT_TYPE_I1
                blob.WriteSByte(sb)
            }
            case by is uint8 {
                blob.WriteByte(0x05) // ELEMENT_TYPE_U1
                blob.WriteByte(by)
            }
            case s is int16 {
                blob.WriteByte(0x06) // ELEMENT_TYPE_I2
                blob.WriteInt16(s)
            }
            case us is uint16 {
                blob.WriteByte(0x07) // ELEMENT_TYPE_U2
                blob.WriteUInt16(us)
            }
            case i is int32 {
                blob.WriteByte(0x08) // ELEMENT_TYPE_I4
                blob.WriteInt32(i)
            }
            case ui is uint32 {
                blob.WriteByte(0x09) // ELEMENT_TYPE_U4
                blob.WriteUInt32(ui)
            }
            case l is int64 {
                blob.WriteByte(0x0A) // ELEMENT_TYPE_I8
                blob.WriteInt64(l)
            }
            case ul is uint64 {
                blob.WriteByte(0x0B) // ELEMENT_TYPE_U8
                blob.WriteUInt64(ul)
            }
            case f is float32 {
                blob.WriteByte(0x0C) // ELEMENT_TYPE_R4
                blob.WriteUInt32(BitConverter.SingleToUInt32Bits(f))
            }
            case d is float64 {
                blob.WriteByte(0x0D) // ELEMENT_TYPE_R8
                blob.WriteUInt64(BitConverter.DoubleToUInt64Bits(d))
            }
            case str is string {
                blob.WriteByte(0x0E) // ELEMENT_TYPE_STRING
                blob.WriteBytes(Encoding.Unicode.GetBytes(str))
            }
            case nil {
                // Portable PDB spec §II.23.2: a null string constant is encoded
                // as ELEMENT_TYPE_STRING followed by the single-byte sentinel
                // 0xFF (a real empty string has zero trailing bytes; the 0xFF
                // sentinel can never appear at the start of a valid UTF-16
                // payload because it would imply a half code unit). Without a
                // tracked declared type we treat any null constant as a null
                // string reference — matching what debuggers expect for the
                // common `const s = nil` case and avoiding the silent dropping
                // of the LocalConstant row.
                blob.WriteByte(0x0E) // ELEMENT_TYPE_STRING
                blob.WriteByte(0xFF)
            }
            default {
                return default(BlobHandle)
            }
        }
        return this.pdbMetadata.GetOrAddBlob(blob)
    }

    private class RecordedMethod {
        init(
            points IReadOnlyList[SequencePoint]?,
            locals IReadOnlyList[LocalInfo]?,
            constants IReadOnlyList[LocalConstantInfo]?,
            ilCodeSize int32,
            localSignatureToken StandaloneSignatureHandle,
            syntaxTree SyntaxTree?,
            asyncStepping AsyncMethodSteppingInfo?
        ) {
            this.AsyncStepping = asyncStepping
            this.Points = points
            this.Locals = locals
            this.Constants = constants
            this.IlCodeSize = ilCodeSize
            this.LocalSignatureToken = localSignatureToken
            this.SyntaxTree = syntaxTree
        }

        prop Points IReadOnlyList[SequencePoint]? {
            get;
        }

        prop Locals IReadOnlyList[LocalInfo]? {
            get;
        }

        prop Constants IReadOnlyList[LocalConstantInfo]? {
            get;
        }

        prop IlCodeSize int32 {
            get;
        }

        prop LocalSignatureToken StandaloneSignatureHandle {
            get;
        }

        /// Gets the (cref:Syntax.SyntaxTree) that contains this method's
        /// declaration, or `null` for synthesized methods.
        /// Used by (cref:Serialize) to pick the per-file
        /// `ImportScope` for each `LocalScope` row.
        prop SyntaxTree SyntaxTree? {
            get;
        }

        prop AsyncStepping AsyncMethodSteppingInfo? {
            get;
        }
    }

    shared {
        // ECMA-335 / Portable PDB hash algorithm GUIDs (spec § "Document").
        private let HashAlgorithmSha256 Guid = Guid("8829D00F-11B8-4213-878B-770E8597AC16")

        // Portable PDB CustomDebugInformation kind GUIDs
        // (spec § "CustomDebugInformation").
        private let EmbeddedSourceKind Guid = Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE")

        private let SourceLinkKind Guid = Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A")
        private let CompilationOptionsKind Guid = Guid("B5FEEC05-8CD0-4A83-96DA-466284BB4BD8")
        private let CompilationMetadataReferencesKind Guid = Guid("7E4D4708-096E-4C5C-AEDA-CB10BA6A740D")
        private let AsyncMethodSteppingInformationKind Guid = Guid("54FD2AC5-E925-401A-9C2A-F94F171072F8")

        /// Stable GSharp language GUID. Once a tool keys off this value (debugger,
        /// symbol server, source indexer) it must never be reissued — see
        /// `docs/debug-info.md`. Generated specifically for this language and
        /// not shared with any other compiler.
        let GSharpLanguageGuid Guid = Guid("4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00")

        private let EmptyBlob[]uint8 = Array.Empty[uint8]()

        /// Writes a single `CompilationOptions` key/value pair using the
        /// spec's null-terminated UTF-8 layout: `name \0 value \0`.
        private func WriteCompilationOption(builder BlobBuilder, name string, value string) {
            builder.WriteUTF8(name)
            builder.WriteByte(0)
            builder.WriteUTF8(value ?? string.Empty)
            builder.WriteByte(0)
        }

        /// Encodes a method's sequence-point blob per Portable PDB spec § "Sequence
        /// points blob". The header writes the row id of the method's
        /// `StandaloneSignature` for locals (0 when the method has no locals)
        /// as a compressed unsigned integer — per spec this is a row id, NOT a
        /// full 32-bit metadata token. When every visible record shares
        /// [`primaryDocument`](paramref) the `InitialDocument` field is
        /// omitted (single-document optimisation).
        private func EncodeSequencePoints(
            blob BlobBuilder,
            points IReadOnlyList[SequencePoint],
            primaryDocument DocumentHandle,
            localSignatureToken StandaloneSignatureHandle
        ) {
            // LocalSignature — the row id of the method's StandaloneSignature for
            // locals (0 when the method has no locals), written as a compressed
            // unsigned integer. Per Portable PDB spec § "Sequence points blob"
            // this field is a row id only; writing the full 32-bit token here
            // happens to round-trip through System.Reflection.Metadata only
            // because the reader masks high bits, but is non-conforming and
            // wastes 3 bytes per method versus a 1-byte rowId. Roslyn writes the
            // row id only; we match that to be spec-compliant.
            let rowId = if localSignatureToken.IsNil {
                0
            } else {
                MetadataTokens.GetRowNumber(localSignatureToken)
            }
            blob.WriteCompressedInteger(rowId)
            // InitialDocument is omitted because every visible point shares the
            // method's primary document (asserted by the caller). Records follow.
            var firstNonHidden = true
            var prevIl = 0
            var prevStartLine = 0
            var prevStartColumn = 0
            var firstRecord = true
            // P2-12 (issue #421): Debuggers (Visual Studio, Rider) reportedly bind
            // F5 breakpoints flakily when the first sequence-point record of a
            // method is hidden (the 0xfeefee marker). Skip any leading hidden
            // points so the first emitted record always carries a real
            // line/column. Methods that are entirely hidden still emit their full
            // (hidden-only) sequence, preserving prior behaviour where there is
            // nothing user-visible to anchor on.
            var startIndex = 0
            var hasVisible = false
            for var i = 0; i < points.Count; i++ {
                if !points[i].IsHidden {
                    hasVisible = true
                    startIndex = i
                    break
                }
            }
            if !hasVisible {
                startIndex = 0
            }
            for var idx = startIndex; idx < points.Count; idx++ {
                let p = points[idx]
                // δIL — first record encodes the absolute IL offset, the rest the
                // delta from the previous record. The spec forbids two records
                // sharing the same IL offset; the BodyEmitter is responsible for
                // collapsing consecutive entries before reaching this point.
                let deltaIl = if firstRecord {
                    p.IlOffset
                } else {
                    p.IlOffset - prevIl
                }
                blob.WriteCompressedInteger(deltaIl)
                prevIl = p.IlOffset
                firstRecord = false
                if p.IsHidden {
                    // ΔLines = 0, ΔColumns = 0 — flagged as hidden.
                    blob.WriteCompressedInteger(0)
                    blob.WriteCompressedInteger(0)
                    continue
                }
                let deltaLines = p.EndLine - p.StartLine
                let deltaColumns = p.EndColumn - p.StartColumn
                blob.WriteCompressedInteger(deltaLines)
                if deltaLines == 0 {
                    blob.WriteCompressedInteger(deltaColumns)
                } else {
                    blob.WriteCompressedSignedInteger(deltaColumns)
                }
                if firstNonHidden {
                    blob.WriteCompressedInteger(p.StartLine)
                    blob.WriteCompressedInteger(p.StartColumn)
                    firstNonHidden = false
                } else {
                    blob.WriteCompressedSignedInteger(p.StartLine - prevStartLine)
                    blob.WriteCompressedSignedInteger(p.StartColumn - prevStartColumn)
                }
                prevStartLine = p.StartLine
                prevStartColumn = p.StartColumn
            }
        }

        private func FindPrimaryDocument(points IReadOnlyList[SequencePoint]) DocumentHandle {
            for p in points {
                if !p.Document.IsNil {
                    return p.Document
                }
            }
            return default(DocumentHandle)
        }
    }
}

/// One local-slot descriptor handed to (cref:PortablePdbEmitter.RecordMethod).
/// Compiler-generated locals (synthesized by lowering) flow through with
/// (cref:IsCompilerGenerated) set so debuggers can hide them from the
/// locals window.
internal struct LocalInfo {
    init(slotIndex int32, name string, isCompilerGenerated bool) {
        this.SlotIndex = slotIndex
        this.Name = name ?? string.Empty
        this.IsCompilerGenerated = isCompilerGenerated
    }

    prop SlotIndex int32 {
        get;
    }

    prop Name string {
        get;
    }

    prop IsCompilerGenerated bool {
        get;
    }
}

/// A compile-time constant binding handed to
/// (cref:PortablePdbEmitter.RecordMethod). The emitter encodes
/// (cref:Value) into a `LocalConstant` signature blob per
/// Portable PDB spec §II.23.2.
internal struct LocalConstantInfo {
    init(name string, value object) {
        this.Name = name ?? string.Empty
        this.Value = value
    }

    prop Name string {
        get;
    }

    prop Value object {
        get;
    }
}

/// A single sequence-point record gathered during IL emit. One-based line and
/// column values follow Portable PDB conventions. Use (cref:Hidden) to
/// construct a hidden marker (0xfeefee equivalent in encoded form).
internal struct SequencePoint {
    init(ilOffset int32, document DocumentHandle, startLine int32, startColumn int32, endLine int32, endColumn int32) {
        this.IlOffset = ilOffset
        this.Document = document
        this.StartLine = startLine
        this.StartColumn = startColumn
        this.EndLine = endLine
        this.EndColumn = endColumn
    }

    prop IlOffset int32 {
        get;
    }

    prop Document DocumentHandle {
        get;
    }

    prop StartLine int32 {
        get;
    }

    prop StartColumn int32 {
        get;
    }

    prop EndLine int32 {
        get;
    }

    prop EndColumn int32 {
        get;
    }

    prop IsHidden bool -> this.StartLine == HiddenLine

    shared {
        /// Sentinel `StartLine` value used by the in-memory representation to
        /// mark a hidden record. The encoded form on disk uses ΔLines=0 ∧
        /// ΔColumns=0 per the Portable PDB spec — this constant only flows through
        /// the emitter's internal collections.
        const HiddenLine int32 = 0xfeefee

        func Hidden(ilOffset int32, document DocumentHandle) SequencePoint -> SequencePoint(
            ilOffset,
            document,
            HiddenLine,
            0,
            HiddenLine,
            0
        )
    }
}
