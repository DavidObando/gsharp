// <copyright file="CustomAttributeEncoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by entry-point first, then private blob-encoding helpers)
#pragma warning disable SA1611 // parameter documentation missing — the public API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-12: custom-attribute blob encoder. Owns every helper that writes an
/// ECMA-335 II.23.3 <c>CustomAttribute</c> value blob plus the
/// per-attribute orchestration that maps a <see cref="BoundAttribute"/>
/// onto a constructor and named-argument pair.
/// </summary>
/// <remarks>
/// <para>
/// Methods moved here from <see cref="ReflectionMetadataEmitter"/> in
/// PR-E-12:
/// </para>
/// <list type="bullet">
/// <item><c>EmitBoundAttribute</c> — entry point for emitting a single
/// bound user attribute (resolves ctor, encodes fixed and named args,
/// attaches the row to the supplied parent).</item>
/// <item><c>EmitUserAttributes</c> — convenience iterator that filters a
/// symbol's bound attributes by target kind and forwards each match to
/// <c>EmitBoundAttribute</c>.</item>
/// <item><c>EmitStringAttribute</c> — fixed-shape single-string attribute
/// emitter (used by the assembly-level orchestrators on the root).</item>
/// <item><c>EmitIsReadOnlyAttributeOnParameter</c> — emits a parameter-level
/// <c>IsReadOnlyAttribute</c> row using the well-known ctor reference.</item>
/// <item><c>NextParameterHandle</c> — small helper that returns the next
/// <see cref="ParameterHandle"/> the metadata builder will allocate; lives
/// here because attribute emission is the dominant consumer (it must be
/// threaded into every <c>AddMethodDefinition</c> call so the Param-table
/// runs stay monotone — see issue #170).</item>
/// </list>
/// <para>
/// Plus the private static blob-encoding helpers:
/// <c>ResolveAttributeConstructor</c>, <c>ParametersMatch</c>,
/// <c>ArgAssignable</c>, <c>BuildCtorArgumentValues</c>,
/// <c>NormalizeWellKnownType</c>, <c>IsTriviallyConvertible</c>,
/// <c>EncodeClrTypeForCtorSig</c>, <c>WriteCustomAttributeFixedArg</c>,
/// <c>WriteCustomAttributeArrayArg</c>, <c>GetSerializedTypeName</c>,
/// <c>GetEnumUnderlyingTypeSafe</c>, <c>WriteCustomAttributeNamedArg</c>,
/// <c>WriteCustomAttributeFieldOrPropertyType</c>.
/// </para>
/// <para>
/// The assembly-level orchestrators
/// (<c>EmitReferenceAssemblyAttribute</c>,
/// <c>EmitAssemblyInteropAttributes</c>, <c>EmitDebuggableAttribute</c>,
/// <c>EmitNullableContextAttribute</c>) moved onto
/// <see cref="AssemblyAttributeEmitter"/> in PR-E-13: they are called once
/// each from <c>EmitCore</c> and forward into this encoder for the actual
/// blob writes.
/// </para>
/// </remarks>
internal sealed class CustomAttributeEncoder
{
    private readonly EmitContext emitCtx;
    private readonly WellKnownReferences wellKnown;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<StructSymbol, EntityHandle>? resolvePrimaryCtorToken;
    private readonly Func<StructSymbol, EntityHandle>? resolveDefaultCtorToken;
    private readonly Func<StructSymbol, ConstructorSymbol, EntityHandle>? resolveExplicitCtorToken;

