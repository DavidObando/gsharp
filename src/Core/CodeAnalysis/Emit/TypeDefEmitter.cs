// <copyright file="TypeDefEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by feature: TypeDef-shape group is followed by its private helpers; constructor group is followed by its private helpers)

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// IL/metadata emission for the TypeDef and constructor surface of every
/// user-defined aggregate type (struct, class, interface, enum, delegate)
/// plus the assembly-level synthesized default constructor.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-8 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level <c>private</c> on
/// <see cref="ReflectionMetadataEmitter"/>. The methods moved are
/// (organized by category):
/// </para>
/// <para><b>TypeDef shape emission:</b></para>
/// <list type="bullet">
/// <item><c>EmitStructTypeDef</c> — struct/class TypeDef plus instance/static field rows</item>
/// <item><c>EmitNestedStructTypeDef</c> — nested-private TypeDef for closure / state-machine types</item>
/// <item><c>EmitEnumTypeDef</c> — enum TypeDef plus <c>value__</c> and literal-field rows</item>
/// <item><c>EmitInterfaceTypeDef</c> — interface TypeDef</item>
/// <item><c>EmitDelegateTypeDef</c> — named delegate TypeDef plus <c>.ctor</c>/<c>Invoke</c> MethodDefs</item>
/// <item><c>EmitAbstractMethod</c> — abstract MethodDef for an interface member</item>
/// </list>
/// <para><b>Constructor emission:</b></para>
/// <list type="bullet">
/// <item><c>EmitClassDefaultConstructor</c> — parameter-less <c>.ctor</c> chaining to the base ctor</item>
/// <item><c>EmitStaticConstructor</c> — <c>.cctor</c> running static-field initializers</item>
/// <item><c>EmitClassPrimaryConstructor</c> — Kotlin-style primary ctor</item>
/// <item><c>EmitClassConstructorWithBaseInitializer</c> — forwarding ctor with explicit <c>: Base(args)</c></item>
/// <item><c>EmitClassConstructorWithBody</c> — explicit <c>init</c> ctor with user body and optional base init</item>
/// <item><c>EmitDefaultConstructor</c> — assembly-level synthesized default ctor for closure classes etc.</item>
/// </list>
/// <para>
/// Plus the small helpers used exclusively by the methods above:
/// <c>GetBaseCtorToken</c>, <c>GetBaseInitializerCtorToken</c>,
/// <c>GetImportedBaseDefaultCtorReference</c>,
/// <c>EmitIsReadOnlyAttribute</c>, <c>EmitIsByRefLikeAttribute</c>. The
/// accessibility-map helpers (<c>MapTypeAccessibility</c> /
/// <c>MapFieldAccessibility</c> / etc.) live in
/// <see cref="AccessibilityMap"/> as of PR-E-12 — both this component and
/// the root call into that single canonical home.
/// </para>
/// <para>
/// Like every other PR-E-* component, <see cref="TypeDefEmitter"/> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> as its peers plus delegate callbacks
/// for the remaining <see cref="ReflectionMetadataEmitter"/> helpers it
/// depends on (<c>EncodeTypeSymbol</c>, <c>EncodeReturnSymbol</c>,
/// <c>GetTypeReference</c>, <c>NextParameterHandle</c>,
/// <c>EmitUserAttributes</c>, <c>EmitIsReadOnlyAttributeOnParameter</c>,
/// <c>GetCtorReference</c>). For the three constructor methods that
/// internally drive the still-private <c>BodyEmitter</c> nested class
/// (<c>EmitStaticConstructor</c>, <c>EmitClassConstructorWithBaseInitializer</c>,
/// <c>EmitClassConstructorWithBody</c>), the body-emission step is
/// reached via injected <see cref="Func{TResult}"/> callbacks that return
/// the IL body offset. Those helpers stay on the root so they remain
/// adjacent to <c>BodyEmitter</c> until PR-E-11 promotes the whole
/// nested class to its own file.
/// </para>
/// <para>
/// What stays on <see cref="ReflectionMetadataEmitter"/>: the synthesized
/// inline-struct constructor (already moved to
/// <see cref="DataStructSynthesizer"/> in PR-E-6), the
/// <c>EmitBaseConstructorArguments</c> helper which is
/// <c>BodyEmitter</c>-internal (moves with <c>BodyEmitter</c> in PR-E-11),
/// and the root's orchestrator <c>Emit</c>/<c>EmitCore</c> entry points
/// (thinned in PR-E-12).
/// </para>
/// </remarks>
internal sealed class TypeDefEmitter
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
    private readonly Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol;
    private readonly Action<ReturnTypeEncoder, TypeSymbol, RefKind> encodeReturnSymbol;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<ParameterHandle> nextParameterHandle;
    private readonly Action<EntityHandle, Symbol, AttributeTargetKind> emitUserAttributes;
    private readonly Action<ParameterHandle> emitIsReadOnlyAttributeOnParameter;
    private readonly Func<ConstructorInfo, MemberReferenceHandle> getCtorReference;
    private readonly Func<StructSymbol, int> emitStaticConstructorBodyBytes;
    private readonly Func<StructSymbol, EntityHandle, int> emitClassDefaultConstructorBodyBytes;
    private readonly Func<StructSymbol, EntityHandle, int> emitClassPrimaryConstructorBodyBytes;
    private readonly Func<StructSymbol, ImmutableArray<ParameterSymbol>, BaseConstructorInitializer, EntityHandle, int> emitClassConstructorWithBaseInitializerBodyBytes;
    private readonly Func<StructSymbol, ConstructorSymbol, BaseConstructorInitializer, EntityHandle, int> emitClassConstructorWithBodyBodyBytes;
    private readonly Func<StructSymbol, DeinitSymbol, BoundBlockStatement, EntityHandle, int> emitClassDeinitializerBodyBytes;

    public TypeDefEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol,
        Action<ReturnTypeEncoder, TypeSymbol, RefKind> encodeReturnSymbol,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<ParameterHandle> nextParameterHandle,
        Action<EntityHandle, Symbol, AttributeTargetKind> emitUserAttributes,
        Action<ParameterHandle> emitIsReadOnlyAttributeOnParameter,
        Func<ConstructorInfo, MemberReferenceHandle> getCtorReference,
        Func<StructSymbol, int> emitStaticConstructorBodyBytes,
        Func<StructSymbol, EntityHandle, int> emitClassDefaultConstructorBodyBytes,
        Func<StructSymbol, EntityHandle, int> emitClassPrimaryConstructorBodyBytes,
        Func<StructSymbol, ImmutableArray<ParameterSymbol>, BaseConstructorInitializer, EntityHandle, int> emitClassConstructorWithBaseInitializerBodyBytes,
        Func<StructSymbol, ConstructorSymbol, BaseConstructorInitializer, EntityHandle, int> emitClassConstructorWithBodyBodyBytes,
        Func<StructSymbol, DeinitSymbol, BoundBlockStatement, EntityHandle, int> emitClassDeinitializerBodyBytes)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw new ArgumentNullException(nameof(encodeTypeSymbol));
        this.encodeReturnSymbol = encodeReturnSymbol ?? throw new ArgumentNullException(nameof(encodeReturnSymbol));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.nextParameterHandle = nextParameterHandle ?? throw new ArgumentNullException(nameof(nextParameterHandle));
        this.emitUserAttributes = emitUserAttributes ?? throw new ArgumentNullException(nameof(emitUserAttributes));
        this.emitIsReadOnlyAttributeOnParameter = emitIsReadOnlyAttributeOnParameter ?? throw new ArgumentNullException(nameof(emitIsReadOnlyAttributeOnParameter));
        this.getCtorReference = getCtorReference ?? throw new ArgumentNullException(nameof(getCtorReference));
        this.emitStaticConstructorBodyBytes = emitStaticConstructorBodyBytes ?? throw new ArgumentNullException(nameof(emitStaticConstructorBodyBytes));
        this.emitClassDefaultConstructorBodyBytes = emitClassDefaultConstructorBodyBytes ?? throw new ArgumentNullException(nameof(emitClassDefaultConstructorBodyBytes));
        this.emitClassPrimaryConstructorBodyBytes = emitClassPrimaryConstructorBodyBytes ?? throw new ArgumentNullException(nameof(emitClassPrimaryConstructorBodyBytes));
        this.emitClassConstructorWithBaseInitializerBodyBytes = emitClassConstructorWithBaseInitializerBodyBytes ?? throw new ArgumentNullException(nameof(emitClassConstructorWithBaseInitializerBodyBytes));
        this.emitClassConstructorWithBodyBodyBytes = emitClassConstructorWithBodyBodyBytes ?? throw new ArgumentNullException(nameof(emitClassConstructorWithBodyBodyBytes));
        this.emitClassDeinitializerBodyBytes = emitClassDeinitializerBodyBytes ?? throw new ArgumentNullException(nameof(emitClassDeinitializerBodyBytes));
    }

    // TypeDef shape emission

    /// <summary>
    /// Emits the TypeDef row for a user-declared struct or class and its
    /// instance/static field/event/property-backing FieldDefs. The struct/
    /// class distinction selects base type (<c>System.ValueType</c> vs
    /// <c>System.Object</c>) and the appropriate <see cref="TypeAttributes"/>
    /// shape. Routes user annotations onto the TypeDef and each FieldDef.
    /// </summary>
    /// <param name="structSym">The struct or class symbol to emit.</param>
    /// <param name="firstFieldRow">The pre-reserved first field row used as the TypeDef's <c>fieldList</c> when no fields are emitted.</param>
    /// <param name="methodListRow">The pre-reserved first method row used as the TypeDef's <c>methodList</c>.</param>
    public void EmitStructTypeDef(StructSymbol structSym, int firstFieldRow, int methodListRow)
    {
        // Phase 4 emit parity (F2, type-erased): generic type definitions
        // are emitted as ordinary non-generic CLR classes/structs. Each
        // T-typed field is encoded as System.Object via EncodeTypeSymbol;
        // constructed instances (Box[int], Box[string]) share the same CLR
        // TypeDef as the definition and round-trip values through box /
        // unbox.any at field-access and primary-ctor boundaries. Constructed
        // StructSymbols are aliased into the lookup dictionaries by
        // RegisterConstructedTypeAliases after the definition's TypeDef and
        // members are emitted.
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            throw new System.NotSupportedException(
                $"Internal error: a constructed StructSymbol ('{structSym.Name}') reached EmitStructTypeDef. Only definitions should be in program.Structs.");
        }

        // Emit field definitions in source order. Each field's signature is a
        // FieldSig encoding the GSharp type symbol.
        FieldDefinitionHandle firstField = default;
        foreach (var field in structSym.Fields)
        {
            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), field.Type);
            var attrs = AccessibilityMap.MapFieldAccessibility(field.Accessibility);
            if (field.IsReadOnly)
            {
                attrs |= FieldAttributes.InitOnly;
            }

            var handle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(field.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = handle;
            }

            this.cache.StructFieldDefs[field] = handle;

            // ADR-0093 §5: a field declared with @FieldOffset(N) inside an
            // explicit-layout type produces a `FieldLayout` row pointing at
            // the field's FieldDef. The @FieldOffset attribute itself is
            // pseudo-custom and is filtered out of the CustomAttribute pass
            // by KnownAttributes.IsPseudoCustomAttribute.
            if (field.ExplicitOffset is int offset)
            {
                this.emitCtx.Metadata.AddFieldLayout(handle, offset);
            }

            // Issue #186 / ADR-0047 §3: route any @-annotations bound onto
            // the field symbol onto the FieldDef row so attributes like
            // @Obsolete round-trip into CustomAttribute rows.
            this.emitUserAttributes(handle, field, AttributeTargetKind.Field);
        }

        // ADR-0051 Phase 6: emit backing FieldDefs for auto-properties.
        foreach (var prop in structSym.Properties)
        {
            if (!prop.IsAutoProperty || prop.BackingField == null)
            {
                continue;
            }

            // #573: when a field-backed synthesized property reuses an existing
            // user field (which was already emitted above), skip creating a
            // duplicate backing FieldDef — the mapping already exists.
            if (this.cache.StructFieldDefs.ContainsKey(prop.BackingField))
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), prop.Type);
            var backingHandle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private,
                name: this.emitCtx.Metadata.GetOrAddString($"<{prop.Name}>k__BackingField"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.cache.StructFieldDefs[prop.BackingField] = backingHandle;
        }

        // ADR-0052: emit backing FieldDefs for field-like events.
        foreach (var ev in structSym.Events)
        {
            if (!ev.IsFieldLike || ev.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), ev.Type);
            var backingHandle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private,
                name: this.emitCtx.Metadata.GetOrAddString(ev.BackingField.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.cache.StructFieldDefs[ev.BackingField] = backingHandle;
        }

        // ADR-0053: emit static field definitions from shared block.
        if (!structSym.StaticFields.IsDefaultOrEmpty)
        {
            foreach (var staticField in structSym.StaticFields)
            {
                var sigBlob = new BlobBuilder();
                this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), staticField.Type);
                var attrs = AccessibilityMap.MapFieldAccessibility(staticField.Accessibility) | FieldAttributes.Static;
                if (staticField.IsReadOnly)
                {
                    attrs |= FieldAttributes.InitOnly;
                }

                var handle = this.emitCtx.Metadata.AddFieldDefinition(
                    attributes: attrs,
                    name: this.emitCtx.Metadata.GetOrAddString(staticField.Name),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
                if (firstField.IsNil)
                {
                    firstField = handle;
                }

                this.cache.StructFieldDefs[staticField] = handle;
            }
        }

        // Issue #263: emit backing FieldDefs for static auto-properties.
        foreach (var prop in structSym.StaticProperties)
        {
            if (!prop.IsAutoProperty || prop.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), prop.Type);
            var backingHandle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: FieldAttributes.Assembly | FieldAttributes.Static,
                name: this.emitCtx.Metadata.GetOrAddString($"<{prop.Name}>k__BackingField"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.cache.StructFieldDefs[prop.BackingField] = backingHandle;
        }

        // Issue #263: emit backing FieldDefs for static field-like events.
        foreach (var ev in structSym.StaticEvents)
        {
            if (!ev.IsFieldLike || ev.BackingField == null)
            {
                continue;
            }

            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), ev.Type);
            var backingHandle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: FieldAttributes.Private | FieldAttributes.Static,
                name: this.emitCtx.Metadata.GetOrAddString(ev.BackingField.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = backingHandle;
            }

            this.cache.StructFieldDefs[ev.BackingField] = backingHandle;
        }

        if (firstField.IsNil)
        {
            // Empty struct: no field rows added; point at next row, which is
            // (firstFieldRow) — same as the next TypeDef's first field row.
            firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow);
        }

        TypeAttributes typeAttrs;
        EntityHandle baseType;
        if (structSym.IsClass)
        {
            // Phase 3.B.3 sub-step 3: classes are CLR reference types.
            // Sealed by default per ADR-0017 (Kotlin-style `open` opt-in).
            // ADR-0078: `sealed class` denotes a CLOSED HIERARCHY (subclassing
            // allowed in-package, exhaustiveness checked at switch sites). It
            // must NOT carry the CLR `Sealed` flag, otherwise subclasses fail
            // to load with `TypeLoadException: parent type is sealed`.
            // Base is either the user-declared base class (if any) or
            // System.Object.
            var classAttrs = TypeAttributes.Class
                | ResolveClassLayoutFlag(structSym) | TypeAttributes.AnsiClass
                | TypeAttributes.BeforeFieldInit
                | AccessibilityMap.MapTypeAccessibility(structSym.Accessibility);
            if (!structSym.IsOpen && !structSym.IsSealedHierarchy)
            {
                classAttrs |= TypeAttributes.Sealed;
            }

            typeAttrs = classAttrs;
            if (structSym.IsAttributeClass)
            {
                // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar — base is
                // System.Attribute, regardless of any other resolution.
                baseType = this.wellKnown.GetSystemAttributeTypeRef();
            }
            else if (structSym.BaseClass != null && this.cache.StructTypeDefs.TryGetValue(structSym.BaseClass, out var baseHandle))
            {
                baseType = baseHandle;
            }
            else if (structSym.ImportedBaseType?.ClrType is Type importedBaseClr)
            {
                // Issue #296: the class inherits from an imported CLR base
                // class; reference it as the TypeDef's base type so the emitted
                // metadata extends the imported base.
                baseType = this.getTypeReference(importedBaseClr);
            }
            else
            {
                baseType = this.wellKnown.ObjectTypeRef;
            }
        }
        else
        {
            typeAttrs = ResolveStructLayoutFlag(structSym) | TypeAttributes.Sealed
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                | AccessibilityMap.MapTypeAccessibility(structSym.Accessibility);
            baseType = this.wellKnown.ValueTypeRef;
        }

        // ADR-0087 §3 R1: a generic user type's TypeDef name is mangled with
        // backtick-arity per ECMA-335 II.10.3.1 (`Box` becomes `Box`1`) and one
        // GenericParam row is emitted per type parameter immediately after
        // AddTypeDefinition. Type-erased non-generic structs keep the unmangled
        // name and have no GenericParam rows.
        var typeDefName = MangleGenericName(structSym.Name, structSym.TypeParameters);
        var handle2 = this.emitCtx.Metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.emitCtx.Metadata.GetOrAddString(structSym.PackageName ?? string.Empty),
            name: this.emitCtx.Metadata.GetOrAddString(typeDefName),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.cache.StructTypeDefs[structSym] = handle2;
        EmitGenericParamRows(this.emitCtx, handle2, structSym.TypeParameters);
        if (structSym.IsInline)
        {
            this.EmitIsReadOnlyAttribute(handle2);
        }

        if (structSym.IsRefStruct)
        {
            // Issue #367: mark user-declared `ref struct` types as by-ref-like.
            this.EmitIsByRefLikeAttribute(handle2);
        }

        // ADR-0093 §5: when @StructLayout supplies Pack or Size, write the
        // matching ClassLayout row. A null/0 pack with a 0 size results in
        // no ClassLayout row at all — the runtime defaults apply.
        EmitClassLayout(this.emitCtx, handle2, structSym.LayoutMetadata);

        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.emitUserAttributes(handle2, structSym, AttributeTargetKind.Type);
    }

    /// <summary>
    /// Emits a nested-private TypeDef for a state-machine type.  Same as
    /// <see cref="EmitStructTypeDef"/> but uses <c>NestedPrivate</c> visibility
    /// and an empty namespace (nested types have no namespace in metadata).
    /// </summary>
    /// <param name="structSym">The nested struct symbol to emit.</param>
    /// <param name="firstFieldRow">The pre-reserved first field row used as the TypeDef's <c>fieldList</c> when no fields are emitted.</param>
    /// <param name="methodListRow">The pre-reserved first method row used as the TypeDef's <c>methodList</c>.</param>
    public void EmitNestedStructTypeDef(StructSymbol structSym, int firstFieldRow, int methodListRow)
    {
        if (!structSym.TypeArguments.IsDefaultOrEmpty)
        {
            throw new System.NotSupportedException(
                $"Internal error: a constructed StructSymbol ('{structSym.Name}') reached EmitNestedStructTypeDef.");
        }

        FieldDefinitionHandle firstField = default;
        foreach (var field in structSym.Fields)
        {
            var sigBlob = new BlobBuilder();
            this.encodeTypeSymbol(new BlobEncoder(sigBlob).FieldSignature(), field.Type);
            var attrs = AccessibilityMap.MapFieldAccessibility(field.Accessibility);
            if (field.IsReadOnly)
            {
                attrs |= FieldAttributes.InitOnly;
            }

            var handle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(field.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
            if (firstField.IsNil)
            {
                firstField = handle;
            }

            this.cache.StructFieldDefs[field] = handle;

            // Issue #186: mirror the EmitStructTypeDef path for nested types
            // so user @-annotations on fields round-trip into CustomAttribute
            // rows on the nested FieldDef as well.
            this.emitUserAttributes(handle, field, AttributeTargetKind.Field);
        }

        if (firstField.IsNil)
        {
            firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow);
        }

        TypeAttributes typeAttrs;
        EntityHandle baseType;
        if (structSym.IsClass)
        {
            var classAttrs = TypeAttributes.Class
                | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass
                | TypeAttributes.BeforeFieldInit
                | TypeAttributes.NestedPrivate;
            if (!structSym.IsOpen && !structSym.IsSealedHierarchy)
            {
                classAttrs |= TypeAttributes.Sealed;
            }

            typeAttrs = classAttrs;
            if (structSym.BaseClass != null && this.cache.StructTypeDefs.TryGetValue(structSym.BaseClass, out var baseHandle))
            {
                baseType = baseHandle;
            }
            else if (structSym.ImportedBaseType?.ClrType is Type importedBaseClr)
            {
                // Issue #296: nested class inheriting an imported CLR base.
                baseType = this.getTypeReference(importedBaseClr);
            }
            else
            {
                baseType = this.wellKnown.ObjectTypeRef;
            }
        }
        else
        {
            typeAttrs = TypeAttributes.SequentialLayout | TypeAttributes.Sealed
                | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
                | TypeAttributes.NestedPrivate;
            baseType = this.wellKnown.ValueTypeRef;
        }

        // Nested types have no namespace in ECMA-335 metadata.
        // Issue #810: when the state-machine class is generic over the
        // outer method's type parameters (mirroring how Roslyn emits
        // `<Empty>d__0<T>`), mangle the name with the backtick-arity
        // suffix per ECMA-335 II.10.3.1, then emit GenericParam rows
        // so reflection sees the real type-parameter slots.
        var nestedTypeDefName = MangleGenericName(structSym.Name, structSym.TypeParameters);
        var handle2 = this.emitCtx.Metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: default(StringHandle),
            name: this.emitCtx.Metadata.GetOrAddString(nestedTypeDefName),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.cache.StructTypeDefs[structSym] = handle2;
        EmitGenericParamRows(this.emitCtx, handle2, structSym.TypeParameters);
        if (structSym.IsRefStruct)
        {
            // Issue #367: nested user-declared `ref struct` types are by-ref-like too.
            this.EmitIsByRefLikeAttribute(handle2);
        }
    }

    /// <summary>
    /// Issue #193: emits a CLR <c>enum</c> TypeDef for a user-defined GSharp
    /// <c>enum Name { ... }</c>. The TypeDef is a sealed value type
    /// deriving from <c>System.Enum</c> with:
    ///   * an instance field <c>value__</c> of <c>int32</c> (the underlying
    ///     type per ADR-0047 §3; widen later if we add explicit underlying
    ///     -type syntax),
    ///   * one <c>public static literal</c> field per <see cref="EnumMemberSymbol"/>
    ///     carrying its integer constant via a <c>HasDefault</c> / Constant row.
    /// Custom attributes bound onto <c>EnumSymbol.Attributes</c> route
    /// to the type-def row; per-member attributes route to each literal field.
    /// </summary>
    /// <param name="enumSym">The enum symbol to emit.</param>
    /// <param name="firstFieldRow">The pre-reserved first field row (unused — the enum captures its own row via <see cref="MetadataBuilder.GetRowCount"/>).</param>
    /// <param name="methodListRow">The pre-reserved first method row used as the TypeDef's <c>methodList</c>.</param>
    public void EmitEnumTypeDef(EnumSymbol enumSym, int firstFieldRow, int methodListRow)
    {
        var enumTypeRef = this.getTypeReference(this.emitCtx.CoreEnumType);

        // P3-8 (#420): emit the TypeDef row *before* its FieldDef rows so the
        // literal-field signatures can refer to the enum's actual TypeDef
        // handle returned by AddTypeDefinition, rather than a speculative
        // row-count+1 value that breaks silently if the emit order ever
        // changes. The TypeDef's fieldList must still point at the first
        // FieldDef row that will belong to this enum, which is the next row
        // about to be added — we capture it via GetRowCount + 1 here and
        // assert below that the first AddFieldDefinition call matches.
        var firstFieldHandle = MetadataTokens.FieldDefinitionHandle(this.emitCtx.Metadata.GetRowCount(TableIndex.Field) + 1);

        var typeAttrs = TypeAttributes.Class | TypeAttributes.Sealed
            | TypeAttributes.AnsiClass | TypeAttributes.AutoLayout
            | AccessibilityMap.MapTypeAccessibility(enumSym.Accessibility);

        var enumTypeDef = this.emitCtx.Metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.emitCtx.Metadata.GetOrAddString(enumSym.PackageName ?? string.Empty),
            name: this.emitCtx.Metadata.GetOrAddString(enumSym.Name),
            baseType: enumTypeRef,
            fieldList: firstFieldHandle,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow));
        this.cache.EnumTypeDefs[enumSym] = enumTypeDef;

        // Field 1: instance int32 'value__' with SpecialName | RTSpecialName.
        var valueFieldSigBlob = new BlobBuilder();
        new BlobEncoder(valueFieldSigBlob).FieldSignature().Int32();
        var valueFieldHandle = this.emitCtx.Metadata.AddFieldDefinition(
            attributes: FieldAttributes.Public | FieldAttributes.SpecialName | FieldAttributes.RTSpecialName,
            name: this.emitCtx.Metadata.GetOrAddString("value__"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(valueFieldSigBlob));
        if (valueFieldHandle != firstFieldHandle)
        {
            throw new InvalidOperationException(
                $"Enum '{enumSym.Name}' value__ FieldDef row {MetadataTokens.GetRowNumber(valueFieldHandle)} did not match the fieldList row {MetadataTokens.GetRowNumber(firstFieldHandle)} stamped on its TypeDef. This indicates another emitter inserted FieldDef rows between TypeDef creation and field emission.");
        }

        // Fields 2..N: one public static literal field per member, signature
        // is the enum's own typedef (the standard CLR convention for enum
        // literals). The Constant row is added below after all field rows
        // have been emitted so they remain in increasing parent-token order.
        var memberFieldHandles = new List<FieldDefinitionHandle>(enumSym.Members.Length);
        foreach (var member in enumSym.Members)
        {
            var memberSigBlob = new BlobBuilder();
            new BlobEncoder(memberSigBlob).FieldSignature().Type(enumTypeDef, isValueType: true);
            var memberFieldHandle = this.emitCtx.Metadata.AddFieldDefinition(
                attributes: FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault,
                name: this.emitCtx.Metadata.GetOrAddString(member.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(memberSigBlob));
            memberFieldHandles.Add(memberFieldHandle);
            this.cache.EnumMemberFieldDefs[member] = memberFieldHandle;
        }

        // Constant rows must be added in increasing parent FieldDefinition
        // order; iterating the literal fields in declaration order naturally
        // satisfies this since AddFieldDefinition is monotone.
        for (int i = 0; i < enumSym.Members.Length; i++)
        {
            this.emitCtx.Metadata.AddConstant(parent: memberFieldHandles[i], value: enumSym.Members[i].Value);
        }

        // Issue #188 (step 3): route any user annotations attached to the
        // enum type onto the TypeDef row, and per-member annotations onto
        // each literal-field row.
        this.emitUserAttributes(enumTypeDef, enumSym, AttributeTargetKind.Type);
        for (int i = 0; i < enumSym.Members.Length; i++)
        {
            this.emitUserAttributes(memberFieldHandles[i], enumSym.Members[i], AttributeTargetKind.Field);
        }
    }

    /// <summary>
    /// Phase 3.B.4: emits the TypeDef row for a user-declared interface.
    /// </summary>
    /// <param name="ifaceSym">The interface symbol.</param>
    /// <param name="firstMethodRow">The preassigned first method row.</param>
    /// <param name="firstFieldRow">The first field row for the next aggregate (interfaces own no fields, so this is forwarded as their fieldList).</param>
    public void EmitInterfaceTypeDef(InterfaceSymbol ifaceSym, int firstMethodRow, int firstFieldRow)
    {
        var typeAttrs = TypeAttributes.Interface | TypeAttributes.Abstract
            | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass
            | AccessibilityMap.MapTypeAccessibility(ifaceSym.Accessibility);
        var typeDefName = MangleGenericName(ifaceSym.Name, ifaceSym.TypeParameters);
        var handle = this.emitCtx.Metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.emitCtx.Metadata.GetOrAddString(ifaceSym.PackageName ?? string.Empty),
            name: this.emitCtx.Metadata.GetOrAddString(typeDefName),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(firstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(firstMethodRow));
        this.cache.InterfaceTypeDefs[ifaceSym] = handle;
        EmitGenericParamRows(this.emitCtx, handle, ifaceSym.TypeParameters);

        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.emitUserAttributes(handle, ifaceSym, AttributeTargetKind.Type);
    }

    /// <summary>
    /// ADR-0059 / issue #255: emits a user-declared named delegate as a sealed
    /// reference type deriving from <c>System.MulticastDelegate</c> with two
    /// runtime-implemented methods:
    /// <list type="bullet">
    ///   <item><c>.ctor(object, native int)</c> — the standard delegate
    ///     constructor recognised by the CLR for delegate creation
    ///     (<c>newobj</c>) and binding.</item>
    ///   <item><c>Invoke(params...) ret</c> — the delegate's call signature
    ///     used by both managed callers and the CLR's delegate dispatch.</item>
    /// </list>
    /// Both methods carry <c>MethodImplAttributes.Runtime | Managed</c> and
    /// have no IL body — the runtime supplies the implementation. We
    /// intentionally do NOT emit <c>BeginInvoke</c>/<c>EndInvoke</c>, matching
    /// Roslyn's portable-assembly convention.
    /// </summary>
    /// <param name="delegateSym">The named delegate symbol.</param>
    /// <param name="firstMethodRow">The pre-reserved method row of the
    /// delegate's <c>.ctor</c> (the second reserved row is its
    /// <c>Invoke</c>).</param>
    public void EmitDelegateTypeDef(DelegateTypeSymbol delegateSym, int firstMethodRow)
    {
        var multicastTypeRef = this.getTypeReference(this.emitCtx.CoreMulticastDelegateType);

        // Delegates own no fields; their fieldList points at the next
        // FieldDef row, which is the first field of whatever TypeDef follows
        // in row order. We mirror the EmitEnumTypeDef pattern of capturing
        // the *next* row from the current FieldDef table count.
        var firstFieldHandle = MetadataTokens.FieldDefinitionHandle(this.emitCtx.Metadata.GetRowCount(TableIndex.Field) + 1);

        var typeAttrs = TypeAttributes.Class | TypeAttributes.Sealed
            | TypeAttributes.AnsiClass | TypeAttributes.AutoLayout
            | AccessibilityMap.MapTypeAccessibility(delegateSym.Accessibility);

        var delegateTypeDef = this.emitCtx.Metadata.AddTypeDefinition(
            attributes: typeAttrs,
            @namespace: this.emitCtx.Metadata.GetOrAddString(delegateSym.PackageName ?? string.Empty),
            name: this.emitCtx.Metadata.GetOrAddString(delegateSym.Name),
            baseType: multicastTypeRef,
            fieldList: firstFieldHandle,
            methodList: MetadataTokens.MethodDefinitionHandle(firstMethodRow));
        this.cache.DelegateTypeDefs[delegateSym] = delegateTypeDef;

        // ---- .ctor(object, native int) ----
        var ctorSigBlob = new BlobBuilder();
        new BlobEncoder(ctorSigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(2, r => r.Void(), ps =>
            {
                ps.AddParameter().Type().Object();
                ps.AddParameter().Type().IntPtr();
            });

        var ctorFirstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("object"),
            sequenceNumber: 1);
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("method"),
            sequenceNumber: 2);

        var ctorAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
            | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName;

        var ctorHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: ctorAttrs,
            implAttributes: MethodImplAttributes.Runtime | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSigBlob),
            bodyOffset: -1,
            parameterList: ctorFirstParamHandle);
        this.cache.DelegateCtorHandles[delegateSym] = ctorHandle;

        // Sanity check: the actual .ctor row must match the row reserved by
        // the scheduler so the TypeDef's methodList pointer is valid.
        if (MetadataTokens.GetRowNumber(ctorHandle) != firstMethodRow)
        {
            throw new InvalidOperationException(
                $"Delegate '{delegateSym.Name}' .ctor MethodDef row {MetadataTokens.GetRowNumber(ctorHandle)} did not match the reserved row {firstMethodRow}. This indicates another emitter inserted method rows between scheduling and delegate emission.");
        }

        // ---- Invoke(params...) ret ----
        var invokeSigBlob = new BlobBuilder();
        new BlobEncoder(invokeSigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                delegateSym.Parameters.Length,
                r => this.encodeReturnSymbol(r, delegateSym.ReturnType ?? TypeSymbol.Void, RefKind.None),
                ps =>
                {
                    foreach (var p in delegateSym.Parameters)
                    {
                        // ADR-0060 §12: a named-delegate parameter declared `ref`/`out`/`in`
                        // emits `T&` on the Invoke signature, plus the IsReadOnlyAttribute
                        // modreq for `in` (matching the C# convention so consumers see a
                        // normal `ref`/`out`/`in` parameter). ParameterAttributes.Out / In
                        // are stamped on the per-parameter row below.
                        var paramEncoder = ps.AddParameter();
                        if (p.RefKind == RefKind.In)
                        {
                            var isReadOnlyAttrType = this.wellKnown.GetIsReadOnlyAttributeTypeRef();
                            if (!isReadOnlyAttrType.IsNil)
                            {
                                paramEncoder.CustomModifiers().AddModifier(isReadOnlyAttrType, isOptional: false);
                            }
                        }

                        this.encodeTypeSymbol(paramEncoder.Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        var invokeFirstParamHandle = this.nextParameterHandle();
        for (var i = 0; i < delegateSym.Parameters.Length; i++)
        {
            var p = delegateSym.Parameters[i];

            // ADR-0060 §12: stamp the Parameter row with .Out / .In for ref-kind delegate
            // parameters, and attach IsReadOnlyAttribute for `in`.
            var paramAttributes = ParameterAttributes.None;
            if (p.RefKind == RefKind.Out)
            {
                paramAttributes |= ParameterAttributes.Out;
            }
            else if (p.RefKind == RefKind.In)
            {
                paramAttributes |= ParameterAttributes.In;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: paramAttributes,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? $"arg{i + 1}"),
                sequenceNumber: (ushort)(i + 1));

            if (p.RefKind == RefKind.In)
            {
                this.emitIsReadOnlyAttributeOnParameter(paramHandle);
            }
        }

        var invokeAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
            | MethodAttributes.Virtual | MethodAttributes.NewSlot;

        var invokeParamList = delegateSym.Parameters.Length > 0
            ? invokeFirstParamHandle
            : this.nextParameterHandle();

        var invokeHandle = this.emitCtx.Metadata.AddMethodDefinition(
            attributes: invokeAttrs,
            implAttributes: MethodImplAttributes.Runtime | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(invokeSigBlob),
            bodyOffset: -1,
            parameterList: invokeParamList);
        this.cache.DelegateInvokeHandles[delegateSym] = invokeHandle;

        // ADR-0047 §3: user annotations targeting the delegate type land on
        // the TypeDef row (same as struct/interface/enum).
        this.emitUserAttributes(delegateTypeDef, delegateSym, AttributeTargetKind.Type);
    }

    /// <summary>
    /// Phase 3.B.4: emits an abstract method definition for an interface
    /// member. Carries <c>Public | Virtual | Abstract | NewSlot | HideBySig</c>
    /// and no body (bodyOffset = -1).
    /// </summary>
    /// <param name="method">The interface method symbol.</param>
    public void EmitAbstractMethod(FunctionSymbol method)
    {
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                method.Parameters.Length,
                r => this.encodeReturnSymbol(r, method.Type, method.ReturnRefKind),
                ps =>
                {
                    foreach (var p in method.Parameters)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
            | MethodAttributes.Virtual | MethodAttributes.Abstract
            | MethodAttributes.NewSlot;
        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: attrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// ADR-0089 / issue #755: emits a static-virtual interface
    /// MethodDef. Carries
    /// <c>Public | Static | Virtual | Abstract | NewSlot | HideBySig</c>
    /// for abstract static slots, omits <c>Abstract</c> when the interface
    /// supplied a default body, and (when a body is present) plugs in the
    /// encoded IL via <paramref name="bodyOffset"/>.
    /// </summary>
    /// <param name="method">The interface static-virtual method symbol.</param>
    /// <param name="hasBody">True if the declaration carries a default body.</param>
    /// <param name="bodyOffset">Pre-emitted IL body offset; ignored when <paramref name="hasBody"/> is false.</param>
    public void EmitStaticVirtualMethod(FunctionSymbol method, bool hasBody, int bodyOffset)
    {
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(
                method.Parameters.Length,
                r => this.encodeReturnSymbol(r, method.Type, method.ReturnRefKind),
                ps =>
                {
                    foreach (var p in method.Parameters)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
            | MethodAttributes.Static | MethodAttributes.Virtual
            | MethodAttributes.NewSlot;
        if (!hasBody)
        {
            attrs |= MethodAttributes.Abstract;
        }

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: attrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: hasBody ? bodyOffset : -1,
            parameterList: this.nextParameterHandle());
    }

    // Constructor emission

    /// <summary>
    /// Emits a parameter-less <c>.ctor</c> for a user-defined <c>class</c>
    /// (Phase 3.B.3). The body chains to the base class's <c>.ctor()</c>
    /// (either an inherited user class or <c>System.Object</c>) and returns.
    /// </summary>
    /// <param name="classSym">The class whose default constructor is being emitted.</param>
    /// <returns>The emitted constructor's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitClassDefaultConstructor(StructSymbol classSym)
    {
        var baseCtorToken = this.GetBaseCtorToken(classSym);
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            // Issue #640: when the class declares instance field initializers,
            // delegate to the body-emitter callback so expressions are evaluated
            // and stored into fields after the base ctor call.
            if (!classSym.InstanceFieldInitializers.IsEmpty)
            {
                bodyOffset = this.emitClassDefaultConstructorBodyBytes(classSym, baseCtorToken);
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(baseCtorToken);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Emits a <c>.cctor</c> (type initializer) for a type with static field
    /// initializers (Issue #262). The body evaluates each initializer expression
    /// and stores the result into the corresponding static field via <c>stsfld</c>.
    /// </summary>
    /// <param name="typeSym">The type whose static constructor is being emitted.</param>
    public void EmitStaticConstructor(StructSymbol typeSym)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.emitStaticConstructorBodyBytes(typeSym);
        }

        var cctorSig = new BlobBuilder();
        new BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => r.Void(), _ => { });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Emits the Kotlin-style primary constructor for a class
    /// (Phase 3.B.3 sub-step 2): an instance ctor taking one parameter per
    /// declared primary-ctor param, chaining to <c>object::.ctor()</c> and
    /// assigning each argument to the same-named field.
    /// </summary>
    /// <param name="classSym">The class with a declared primary constructor.</param>
    /// <returns>The emitted constructor's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitClassPrimaryConstructor(StructSymbol classSym)
    {
        var parameters = classSym.PrimaryConstructorParameters;
        var baseCtorToken = this.GetBaseCtorToken(classSym);

        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            // Issue #640: when the class declares instance field initializers,
            // delegate to the body-emitter callback so expressions are evaluated
            // and stored into fields after the base ctor call and primary ctor
            // parameter assignments.
            // ADR-0087 §3 R3: also delegate to the callback for generic
            // user classes so the param→field stfld is routed through a
            // TypeSpec-parented MemberRef (the callback uses
            // ResolveFieldToken; the inline path below uses bare
            // FieldDefs which fail ilverify on a self-instantiation).
            if (!classSym.InstanceFieldInitializers.IsEmpty
                || ReflectionMetadataEmitter.IsUserGenericTypeReference(classSym))
            {
                bodyOffset = this.emitClassPrimaryConstructorBodyBytes(classSym, baseCtorToken);
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(baseCtorToken);

                // For each ctor param: this.<field> = arg; positional 1:1 with
                // fields of the same name.
                for (var i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];
                    if (!classSym.TryGetField(param.Name, out var field))
                    {
                        throw new InvalidOperationException($"Class '{classSym.Name}' has no field for primary ctor parameter '{param.Name}'.");
                    }

                    if (!this.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle))
                    {
                        throw new InvalidOperationException($"Class field '{field.Name}' has no emitted FieldDef.");
                    }

                    il.LoadArgument(0);
                    il.LoadArgument(i + 1);
                    il.OpCode(ILOpCode.Stfld);
                    il.Token(fieldHandle);
                }

                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in parameters)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #306: emits a constructor that forwards arguments to an explicit
    /// base constructor (<c>: Base(args)</c>) before initializing the class's
    /// own fields from the primary-constructor parameters. The base arguments
    /// are evaluated via a <c>BodyEmitter</c> so they may reference the
    /// primary-constructor parameters; the resolved base ctor token comes from
    /// the bound <see cref="BaseConstructorInitializer"/>.
    /// </summary>
    /// <param name="classSym">The class whose forwarding constructor is being emitted.</param>
    /// <param name="parameters">The constructor parameters (the primary-constructor parameters, or empty when the base arguments are constant).</param>
    /// <returns>The emitted constructor's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitClassConstructorWithBaseInitializer(StructSymbol classSym, ImmutableArray<ParameterSymbol> parameters)
    {
        var init = classSym.BaseConstructorInitializer;
        var baseCtorToken = this.GetBaseInitializerCtorToken(classSym, init);

        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.emitClassConstructorWithBaseInitializerBodyBytes(classSym, parameters, init, baseCtorToken);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in parameters)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type);
                    }
                });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #306: emits a class constructor materialized from an explicit
    /// <c>init(...)</c> declaration. The body first chains to the resolved base
    /// constructor (either the explicit <c>: base(args)</c> initializer or the
    /// conventional parameterless chain) and then runs the bound constructor
    /// body, which sees <c>this</c>, the constructor parameters, and the class's
    /// fields (as bare names).
    /// </summary>
    /// <param name="classSym">The class whose explicit constructor is being emitted.</param>
    /// <param name="ctor">The specific explicit ctor overload to emit. When <see langword="null"/> the legacy single-ctor entry on the class is used.</param>
    /// <returns>The emitted constructor's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitClassConstructorWithBody(StructSymbol classSym, ConstructorSymbol ctor = null)
    {
        ctor ??= classSym.ExplicitConstructor;
        var function = ctor.Function;
        var init = ctor.BaseInitializer;
        var baseCtorToken = init != null
            ? this.GetBaseInitializerCtorToken(classSym, init)
            : this.GetBaseCtorToken(classSym);

        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.emitClassConstructorWithBodyBodyBytes(classSym, ctor, init, baseCtorToken);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                function.Parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var p in function.Parameters)
                    {
                        // ADR-0060: ref-kind constructor parameters are encoded as
                        // managed pointers (`T&`). For `in`, also stamp the
                        // IsReadOnlyAttribute modreq.
                        var paramEncoder = ps.AddParameter();
                        if (p.RefKind == RefKind.In)
                        {
                            var isReadOnlyAttrType = this.wellKnown.GetIsReadOnlyAttributeTypeRef();
                            if (!isReadOnlyAttrType.IsNil)
                            {
                                paramEncoder.CustomModifiers().AddModifier(isReadOnlyAttrType, isOptional: false);
                            }
                        }

                        this.encodeTypeSymbol(paramEncoder.Type(isByRef: p.RefKind != RefKind.None), p.Type);
                    }
                });

        // ADR-0060: emit a Parameter row per source parameter so we can stamp
        // ParameterAttributes.In/Out and (for `in`) IsReadOnlyAttribute.
        var firstCtorParamHandle = this.nextParameterHandle();
        for (var pi = 0; pi < function.Parameters.Length; pi++)
        {
            var p = function.Parameters[pi];
            var paramAttributes = ParameterAttributes.None;
            if (p.RefKind == RefKind.Out)
            {
                paramAttributes |= ParameterAttributes.Out;
            }
            else if (p.RefKind == RefKind.In)
            {
                paramAttributes |= ParameterAttributes.In;
            }

            var paramHandle = this.emitCtx.Metadata.AddParameter(
                attributes: paramAttributes,
                name: this.emitCtx.Metadata.GetOrAddString(p.Name ?? string.Empty),
                sequenceNumber: pi + 1);

            if (p.RefKind == RefKind.In)
            {
                this.emitIsReadOnlyAttributeOnParameter(paramHandle);
            }
        }

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: firstCtorParamHandle);
    }

    /// <summary>
    /// ADR-0068 / issue #698: emits the synthesized <c>Finalize</c> override
    /// for a class that declares a <c>deinit { … }</c> body. The emitted
    /// method has signature <c>protected override void Finalize()</c>
    /// (<see cref="MethodAttributes.Family"/> | <see cref="MethodAttributes.Virtual"/>
    /// | <see cref="MethodAttributes.HideBySig"/>) and overrides the
    /// <c>Finalize</c> slot inherited from <c>System.Object</c> by
    /// name+signature match. The body bytes are produced by the injected
    /// <c>emitClassDeinitializerBodyBytes</c> delegate which wraps the user
    /// body in <c>try { … } finally { base.Finalize(); }</c> exactly as the
    /// C# compiler emits for <c>~Type()</c>.
    /// </summary>
    /// <param name="classSym">The class declaring the <c>deinit</c>.</param>
    /// <param name="deinit">The bound deinit symbol.</param>
    /// <param name="body">The lowered deinit body block.</param>
    /// <returns>The emitted method's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitClassDeinitializer(StructSymbol classSym, DeinitSymbol deinit, BoundBlockStatement body)
    {
        var baseFinalizeRef = this.wellKnown.GetObjectFinalizeRef();

        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            bodyOffset = this.emitClassDeinitializerBodyBytes(classSym, deinit, body, baseFinalizeRef);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Family | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Finalize"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Assembly-level synthesized default constructor used by synthesized
    /// closure / state-machine classes that have no user-authored ctor.
    /// </summary>
    /// <returns>The emitted constructor's MethodDef handle.</returns>
    public MethodDefinitionHandle EmitDefaultConstructor()
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.LoadArgument(0);
            il.Call(this.wellKnown.ObjectCtorRef);
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
        }

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
                | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    // Private helpers — exclusive to the methods above

    /// <summary>Resolves the <c>.ctor()</c> token a derived class's ctor should chain to: either the base class's default ctor (already emitted) or <see cref="WellKnownReferences.ObjectCtorRef"/>.</summary>
    private EntityHandle GetBaseCtorToken(StructSymbol classSym)
    {
        if (classSym.BaseClass != null && this.cache.ClassCtorHandles.TryGetValue(classSym.BaseClass, out var baseCtor))
        {
            return baseCtor;
        }

        if (classSym.IsAttributeClass)
        {
            // Phase 4 of #141 / ADR-0047 §5: chain to System.Attribute..ctor()
            // since the base type was overridden away from System.Object.
            return this.wellKnown.GetSystemAttributeCtorRef();
        }

        if (classSym.ImportedBaseType?.ClrType is Type importedBaseClr)
        {
            // Issue #296: chain the generated ctor to the imported CLR base's
            // accessible parameterless constructor.
            return this.GetImportedBaseDefaultCtorReference(importedBaseClr);
        }

        return this.wellKnown.ObjectCtorRef;
    }

    /// <summary>
    /// Issue #296: resolves a MemberRef to the imported CLR base class's
    /// accessible parameterless <c>.ctor()</c> for base-constructor chaining.
    /// Uses metadata-safe reflection (the declaring type is loaded under a
    /// MetadataLoadContext). Falls back to a synthesized parameterless ctor
    /// reference when no explicit parameterless ctor is discoverable.
    /// </summary>
    private EntityHandle GetImportedBaseDefaultCtorReference(Type importedBaseClr)
    {
        ConstructorInfo parameterless = null;
        foreach (var ctor in importedBaseClr.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (ctor.GetParameters().Length != 0)
            {
                continue;
            }

            if (ctor.IsPublic || ctor.IsFamily || ctor.IsFamilyOrAssembly)
            {
                parameterless = ctor;
                break;
            }
        }

        if (parameterless != null)
        {
            return this.getCtorReference(parameterless);
        }

        // No explicit accessible parameterless ctor was found; reference a
        // synthesized parameterless ctor signature on the base type ref. This
        // matches the implicit default ctor a base class would otherwise expose.
        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });
        return this.emitCtx.Metadata.AddMemberReference(
            parent: this.getTypeReference(importedBaseClr),
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>Issue #306: resolves the metadata token of the base constructor targeted by a <see cref="BaseConstructorInitializer"/>.</summary>
    private EntityHandle GetBaseInitializerCtorToken(StructSymbol classSym, BaseConstructorInitializer init)
    {
        if (init.IsClrBase)
        {
            return this.getCtorReference(init.ClrConstructor);
        }

        var gsharpBase = init.GSharpBaseType;
        if (init.Arguments.Length > 0
            && gsharpBase.HasPrimaryConstructor
            && this.cache.ClassPrimaryCtorHandles.TryGetValue(gsharpBase, out var primaryHandle))
        {
            return primaryHandle;
        }

        if (this.cache.ClassCtorHandles.TryGetValue(gsharpBase, out var defaultHandle))
        {
            return defaultHandle;
        }

        // Fall back to the conventional resolution (parameterless chain).
        return this.GetBaseCtorToken(classSym);
    }

    /// <summary>Emits <c>System.Runtime.CompilerServices.IsReadOnlyAttribute</c> on an inline struct TypeDef.</summary>
    /// <param name="typeHandle">The inline struct TypeDef handle.</param>
    private void EmitIsReadOnlyAttribute(TypeDefinitionHandle typeHandle)
    {
        var ctorRef = this.wellKnown.GetIsReadOnlyAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    /// <summary>
    /// Issue #367: emits the metadata that marks a user-declared <c>ref struct</c>
    /// TypeDef as by-ref-like, plus the legacy <c>Obsolete</c> attribute that
    /// instructs downstream C# compilers without ref-struct awareness to emit
    /// an error if such a struct is consumed as a normal value type.
    /// </summary>
    private void EmitIsByRefLikeAttribute(TypeDefinitionHandle typeHandle)
    {
        var ctorRef = this.wellKnown.GetIsByRefLikeAttributeCtorRef();

        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));

        var obsoleteCtorRef = this.wellKnown.GetObsoleteAttributeStringBoolCtorRef();

        var obsoleteBlob = new BlobBuilder();
        obsoleteBlob.WriteUInt16(0x0001);
        obsoleteBlob.WriteSerializedString("Types with embedded references are not supported in this version of your compiler.");
        obsoleteBlob.WriteByte(1);
        obsoleteBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: typeHandle,
            constructor: obsoleteCtorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(obsoleteBlob));
    }

    /// <summary>
    /// ADR-0087 §3 R1: emits one <c>GenericParam</c> row per supplied
    /// type parameter, in source order, owned by <paramref name="owner"/>
    /// (which may be a <see cref="TypeDefinitionHandle"/> for a generic
    /// type or a <see cref="MethodDefinitionHandle"/> for a generic method).
    /// </summary>
    /// <param name="emitCtx">The emit context whose pending-generic-parameter buffer the rows are queued into.</param>
    /// <param name="owner">The owning TypeDef or MethodDef handle.</param>
    /// <param name="typeParameters">The type parameters to emit.</param>
    /// <remarks>
    /// The rows are queued — not added inline — because ECMA-335 II.22.20 requires
    /// the <c>GenericParam</c> table sorted by (Owner, Number). Because TypeDefs
    /// and MethodDefs are emitted in interleaved visit orders, inline emission
    /// is guaranteed to violate the sort invariant on multi-generic samples.
    /// <see cref="FlushPendingGenericParameters"/> sorts and adds them at the end.
    /// </remarks>
    internal static void EmitGenericParamRows(
        EmitContext emitCtx,
        EntityHandle owner,
        ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return;
        }

        for (var i = 0; i < typeParameters.Length; i++)
        {
            var tp = typeParameters[i];
            var attrs = GenericParameterAttributes.None;
            if (tp.Variance == TypeParameterVariance.In)
            {
                attrs |= GenericParameterAttributes.Contravariant;
            }
            else if (tp.Variance == TypeParameterVariance.Out)
            {
                attrs |= GenericParameterAttributes.Covariant;
            }

            // ADR-0097 / issue #775: project G# `class` / `struct` / `new()`
            // constraints onto the matching CLR GenericParam flag bits.
            // ECMA-335 II.10.1.7 mandates that the value-type constraint
            // implies the default-constructor constraint — the emitter
            // forces both bits whenever `struct` is set.
            if (tp.HasReferenceTypeConstraint)
            {
                attrs |= GenericParameterAttributes.ReferenceTypeConstraint;
            }

            if (tp.HasValueTypeConstraint)
            {
                attrs |= GenericParameterAttributes.NotNullableValueTypeConstraint;
                attrs |= GenericParameterAttributes.DefaultConstructorConstraint;
            }
            else if (tp.HasDefaultConstructorConstraint)
            {
                attrs |= GenericParameterAttributes.DefaultConstructorConstraint;
            }

            emitCtx.PendingGenericParameters.Add(new PendingGenericParameter(
                Owner: owner,
                Attributes: attrs,
                Name: tp.Name,
                Index: (ushort)i));
        }
    }

    /// <summary>
    /// ADR-0087 §3 R1: flushes deferred <c>GenericParam</c> rows in
    /// (Owner-coded-index, Number) order. The TypeOrMethodDef coded index
    /// uses bit 0 as tag (0=TypeDef, 1=MethodDef); the upper bits are the row id.
    /// </summary>
    /// <param name="emitCtx">The emit context whose pending rows are flushed.</param>
    internal static void FlushPendingGenericParameters(EmitContext emitCtx)
    {
        var pending = emitCtx.PendingGenericParameters;
        if (pending.Count == 0)
        {
            return;
        }

        pending.Sort((a, b) =>
        {
            int ka = EncodeTypeOrMethodDefCodedIndex(a.Owner);
            int kb = EncodeTypeOrMethodDefCodedIndex(b.Owner);
            if (ka != kb)
            {
                return ka.CompareTo(kb);
            }

            return a.Index.CompareTo(b.Index);
        });

        var metadata = emitCtx.Metadata;
        for (int i = 0; i < pending.Count; i++)
        {
            var row = pending[i];
            metadata.AddGenericParameter(
                parent: row.Owner,
                attributes: row.Attributes,
                name: metadata.GetOrAddString(row.Name),
                index: row.Index);
        }

        pending.Clear();
    }

    private static int EncodeTypeOrMethodDefCodedIndex(EntityHandle owner)
    {
        // ECMA-335 II.24.2.6: TypeOrMethodDef coded index uses tag bit 0.
        // TypeDef tag = 0, MethodDef tag = 1.
        int rowId = MetadataTokens.GetRowNumber(owner);
        int tag = owner.Kind == HandleKind.TypeDefinition ? 0 : 1;
        return (rowId << 1) | tag;
    }

    /// <summary>
    /// ADR-0087 §3 R1: per ECMA-335 II.10.3.1 a generic TypeDef's name carries
    /// the backtick-arity suffix so reflection round-trips <c>Box</c> as
    /// <c>Box`1</c>. Non-generic types keep their bare name.
    /// </summary>
    /// <param name="name">The unmangled symbol name (e.g. <c>Box</c>).</param>
    /// <param name="typeParameters">The type parameters declared on the type.</param>
    /// <returns>The mangled metadata name (e.g. <c>Box`1</c>) or <paramref name="name"/> when the type is non-generic.</returns>
    internal static string MangleGenericName(string name, ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return name;
        }

        return name + "`" + typeParameters.Length.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// ADR-0093 §5: resolves the <see cref="TypeAttributes"/> layout flag
    /// for a user struct. Defaults to <see cref="TypeAttributes.SequentialLayout"/>
    /// when no <c>@StructLayout(LayoutKind.…)</c> annotation is present —
    /// the historical struct layout. When the annotation requests
    /// <see cref="System.Runtime.InteropServices.LayoutKind.Explicit"/>,
    /// the emitter writes the matching <see cref="TypeAttributes.ExplicitLayout"/>
    /// flag instead so the runtime honours the per-field
    /// <see cref="MetadataBuilder.AddFieldLayout"/> rows.
    /// </summary>
    /// <param name="structSym">The struct symbol being emitted.</param>
    /// <returns>The chosen layout flag.</returns>
    internal static TypeAttributes ResolveStructLayoutFlag(StructSymbol structSym)
    {
        var meta = structSym.LayoutMetadata;
        if (meta == null)
        {
            return TypeAttributes.SequentialLayout;
        }

        return meta.Layout switch
        {
            System.Runtime.InteropServices.LayoutKind.Explicit => TypeAttributes.ExplicitLayout,
            System.Runtime.InteropServices.LayoutKind.Auto => TypeAttributes.AutoLayout,
            _ => TypeAttributes.SequentialLayout,
        };
    }

    /// <summary>
    /// ADR-0093 §5: resolves the <see cref="TypeAttributes"/> layout flag
    /// for a user class. Defaults to <see cref="TypeAttributes.AutoLayout"/>
    /// when no <c>@StructLayout(LayoutKind.…)</c> annotation is present —
    /// the historical class layout and the C# default. When the annotation
    /// is supplied, the chosen layout flag matches the requested
    /// <see cref="System.Runtime.InteropServices.LayoutKind"/> so the class
    /// can participate in P/Invoke as a by-reference parameter.
    /// </summary>
    /// <param name="structSym">The class symbol being emitted.</param>
    /// <returns>The chosen layout flag.</returns>
    internal static TypeAttributes ResolveClassLayoutFlag(StructSymbol structSym)
    {
        var meta = structSym.LayoutMetadata;
        if (meta == null)
        {
            return TypeAttributes.AutoLayout;
        }

        return meta.Layout switch
        {
            System.Runtime.InteropServices.LayoutKind.Explicit => TypeAttributes.ExplicitLayout,
            System.Runtime.InteropServices.LayoutKind.Sequential => TypeAttributes.SequentialLayout,
            _ => TypeAttributes.AutoLayout,
        };
    }

    /// <summary>
    /// ADR-0093 §5: writes the optional ClassLayout row for a type that
    /// carries an explicit <c>Pack</c> or <c>Size</c> on its
    /// <c>@StructLayout(LayoutKind.…)</c> annotation. A null
    /// <paramref name="metadata"/> or one with both fields unset produces
    /// no ClassLayout row — the runtime defaults apply.
    /// </summary>
    /// <param name="emitCtx">The current emit context.</param>
    /// <param name="typeDefHandle">The TypeDef handle the layout applies to.</param>
    /// <param name="metadata">The resolved layout metadata, or <c>null</c>.</param>
    internal static void EmitClassLayout(EmitContext emitCtx, TypeDefinitionHandle typeDefHandle, StructLayoutMetadata metadata)
    {
        if (metadata == null)
        {
            return;
        }

        if (!metadata.Pack.HasValue && !metadata.Size.HasValue)
        {
            return;
        }

        emitCtx.Metadata.AddTypeLayout(
            type: typeDefHandle,
            packingSize: (ushort)(metadata.Pack ?? 0),
            size: (uint)(metadata.Size ?? 0));
    }
}
