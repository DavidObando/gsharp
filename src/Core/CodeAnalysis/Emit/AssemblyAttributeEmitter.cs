// <copyright file="AssemblyAttributeEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private per-attribute helpers they orchestrate)
#pragma warning disable SA1611 // parameter documentation missing — the public API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-13 (#1361): assembly-attribute emitter. Owns the assembly-level
/// attribute orchestrators that decorate the <c>Assembly</c> row built in
/// <c>EmitCore</c>, plus the assembly-version parsing that feeds that row.
/// </summary>
/// <remarks>
/// <para>
/// Methods moved here from <see cref="ReflectionMetadataEmitter"/> in
/// PR-E-13:
/// </para>
/// <list type="bullet">
/// <item><c>EmitReferenceAssemblyAttribute</c> — marks metadata-only
/// assemblies with <c>ReferenceAssemblyAttribute</c>.</item>
/// <item><c>ParseAssemblyVersion</c> — parses
/// <see cref="EmitContext.AssemblyVersionOverride"/> into the four-part
/// <see cref="Version"/> for the Assembly row.</item>
/// <item><c>EmitAssemblyInteropAttributes</c> — the cross-language-interop
/// orchestrator (informational version, type-semantics metadata, friend
/// assemblies, assembly-level nullable context).</item>
/// <item><c>EmitUserAssemblyAttributes</c> — emits every user-declared
/// <c>@assembly:</c> annotation (issue #2237).</item>
/// <item><c>EmitFriendAssemblyAttributes</c> — one
/// <c>InternalsVisibleToAttribute</c> row per declared friend
/// (issues #1929/#1953).</item>
/// <item><c>EmitGSharpTypeSemantics</c> — the
/// <c>AssemblyMetadataAttribute</c> type-semantics payload consumed by
/// <see cref="ImportedAssemblySemantics"/>.</item>
/// <item><c>EmitDebuggableAttribute</c> — <c>DebuggableAttribute(true, true)</c>
/// when debug information is present.</item>
/// <item><c>EmitNullableContextAttribute</c> — assembly-level
/// <c>NullableContextAttribute(1)</c>.</item>
/// </list>
/// <para>
/// Blob writing is delegated to <see cref="CustomAttributeEncoder"/>
/// wherever the attribute shape allows; the fixed-shape emitters here
/// (reference-assembly, debuggable, nullable-context) write their blobs
/// inline exactly as they did on the root.
/// </para>
/// </remarks>
internal sealed class AssemblyAttributeEmitter
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
    private readonly CustomAttributeEncoder attrEncoder;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;

    public AssemblyAttributeEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        CustomAttributeEncoder attrEncoder,
        Func<Type, TypeReferenceHandle> getTypeReference)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.attrEncoder = attrEncoder ?? throw new ArgumentNullException(nameof(attrEncoder));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
    }

    /// <summary>
    /// Marks the assembly with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute()</c> so
    /// loaders treat it as metadata-only and refuse to execute its (absent)
    /// method bodies.
    /// </summary>
    public void EmitReferenceAssemblyAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.ReferenceAssemblyAttribute", requireExternalVisibility: false, out var resolved)
            ? resolved
            : throw new InvalidOperationException(
                "Reference assembly emit requires System.Runtime.CompilerServices.ReferenceAssemblyAttribute to be resolvable from the supplied references.");
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        // Empty fixed/named argument blob: prolog 0x0001 + 0 named args.
        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Parses <see cref="EmitContext.AssemblyVersionOverride"/> into a <see cref="Version"/> suitable
    /// for the assembly row. Falls back to <c>1.0.0.0</c> when the string is absent or
    /// does not parse as a version.
    /// </summary>
    public Version ParseAssemblyVersion()
    {
        if (string.IsNullOrEmpty(this.emitCtx.AssemblyVersionOverride))
        {
            return new Version(1, 0, 0, 0);
        }

        // NuGet versions can contain pre-release suffixes (e.g. "1.2.3-beta.1").
        // Extract just the numeric prefix for System.Version.
        var versionStr = this.emitCtx.AssemblyVersionOverride;
        var dashIdx = versionStr.IndexOf('-');
        if (dashIdx >= 0)
        {
            versionStr = versionStr.Substring(0, dashIdx);
        }

        var plusIdx = versionStr.IndexOf('+');
        if (plusIdx >= 0)
        {
            versionStr = versionStr.Substring(0, plusIdx);
        }

        if (Version.TryParse(versionStr, out var v))
        {
            // Pad to four components for ECMA-335 assembly identity.
            return new Version(
                Math.Max(v.Major, 0),
                Math.Max(v.Minor, 0),
                Math.Max(v.Build, 0),
                Math.Max(v.Revision, 0));
        }

        return new Version(1, 0, 0, 0);
    }

    /// <summary>
    /// Emits assembly-level attributes required for cross-language interop (C#/F#
    /// consumability): <c>AssemblyInformationalVersionAttribute</c>,
    /// <c>AssemblyMetadataAttribute("RepositoryUrl", ...)</c>, and
    /// <c>NullableContextAttribute(1)</c>.
    /// </summary>
    public void EmitAssemblyInteropAttributes(AssemblyDefinitionHandle assemblyHandle)
    {
        // Issue #2237: emit every user-declared `@assembly:` attribute
        // (everything except InternalsVisibleTo, which keeps its dedicated
        // emission below) first, so the built-in synthesized attributes that
        // follow can detect — and skip — a type the user already declared
        // explicitly (e.g. an NBGV-style
        // `@assembly:AssemblyInformationalVersionAttribute(...)`), avoiding a
        // duplicate, non-repeatable CustomAttribute row.
        var userDeclaredAttributeTypeNames = this.EmitUserAssemblyAttributes(assemblyHandle);

        // 1. AssemblyInformationalVersionAttribute — carries the full NuGet
        // version string including pre-release suffix.
        if (!string.IsNullOrEmpty(this.emitCtx.AssemblyVersionOverride)
            && !userDeclaredAttributeTypeNames.Contains("System.Reflection.AssemblyInformationalVersionAttribute"))
        {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyInformationalVersionAttribute",
                typeof(System.Reflection.AssemblyInformationalVersionAttribute),
                this.emitCtx.AssemblyVersionOverride);
        }

        if (!string.IsNullOrEmpty(this.emitCtx.TargetFrameworkMoniker)
            && !userDeclaredAttributeTypeNames.Contains("System.Runtime.Versioning.TargetFrameworkAttribute"))
        {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Runtime.Versioning.TargetFrameworkAttribute",
                typeof(System.Runtime.Versioning.TargetFrameworkAttribute),
                this.emitCtx.TargetFrameworkMoniker);
        }

        this.EmitGSharpTypeSemantics(assemblyHandle);

        // Issue #1929/#1953: producer-declared friend assemblies. Each
        // `@assembly:InternalsVisibleTo("Foo")` annotation becomes a real
        // System.Runtime.CompilerServices.InternalsVisibleToAttribute row so
        // cross-assembly internal access is genuine producer opt-in — no
        // consumer-side name heuristic (see ImportedAssemblySemantics).
        this.EmitFriendAssemblyAttributes(assemblyHandle);

        // 2. NullableContextAttribute(1) — declares the assembly's default
        // nullable context as "annotated" so C# consumers see non-null by
        // default for GSharp types (GSharp has no null references).
        this.EmitNullableContextAttribute(assemblyHandle);
    }

    /// <summary>
    /// Issue #2237: emits a real <c>CustomAttribute</c> row for every
    /// file-level <c>@assembly:</c> annotation the binder resolved
    /// (<see cref="Binding.BoundProgram.AssemblyAttributes"/>) — every
    /// annotation EXCEPT <c>InternalsVisibleTo</c>, which
    /// <see cref="EmitFriendAssemblyAttributes"/> already covers. Reuses the
    /// same generic <see cref="CustomAttributeEncoder.EmitBoundAttribute"/>
    /// path used for type/method/field-level attributes, so any attribute
    /// type the compiler can resolve — BCL (<c>AssemblyVersionAttribute</c>,
    /// <c>AssemblyMetadataAttribute</c>, ...) or a same-compilation
    /// user-declared attribute type — becomes real assembly metadata,
    /// achieving parity with C#'s <c>[assembly: ...]</c>.
    /// </summary>
    /// <returns>
    /// The distinct set of emitted attributes' CLR type full names, used by
    /// <see cref="EmitAssemblyInteropAttributes"/> to avoid emitting a
    /// duplicate built-in synthesized attribute of the same (non-repeatable)
    /// type.
    /// </returns>
    private ImmutableHashSet<string> EmitUserAssemblyAttributes(AssemblyDefinitionHandle assemblyHandle)
    {
        var emitted = ImmutableHashSet.CreateBuilder<string>(StringComparer.Ordinal);
        foreach (var attr in this.emitCtx.Program.AssemblyAttributes)
        {
            this.attrEncoder.EmitBoundAttribute(assemblyHandle, attr);
            var clrTypeName = attr.AttributeType?.ClrType?.FullName;
            if (clrTypeName != null)
            {
                emitted.Add(clrTypeName);
            }
        }

        return emitted.ToImmutable();
    }

    private void EmitFriendAssemblyAttributes(AssemblyDefinitionHandle assemblyHandle)
    {
        foreach (var friend in this.emitCtx.Program.FriendAssemblies)
        {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Runtime.CompilerServices.InternalsVisibleToAttribute",
                typeof(System.Runtime.CompilerServices.InternalsVisibleToAttribute),
                friend);
        }
    }

    private void EmitGSharpTypeSemantics(AssemblyDefinitionHandle assemblyHandle)
    {
        foreach (var type in this.emitCtx.Program.Structs)
        {
            if (!this.cache.StructTypeDefs.TryGetValue(type, out var handle))
            {
                continue;
            }

            // Value types (`data struct`, or any struct with a primary
            // constructor) always carry the marker. Issue #2263: a `data class`
            // must ALSO carry it so a cross-assembly consumer can recover its
            // data semantics and support `with`/copy — but a plain (non-data)
            // reference class stays unmarked so it keeps importing as an
            // ordinary CLR class rather than a semantic aggregate.
            var isDataClass = type.IsClass && type.IsData;
            if (!isDataClass
                && (type.IsClass || (!type.IsData && !type.HasPrimaryConstructor)))
            {
                continue;
            }

            // Issue #1953 follow-up: pair each primary-ctor parameter name
            // with its backing field's metadata token (0 when no backing
            // field is found, e.g. a property-backed parameter), so the
            // importer (ImportedTypeSymbol.BuildPrimaryConstructorParameters)
            // can recover the parameter's type via the exact field even when
            // a future lowering/mangling pass makes the parameter name differ
            // from the field name — falling back to name matching only when
            // no token was recorded.
            var fieldsByName = type.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
            var parameterEntries = type.PrimaryConstructorParameters.Select(p =>
            {
                var token = 0;
                if (fieldsByName.TryGetValue(p.Name, out var backingField)
                    && this.cache.StructFieldDefs.TryGetValue(backingField, out var fieldHandle))
                {
                    token = MetadataTokens.GetToken(fieldHandle);
                }

                return $"{p.Name}:{token.ToString(CultureInfo.InvariantCulture)}";
            });

            var payload = string.Join(
                "|",
                MetadataTokens.GetToken(handle).ToString(CultureInfo.InvariantCulture),
                type.IsClass ? "class" : "struct",
                type.IsData ? "1" : "0",
                string.Join(",", parameterEntries));
            this.attrEncoder.EmitStringPairAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyMetadataAttribute",
                typeof(System.Reflection.AssemblyMetadataAttribute),
                ImportedAssemblySemantics.TypeSemanticsMetadataKey,
                payload);
        }
    }

    /// <summary>
    /// Emits <c>System.Diagnostics.DebuggableAttribute(true, true)</c> when
    /// debug information is present so managed debuggers treat the assembly as
    /// JIT-tracked and non-optimized.
    /// </summary>
    public void EmitDebuggableAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Diagnostics.DebuggableAttribute", requireExternalVisibility: false, out var resolved)
            ? resolved
            : typeof(System.Diagnostics.DebuggableAttribute);
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().Boolean();
                p.AddParameter().Type().Boolean();
            });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteBoolean(true);  // isJITTrackingEnabled
        valueBlob.WriteBoolean(true);  // isJITOptimizerDisabled
        valueBlob.WriteUInt16(0);      // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Emits <c>System.Runtime.CompilerServices.NullableContextAttribute(1)</c>
    /// on the assembly so C# consumers see GSharp public surface as non-nullable
    /// (oblivious context = 0, annotated = 1, warnings-only = 2).
    /// </summary>
    private void EmitNullableContextAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        // Reuse the cached NullableContextAttribute(byte) ctor MemberRef so the
        // assembly-, type-, and method-level emitters all share one row (the
        // P3-11 dedup invariant; see DeterministicEmitTests).
        var ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef();
        if (ctorRef.IsNil)
        {
            // The attribute may not exist in older TFMs — skip silently.
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteByte(1);        // Flag = Annotated (non-null by default)
        valueBlob.WriteUInt16(0);      // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }
}
