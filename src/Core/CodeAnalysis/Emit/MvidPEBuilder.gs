// <copyright file="MvidPEBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable

/// A (cref:ManagedPEBuilder) subclass that adds a `.mvid` PE section
/// to the output assembly. MSBuild's `CopyRefAssembly` task uses a lightweight
/// reader (`MvidReader`) that looks for this section to quickly extract the
/// module version identifier without loading full metadata. Without it, the task
/// cannot determine whether the public API surface has changed between builds and
/// falls back to always copying, defeating incremental build gating for downstream
/// consumers.
internal class MvidPEBuilder : ManagedPEBuilder {
    private var mvidSectionFixup Blob

    init(
        header PEHeaderBuilder,
        metadataRootBuilder MetadataRootBuilder,
        ilStream BlobBuilder,
        entryPoint MethodDefinitionHandle,
        debugDirectoryBuilder DebugDirectoryBuilder?,
        deterministicIdProvider(IEnumerable[Blob]) -> BlobContentId
    ) : base(
        header,
        metadataRootBuilder,
        ilStream,
        nil,
        nil,
        nil,
        debugDirectoryBuilder,
        128,
        entryPoint,
        CorFlags.ILOnly,
        deterministicIdProvider
    ) { }

    /// Serializes the PE and returns the `.mvid` section fixup blob so
    /// the caller can patch it with the final content-derived GUID.
    /// @param peBlob Destination blob builder for the PE image.
    /// @param mvidFixup On return, the reserved blob within the `.mvid` section that the
    /// caller must overwrite with the deterministic content ID GUID.
    /// @returns The content identifier derived from the serialized PE.
    func Serialize(peBlob BlobBuilder, out mvidFixup Blob) BlobContentId {
        let result = base.Serialize(peBlob)
        mvidFixup = this.mvidSectionFixup
        return result
    }

    protected override func CreateSections() ImmutableArray[PEBuilder.Section] {
        let baseSections = base.CreateSections()
        let builder = ImmutableArray.CreateBuilder[PEBuilder.Section](baseSections.Length + 1)
        // Append .mvid after the base sections so the final order matches the
        // conventional Roslyn layout (.text / .rsrc / .reloc / .mvid). Placing
        // .mvid first is spec-legal but uncommon and can confuse older tooling.
        builder.AddRange(baseSections)
        builder.Add(
            PEBuilder.Section(
                MvidSectionName,
                SectionCharacteristics.MemRead | SectionCharacteristics.ContainsInitializedData | SectionCharacteristics.MemDiscardable
            )
        )
        return builder.MoveToImmutable()
    }

    protected override func SerializeSection(name string, location SectionLocation) BlobBuilder {
        if name.Equals(MvidSectionName, StringComparison.Ordinal) {
            let sectionBuilder = BlobBuilder()
            this.mvidSectionFixup = sectionBuilder.ReserveBytes(SizeOfGuid)
            BlobWriter(this.mvidSectionFixup).WriteBytes(0, SizeOfGuid)
            return sectionBuilder
        }
        return base.SerializeSection(name, location)
    }

    shared {
        private const MvidSectionName string = ".mvid"
        private const SizeOfGuid int32 = 16
    }
}
