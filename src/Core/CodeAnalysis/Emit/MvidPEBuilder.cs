// <copyright file="MvidPEBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1100 // base. required — Serialize(BlobBuilder) is inherited, not overridden
#pragma warning disable SA1118 // multi-line Section ctor is clearest here

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// A <see cref="ManagedPEBuilder"/> subclass that adds a <c>.mvid</c> PE section
/// to the output assembly. MSBuild's <c>CopyRefAssembly</c> task uses a lightweight
/// reader (<c>MvidReader</c>) that looks for this section to quickly extract the
/// module version identifier without loading full metadata. Without it, the task
/// cannot determine whether the public API surface has changed between builds and
/// falls back to always copying, defeating incremental build gating for downstream
/// consumers.
/// </summary>
internal sealed class MvidPEBuilder : ManagedPEBuilder
{
    private const string MvidSectionName = ".mvid";
    private const int SizeOfGuid = 16;

    private Blob mvidSectionFixup;

    public MvidPEBuilder(
        PEHeaderBuilder header,
        MetadataRootBuilder metadataRootBuilder,
        BlobBuilder ilStream,
        MethodDefinitionHandle entryPoint,
        DebugDirectoryBuilder debugDirectoryBuilder,
        Func<IEnumerable<Blob>, BlobContentId> deterministicIdProvider)
        : base(
            header,
            metadataRootBuilder,
            ilStream,
            entryPoint: entryPoint,
            debugDirectoryBuilder: debugDirectoryBuilder,
            deterministicIdProvider: deterministicIdProvider)
    {
    }

    /// <summary>
    /// Serializes the PE and returns the <c>.mvid</c> section fixup blob so
    /// the caller can patch it with the final content-derived GUID.
    /// </summary>
    /// <param name="peBlob">Destination blob builder for the PE image.</param>
    /// <param name="mvidFixup">
    /// On return, the reserved blob within the <c>.mvid</c> section that the
    /// caller must overwrite with the deterministic content ID GUID.
    /// </param>
    /// <returns>The content identifier derived from the serialized PE.</returns>
    public BlobContentId Serialize(BlobBuilder peBlob, out Blob mvidFixup)
    {
        var result = base.Serialize(peBlob);
        mvidFixup = this.mvidSectionFixup;
        return result;
    }

    protected override ImmutableArray<Section> CreateSections()
    {
        var baseSections = base.CreateSections();
        var builder = ImmutableArray.CreateBuilder<Section>(baseSections.Length + 1);

        builder.Add(new Section(MvidSectionName, SectionCharacteristics.MemRead | SectionCharacteristics.ContainsInitializedData | SectionCharacteristics.MemDiscardable));

        builder.AddRange(baseSections);
        return builder.MoveToImmutable();
    }

    protected override BlobBuilder SerializeSection(string name, SectionLocation location)
    {
        if (name.Equals(MvidSectionName, StringComparison.Ordinal))
        {
            var sectionBuilder = new BlobBuilder();
            this.mvidSectionFixup = sectionBuilder.ReserveBytes(SizeOfGuid);
            new BlobWriter(this.mvidSectionFixup).WriteBytes(0, SizeOfGuid);
            return sectionBuilder;
        }

        return base.SerializeSection(name, location);
    }
}
