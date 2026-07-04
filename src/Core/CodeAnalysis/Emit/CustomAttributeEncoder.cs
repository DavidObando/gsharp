// <copyright file="CustomAttributeEncoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by entry-point first, then private blob-encoding helpers)
#pragma warning disable SA1611 // parameter documentation missing — the public API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

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
/// <c>EmitNullableContextAttribute</c>) stay on
/// <see cref="ReflectionMetadataEmitter"/>: they are called once each
/// from <c>EmitCore</c> and forward into this encoder for the actual
/// blob writes.
/// </para>
/// </remarks>
internal sealed class CustomAttributeEncoder
{
    private readonly EmitContext emitCtx;
    private readonly WellKnownReferences wellKnown;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<StructSymbol, EntityHandle> resolvePrimaryCtorToken;
    private readonly Func<StructSymbol, EntityHandle> resolveDefaultCtorToken;
    private readonly Func<StructSymbol, ConstructorSymbol, EntityHandle> resolveExplicitCtorToken;

    public CustomAttributeEncoder(
        EmitContext emitCtx,
        WellKnownReferences wellKnown,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<StructSymbol, EntityHandle> resolvePrimaryCtorToken = null,
        Func<StructSymbol, EntityHandle> resolveDefaultCtorToken = null,
        Func<StructSymbol, ConstructorSymbol, EntityHandle> resolveExplicitCtorToken = null)
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
        var attrType = this.emitCtx.References.TryResolveType(typeName, out var resolved)
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
        var attrType = this.emitCtx.References.TryResolveType(typeName, out var resolved)
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

        if (!this.emitCtx.References.TryResolveType(clrType.FullName, out var resolved))
        {
            resolved = clrType;
        }