    public CustomAttributeEncoder(
        EmitContext emitCtx,
        WellKnownReferences wellKnown,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<StructSymbol, EntityHandle>? resolvePrimaryCtorToken = null,
        Func<StructSymbol, EntityHandle>? resolveDefaultCtorToken = null,
        Func<StructSymbol, ConstructorSymbol, EntityHandle>? resolveExplicitCtorToken = null)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.resolvePrimaryCtorToken = resolvePrimaryCtorToken;
        this.resolveDefaultCtorToken = resolveDefaultCtorToken;
        this.resolveExplicitCtorToken = resolveExplicitCtorToken;
    }

    /// <summary>
    /// Emits a fixed-shape custom attribute whose constructor takes a single
    /// <see cref="string"/> argument, used by assembly-level helpers such as
    /// <c>EmitReferenceAssemblyAttribute</c> and the AssemblyInfo emitters.
    /// </summary>
    public void EmitStringAttribute(EntityHandle parent, string typeName, Type fallbackType, string value)
    {
        var attrType = this.emitCtx.References.TryResolveType(typeName, requireExternalVisibility: false, out var resolved)
            ? resolved
            : fallbackType;
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), p => p.AddParameter().Type().String());

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteSerializedString(value);
        valueBlob.WriteUInt16(0); // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    public void EmitStringPairAttribute(EntityHandle parent, string typeName, Type fallbackType, string firstValue, string secondValue)
    {
        var attrType = this.emitCtx.References.TryResolveType(typeName, requireExternalVisibility: false, out var resolved)
            ? resolved
            : fallbackType;
        var attrTypeRef = this.getTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), p =>
            {
                p.AddParameter().Type().String();
                p.AddParameter().Type().String();
            });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        valueBlob.WriteSerializedString(firstValue);
        valueBlob.WriteSerializedString(secondValue);
        valueBlob.WriteUInt16(0); // NumNamed

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    public void EmitIsReadOnlyAttributeOnParameter(ParameterHandle paramHandle)
    {
        var ctorRef = this.wellKnown.GetIsReadOnlyAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// ADR-0101 / issue #799: emits a parameter-level
    /// <see cref="System.ParamArrayAttribute"/> row using the well-known ctor
    /// reference. Stamped on the last (variadic) parameter of every
    /// G#-authored variadic function so the metadata signature is
    /// indistinguishable from a C#-authored <c>params T[]</c> method.
    /// </summary>
    /// <param name="paramHandle">The Param row to attach the attribute to.</param>
    public void EmitParamArrayAttributeOnParameter(ParameterHandle paramHandle)
    {
        var ctorRef = this.wellKnown.GetParamArrayAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// ADR-0173 / issue #3627: emits
    /// <c>System.Runtime.CompilerServices.ParamCollectionAttribute</c> on a
    /// Param row — the C#13 params-collections marker for a variadic
    /// parameter whose carrier is a non-array collection. Silently no-ops
    /// when the attribute type can't be resolved (pre-.NET 9 TFMs).
    /// </summary>
    /// <param name="paramHandle">The Param row to attach the attribute to.</param>
    public void EmitParamCollectionAttributeOnParameter(ParameterHandle paramHandle)
    {
        var ctorRef = this.wellKnown.GetParamCollectionAttributeCtorRef();
        if (ctorRef.IsNil)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #834: emits
    /// <c>System.Runtime.CompilerServices.NullableAttribute</c> on a Param row
    /// using either the single-byte ctor (when <paramref name="flags"/> has
    /// length 1) or the byte-array ctor (when there are nested generic
    /// inner-position bytes). Silently no-ops when the attribute type can't
    /// be resolved (very old TFMs) or when <paramref name="flags"/> is empty.
    /// </summary>
    /// <param name="paramHandle">The Param row to attach the attribute to.</param>
    /// <param name="flags">The DFS pre-order nullability byte array.</param>
    public void EmitNullableAttributeOnParameter(ParameterHandle paramHandle, ImmutableArray<byte> flags)
    {
        this.EmitNullableAttributeOnEntity(paramHandle, flags);
    }

    /// <summary>
    /// Issue #1354: emits a per-field
    /// <c>System.Runtime.CompilerServices.NullableAttribute</c> on a Field row
    /// when <paramref name="type"/> has at least one position that deviates from
    /// the non-null default (i.e. the computed flags array contains a byte other
    /// than <see cref="NullableFlagsBuilder.NotAnnotated"/>). All-non-null
    /// reference fields rely on the enclosing type's <c>NullableContextAttribute(1)</c>
    /// instead, matching the compact C#/Roslyn emit shape and keeping round-trip
    /// fidelity (importer reads non-null via the type-chain context walk).
    /// </summary>
    /// <param name="fieldHandle">The Field row to attach the attribute to.</param>
    /// <param name="type">The field's declared type.</param>
    public void EmitNullableAttributeOnField(FieldDefinitionHandle fieldHandle, TypeSymbol type)
    {
        var flags = NullableFlagsBuilder.Build(type);
        if (ShouldEmitPerPositionNullable(flags))
        {
            this.EmitNullableAttributeOnEntity(fieldHandle, flags);
        }

        // ADR-0172 Phase B: every per-field slot-metadata pass also carries
        // tuple element names when the declared type has any.
        this.EmitTupleElementNamesAttribute(fieldHandle, type);
    }

    /// <summary>
    /// ADR-0172 Phase B: emits
    /// <c>System.Runtime.CompilerServices.TupleElementNamesAttribute(string[])</c>
    /// on a Param / Field / Property row when <paramref name="type"/> declares
    /// at least one tuple element name anywhere in its tree (flattened DFS
    /// pre-order, null entries for unnamed positions — the C# encoding).
    /// Silently no-ops when no name exists or the attribute type can't be
    /// resolved (very old TFMs).
    /// </summary>
    /// <param name="parent">The metadata row to attach the attribute to.</param>
    /// <param name="type">The declared parameter / return / field / property type.</param>
    public void EmitTupleElementNamesAttribute(EntityHandle parent, TypeSymbol type)
    {
        var names = TupleElementNamesBuilder.Build(type);
        if (names.IsDefaultOrEmpty)
        {
            return;
        }

        var ctorRef = this.wellKnown.GetTupleElementNamesAttributeCtorRef();
        if (ctorRef.IsNil)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteInt32(names.Length);
        foreach (var name in names)
        {
            valueBlob.WriteSerializedString(name);
        }

        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #1354: emits a per-property
    /// <c>System.Runtime.CompilerServices.NullableAttribute</c> on a Property row
    /// under the same "deviates from non-null default" condition as
    /// <see cref="EmitNullableAttributeOnField"/>. Properties have no dedicated
    /// return-parameter row, so the attribute lands on the Property row itself
    /// (mirrors <c>ClrNullability.GetPropertyTypeSymbol</c>'s read path).
    /// </summary>
    /// <param name="propertyHandle">The Property row to attach the attribute to.</param>
    /// <param name="type">The property's declared type.</param>
    public void EmitNullableAttributeOnProperty(PropertyDefinitionHandle propertyHandle, TypeSymbol type)
    {
        var flags = NullableFlagsBuilder.Build(type);
        if (ShouldEmitPerPositionNullable(flags))
        {
            this.EmitNullableAttributeOnEntity(propertyHandle, flags);
        }

        // ADR-0172 Phase B: see EmitNullableAttributeOnField.
        this.EmitTupleElementNamesAttribute(propertyHandle, type);
    }

    /// <summary>
    /// Issue #1354: returns <c>true</c> when a per-position
    /// <c>[NullableAttribute]</c> must be emitted for a field/property — i.e. the
    /// flags array is non-empty AND contains at least one byte that is not
    /// <see cref="NullableFlagsBuilder.NotAnnotated"/> (a <c>2</c> nullable
    /// position or a <c>0</c> oblivious position). When every position is
    /// non-null the type-level <c>NullableContextAttribute(1)</c> covers it.
    /// </summary>
    /// <param name="flags">The DFS pre-order nullability byte array.</param>
    /// <returns><c>true</c> when the attribute must be emitted.</returns>
    internal static bool ShouldEmitPerPositionNullable(ImmutableArray<byte> flags)
    {
        if (flags.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var b in flags)
        {
            if (b != NullableFlagsBuilder.NotAnnotated)
            {
                return true;
            }
        }

        return false;
    }

    private void EmitNullableAttributeOnEntity(EntityHandle parent, ImmutableArray<byte> flags)
    {
        if (flags.IsDefaultOrEmpty)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);

        MemberReferenceHandle ctorRef;
        if (flags.Length == 1)
        {
            ctorRef = this.wellKnown.GetNullableAttributeByteCtorRef();
            if (ctorRef.IsNil)
            {
                return;
            }

            valueBlob.WriteByte(flags[0]);
        }
        else
        {
            ctorRef = this.wellKnown.GetNullableAttributeByteArrayCtorRef();
            if (ctorRef.IsNil)
            {
                return;
            }

            valueBlob.WriteInt32(flags.Length);
            foreach (var b in flags)
            {
                valueBlob.WriteByte(b);
            }
        }

        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #834: emits
    /// <c>System.Runtime.CompilerServices.NullableContextAttribute(<paramref name="flag"/>)</c>
    /// on a MethodDef row to declare the method-level default nullability
    /// context (per-position <c>NullableAttribute</c> rows only need to cover
    /// positions that deviate from this default).
    /// </summary>
    /// <param name="methodHandle">The MethodDef row to attach the attribute to.</param>
    /// <param name="flag">The nullability flag (0/1/2).</param>
    public void EmitNullableContextAttributeOnMethod(MethodDefinitionHandle methodHandle, byte flag)
    {
        var ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef();
        if (ctorRef.IsNil)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteByte(flag);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: methodHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #1354: emits
    /// <c>System.Runtime.CompilerServices.NullableContextAttribute(<paramref name="flag"/>)</c>
    /// on a TypeDef row to declare the type-level default nullability context.
    /// This is the linchpin of gsc→gsc round-trip: the metadata importer's
    /// <c>ReadNullableFlags</c> fallback walks the <c>DeclaringType</c> chain, so a
    /// non-null reference field/property emitted with no per-position
    /// <c>[NullableAttribute]</c> is re-read as non-null only when this type-level
    /// context is present (otherwise, post-#1354, the absence would read as
    /// nullable). Mirrors what C#/Roslyn emits on every nullable-aware type.
    /// </summary>
    /// <param name="typeHandle">The TypeDef row to attach the attribute to.</param>
    /// <param name="flag">The nullability flag (0/1/2).</param>
    public void EmitNullableContextAttributeOnType(TypeDefinitionHandle typeHandle, byte flag)
    {
        var ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef();
        if (ctorRef.IsNil)
        {
            return;
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteByte(flag);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Phase 3 of #141 / ADR-0047 §3: emits a <c>CustomAttribute</c> row for
    /// every bound user annotation on <paramref name="symbol"/> whose target
    /// matches <paramref name="filter"/>. Resolves the attribute type to a
    /// CLR <see cref="Type"/>, picks a constructor matching the supplied
    /// positional argument arity / element types, writes the ECMA-335 II.23.3
    /// value blob (prolog <c>0x0001</c>, fixed args, named-arg count, named
    /// args), and attaches it to <paramref name="parent"/>.
    /// Attributes whose CLR type can't be resolved or whose ctor cannot be
    /// matched are silently skipped — the binder owns user-facing diagnostics.
    /// </summary>
    /// <remarks>
    /// Pseudo-custom attributes (<c>@DllImport</c>, <c>@LibraryImport</c>,
    /// <c>@StructLayout</c>, <c>@FieldOffset</c>) are always skipped — they
    /// are written into dedicated metadata-table rows (ImplMap,
    /// ClassLayout, FieldLayout) by other emit paths, and duplicating them
    /// as <c>CustomAttribute</c> rows would create a misleading reflection
    /// view (see <see cref="KnownAttributes.IsPseudoCustomAttribute"/>).
    /// </remarks>
    /// <param name="parent">The metadata entity (TypeDef / MethodDef / ...) to attach the attribute to.</param>
    /// <param name="symbol">The symbol carrying the bound annotation list.</param>
    /// <param name="filter">Only attributes whose <see cref="BoundAttribute.Target"/> equals this kind are emitted.</param>
    public void EmitUserAttributes(EntityHandle parent, Symbol symbol, AttributeTargetKind filter)
    {
        if (symbol?.Attributes.IsDefaultOrEmpty != false)
        {
            return;
        }

        foreach (var attr in symbol.Attributes)
        {
            if (attr.Target != filter)
            {
                continue;
            }

            if (KnownAttributes.IsPseudoCustomAttribute(attr))
            {
                continue;
            }

            this.EmitBoundAttribute(parent, attr);
        }
    }

    /// <summary>
    /// Variant of <see cref="EmitUserAttributes"/> that skips any attribute
    /// matching <paramref name="excludePredicate"/>. Used historically by
    /// the P/Invoke emitter (ADR-0086 / issue #727) to elide the
    /// <c>@DllImport</c> attribute itself; the universal pseudo-custom
    /// filter on <see cref="EmitUserAttributes"/> now covers
    /// <c>@DllImport</c>, <c>@LibraryImport</c>, <c>@StructLayout</c>, and
    /// <c>@FieldOffset</c> automatically, so this overload is retained
    /// only for callers that need additional, narrower exclusion logic.
    /// </summary>
    /// <param name="parent">The metadata entity (TypeDef / MethodDef / ...) to attach the attributes to.</param>
    /// <param name="symbol">The symbol carrying the bound annotation list.</param>
    /// <param name="filter">Only attributes whose <see cref="BoundAttribute.Target"/> equals this kind are considered.</param>
    /// <param name="excludePredicate">Attributes for which this predicate returns <c>true</c> are skipped.</param>
    public void EmitUserAttributesExcept(EntityHandle parent, Symbol symbol, AttributeTargetKind filter, Func<BoundAttribute, bool> excludePredicate)
    {
        if (symbol?.Attributes.IsDefaultOrEmpty != false)
        {
            return;
        }

        foreach (var attr in symbol.Attributes)
        {
            if (attr.Target != filter)
            {
                continue;
            }

            if (KnownAttributes.IsPseudoCustomAttribute(attr))
            {
                continue;
            }

            if (excludePredicate != null && excludePredicate(attr))
            {
                continue;
            }

            this.EmitBoundAttribute(parent, attr);
        }
    }

    /// <summary>
    /// Returns the next <see cref="ParameterHandle"/> that will be assigned by
    /// the next call to <see cref="MetadataBuilder.AddParameter"/>. Issue #170:
    /// every <c>AddMethodDefinition</c> call must thread this value into its
    /// <c>parameterList</c> argument so the Param table's per-method runs stay
    /// monotone — methods that emit no parameter rows must share the same
    /// "next" handle, and methods that emit N rows anchor the run that follows.
    /// </summary>
    public ParameterHandle NextParameterHandle()
        => MetadataTokens.ParameterHandle(this.emitCtx.Metadata.GetRowCount(TableIndex.Param) + 1);

    public void EmitBoundAttribute(EntityHandle parent, BoundAttribute attr)
    {
        // Issue #1921: a same-compilation user class deriving from
        // System.Attribute (accepted by GS0200 via
        // StructSymbol.DerivesFromSystemAttribute) has no ClrType until
        // emitted — the CLR-reflection path below can't resolve its
        // constructor. Mirror that path symbolically instead so a plain
        // `@Note("x")` on a user `NoteAttribute` round-trips into a real
        // CustomAttribute row the same way a BCL attribute does.
        if (attr.AttributeType is StructSymbol userAttrType && userAttrType.ClrType == null)
        {
            this.EmitUserBoundAttribute(parent, userAttrType, attr);
            return;
        }

        var clrType = attr.AttributeType.ClrType;
        if (clrType == null)
        {
            return;
        }

        // Type.FullName is null for a constructed generic whose type argument
        // has no full name of its own -- reachable via the C#11-style generic
        // attribute application in DeclarationBinder.Attributes.cs. That is a
        // resolve FAILURE, not a reason to skip the attribute: TryResolveType
        // already returned false for a null name (its first statement is an
        // IsNullOrEmpty check) and the emit continued against the raw CLR type.
        // Returning here instead silently dropped the CustomAttribute row.
        var fullName = clrType.FullName;
        if (fullName == null
            || !this.emitCtx.References.TryResolveType(fullName, requireExternalVisibility: false, out var resolved))
        {
            resolved = clrType;
        }

        var positional = attr.PositionalArguments;
        var ctor = ResolveAttributeConstructor(resolved, positional);
        if (ctor == null)
        {
            // Issue #4097: "no candidate matched" is the right ANSWER for this
            // program; treating it as "nothing to emit" was the bug. Dropping
            // the row here compiled clean, IL-verified and ran, and the
            // annotation the author wrote was simply absent from the metadata.
            // That silence is how issue #4073's `Type[]` half stayed invisible.
            EmitDiagnosticException.ThrowAttributeConstructorNotFound(
                attr.Syntax,
                attr.AttributeType.Name,
                DescribeArgumentList(positional));
        }

        var ctorParams = ctor.GetParameters();
        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                ctorParams.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in ctorParams)
                    {
                        this.EncodeClrTypeForCtorSig(ps.AddParameter().Type(), p.ParameterType);
                    }
                });

        var attrTypeRef = this.getTypeReference(resolved);
        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        // Map the supplied positional arguments onto the constructor parameters,
        // collapsing a trailing params-array (e.g. InlineData(params object[]))
        // into a single synthesized array argument.
        var effective = BuildCtorArgumentValues(ctorParams, positional);

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        for (int i = 0; i < ctorParams.Length; i++)
        {
            // Normalize to the executing runtime's Type so the reference-equality
            // checks in the value-blob writer succeed even when the attribute was
            // resolved through a MetadataLoadContext (e.g. third-party packages).
            var writeType = NormalizeWellKnownType(ctorParams[i].ParameterType);
            WriteCustomAttributeFixedArg(valueBlob, writeType, effective[i]);
        }

        var named = attr.NamedArguments;
        valueBlob.WriteUInt16((ushort)named.Length);
        foreach (var arg in named)
        {
            WriteCustomAttributeNamedArg(valueBlob, resolved, arg);
        }

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #1921: emits a <c>CustomAttribute</c> row for an attribute whose
    /// resolved type is a same-compilation <see cref="StructSymbol"/> (no
    /// <c>ClrType</c> yet — it hasn't been emitted). Selects the
    /// primary or an explicit constructor by exact arity against
    /// <paramref name="attr"/>'s positional arguments (the same "match the
    /// constructor shape" step <see cref="ResolveAttributeConstructor"/> does
    /// for CLR types, minus params-array expansion, which no G# constructor
    /// declaration can express) and writes the fixed-argument blob using each
    /// parameter's own (always-primitive-or-string, hence already-resolved)
    /// <c>TypeSymbol.ClrType</c>.
    /// </summary>
    /// <remarks>
    /// Named (property/field) arguments are intentionally NOT supported for
    /// user-defined attribute types here: <see cref="WriteCustomAttributeNamedArg"/>
    /// resolves the target member's CLR type via <c>Type.GetProperty</c>/
    /// <c>Type.GetField</c> reflection, which is unavailable for a type
    /// that hasn't been emitted yet. Reimplementing that against
    /// <see cref="StructSymbol"/> fields/properties (including nested-enum
    /// underlying types, <see cref="System.Type"/> arguments, etc.) is a
    /// separate, considerably larger feature than closing the GS0200
    /// recognition gap this issue is about. Named arguments on a
    /// same-compilation user attribute are now rejected at bind time (GS0466,
    /// see <c>DeclarationBinder.BindAttribute</c>), so <paramref name="attr"/>
    /// never carries any by the time it reaches the emitter — this method
    /// only ever writes <c>NumNamed = 0</c>.
    /// </remarks>
    private void EmitUserBoundAttribute(EntityHandle parent, StructSymbol attributeType, BoundAttribute attr)
    {
        if (!this.TryResolveUserAttributeConstructor(
                attributeType,
                attr,
                out var ctorToken,
                out var paramTypes,
                out var unsupportedParameter))
        {
            // Issue #4097: both failure modes used to drop the row silently.
            // They are genuinely different and must not share one message. An
            // invalid PARAMETER type means the attribute DECLARATION is
            // ill-formed — measured: every shape that reaches here is one csc
            // rejects as CS0181 — so the arguments are not what to talk about
            // (GS0584). Anything else means no constructor accepts what was
            // written (GS0583).
            if (unsupportedParameter is { } offending)
            {
                EmitDiagnosticException.ThrowAttributeConstructorParameterTypeNotSupported(
                    attr.Syntax,
                    offending.Name,
                    attributeType.Name,
                    offending.Type?.Name ?? "?");
            }

            EmitDiagnosticException.ThrowAttributeConstructorNotFound(
                attr.Syntax,
                attributeType.Name,
                DescribeArgumentList(attr.PositionalArguments));
        }

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001); // Prolog
        for (int i = 0; i < paramTypes.Length; i++)
        {
            var writeType = NormalizeWellKnownType(paramTypes[i]);
            WriteCustomAttributeFixedArg(valueBlob, writeType, attr.PositionalArguments[i].Value);
        }

        valueBlob.WriteUInt16(0); // NumNamed — see remarks above.

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: parent,
            constructor: ctorToken,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Selects the primary or an explicit constructor of <paramref name="attributeType"/>
    /// whose arity matches <paramref name="attr"/>'s positional argument count
    /// AND whose parameter types actually accept the supplied argument values
    /// (the same <see cref="ArgAssignable"/> check <see cref="ResolveAttributeConstructor"/>
    /// uses for CLR-imported attribute types), returning the already-correct
    /// emit-ready <see cref="EntityHandle"/> for it (a bare <c>MethodDef</c>,
    /// or — for a constructed generic attribute type — a <c>MemberRef</c>
    /// parented at the constructed TypeSpec; both cases are handled by the
    /// injected resolver delegates, the same ones used for `newobj` against a
    /// user constructor). Returns <see langword="false"/> when no arity match
    /// exists or a parameter's type has no <see cref="TypeSymbol.ClrType"/>
    /// (an as-yet-unemitted user type used as an attribute constructor
    /// parameter — unsupported, same as the CLR path bailing out when it
    /// can't resolve a parameter type). Throws <see cref="EmitDiagnosticException"/>
    /// (surfaced as GS9998) when two or more same-arity explicit constructors
    /// both accept the supplied arguments — overload resolution has no way to
    /// silently guess which one the user meant (issue #1921 code review).
    /// </summary>
    private bool TryResolveUserAttributeConstructor(
        StructSymbol attributeType,
        BoundAttribute attr,
        out EntityHandle ctorToken,
        [NotNullWhen(true)] out Type[]? paramTypes,
        out ParameterSymbol? unsupportedParameter)
    {
        var argCount = attr.PositionalArguments.Length;
        ctorToken = default;
        paramTypes = null;
        unsupportedParameter = null;
        var sawProjectableCandidate = false;

        if (attributeType.HasPrimaryConstructor
            && attributeType.PrimaryConstructorParameters.Length == argCount
            && this.resolvePrimaryCtorToken != null)
        {
            if (!TryGetClrParameterTypes(attributeType.PrimaryConstructorParameters, out paramTypes, out var offending))
            {
                unsupportedParameter = offending;
            }
            else if (SawProjectable(ref sawProjectableCandidate)
                && ArgumentsAssignable(attr.PositionalArguments, paramTypes))
            {
                ctorToken = this.resolvePrimaryCtorToken(attributeType);
                return true;
            }
            else
            {
                // Issue #4097: this arm used to be missing entirely. A primary
                // constructor was accepted on ARITY alone, so `@Note(1)` at
                // `NoteAttribute(Text string)` reached the blob writer with an
                // int for a string slot and came out as GS9998 — an internal
                // compiler error for a plain argument-type mistake. The
                // CLR-imported path has always applied this rule via
                // `ParametersMatch`.
                paramTypes = null;
            }
        }

        if (this.resolveExplicitCtorToken != null)
        {
            ConstructorSymbol? matchedCtor = null;
            Type[]? matchedParamTypes = null;
            ConstructorSymbol? ambiguousCtor = null;

            foreach (var ctor in attributeType.EffectiveExplicitConstructors)
            {
                if (ctor.Parameters.Length != argCount)
                {
                    continue;
                }

                if (!TryGetClrParameterTypes(ctor.Parameters, out var candidateParamTypes, out var offending))
                {
                    // Recorded, but only provisionally — see the
                    // `sawProjectableCandidate` reset below.
                    // First unencodable parameter wins, and an already-recorded
                    // one from the primary constructor is kept. Where BOTH a
                    // primary constructor of this arity rejected the arguments
                    // and an explicit one of the same arity has an unencodable
                    // parameter, GS0584 is reported rather than GS0583 — it
                    // names a real obstacle to emitting this attribute at all,
                    // so fixing the arguments alone would not help.
                    unsupportedParameter ??= offending;
                    continue;
                }

                sawProjectableCandidate = true;
                if (!ArgumentsAssignable(attr.PositionalArguments, candidateParamTypes))
                {
                    continue;
                }

                if (matchedCtor != null)
                {
                    ambiguousCtor = ctor;
                    break;
                }

                matchedCtor = ctor;
                matchedParamTypes = candidateParamTypes;
            }

            if (ambiguousCtor != null)
            {
                EmitDiagnosticException.Throw(
                    attr.Syntax,
                    $"Ambiguous constructor for attribute '{attributeType.Name}': more than one 'init(...)' overload with {argCount} parameter(s) accepts the given argument types. Add an explicit conversion or change the argument types to disambiguate.");
            }

            if (matchedCtor != null && matchedParamTypes != null)
            {
                ctorToken = this.resolveExplicitCtorToken(attributeType, matchedCtor);
                paramTypes = matchedParamTypes;
                return true;
            }
        }

        if (sawProjectableCandidate)
        {
            // Review feedback on PR #4137: an unprojectable parameter was
            // recorded on ARITY alone, before applicability was settled. If
            // some other constructor of the same arity projected fine and the
            // arguments simply did not match it, the author's problem is the
            // arguments (GS0583), not a parameter type on a constructor that
            // was never going to be chosen (GS0584). Clearing the record here
            // keeps GS0584 for the case where EVERY arity-matching candidate
            // failed to project.
            unsupportedParameter = null;
        }

        if (argCount == 0 && this.resolveDefaultCtorToken != null)
        {
            try
            {
                ctorToken = this.resolveDefaultCtorToken(attributeType);
            }
            catch (InvalidOperationException)
            {
                // No emitted default ctor (e.g. an attribute class declared
                // with only explicit `init(...)` constructors) — nothing
                // else to try for a zero-arg application.
                return false;
            }

            paramTypes = Array.Empty<Type>();
            return true;
        }

        paramTypes = null;
        return false;
    }

    /// <summary>
    /// Projects a same-compilation constructor's parameter types onto CLR
    /// types, naming the first parameter that has none.
    /// </summary>
    /// <param name="parameters">The constructor's parameters.</param>
    /// <param name="clrTypes">The projected types, when every parameter has one.</param>
    /// <param name="unsupported">
    /// Issue #4097: the first parameter whose type has no <c>ClrType</c> — a
    /// same-compilation type, whose TypeDef only exists at emit. The caller
    /// needs to know WHICH parameter so it can say so instead of reporting the
    /// unrelated "no constructor accepts these arguments".
    /// </param>
    /// <returns>Whether every parameter projected.</returns>
    private static bool TryGetClrParameterTypes(
        ImmutableArray<ParameterSymbol> parameters,
        [NotNullWhen(true)] out Type[]? clrTypes,
        out ParameterSymbol? unsupported)
    {
        clrTypes = new Type[parameters.Length];
        unsupported = null;
        for (int i = 0; i < parameters.Length; i++)
        {
            if (!TryGetAttributeParameterWriteType(parameters[i].Type, out var clr))
            {
                clrTypes = null;
                unsupported = parameters[i];
                return false;
            }

            clrTypes[i] = clr;
        }

        return true;
    }

    /// <summary>
    /// The CLR type the fixed-argument writer should encode one same-compilation
    /// constructor parameter AS.
    /// </summary>
    /// <remarks>
    /// <para>Issue #4097, found in the Oahu corpus: a user attribute whose
    /// constructor parameter is a same-compilation ENUM —
    /// <c>@OahuCapability(CapabilityClass.Safe)</c> — has no <c>ClrType</c>
    /// while the blob is built, because the enum's TypeDef only exists at emit.
    /// The whole attribute used to be dropped in silence, and a first pass at
    /// this issue reported it as unsupported. Both are wrong: the program is
    /// legal, and ECMA-335 II.23.3 writes an enum-typed fixed argument as its
    /// UNDERLYING primitive, which is available here.</para>
    /// <para>Three facts make this a substitution rather than a feature. The
    /// underlying type of a G# enum is always <c>int32</c>; the bound argument
    /// value is already that underlying constant, not a symbol (the binder's
    /// enum-literal arm stores <c>lit.Value</c>); and the constructor's own
    /// token and signature come from the emitted <c>MethodDef</c> via the
    /// injected resolvers, so nothing on this path has to encode the enum type
    /// itself. Only the value's WIDTH was ever missing.</para>
    /// </remarks>
    /// <param name="type">The declared parameter type.</param>
    /// <param name="writeType">The CLR type to encode the argument as.</param>
    /// <returns>Whether the parameter can be encoded at all.</returns>
    private static bool TryGetAttributeParameterWriteType(TypeSymbol? type, [NotNullWhen(true)] out Type? writeType)
    {
        if (type?.ClrType is { } declared)
        {
            writeType = declared;
            return true;
        }

        if (type is EnumSymbol sourceEnum && sourceEnum.UnderlyingType.ClrType is { } underlying)
        {
            writeType = underlying;
            return true;
        }

        // Issue #4144: the array sibling of the case above — a same-
        // compilation enum ARRAY parameter (`Kinds []Status`) — has no
        // `ClrType` on the ARRAY type either, for the same reason (the
        // element enum's TypeDef only exists at emit). The binder
        // (`DeclarationBinder.TryBindAttributeArrayArgument`) already builds
        // the constant CONTAINER as `int32[]` for exactly this shape, so the
        // signature must match: encode the parameter as `int32[]`.
        TypeSymbol? arrayElementType = type switch
        {
            SliceTypeSymbol slice => slice.ElementType,
            ArrayTypeSymbol array => array.ElementType,
            _ => null,
        };
        if (arrayElementType is EnumSymbol arrayEnum && arrayEnum.UnderlyingType.ClrType is { } arrayUnderlying)
        {
            writeType = arrayUnderlying.MakeArrayType();
            return true;
        }

        writeType = null;
        return false;
    }

    /// <summary>
    /// Describes the supplied positional arguments by their SOURCE types, for
    /// the GS0583 message — the same information C# puts in CS1503.
    /// </summary>
    /// <param name="positional">The bound positional arguments.</param>
    /// <returns>A comma-separated list of type names, empty for no arguments.</returns>
    private static string DescribeArgumentList(ImmutableArray<BoundAttributeArgument> positional)
        => string.Join(
            ", ",
            positional.Select(argument =>
                argument.Type?.Name
                    ?? (argument.Value is { } value ? value.GetType().Name : "nil")));

    private static ConstructorInfo? ResolveAttributeConstructor(Type attributeType, ImmutableArray<BoundAttributeArgument> positional)
    {
        var ctors = attributeType.GetConstructors(BindingFlags.Public | BindingFlags.Instance);

        // First pass: exact-arity match (the common case).
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length != positional.Length)
            {
                continue;
            }

            if (ParametersMatch(pars, positional, expandLast: false))
            {
                return ctor;
            }
        }

        // Second pass: trailing OPTIONAL parameters. `ToStringAttribute(Type
        // type, string format = null)` applied as `@ToString(typeof(X))` is
        // legal C# and legal G#, and the blob still carries a value for every
        // constructor parameter — the defaulted one included.
        //
        // Issue #4097 found this in the Oahu corpus rather than by reasoning:
        // no pass admitted it, so the attribute was DROPPED from every Oahu
        // assembly that used it, silently, and had been for as long as the
        // corpus has been pinned. That is the defect this issue is about, seen
        // from the other side — the silence was hiding a matcher gap, not just
        // a user error. Reporting GS0583 here would be wrong: the program is
        // one the language accepts.
        //
        // Placed before the params-array pass because normal form beats
        // expanded form, which is also what C# overload resolution does.
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length <= positional.Length)
            {
                continue;
            }

            if (!TrailingParametersAreOptional(pars, positional.Length))
            {
                continue;
            }

            var applicable = true;
            for (int i = 0; i < positional.Length; i++)
            {
                if (!ArgAssignable(positional[i].Value, pars[i].ParameterType, positional[i].Type))
                {
                    applicable = false;
                    break;
                }
            }

            if (applicable)
            {
                return ctor;
            }
        }

        // Third pass: params-array expansion. A constructor whose last
        // parameter is a PARAMS array can absorb zero or more trailing
        // positional arguments, each assignable to the element type — e.g.
        // xUnit's InlineData(params object[] data). The exact-arity pass above
        // already handles passing the array directly.
        //
        // Review feedback on PR #4137: this used to test the parameter's SHAPE
        // (one-dimensional array) rather than whether it is actually declared
        // `params`, so an ordinary array parameter absorbed trailing arguments
        // too. `@Many(typeof(A), typeof(B))` at `ManyAttribute(Type[] values)`
        // matched and emitted a constructor call the source cannot write — C#
        // reports CS1729 for the same program. That is the soundness rule
        // PR #4087 established for `ArgAssignable`: anything the matcher admits
        // is a call the emitter is willing to write, so it must admit only
        // calls the language accepts.
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length == 0)
            {
                continue;
            }

            if (!IsParamsArray(pars[pars.Length - 1]))
            {
                continue;
            }

            if (positional.Length < pars.Length - 1)
            {
                continue;
            }

            if (ParametersMatch(pars, positional, expandLast: true))
            {
                return ctor;
            }
        }

        return null;
    }

    /// <summary>
    /// Whether every parameter from <paramref name="suppliedCount"/> onward is
    /// optional AND carries a default the attribute blob can actually write.
    /// </summary>
    /// <remarks>
    /// An ECMA-335 II.23.3 fixed-argument list has one entry per constructor
    /// parameter, so "the caller may omit it" is not enough — a value has to be
    /// produced. A parameter marked <c>[Optional]</c> with no constant gives
    /// nothing to write for a value type, so it is refused rather than guessed
    /// at; a reference type takes <c>nil</c>, which is what the CLR would pass.
    /// </remarks>
    /// <param name="pars">The candidate constructor's parameters.</param>
    /// <param name="suppliedCount">How many arguments the source supplied.</param>
    /// <returns>Whether the omitted tail can be defaulted.</returns>
    private static bool TrailingParametersAreOptional(ParameterInfo[] pars, int suppliedCount)
    {
        for (int i = suppliedCount; i < pars.Length; i++)
        {
            if (!TryGetOptionalDefault(pars[i], out _))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Reads an omitted parameter's default. Uses <c>RawDefaultValue</c> rather
    /// than <c>DefaultValue</c> because a third-party attribute is routinely
    /// resolved through a <see cref="MetadataLoadContext"/>, where the latter
    /// is not available.
    /// </summary>
    /// <param name="parameter">The omitted parameter.</param>
    /// <param name="value">The value to encode for it.</param>
    /// <returns>Whether a writable default exists.</returns>
    private static bool TryGetOptionalDefault(ParameterInfo parameter, out object? value)
    {
        value = null;
        if (!parameter.IsOptional)
        {
            return false;
        }

        object? raw;
        try
        {
            raw = parameter.RawDefaultValue;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            // A metadata-loaded parameter whose Constant row cannot be decoded.
            return false;
        }

        if (raw is DBNull or Missing)
        {
            // `[Optional]` with no Constant row. A reference slot takes nil; a
            // value slot has no answer this encoder may invent.
            return !parameter.ParameterType.IsValueType;
        }

        value = raw;
        return true;
    }

    /// <summary>Marks that an arity-matching constructor projected, and returns true.</summary>
    /// <param name="seen">The flag to set.</param>
    /// <returns>Always <see langword="true"/>, so it can chain into a condition.</returns>
    private static bool SawProjectable(ref bool seen)
    {
        seen = true;
        return true;
    }

    /// <summary>
    /// Whether a parameter is a genuine <c>params</c> array — asked of
    /// <c>ParamArrayAttribute</c>, which is the authority, rather than inferred
    /// from the parameter being a one-dimensional array.
    /// </summary>
    /// <remarks>
    /// Read through <see cref="ParameterInfo.CustomAttributes"/> and compared by
    /// full name because a third-party attribute is routinely resolved through
    /// a <see cref="MetadataLoadContext"/>, where the loaded
    /// <c>ParamArrayAttribute</c> is not the executing runtime's and
    /// <c>GetCustomAttributes(Type, bool)</c> would not match it.
    /// </remarks>
    /// <param name="parameter">The candidate trailing parameter.</param>
    /// <returns>Whether the parameter may absorb trailing arguments.</returns>
    private static bool IsParamsArray(ParameterInfo parameter)
    {
        if (!parameter.ParameterType.IsArray || parameter.ParameterType.GetArrayRank() != 1)
        {
            return false;
        }

        try
        {
            foreach (var attribute in parameter.CustomAttributes)
            {
                if (attribute.AttributeType.FullName == "System.ParamArrayAttribute")
                {
                    return true;
                }
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            // A metadata-loaded parameter whose custom attributes cannot be
            // decoded: treat it as an ordinary array rather than guessing.
            return false;
        }

        return false;
    }

    private static bool ParametersMatch(ParameterInfo[] pars, ImmutableArray<BoundAttributeArgument> positional, bool expandLast)
    {
        var fixedCount = expandLast ? pars.Length - 1 : pars.Length;
        for (int i = 0; i < fixedCount; i++)
        {
            if (!ArgAssignable(positional[i].Value, pars[i].ParameterType, positional[i].Type))
            {
                return false;
            }
        }

        if (expandLast)
        {
            var elementType = pars[pars.Length - 1].ParameterType.GetElementType()!;
            for (int i = fixedCount; i < positional.Length; i++)
            {
                if (!ArgAssignable(positional[i].Value, elementType, positional[i].Type))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Decides whether one bound attribute argument may be encoded into one
    /// constructor parameter — the applicability rule that drives constructor
    /// SELECTION, so anything this admits is a call the emitter is willing to
    /// write.
    /// </summary>
    /// <param name="supplied">The bound constant value.</param>
    /// <param name="paramType">The constructor parameter's CLR type.</param>
    /// <param name="suppliedType">
    /// The argument's SOURCE type, when the caller has the
    /// <see cref="BoundAttributeArgument"/> in hand. Only the widened-array arm
    /// consults it; a recursive element check passes <c>null</c> because an
    /// element carries no separate bound type.
    /// </param>
    /// <returns>Whether the value may be encoded into that parameter.</returns>
    private static bool ArgAssignable(object? supplied, Type paramType, TypeSymbol? suppliedType = null)
    {
        // Third-party attributes are commonly resolved through a
        // MetadataLoadContext. Normalize framework types before using CLR
        // assignability so, for example, its System.String matches a runtime
        // string constant.
        paramType = NormalizeWellKnownType(paramType);

        // Everything is assignable to System.Object. Compared by name so the
        // check holds for attribute types resolved through a MetadataLoadContext.
        if (paramType.FullName == "System.Object")
        {
            return true;
        }

        if (supplied == null)
        {
            return !(paramType.IsValueType && Nullable.GetUnderlyingType(paramType) == null);
        }

        if (paramType.IsInstanceOfType(supplied))
        {
            return true;
        }

        if (supplied is TypeSymbol &&
            paramType.FullName == "System.Type")
        {
            return true;
        }

        // Issue #4073: `[]Type{typeof(SourceType)}` is carried as an `object[]`,
        // because #3684 had to widen the constant CONTAINER to hold the
        // `TypeSymbol` placeholder a same-compilation `typeof` produces (a
        // `Type[]` cannot). Without this arm the widened container matched no
        // `Type[]` constructor parameter, so the WHOLE attribute was dropped from
        // the assembly with no diagnostic — the array's own elements were never
        // even reached. The blob is written from the SIGNATURE's element type,
        // so the container's element type never leaves the compiler.
        //
        // Review feedback on PR #4087: the container is widened, the SOURCE's
        // array type is not — so the widening is undone by asking
        // `BoundAttributeArgument.Type` what the author actually wrote, and the
        // arm fires only when that element type IS the parameter's. Matching on
        // the container alone made every `object[]` covariant by its current
        // VALUES: `@Names([]object{"x"})` satisfied a `string[]` constructor and
        // the emitter encoded a call the source could not have written. Compared
        // by name rather than by identity because a `/r:` compile resolves the
        // attribute through a `MetadataLoadContext`, so its `System.Type[]` is
        // not the runtime's.
        //
        // The normalized element is bound to a PATTERN LOCAL rather than read
        // inline as a member of the call result. cs2gs migrates this file, and
        // its nullable flow does not honour `[NotNullIfNotNull]`, so the inline
        // form translated to an asserted parenthesized receiver and tripped the
        // redundant-assertion inventory ratchet in
        // `Issue3422RedundantNullForgivenessTranslationTests` — eight permitted,
        // this made nine. The local is the same value: the argument is non-null
        // here, so the helper's `[NotNullIfNotNull]` guarantees a non-null
        // result and the pattern always matches. (Spelled without the token the
        // ratchet counts: that inventory strips comment lines, but a comment
        // quoting the pattern is the #3469 trap and makes every grep-based
        // reading of the migrated tree lie.)
        if (paramType.IsArray
            && paramType.GetArrayRank() == 1
            && paramType.GetElementType() is { } parameterElementType
            && supplied is object?[] widenedElements
            && suppliedType?.ClrType is { IsArray: true } declaredArrayType
            && declaredArrayType.GetArrayRank() == 1
            && declaredArrayType.GetElementType() is { } declaredElementType
            && NormalizeWellKnownType(declaredElementType) is { } normalizedElementType
            && string.Equals(
                normalizedElementType.FullName,
                parameterElementType.FullName,
                StringComparison.Ordinal))
        {
            foreach (var element in widenedElements)
            {
                if (!ArgAssignable(element, parameterElementType))
                {
                    return false;
                }
            }

            return true;
        }

        return IsTriviallyConvertible(supplied.GetType(), paramType);
    }

    /// <summary>
    /// Issue #1921 code review (overload disambiguation): checks every
    /// positional argument against the corresponding same-compilation
    /// constructor parameter type using the same <see cref="ArgAssignable"/>
    /// rule the CLR-attribute path applies via <see cref="ParametersMatch"/>.
    /// No params-array expansion — no G# constructor declaration can express
    /// a trailing params array.
    /// </summary>
    private static bool ArgumentsAssignable(ImmutableArray<BoundAttributeArgument> positional, Type[] paramTypes)
    {
        for (int i = 0; i < paramTypes.Length; i++)
        {
            if (!ArgAssignable(positional[i].Value, paramTypes[i], positional[i].Type))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Maps the supplied positional arguments onto the constructor parameters,
    /// collapsing a trailing params-array into a single synthesized
    /// <see cref="object"/>[] when the call site supplied the elements inline
    /// (params expansion). Returns one value per constructor parameter.
    /// </summary>
    private static object?[] BuildCtorArgumentValues(ParameterInfo[] ctorParams, ImmutableArray<BoundAttributeArgument> positional)
    {
        var lastIsArray = ctorParams.Length > 0
            && IsParamsArray(ctorParams[ctorParams.Length - 1]);

        // Direct (non-expanded) form: arity matches and the final argument is
        // itself assignable to the array parameter (or there is no array tail).
        var lastSupplied = positional.Length == ctorParams.Length && positional.Length > 0
            ? positional[positional.Length - 1].Value
            : null;

        // Issue #4097: a constructor selected through its trailing OPTIONAL
        // parameters supplies fewer arguments than it has slots, and the blob
        // needs one entry per slot. That is the normal form, never the expanded
        // one, so it short-circuits the params-array reasoning below.
        //
        // The `TrailingParametersAreOptional` half is NOT redundant, and the
        // first version of this fix omitted it. "Fewer arguments than slots" is
        // ALSO true of a params tail absorbing zero trailing elements —
        // `@MemberData("ShapeAreas")` at
        // `MemberDataAttribute(string, params object[])` supplies one argument
        // for two slots. Without the guard that took the direct path, and since
        // a params array is not `IsOptional` (measured), nothing filled the
        // slot: the blob got `nil` where the expanded form writes an EMPTY
        // ARRAY. Well-formed blob, wrong content — it compiled, IL-verified,
        // and xunit then found a theory with no data rows, reporting one
        // dataless test instead of three cases. Caught by the cs2gs corpus
        // gate, which is the only gate that runs the migrated tests.
        var defaulted = positional.Length < ctorParams.Length
            && TrailingParametersAreOptional(ctorParams, positional.Length);
        var direct = defaulted
            || !lastIsArray
            || (positional.Length == ctorParams.Length
                && (lastSupplied == null
                    || ctorParams[ctorParams.Length - 1].ParameterType.IsInstanceOfType(lastSupplied)
                    || lastSupplied.GetType().IsArray));

        if (direct)
        {
            var values = new object?[ctorParams.Length];
            for (int i = 0; i < ctorParams.Length; i++)
            {
                if (i < positional.Length)
                {
                    values[i] = positional[i].Value;
                }
                else if (TryGetOptionalDefault(ctorParams[i], out var fallback))
                {
                    values[i] = fallback;
                }
            }

            return values;
        }

        var result = new object?[ctorParams.Length];
        for (int i = 0; i < ctorParams.Length - 1; i++)
        {
            result[i] = positional[i].Value;
        }

        var tail = positional.Length - (ctorParams.Length - 1);
        var array = new object?[tail];
        for (int i = 0; i < tail; i++)
        {
            array[i] = positional[ctorParams.Length - 1 + i].Value;
        }

        result[ctorParams.Length - 1] = array;
        return result;
    }

    /// <summary>
    /// Returns the executing runtime's <see cref="Type"/> for well-known
    /// core-library types (primitives, string, object, Type, and single-rank
    /// arrays thereof) so that the reference-equality dispatch in
    /// <see cref="WriteCustomAttributeFixedArg"/> works even when the attribute
    /// was resolved through a <see cref="MetadataLoadContext"/>. Unknown types
    /// are returned unchanged.
    /// </summary>
    [return: NotNullIfNotNull(nameof(t))]
    private static Type? NormalizeWellKnownType(Type? t)
    {
        if (t == null)
        {
            return null;
        }

        if (t.IsArray && t.GetArrayRank() == 1)
        {
            var element = NormalizeWellKnownType(t.GetElementType()!);
            return element.MakeArrayType();
        }

        var byName = Type.GetType(t.FullName ?? string.Empty);
        return byName ?? t;
    }

    private static bool IsTriviallyConvertible(Type from, Type to)
    {
        if (from == to)
        {
            return true;
        }

        if (to.IsEnum)
        {
            return from == GetEnumUnderlyingTypeSafe(to);
        }

        if (from.IsArray && to.IsArray && from.GetArrayRank() == 1 && to.GetArrayRank() == 1)
        {
            return IsTriviallyConvertible(from.GetElementType()!, to.GetElementType()!);
        }

        return false;
    }

    private void EncodeClrTypeForCtorSig(SignatureTypeEncoder enc, Type t)
    {
        if (t.IsSameAs(typeof(bool)))
        {
            enc.Boolean();
        }
        else if (t.IsSameAs(typeof(char)))
        {
            enc.Char();
        }
        else if (t.IsSameAs(typeof(sbyte)))
        {
            enc.SByte();
        }
        else if (t.IsSameAs(typeof(byte)))
        {
            enc.Byte();
        }
        else if (t.IsSameAs(typeof(short)))
        {
            enc.Int16();
        }
        else if (t.IsSameAs(typeof(ushort)))
        {
            enc.UInt16();
        }
        else if (t.IsSameAs(typeof(int)))
        {
            enc.Int32();
        }
        else if (t.IsSameAs(typeof(uint)))
        {
            enc.UInt32();
        }
        else if (t.IsSameAs(typeof(long)))
        {
            enc.Int64();
        }
        else if (t.IsSameAs(typeof(ulong)))
        {
            enc.UInt64();
        }
        else if (t.IsSameAs(typeof(float)))
        {
            enc.Single();
        }
        else if (t.IsSameAs(typeof(double)))
        {
            enc.Double();
        }
        else if (t.IsSameAs(typeof(string)))
        {
            enc.String();
        }
        else if (t.IsSameAs(typeof(object)))
        {
            enc.Object();
        }
        else if (t.IsEnum)
        {
            // Issue #3892: this is the METHOD SIGNATURE of the attribute's
            // `.ctor` MemberRef, not the custom-attribute VALUE blob. ECMA-335
            // II.23.3 says the *value* of an enum-typed fixed argument is
            // serialised as its underlying type — that rule is applied by
            // WriteCustomAttributeFixedArg below and is correct there. It does
            // NOT apply to the signature: II.23.2.12 requires the parameter to
            // be encoded as VALUETYPE <TypeRef to the enum>. Substituting the
            // underlying type here produced `AttributeUsageAttribute..ctor(Int32)`,
            // a MemberRef the runtime cannot resolve — so any type carrying such
            // an attribute threw MissingMethodException the moment reflection
            // touched it (xunit discovery enumerating GetExportedTypes()).
            enc.Type(this.getTypeReference(t), isValueType: true);
        }
        else if (t.IsArray && t.GetArrayRank() == 1)
        {
            // ECMA-335 II.23.2.12: SZARRAY element-type for a single-dimensional array parameter.
            this.EncodeClrTypeForCtorSig(enc.SZArray(), t.GetElementType()!);
        }
        else if (t.IsSameAs(typeof(Type)))
        {
            // System.Type parameter: encoded as a CLASS type reference in the ctor signature.
            enc.Type(this.getTypeReference(typeof(Type)), isValueType: false);
        }
        else
        {
            // Fallback: encode as object so the signature is still well-formed.
            enc.Object();
        }
    }

    private void WriteCustomAttributeFixedArg(BlobBuilder bb, Type paramType, object? value)
    {
        if (paramType.IsEnum)
        {
            WriteCustomAttributeFixedArg(bb, GetEnumUnderlyingTypeSafe(paramType), value);
            return;
        }

        if (paramType.IsSameAs(typeof(bool)))
        {
            bb.WriteByte(object.Equals(value, true) ? (byte)1 : (byte)0);
        }
        else if (paramType.IsSameAs(typeof(char)))
        {
            var charValue = System.Convert.ToUInt16(
                value,
                System.Globalization.CultureInfo.InvariantCulture);
            bb.WriteByte((byte)charValue);
            bb.WriteByte((byte)(charValue >> 8));
        }
        else if (paramType.IsSameAs(typeof(sbyte)))
        {
            bb.WriteSByte(Convert.ToSByte(value));
        }
        else if (paramType.IsSameAs(typeof(byte)))
        {
            bb.WriteByte(Convert.ToByte(value));
        }
        else if (paramType.IsSameAs(typeof(short)))
        {
            bb.WriteInt16(Convert.ToInt16(value));
        }
        else if (paramType.IsSameAs(typeof(ushort)))
        {
            bb.WriteUInt16(Convert.ToUInt16(value));
        }
        else if (paramType.IsSameAs(typeof(int)))
        {
            bb.WriteInt32(Convert.ToInt32(value));
        }
        else if (paramType.IsSameAs(typeof(uint)))
        {
            bb.WriteUInt32(Convert.ToUInt32(value));
        }
        else if (paramType.IsSameAs(typeof(long)))
        {
            bb.WriteInt64(Convert.ToInt64(value));
        }
        else if (paramType.IsSameAs(typeof(ulong)))
        {
            bb.WriteUInt64(Convert.ToUInt64(value));
        }
        else if (paramType.IsSameAs(typeof(float)))
        {
            bb.WriteSingle(Convert.ToSingle(value));
        }
        else if (paramType.IsSameAs(typeof(double)))
        {
            bb.WriteDouble(Convert.ToDouble(value));
        }
        else if (paramType.IsSameAs(typeof(string)))
        {
            bb.WriteSerializedString((string?)value);
        }
        else if (paramType.IsSameAs(typeof(Type)))
        {
            // ECMA-335 II.23.3: a System.Type argument is encoded as a
            // SerString carrying the canonical type-name. A null Type
            // serialises as the SerString null marker (0xFF).
            bb.WriteSerializedString(value switch
            {
                Type t => GetSerializedTypeName(t),
                TypeSymbol symbol => this.GetSerializedTypeName(symbol),
                _ => null,
            });
        }
        else if (paramType.IsArray && paramType.GetArrayRank() == 1)
        {
            WriteCustomAttributeArrayArg(bb, paramType.GetElementType()!, value);
        }
        else if (paramType.IsSameAs(typeof(object)))
        {
            // ECMA-335 II.23.3: boxed object argument carries the
            // FieldOrPropType tag of the runtime type then the value.
            if (value == null)
            {
                // Null object: encode as STRING null marker per common practice.
                WriteCustomAttributeFieldOrPropertyType(bb, typeof(string));
                bb.WriteSerializedString(null);
            }
            else
            {
                var runtimeType = value is Type or TypeSymbol
                    ? typeof(Type)
                    : value.GetType();
                WriteCustomAttributeFieldOrPropertyType(bb, runtimeType);
                WriteCustomAttributeFixedArg(bb, runtimeType, value);
            }
        }
        else
        {
            // Fallback: serialise as string round-trip (best-effort).
            bb.WriteSerializedString(value?.ToString());
        }
    }

    private void WriteCustomAttributeArrayArg(BlobBuilder bb, Type elementType, object? value)
    {
        // ECMA-335 II.23.3: an SZARRAY argument is encoded as an Int32 length
        // (or 0xFFFFFFFF for a null array) followed by length elements of
        // FixedArg(elementType).
        if (value == null)
        {
            bb.WriteUInt32(0xFFFFFFFFu);
            return;
        }

        var array = (Array)value;
        bb.WriteInt32(array.Length);
        for (int i = 0; i < array.Length; i++)
        {
            WriteCustomAttributeFixedArg(bb, elementType, array.GetValue(i));
        }
    }

    private static string GetSerializedTypeName(Type t)
    {
        // ECMA-335 II.23.3 + I.8.5.2: the canonical serialised form is the
        // assembly-qualified name; types from mscorlib / System.Private.CoreLib
        // may omit the assembly portion. We always emit the assembly-qualified
        // form so the consumer can unambiguously rebind the type.
        return t.AssemblyQualifiedName ?? t.FullName ?? t.Name;
    }

    /// <summary>
    /// Issue #4073: writes the assembly-qualified name of a SYMBOLIC
    /// <c>typeof</c> argument, recursing through every structural position so a
    /// constructed generic names its real arguments.
    /// </summary>
    /// <remarks>
    /// <para>This used to be one line — the type's own metadata name plus the
    /// assembly under compilation — which is correct for a scalar
    /// same-compilation type and wrong for everything else. A constructed
    /// generic's DEFINITION usually lives in a referenced assembly while its
    /// arguments live here, so a single trailing assembly name cannot describe
    /// it; and the definition needs its arity suffix and an argument list, which
    /// a constructed <see cref="StructSymbol"/> could not supply because it
    /// carries its arguments on <c>TypeArguments</c> and leaves
    /// <c>TypeParameters</c> empty (so the suffix computed to zero and
    /// <c>typeof(MyBox[Status])</c> serialised as the unresolvable
    /// <c>P.MyBox</c>).</para>
    /// <para>The shape is ECMA-335 I.8.5.2 / <see cref="Type.AssemblyQualifiedName"/>:
    /// <c>Ns.Def`N[[argAqn],[argAqn]], DefAssembly</c>, with array and
    /// <c>Nullable</c> wrappers attaching to the NAME while the assembly stays
    /// the wrapped part's (respectively the core library's).</para>
    /// </remarks>
    /// <param name="type">The symbolic type to serialise.</param>
    /// <returns>The assembly-qualified name.</returns>
    private string GetSerializedTypeName(TypeSymbol type)
    {
        var (name, assembly) = this.GetSerializedTypeParts(type);
        return name + ", " + assembly;
    }

    /// <summary>
    /// Splits a symbolic type's serialised form into its name and its declaring
    /// assembly, so a wrapper (array, <c>Nullable</c>) can attach to the name
    /// without disturbing the assembly, and a generic instantiation can qualify
    /// each argument independently.
    /// </summary>
    /// <param name="type">The symbolic type.</param>
    /// <returns>The name part and the assembly part.</returns>
    private (string Name, string Assembly) GetSerializedTypeParts(TypeSymbol type)
    {
        switch (type)
        {
            case NullableTypeSymbol nullable when nullable.UnderlyingType is { } underlying:
                // A nullable REFERENCE has no distinct runtime type (ADR: the
                // annotation is metadata over the same CLR shape), so it
                // serialises as its underlying type. A nullable VALUE type is a
                // real `System.Nullable<T>` instantiation.
                return NullableLifting.IsAnyValueTypeNullable(nullable)
                    ? this.BuildNullableParts(underlying)
                    : this.GetSerializedTypeParts(underlying);

            // Issue #4098: a G# STRUCTURAL type. Deliberately ahead of every
            // ClrType-consulting arm and deliberately UNGATED: see
            // TryGetStructuralTypeParts for why `{ ClrType: null }` would be
            // the wrong guard.
            case MapTypeSymbol or TupleTypeSymbol or FunctionTypeSymbol or ChannelTypeSymbol
                or SequenceTypeSymbol or AsyncSequenceTypeSymbol
                when this.TryGetStructuralTypeParts(type, out var structuralParts):
                return structuralParts;

            case SliceTypeSymbol slice:
                return AppendNameSuffix(this.GetSerializedTypeParts(slice.ElementType), "[]");

            case ArrayTypeSymbol array:
                return AppendNameSuffix(this.GetSerializedTypeParts(array.ElementType), "[]");

            case RectangularArrayTypeSymbol rectangular:
                return AppendNameSuffix(
                    this.GetSerializedTypeParts(rectangular.ElementType),
                    "[" + new string(',', Math.Max(rectangular.Rank - 1, 0)) + "]");

            case ImportedTypeSymbol { OpenDefinition: { } openDefinition } imported
                when !imported.TypeArguments.IsDefaultOrEmpty:
                return (
                    (openDefinition.FullName ?? openDefinition.Name) + this.BuildArgumentList(imported.TypeArguments),
                    openDefinition.Assembly.FullName ?? openDefinition.Assembly.GetName().Name ?? this.CompilationAssemblyName());

            // Issue #4095: a type nested in a GENERIC OUTER carries the
            // encloser's vector on `EnclosingTypeArguments` and leaves
            // `TypeArguments` holding only what the nested level declares, so
            // matching on `TypeArguments` alone missed `Outer[Status].Inner`
            // entirely and it fell through to the bare open name
            // `P.Outer`1+Inner`. That name RESOLVES — to `Outer<T>+Inner` —
            // so nothing threw and the attribute simply carried a different
            // type from the one the source wrote. The instantiation the CLR
            // wants is the FLATTENED enclosing-then-own vector, matching the
            // GenericParam rows `TypeDefEmitter` copies down each nesting
            // level (ADR-0087 §3 R1).
            case StructSymbol { ClrType: null } structType
                when !structType.EnclosingTypeArguments.IsDefaultOrEmpty
                    || !structType.TypeArguments.IsDefaultOrEmpty:
                return (
                    GetMetadataTypeName(structType.Definition)
                        + this.BuildArgumentList(
                            Flatten(structType.EnclosingTypeArguments, structType.TypeArguments)),
                    this.CompilationAssemblyName());

            case InterfaceSymbol { ClrType: null } interfaceType when !interfaceType.TypeArguments.IsDefaultOrEmpty:
                return (
                    GetMetadataTypeName(interfaceType.Definition) + this.BuildArgumentList(interfaceType.TypeArguments),
                    this.CompilationAssemblyName());

            // Review feedback on PR #4087: a constructed generic DELEGATE keeps
            // its vector on `TypeArguments` exactly as a struct or interface
            // does, so it belongs with them and not with the scalar arm below.
            // It fails differently, though: `DelegateTypeSymbol.CreateConstructed`
            // PRESERVES `TypeParameters`, so the arity suffix is right and the
            // name resolves — to the OPEN definition. `typeof(Pred[Status])`
            // reified as `P.Pred`1` rather than `Pred<Status>`, and nested as an
            // argument (`Box[Pred[Status]]`) it produced a type whose `FullName`
            // is null, because an open generic is not a legal instantiation
            // argument.
            case DelegateTypeSymbol { ClrType: null } delegateType
                when !delegateType.TypeArguments.IsDefaultOrEmpty:
                return (
                    GetMetadataTypeName(delegateType.Definition ?? delegateType)
                        + this.BuildArgumentList(delegateType.TypeArguments),
                    this.CompilationAssemblyName());

            // Issue #4095, review feedback: a nested ENUM reaches emit through
            // `EnumSymbol.ConstructNested`, which records the same flattened
            // enclosing vector a nested struct gets. An enum declares no
            // parameters of its own, so the vector IS
            // `EnclosingTypeArguments`. Without this arm
            // `typeof(Outer[Status].Kind)` fell into the scalar group below and
            // wrote the open `P.Outer`1+Kind`.
            case EnumSymbol { ClrType: null } enumType
                when !enumType.EnclosingTypeArguments.IsDefaultOrEmpty:
                return (
                    GetMetadataTypeName(enumType.Definition ?? enumType)
                        + this.BuildArgumentList(enumType.EnclosingTypeArguments),
                    this.CompilationAssemblyName());

            case StructSymbol { ClrType: null }:
            case InterfaceSymbol { ClrType: null }:
            case EnumSymbol { ClrType: null }:
            case DelegateTypeSymbol { ClrType: null }:
                return (GetMetadataTypeName(type), this.CompilationAssemblyName());
        }

        if (type.ClrType is { } clrType)
        {
            return (
                clrType.FullName ?? clrType.Name,
                clrType.Assembly.FullName ?? clrType.Assembly.GetName().Name ?? this.CompilationAssemblyName());
        }

        return (GetMetadataTypeName(type), this.CompilationAssemblyName());
    }

    /// <summary>
    /// Builds the <c>[[arg],[arg]]</c> instantiation suffix, qualifying each
    /// argument with its OWN assembly — the whole point of the recursion, since
    /// an imported definition is routinely closed over a same-compilation
    /// argument.
    /// </summary>
    /// <param name="typeArguments">The symbolic type arguments.</param>
    /// <returns>The bracketed argument list.</returns>
    private string BuildArgumentList(ImmutableArray<TypeSymbol> typeArguments)
    {
        var parts = typeArguments.Select(argument =>
        {
            var (name, assembly) = this.GetSerializedTypeParts(argument);
            return "[" + name + ", " + assembly + "]";
        });
        return "[" + string.Join(",", parts) + "]";
    }

    /// <summary>
    /// Builds the <c>System.Nullable`1</c> instantiation over
    /// <paramref name="underlying"/>, resolving the open definition through the
    /// compilation's reference set rather than the emitting host's, so the
    /// assembly it names is the one the emitted assembly actually references.
    /// </summary>
    /// <param name="underlying">The value-type underlying type.</param>
    /// <returns>The name and assembly parts of the nullable instantiation.</returns>
    private (string Name, string Assembly) BuildNullableParts(TypeSymbol underlying)
    {
        var (innerName, innerAssembly) = this.GetSerializedTypeParts(underlying);
        var suffix = "[[" + innerName + ", " + innerAssembly + "]]";
        if (this.emitCtx.References.TryResolveType("System.Nullable`1", requireExternalVisibility: false, out var nullableOpen)
            && nullableOpen != null)
        {
            return (
                (nullableOpen.FullName ?? "System.Nullable`1") + suffix,
                nullableOpen.Assembly.FullName ?? nullableOpen.Assembly.GetName().Name ?? innerAssembly);
        }

        // Defensive: every reference set that can compile a nilable value type
        // carries the core library, so this is unreachable in practice.
        return ("System.Nullable`1" + suffix, innerAssembly);
    }

    /// <summary>
    /// Issue #4098: serialises a G# STRUCTURAL type — <c>map</c>, tuple,
    /// <c>func</c>, <c>chan</c>, <c>sequence</c> — as the BCL type it projects
    /// onto, closed over its components SYMBOLICALLY.
    /// </summary>
    /// <remarks>
    /// <para><b>What was wrong.</b> Each structural symbol computes its own
    /// <c>ClrType</c> by closing an open BCL definition over its components. A
    /// same-compilation component has none while binding, so the structural
    /// symbol's <c>ClrType</c> came out null and the switch fell through to
    /// <c>GetMetadataTypeName</c>'s <c>default:</c> arm — bare
    /// <c>type.Name</c>, which for these kinds is the G# DISPLAY spelling
    /// (<c>map[string,Status]</c>, <c>(Status) -&gt; bool</c>, <c>chan</c>),
    /// qualified to the compilation's own assembly. Nothing can decode
    /// that.</para>
    /// <para><b>Why there is no <c>{ ClrType: null }</c> guard.</b> The obvious
    /// spelling of these arms — gate on a null <c>ClrType</c>, the way the
    /// <c>StructSymbol</c>/<c>InterfaceSymbol</c> arms do — would leave a
    /// quieter half of the same defect in place.
    /// <c>map[string, List[Status]]</c> has a component whose <c>ClrType</c> is
    /// NON-null: <c>List&lt;object&gt;</c>, closed over the erasure surrogate.
    /// So <c>MapTypeSymbol.MakeClrType</c> succeeds, and the <c>ClrType</c>
    /// fallback below wrote
    /// <c>Dictionary`2[[String],[List`1[[System.Int32]]]]</c> — a name that
    /// RESOLVES, to the wrong type. Measured, not reasoned. The sibling
    /// wrapper arms (slice, array, rectangular, nullable) already recurse
    /// symbolically without such a guard for exactly this reason; these follow
    /// them.</para>
    /// <para><b>Where the projection decisions come from.</b> Each is taken
    /// from the symbol that already owns it rather than restated here:
    /// <see cref="ChannelTypeSymbol.OpenClrDefinition"/> for the channel
    /// direction and
    /// <see cref="SequenceTypeSymbol.TryGetEnumerableInterfaceShape"/> for the
    /// sync/async sequence split. The open definition is then resolved through
    /// the COMPILATION's reference set, not the emitting host's, so the
    /// assembly named is the one the emitted assembly actually references —
    /// the same shape as <see cref="BuildNullableParts"/>.</para>
    /// <para><b>What it declines.</b> A <c>func</c> above the shipped
    /// <c>Func</c>/<c>Action</c> arities has no spelling at all, and neither
    /// does a zero-element tuple. Those return <see langword="false"/> and fall
    /// through to the pre-existing behaviour rather than inventing a name;
    /// their <c>ClrType</c> is null for the same reason, so they are already
    /// emit-limited everywhere else.</para>
    /// </remarks>
    /// <param name="type">The structural type symbol.</param>
    /// <param name="parts">The serialised name and assembly parts.</param>
    /// <returns>Whether a BCL projection exists for this shape.</returns>
    private bool TryGetStructuralTypeParts(TypeSymbol type, out (string Name, string Assembly) parts)
    {
        switch (type)
        {
            case MapTypeSymbol map:
                return this.TryCloseOpenDefinition(
                    "System.Collections.Generic.Dictionary`2",
                    new[] { this.GetSerializedTypeParts(map.KeyType), this.GetSerializedTypeParts(map.ValueType) },
                    out parts);

            case ChannelTypeSymbol channel:
                return this.TryCloseOpenDefinition(
                    ChannelTypeSymbol.OpenClrDefinition(channel.Direction) is { FullName: { } channelName }
                        ? channelName
                        : "System.Threading.Channels.Channel`1",
                    new[] { this.GetSerializedTypeParts(channel.ElementType) },
                    out parts);

            case SequenceTypeSymbol or AsyncSequenceTypeSymbol
                when SequenceTypeSymbol.TryGetEnumerableInterfaceShape(type, out var openSequence, out var element)
                    && openSequence is { FullName: { } sequenceName }:
                return this.TryCloseOpenDefinition(
                    sequenceName,
                    new[] { this.GetSerializedTypeParts(element) },
                    out parts);

            case TupleTypeSymbol tuple:
                return this.TryGetTupleParts(tuple.ElementTypes, out parts);

            case FunctionTypeSymbol function:
                return this.TryGetFunctionParts(function, out parts);
        }

        parts = default;
        return false;
    }

    /// <summary>
    /// Serialises a tuple as the <c>System.ValueTuple`N</c> family, nesting the
    /// tail into <c>TRest</c> above arity 7 exactly as
    /// <c>TupleTypeSymbol</c>'s CLR builder does.
    /// </summary>
    /// <param name="elements">The element types.</param>
    /// <param name="parts">The serialised name and assembly parts.</param>
    /// <returns>Whether the tuple has a <c>ValueTuple</c> spelling.</returns>
    private bool TryGetTupleParts(ImmutableArray<TypeSymbol> elements, out (string Name, string Assembly) parts)
    {
        if (elements.IsDefaultOrEmpty)
        {
            parts = default;
            return false;
        }

        if (elements.Length <= 7)
        {
            return this.TryCloseOpenDefinition(
                "System.ValueTuple`" + elements.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
                elements.Select(this.GetSerializedTypeParts).ToArray(),
                out parts);
        }

        if (!this.TryGetTupleParts(ImmutableArray.CreateRange(elements.Skip(7)), out var rest))
        {
            parts = default;
            return false;
        }

        var arguments = elements.Take(7).Select(this.GetSerializedTypeParts).Append(rest).ToArray();
        return this.TryCloseOpenDefinition("System.ValueTuple`8", arguments, out parts);
    }

    /// <summary>
    /// Serialises a <c>func</c> type as <c>System.Action`N</c> (void return) or
    /// <c>System.Func`N+1</c>, using the same void rule
    /// <c>FunctionTypeSymbol</c>'s CLR builder applies.
    /// </summary>
    /// <param name="function">The function type.</param>
    /// <param name="parts">The serialised name and assembly parts.</param>
    /// <returns>Whether a shipped delegate shape exists for this arity.</returns>
    private bool TryGetFunctionParts(FunctionTypeSymbol function, out (string Name, string Assembly) parts)
    {
        const int MaxDelegateArity = 16;
        var parameterCount = function.ParameterTypes.Length;
        if (parameterCount > MaxDelegateArity)
        {
            parts = default;
            return false;
        }

        var arguments = function.ParameterTypes.Select(this.GetSerializedTypeParts).ToList();
        if (FunctionTypeSymbol.IsVoidReturn(function.ReturnType))
        {
            // `System.Action` is not generic, so it takes no argument list.
            return parameterCount == 0
                ? this.TryCloseOpenDefinition("System.Action", Array.Empty<(string, string)>(), out parts)
                : this.TryCloseOpenDefinition(
                    "System.Action`" + parameterCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    arguments,
                    out parts);
        }

        arguments.Add(this.GetSerializedTypeParts(function.ReturnType));
        return this.TryCloseOpenDefinition(
            "System.Func`" + arguments.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            arguments,
            out parts);
    }

    /// <summary>
    /// Resolves an open BCL definition through the COMPILATION's reference set
    /// and closes it over already-serialised argument parts.
    /// </summary>
    /// <remarks>
    /// The host's own <c>typeof(Dictionary&lt;,&gt;)</c> is deliberately not
    /// used: the name written into the blob must be the one the emitted
    /// assembly references. Never <c>MakeGenericType</c> — a same-compilation
    /// argument has no CLR type to close over, which is the whole reason this
    /// serialiser exists.
    /// </remarks>
    /// <param name="openDefinitionName">The open definition's full metadata name.</param>
    /// <param name="argumentParts">The serialised arguments, empty for a non-generic definition.</param>
    /// <param name="parts">The serialised name and assembly parts.</param>
    /// <returns>Whether the reference set declares the definition.</returns>
    private bool TryCloseOpenDefinition(
        string openDefinitionName,
        IReadOnlyCollection<(string Name, string Assembly)> argumentParts,
        out (string Name, string Assembly) parts)
    {
        if (!this.emitCtx.References.TryResolveType(openDefinitionName, requireExternalVisibility: false, out var open)
            || open is null)
        {
            parts = default;
            return false;
        }

        var suffix = argumentParts.Count == 0
            ? string.Empty
            : "[" + string.Join(",", argumentParts.Select(part => "[" + part.Name + ", " + part.Assembly + "]")) + "]";

        parts = (
            (open.FullName ?? openDefinitionName) + suffix,
            open.Assembly.FullName ?? open.Assembly.GetName().Name ?? this.CompilationAssemblyName());
        return true;
    }

    /// <summary>Gets the identity of the assembly being emitted.</summary>
    /// <returns>The assembly's simple name.</returns>
    private string CompilationAssemblyName()
        => this.emitCtx.AssemblyNameOverride ??
           this.emitCtx.Program.PackageName ??
           "Default";

    private static (string Name, string Assembly) AppendNameSuffix((string Name, string Assembly) parts, string suffix)
        => (parts.Name + suffix, parts.Assembly);

    /// <summary>
    /// Issue #4095: joins a nested type's enclosing vector to its own, in the
    /// order the emitted GenericParam rows declare them, tolerating either side
    /// being an uninitialized <see cref="ImmutableArray{T}"/>.
    /// </summary>
    /// <param name="enclosing">Arguments supplied by the containing types.</param>
    /// <param name="own">Arguments declared by the nested type itself.</param>
    /// <returns>The flattened instantiation vector.</returns>
    private static ImmutableArray<TypeSymbol> Flatten(
        ImmutableArray<TypeSymbol> enclosing,
        ImmutableArray<TypeSymbol> own)
    {
        var head = enclosing.IsDefault ? ImmutableArray<TypeSymbol>.Empty : enclosing;
        return own.IsDefaultOrEmpty ? head : head.AddRange(own);
    }

    internal static string GetMetadataTypeName(TypeSymbol type)
    {
        string packageName;
        TypeSymbol? containingType;
        int arity;
        switch (type)
        {
            case StructSymbol structType:
                packageName = structType.PackageName;
                containingType = structType.ContainingType;

                // ADR-0087 §3 R1 / issue #2916: a nested TypeDef's backtick
                // suffix counts only the parameters DECLARED at that level,
                // while its GenericParam rows carry the flattened
                // enclosing-plus-own vector that `TypeParameters` holds. Issue
                // #4095: reading the flattened length here named
                // `Outer[Status].Inner` as `P.Outer`1+Inner`1`, which the
                // emitted metadata does not declare, so the attribute could no
                // longer be decoded at all. This is the same expression
                // `TypeDefEmitter.EmitStructTypeDefinition` uses to choose the
                // name, so the two cannot drift again.
                arity = structType.Declaration == null
                    ? structType.TypeParameters.Length
                    : structType.Declaration.TypeParameterList?.Parameters.Count ?? 0;
                break;
            case InterfaceSymbol interfaceType:
                packageName = interfaceType.PackageName;
                containingType = interfaceType.ContainingType;
                arity = interfaceType.TypeParameters.Length;
                break;
            case EnumSymbol enumType:
                packageName = enumType.PackageName;
                containingType = enumType.ContainingType;
                arity = 0;
                break;
            case DelegateTypeSymbol delegateType:
                packageName = delegateType.PackageName;
                containingType = null;
                arity = delegateType.TypeParameters.Length;
                break;
            default:
                return type.Name;
        }

        string name = arity == 0 ? type.Name : type.Name + "`" + arity;
        if (containingType is not null)
        {
            return GetMetadataTypeName(containingType) + "+" + name;
        }

        return string.IsNullOrEmpty(packageName) ? name : packageName + "." + name;
    }

    /// <summary>
    /// Returns the underlying primitive type of an enum in a way that works for
    /// types loaded through a <see cref="MetadataLoadContext"/>. The BCL helper
    /// <see cref="Enum.GetUnderlyingType(Type)"/> requires a runtime
    /// <see cref="Type"/> and throws <see cref="NotSupportedException"/> for
    /// metadata-loaded types (issue #418 / P1-8), which surfaces as an emit-time
    /// crash in the custom-attribute blob writer whenever an attribute argument
    /// is an enum defined in a referenced (non-BCL) package.
    /// </summary>
    /// <remarks>
    /// Per ECMA-335 II.14.3 every enum is laid out as a class containing a
    /// single instance field named <c>value__</c> whose type is the underlying
    /// primitive (e.g. <see cref="int"/>). Reading that field's type works
    /// uniformly for runtime and metadata-loaded types. The result is then
    /// normalized to the executing runtime's <see cref="Type"/> so that the
    /// reference-equality dispatch in the blob writers matches.
    /// </remarks>
    private static Type GetEnumUnderlyingTypeSafe(Type enumType)
    {
        var valueField = enumType.GetField("value__", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        var fieldType = valueField?.FieldType;
        if (fieldType == null)
        {
            // Defensive fallback: a malformed enum without value__ would be
            // invalid metadata, but treating it as int32 keeps the writer
            // robust rather than crashing during emit.
            return typeof(int);
        }

        return NormalizeWellKnownType(fieldType);
    }

    private void WriteCustomAttributeNamedArg(BlobBuilder bb, Type attributeType, BoundAttributeArgument arg)
    {
        string emittedName = Invariant.Required(
            arg.Name,
            "a named attribute argument always has a member name");
        MemberInfo[] members = attributeType
            .GetMembers(BindingFlags.Public | BindingFlags.Instance)
            .ToArray();
        string[] memberNames = members
            .Select(member => member.Name)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        string name = members
            .Where(member => member is PropertyInfo or FieldInfo)
            .Select(member => member.Name)
            .FirstOrDefault(candidate =>
                SyntaxFacts.GetEmittedIdentifier(
                    candidate,
                    IdentifierNameContext.General,
                    memberNames) == emittedName)
            ?? emittedName;
        var prop = attributeType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        var field = prop == null
            ? attributeType.GetField(name, BindingFlags.Public | BindingFlags.Instance)
            : null;
        Type memberType;
        byte kindTag;
        if (prop != null)
        {
            kindTag = 0x54;
            memberType = prop.PropertyType;
        }
        else if (field != null)
        {
            kindTag = 0x53;
            memberType = field.FieldType;
        }
        else
        {
            // Unknown member — skip silently; binder owns user diagnostics.
            return;
        }

        bb.WriteByte(kindTag);
        WriteCustomAttributeFieldOrPropertyType(bb, memberType);
        bb.WriteSerializedString(name);
        WriteCustomAttributeFixedArg(bb, memberType, arg.Value);
    }

    private static void WriteCustomAttributeFieldOrPropertyType(BlobBuilder bb, Type t)
    {
        // ECMA-335 II.23.3 — element-type byte for a FIELD/PROPERTY tag.
        if (t.IsSameAs(typeof(bool)))
        {
            bb.WriteByte(0x02);
        }
        else if (t.IsSameAs(typeof(char)))
        {
            bb.WriteByte(0x03);
        }
        else if (t.IsSameAs(typeof(sbyte)))
        {
            bb.WriteByte(0x04);
        }
        else if (t.IsSameAs(typeof(byte)))
        {
            bb.WriteByte(0x05);
        }
        else if (t.IsSameAs(typeof(short)))
        {
            bb.WriteByte(0x06);
        }
        else if (t.IsSameAs(typeof(ushort)))
        {
            bb.WriteByte(0x07);
        }
        else if (t.IsSameAs(typeof(int)))
        {
            bb.WriteByte(0x08);
        }
        else if (t.IsSameAs(typeof(uint)))
        {
            bb.WriteByte(0x09);
        }
        else if (t.IsSameAs(typeof(long)))
        {
            bb.WriteByte(0x0A);
        }
        else if (t.IsSameAs(typeof(ulong)))
        {
            bb.WriteByte(0x0B);
        }
        else if (t.IsSameAs(typeof(float)))
        {
            bb.WriteByte(0x0C);
        }
        else if (t.IsSameAs(typeof(double)))
        {
            bb.WriteByte(0x0D);
        }
        else if (t.IsSameAs(typeof(string)))
        {
            bb.WriteByte(0x0E);
        }
        else if (t.IsSameAs(typeof(Type)))
        {
            // 0x50 — System.Type (no payload byte; the FixedArg holds the SerString).
            bb.WriteByte(0x50);
        }
        else if (t.IsSameAs(typeof(object)))
        {
            // 0x51 — boxed object. The FixedArg writer prefixes the runtime
            // type tag and value when emitting the argument body.
            bb.WriteByte(0x51);
        }
        else if (t.IsArray && t.GetArrayRank() == 1)
        {
            // 0x1D SZARRAY followed by the element type's FieldOrPropType byte.
            bb.WriteByte(0x1D);
            WriteCustomAttributeFieldOrPropertyType(bb, t.GetElementType()!);
        }
        else if (t.IsEnum)
        {
            // 0x55 then serialised type name (assembly-qualified).
            bb.WriteByte(0x55);
            bb.WriteSerializedString(GetSerializedTypeName(t));
        }
        else
        {
            // Fallback to STRING.
            bb.WriteByte(0x0E);
        }
    }
}