        var positional = attr.PositionalArguments;
        var ctor = ResolveAttributeConstructor(resolved, positional);
        if (ctor == null)
        {
            return;
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
    /// recognition gap this issue is about; named arguments on a user
    /// attribute are silently dropped rather than crashing, matching the
    /// existing "unknown member — skip silently" behavior in
    /// <see cref="WriteCustomAttributeNamedArg"/> for the CLR path.
    /// </remarks>
    private void EmitUserBoundAttribute(EntityHandle parent, StructSymbol attributeType, BoundAttribute attr)
    {
        if (!this.TryResolveUserAttributeConstructor(attributeType, attr.PositionalArguments.Length, out var ctorToken, out var paramTypes))
        {
            return;
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
    /// whose arity exactly matches <paramref name="argCount"/> and returns the
    /// already-correct emit-ready <see cref="EntityHandle"/> for it (a bare
    /// <c>MethodDef</c>, or — for a constructed generic attribute type — a
    /// <c>MemberRef</c> parented at the constructed TypeSpec; both cases are
    /// handled by the injected resolver delegates, the same ones used for
    /// `newobj` against a user constructor). Returns <see langword="false"/>
    /// when no arity match exists or a parameter's type has no
    /// <see cref="TypeSymbol.ClrType"/> (an as-yet-unemitted user type used as
    /// an attribute constructor parameter — unsupported, same as the CLR path
    /// bailing out when it can't resolve a parameter type).
    /// </summary>
    private bool TryResolveUserAttributeConstructor(
        StructSymbol attributeType,
        int argCount,
        out EntityHandle ctorToken,
        out Type[] paramTypes)
    {
        ctorToken = default;
        paramTypes = null;

        if (attributeType.HasPrimaryConstructor
            && attributeType.PrimaryConstructorParameters.Length == argCount
            && this.resolvePrimaryCtorToken != null
            && TryGetClrParameterTypes(attributeType.PrimaryConstructorParameters, out paramTypes))
        {
            ctorToken = this.resolvePrimaryCtorToken(attributeType);
            return true;
        }

        if (this.resolveExplicitCtorToken != null)
        {
            foreach (var ctor in attributeType.EffectiveExplicitConstructors)
            {
                if (ctor.Parameters.Length != argCount)
                {
                    continue;
                }

                if (!TryGetClrParameterTypes(ctor.Parameters, out paramTypes))
                {
                    continue;
                }

                ctorToken = this.resolveExplicitCtorToken(attributeType, ctor);
                return true;
            }
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

    private static bool TryGetClrParameterTypes(ImmutableArray<ParameterSymbol> parameters, out Type[] clrTypes)
    {
        clrTypes = new Type[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
        {
            var clr = parameters[i].Type?.ClrType;
            if (clr == null)
            {
                clrTypes = null;
                return false;
            }

            clrTypes[i] = clr;
        }

        return true;
    }

    private static ConstructorInfo ResolveAttributeConstructor(Type attributeType, ImmutableArray<BoundAttributeArgument> positional)
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

        // Second pass: params-array expansion. A constructor whose last
        // parameter is a single-dimensional array can absorb zero or more
        // trailing positional arguments, each assignable to the element type —
        // e.g. xUnit's InlineData(params object[] data). The exact-arity pass
        // above already handles passing the array directly.
        foreach (var ctor in ctors)
        {
            var pars = ctor.GetParameters();
            if (pars.Length == 0)
            {
                continue;
            }

            var lastType = pars[pars.Length - 1].ParameterType;
            if (!lastType.IsArray || lastType.GetArrayRank() != 1)
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

    private static bool ParametersMatch(ParameterInfo[] pars, ImmutableArray<BoundAttributeArgument> positional, bool expandLast)
    {
        var fixedCount = expandLast ? pars.Length - 1 : pars.Length;
        for (int i = 0; i < fixedCount; i++)
        {
            if (!ArgAssignable(positional[i].Value, pars[i].ParameterType))
            {
                return false;
            }
        }

        if (expandLast)
        {
            var elementType = pars[pars.Length - 1].ParameterType.GetElementType()!;
            for (int i = fixedCount; i < positional.Length; i++)
            {
                if (!ArgAssignable(positional[i].Value, elementType))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool ArgAssignable(object supplied, Type paramType)
    {
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

        return IsTriviallyConvertible(supplied.GetType(), paramType);
    }

    /// <summary>
    /// Maps the supplied positional arguments onto the constructor parameters,
    /// collapsing a trailing params-array into a single synthesized
    /// <see cref="object"/>[] when the call site supplied the elements inline
    /// (params expansion). Returns one value per constructor parameter.
    /// </summary>
    private static object[] BuildCtorArgumentValues(ParameterInfo[] ctorParams, ImmutableArray<BoundAttributeArgument> positional)
    {
        var lastIsArray = ctorParams.Length > 0
            && ctorParams[ctorParams.Length - 1].ParameterType.IsArray
            && ctorParams[ctorParams.Length - 1].ParameterType.GetArrayRank() == 1;

        // Direct (non-expanded) form: arity matches and the final argument is
        // itself assignable to the array parameter (or there is no array tail).
        var lastSupplied = positional.Length == ctorParams.Length && positional.Length > 0
            ? positional[positional.Length - 1].Value
            : null;
        var direct = !lastIsArray
            || (positional.Length == ctorParams.Length
                && (lastSupplied == null
                    || ctorParams[ctorParams.Length - 1].ParameterType.IsInstanceOfType(lastSupplied)
                    || lastSupplied.GetType().IsArray));

        if (direct)
        {
            var values = new object[ctorParams.Length];
            for (int i = 0; i < ctorParams.Length; i++)
            {
                values[i] = positional[i].Value;
            }

            return values;
        }

        var result = new object[ctorParams.Length];
        for (int i = 0; i < ctorParams.Length - 1; i++)
        {
            result[i] = positional[i].Value;
        }

        var tail = positional.Length - (ctorParams.Length - 1);
        var array = new object[tail];
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
    private static Type NormalizeWellKnownType(Type t)
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
            EncodeClrTypeForCtorSig(enc, GetEnumUnderlyingTypeSafe(t));
        }
        else if (t.IsArray && t.GetArrayRank() == 1)
        {
            // ECMA-335 II.23.2.12: SZARRAY element-type for a single-dimensional array parameter.
            this.EncodeClrTypeForCtorSig(enc.SZArray(), t.GetElementType()!);
        }
        else if (typeof(Type).IsAssignableFrom(t))
        {
            // System.Type parameter: encoded as a CLASS type reference in the ctor signature.
            enc.Type(this.getTypeReference(t), isValueType: false);
        }
        else
        {
            // Fallback: encode as object so the signature is still well-formed.
            enc.Object();
        }
    }

    private static void WriteCustomAttributeFixedArg(BlobBuilder bb, Type paramType, object value)
    {
        if (paramType.IsEnum)
        {
            WriteCustomAttributeFixedArg(bb, GetEnumUnderlyingTypeSafe(paramType), value);
            return;
        }

        if (paramType.IsSameAs(typeof(bool)))
        {
            bb.WriteBoolean((bool)value);
        }
        else if (paramType.IsSameAs(typeof(char)))
        {
            bb.WriteUInt16((char)value);
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
            bb.WriteSerializedString((string)value);
        }
        else if (typeof(Type).IsAssignableFrom(paramType))
        {
            // ECMA-335 II.23.3: a System.Type argument is encoded as a
            // SerString carrying the canonical type-name. A null Type
            // serialises as the SerString null marker (0xFF).
            bb.WriteSerializedString(value is Type t ? GetSerializedTypeName(t) : null);
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
                var runtimeType = value.GetType();
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

    private static void WriteCustomAttributeArrayArg(BlobBuilder bb, Type elementType, object value)
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

    private static void WriteCustomAttributeNamedArg(BlobBuilder bb, Type attributeType, BoundAttributeArgument arg)
    {
        var prop = attributeType.GetProperty(arg.Name, BindingFlags.Public | BindingFlags.Instance);
        var field = prop == null
            ? attributeType.GetField(arg.Name, BindingFlags.Public | BindingFlags.Instance)
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
        bb.WriteSerializedString(arg.Name);
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
        else if (typeof(Type).IsAssignableFrom(t))
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
