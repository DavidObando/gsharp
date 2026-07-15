// <copyright file="MemberDefEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by feature: each public entry point is followed by its own private helpers — instance-property group, static-property group, instance-event group, static-event group, interface group)

using System;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// IL emission for property and event accessor MethodDefs, plus the
/// PropertyDef/EventDef/PropertyMap/EventMap/MethodSemantics rows that
/// link them to their owning TypeDef. Covers instance, static, and
/// interface variants for both properties and events.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-7 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level <c>private</c> on
/// <see cref="ReflectionMetadataEmitter"/> (none lived inside the nested
/// <c>BodyEmitter</c>), so this extraction is a clean Option-A move with
/// no BodyEmitter seam issues like PR-E-5 had with the conversion
/// methods. The methods moved are:
/// </para>
/// <list type="bullet">
/// <item><c>EmitPropertyAccessors</c> / <c>EmitPropertyGetter</c> / <c>EmitPropertySetter</c></item>
/// <item><c>EmitStaticPropertyAccessors</c> / <c>EmitStaticPropertyGetter</c> / <c>EmitStaticPropertySetter</c></item>
/// <item><c>EmitEventAccessors</c> / <c>EmitEventAddAccessor</c> / <c>EmitEventRemoveAccessor</c> / <c>EmitEventRaiseAccessor</c></item>
/// <item><c>EmitStaticEventAccessors</c> / <c>EmitStaticEventAddAccessor</c> / <c>EmitStaticEventRemoveAccessor</c></item>
/// <item><c>EmitInterfacePropertyAccessors</c> / <c>EmitInterfaceEventAccessors</c></item>
/// </list>
/// <para>
/// Plus four private helpers used exclusively by the methods above:
/// </para>
/// <list type="bullet">
/// <item><c>PropertyImplicitlyImplementsInterface</c> — virtual-slot promotion check for issue #248 / #525</item>
/// <item><c>EventImplicitlyImplementsInterface</c> — same, for ADR-0052 event accessors</item>
/// <item><c>GetEventTypeHandle</c> — resolves the EntityHandle for an event handler type</item>
/// <item><c>GetInterlockedCompareExchangeSpec</c> — MethodSpec for the CAS loop in field-like add/remove (issue #256)</item>
/// </list>
/// <para>
/// Like every other PR-E-* component, <c>MemberDefEmitter</c> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> as its peers, plus delegate
/// callbacks bound to the remaining <see cref="ReflectionMetadataEmitter"/>
/// helpers it depends on (<c>EmitFunction</c>, <c>EncodeTypeSymbol</c>,
/// <c>NextParameterHandle</c>, <c>GetTypeReference</c>,
/// <c>GetTypeHandleForMember</c>). The callbacks mirror the pattern
/// PR-E-4 <see cref="SlotPlanner"/>, PR-E-5 <see cref="ConversionEmitter"/>,
/// and PR-E-6 <see cref="DataStructSynthesizer"/> established to avoid
/// hard back-references to the root emitter.
/// </para>
/// <para>
/// The shared <see cref="MetadataTokenCache.PropertyAccessorHandles"/>,
/// <see cref="MetadataTokenCache.EventAccessorHandles"/>, and
/// <see cref="MetadataTokenCache.TypesWithPropertyMap"/> collections stay
/// on the cache, not on this component, so future consumers (e.g.
/// TypeDefEmitter in PR-E-8) can keep reading them without needing a
/// reference to <c>MemberDefEmitter</c>.
/// </para>
/// </remarks>
internal sealed class MemberDefEmitter
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
    private readonly Func<FunctionSymbol, BoundBlockStatement, bool, MethodDefinitionHandle> emitFunction;
    private readonly Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol;
    private readonly Func<ParameterHandle> nextParameterHandle;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<Type, EntityHandle> getTypeHandleForMember;
    private readonly Func<StructSymbol, FieldSymbol, EntityHandle> resolveFieldToken;
    private readonly Action<PropertyDefinitionHandle, TypeSymbol> emitNullableAttributeOnProperty;
    private readonly Action<EntityHandle, Symbol, AttributeTargetKind> emitUserAttributes;

    public MemberDefEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        Func<FunctionSymbol, BoundBlockStatement, bool, MethodDefinitionHandle> emitFunction,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol,
        Func<ParameterHandle> nextParameterHandle,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<Type, EntityHandle> getTypeHandleForMember,
        Func<StructSymbol, FieldSymbol, EntityHandle> resolveFieldToken,
        Action<PropertyDefinitionHandle, TypeSymbol> emitNullableAttributeOnProperty,
        Action<EntityHandle, Symbol, AttributeTargetKind> emitUserAttributes)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.emitFunction = emitFunction ?? throw new ArgumentNullException(nameof(emitFunction));
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw new ArgumentNullException(nameof(encodeTypeSymbol));
        this.nextParameterHandle = nextParameterHandle ?? throw new ArgumentNullException(nameof(nextParameterHandle));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw new ArgumentNullException(nameof(getTypeHandleForMember));
        this.resolveFieldToken = resolveFieldToken ?? throw new ArgumentNullException(nameof(resolveFieldToken));
        this.emitNullableAttributeOnProperty = emitNullableAttributeOnProperty ?? throw new ArgumentNullException(nameof(emitNullableAttributeOnProperty));
        this.emitUserAttributes = emitUserAttributes ?? throw new ArgumentNullException(nameof(emitUserAttributes));
    }

    public void EmitPropertyAccessors(StructSymbol structSym)
    {
        if (structSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in structSym.Properties)
        {
            if (!this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                emittedGetter = this.EmitPropertyGetter(structSym, prop);
            }

            // Emit setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                emittedSetter = this.EmitPropertySetter(structSym, prop);
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            if (prop.IsIndexer && !prop.Parameters.IsDefaultOrEmpty)
            {
                // ADR-0118 / issue #944: a CLR default indexer property carries
                // its index parameter types in the PropertyDef signature.
                var indexParams = prop.Parameters;
                new BlobEncoder(propertySignature)
                    .PropertySignature(isInstanceProperty: true)
                    .Parameters(
                        indexParams.Length,
                        returnType => this.encodeTypeSymbol(returnType.Type(), prop.Type),
                        parameters =>
                        {
                            foreach (var indexParam in indexParams)
                            {
                                this.encodeTypeSymbol(parameters.AddParameter().Type(), indexParam.Type);
                            }
                        });
            }
            else
            {
                new BlobEncoder(propertySignature)
                    .PropertySignature(isInstanceProperty: true)
                    .Parameters(0, returnType => this.encodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });
            }

            var propDef = this.emitCtx.Metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(
                    prop.HasExplicitInterfaceClause
                        ? ExplicitInterfaceMetadataNaming.GetMetadataName(prop.Name, prop.ExplicitInterfaceClauseTarget)
                        : prop.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }

            this.emitNullableAttributeOnProperty(propDef, prop.Type);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property);
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if (!firstPropDef.IsNil)
        {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.cache.TypesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// Emits a property accessor's method body, shared by all four property
    /// accessor copies (instance/static × get/set). Returns a fully-emitted
    /// computed-accessor MethodDef when the accessor has a bound body (the
    /// caller returns it directly), otherwise a body offset for the
    /// auto-property or NotImplementedException fallback body. The issue #989
    /// self-TypeSpec backing-field token handling lives here in exactly one
    /// place so it can no longer drift between the copies.
    /// </summary>
    /// <param name="structSym">The owning type whose accessor is emitted.</param>
    /// <param name="prop">The property whose accessor body is emitted.</param>
    /// <param name="isStatic"><see langword="true"/> for a static accessor.</param>
    /// <param name="isGetter"><see langword="true"/> for a getter, <see langword="false"/> for a setter.</param>
    /// <returns>
    /// A tuple: <c>Computed</c> is the handle of a fully-emitted computed
    /// accessor (return it directly) or <see langword="null"/>; <c>BodyOffset</c>
    /// is the method-body offset for the auto/fallback body, or <c>-1</c>.
    /// </returns>
    private (MethodDefinitionHandle? Computed, int BodyOffset) EmitPropertyAccessorBody(
        StructSymbol structSym, PropertySymbol prop, bool isStatic, bool isGetter)
    {
        if (this.emitCtx.MetadataOnly)
        {
            return (null, -1);
        }

        if (prop.IsAutoProperty && prop.BackingField != null
            && this.cache.StructFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
        {
            // Issue #989: inside a generic type's own accessor body the
            // backing-field token must be a self-TypeSpec MemberRef
            // (Box`1<!0>), not the bare FieldDef, or the verifier rejects
            // the receiver type on the stack.
            var backingToken = ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
                ? this.resolveFieldToken(structSym, prop.BackingField)
                : (EntityHandle)backingHandle;
            var il = new InstructionEncoder(new BlobBuilder());
            if (isGetter)
            {
                if (!isStatic)
                {
                    il.LoadArgument(0);
                }

                il.OpCode(isStatic ? ILOpCode.Ldsfld : ILOpCode.Ldfld);
            }
            else
            {
                if (!isStatic)
                {
                    il.LoadArgument(0);
                }

                il.LoadArgument(isStatic ? 0 : 1);
                il.OpCode(isStatic ? ILOpCode.Stsfld : ILOpCode.Stfld);
            }

            il.Token(backingToken);
            il.OpCode(ILOpCode.Ret);
            return (null, this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il)));
        }

        var accessorSymbol = isGetter ? prop.GetterSymbol : prop.SetterSymbol;
        if (accessorSymbol != null && this.emitCtx.Program.Functions.TryGetValue(accessorSymbol, out var body))
        {
            // Computed property with bound body: emit using EmitFunction infrastructure.
            return (this.emitFunction(accessorSymbol, body, false), -1);
        }

        // Fallback: throw new NotImplementedException().
        var nieIl = new InstructionEncoder(new BlobBuilder());
        var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
        nieIl.OpCode(ILOpCode.Newobj);
        nieIl.Token(nieCtor);
        nieIl.OpCode(ILOpCode.Throw);
        return (null, this.emitCtx.MethodBodyStream.AddMethodBody(nieIl, maxStack: MaxStackTracker.ComputeMaxStack(nieIl)));
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits a getter accessor MethodDef (get_PropertyName).
    /// For auto-properties: ldarg.0, ldfld backing, ret.
    /// For computed properties: emits the bound getter body IL.
    /// </summary>
    private MethodDefinitionHandle EmitPropertyGetter(StructSymbol structSym, PropertySymbol prop)
    {
        var (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: false, isGetter: true);
        if (computed.HasValue)
        {
            return computed.Value;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => this.encodeTypeSymbol(r.Type(), prop.Type), _ => { });

        // ADR-0149: an explicit-interface qualifier clause property (whether
        // an auto-property, reaching this fallback path, or an indexer,
        // which always has a computed body and so never reaches this path)
        // is ALWAYS private in CLR metadata — see the matching remark on
        // ReflectionMetadataEmitter.EmitFunction's effectiveAccessibility.
        var methodAttrs = (prop.HasExplicitInterfaceClause ? MethodAttributes.Private : MethodAttributes.Public)
            | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (prop.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.PropertyImplicitlyImplementsInterface(structSym, prop))
        {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.ExplicitInterfaceMember != null)
        {
            // Issue #2362: a mangled-name explicit interface property
            // implementation is bound to its interface slot purely via an
            // explicit MethodImpl row (see
            // EmitExplicitInterfacePropertyMethodImpls) — its accessor's own
            // name never matches the interface member's name, so
            // PropertyImplicitlyImplementsInterface (a name-based check)
            // never fires for it. Per ECMA-335 §II.10.3.3, a MethodImpl body
            // method must be virtual; Final additionally prevents a derived
            // class from accidentally overriding this synthetic accessor by
            // name (it has no natural override point, exactly like the
            // #2010 mangled explicit method convention's own methods, which
            // get Virtual | NewSlot | Final unconditionally via EmitFunction).
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
        }

        // ADR-0149: a property declared with an explicit-interface qualifier
        // clause needs a collision-free metadata name for its getter, same
        // rationale as ExplicitInterfaceMetadataNaming's remarks (two
        // explicit implementations sharing a plain property name would
        // otherwise also share the identical "get_Name" accessor name).
        var getterName = prop.HasExplicitInterfaceClause
            ? "get_" + ExplicitInterfaceMetadataNaming.GetMetadataName(prop.Name, prop.ExplicitInterfaceClauseTarget)
            : $"get_{prop.Name}";

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(getterName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits a setter accessor MethodDef (set_PropertyName).
    /// For auto-properties: ldarg.0, ldarg.1, stfld backing, ret.
    /// For computed properties: emits the bound setter body IL.
    /// </summary>
    private MethodDefinitionHandle EmitPropertySetter(StructSymbol structSym, PropertySymbol prop)
    {
        var (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: false, isGetter: false);
        if (computed.HasValue)
        {
            return computed.Value;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(
                1,
                r =>
                {
                    // Issue #946: an `init`-only setter encodes its void return
                    // with modreq(System.Runtime.CompilerServices.IsExternalInit),
                    // exactly as a C# 9 init-only setter does. This is how the
                    // CLR and peer compilers recognize the accessor as init-only.
                    if (prop.IsInitOnly)
                    {
                        var isExternalInit = this.wellKnown.GetIsExternalInitTypeRef();
                        if (!isExternalInit.IsNil)
                        {
                            r.CustomModifiers().AddModifier(isExternalInit, isOptional: false);
                        }
                    }

                    r.Void();
                },
                ps => this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type));

        // ADR-0149: see the matching visibility comment in EmitPropertyGetter
        // — an explicit-interface qualifier clause property is always
        // private in CLR metadata.
        var methodAttrs = (prop.HasExplicitInterfaceClause ? MethodAttributes.Private : MethodAttributes.Public)
            | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (prop.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.PropertyImplicitlyImplementsInterface(structSym, prop))
        {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (prop.ExplicitInterfaceMember != null)
        {
            // Issue #2362: see the matching comment in EmitPropertyGetter —
            // the setter half of a mangled-name explicit interface property
            // implementation needs the same Virtual | NewSlot | Final promotion
            // so its MethodImpl row (emitted separately) is ECMA-335-valid.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
        }

        // Emit a Parameter row for "value" so the setter has a named parameter.
        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString(prop.SetterParameterName ?? "value"),
            sequenceNumber: 1);

        // ADR-0149: see the matching comment in EmitPropertyGetter.
        var setterName = prop.HasExplicitInterfaceClause
            ? "set_" + ExplicitInterfaceMetadataNaming.GetMetadataName(prop.Name, prop.ExplicitInterfaceClauseTarget)
            : $"set_{prop.Name}";

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(setterName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for static properties declared in a shared block.
    /// </summary>
    /// <param name="structSym">The owning struct or class symbol whose static properties are emitted.</param>
    public void EmitStaticPropertyAccessors(StructSymbol structSym)
    {
        if (structSym.StaticProperties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in structSym.StaticProperties)
        {
            if (!this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                emittedGetter = this.EmitStaticPropertyGetter(structSym, prop);
            }

            // Emit setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                emittedSetter = this.EmitStaticPropertySetter(structSym, prop);
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            new BlobEncoder(propertySignature)
                .PropertySignature(isInstanceProperty: false)
                .Parameters(0, returnType => this.encodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });

            var propDef = this.emitCtx.Metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(prop.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }

            this.emitNullableAttributeOnProperty(propDef, prop.Type);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property);
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        // Issue #418 (P1-7): only add a PropertyMap here if the instance-property
        // emission path (EmitPropertyAccessors) didn't already add one. Using
        // structSym.Properties.IsDefaultOrEmpty was incorrect — instance properties
        // may be declared but all skipped during emission (e.g., computed property
        // whose getter symbol has no entry in program.Functions), leaving no
        // PropertyMap. Without this row the static PropertyDef rows would be
        // orphaned and violate ECMA-335 §II.22.35.
        if (!firstPropDef.IsNil && !this.cache.TypesWithPropertyMap.Contains(typeDefHandle))
        {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.cache.TypesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// Issue #263: emits a static getter accessor MethodDef (get_PropertyName).
    /// </summary>
    private MethodDefinitionHandle EmitStaticPropertyGetter(StructSymbol structSym, PropertySymbol prop)
    {
        var (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: true, isGetter: true);
        if (computed.HasValue)
        {
            return computed.Value;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(0, r => this.encodeTypeSymbol(r.Type(), prop.Type), _ => { });

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"get_{prop.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #263: emits a static setter accessor MethodDef (set_PropertyName).
    /// </summary>
    private MethodDefinitionHandle EmitStaticPropertySetter(StructSymbol structSym, PropertySymbol prop)
    {
        var (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: true, isGetter: false);
        if (computed.HasValue)
        {
            return computed.Value;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString(prop.SetterParameterName ?? "value"),
            sequenceNumber: 1);

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"set_{prop.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for static events declared in a shared block.
    /// </summary>
    /// <param name="structSym">The owning struct or class symbol whose static events are emitted.</param>
    public void EmitStaticEventAccessors(StructSymbol structSym)
    {
        if (structSym.StaticEvents.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in structSym.StaticEvents)
        {
            if (!this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit add_X MethodDef.
            var addMethod = this.EmitStaticEventAddAccessor(structSym, ev);

            // Emit remove_X MethodDef.
            var removeMethod = this.EmitStaticEventRemoveAccessor(structSym, ev);

            // Issue #257: emit raise_X MethodDef if present.
            MethodDefinitionHandle? raiseMethod = null;
            if (ev.RaiseMethodSymbol != null)
            {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: true);
            }

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.emitCtx.Metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod);
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod);
            if (raiseMethod.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod.Value);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        // Only add if no instance events already created an EventMap for this type.
        if (!firstEventDef.IsNil && structSym.Events.IsDefaultOrEmpty)
        {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }

    /// <summary>
    /// Issue #263: emits a static add_X accessor MethodDef for a static event.
    /// </summary>
    private MethodDefinitionHandle EmitStaticEventAddAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: true, isAdd: true);
            }
            else if (ev.AddMethodSymbol != null && this.emitCtx.Program.Functions.TryGetValue(ev.AddMethodSymbol, out var addBody))
            {
                var handle = this.emitFunction(ev.AddMethodSymbol, addBody, false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"add_{ev.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #263: emits a static remove_X accessor MethodDef for a static event.
    /// </summary>
    private MethodDefinitionHandle EmitStaticEventRemoveAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: true, isAdd: false);
            }
            else if (ev.RemoveMethodSymbol != null && this.emitCtx.Program.Functions.TryGetValue(ev.RemoveMethodSymbol, out var removeBody))
            {
                var handle = this.emitFunction(ev.RemoveMethodSymbol, removeBody, false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static;

        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"remove_{ev.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #248: determines whether a property on a class/struct implicitly implements
    /// an interface property (same name and type on any implemented interface).
    /// </summary>
    private bool PropertyImplicitlyImplementsInterface(StructSymbol structSym, PropertySymbol prop)
    {
        if (!structSym.Interfaces.IsDefaultOrEmpty)
        {
            foreach (var iface in structSym.Interfaces)
            {
                if (iface.Properties.IsDefaultOrEmpty)
                {
                    continue;
                }

                foreach (var ifaceProp in iface.Properties)
                {
                    if (ifaceProp.Name == prop.Name)
                    {
                        return true;
                    }
                }
            }
        }

        // Issue #525: imported CLR interfaces from the base-type clause also
        // trigger the implicit-implementation virtual-slot promotion.
        if (!structSym.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            var propClr = prop.Type?.ClrType;
            foreach (var ifaceSym in structSym.ImplementedClrInterfaces)
            {
                var clrIface = ifaceSym?.ClrType;
                if (clrIface == null)
                {
                    continue;
                }

                foreach (var clrProp in clrIface.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (clrProp.Name == prop.Name && (propClr == null || ClrTypeUtilities.AreSame(propClr, clrProp.PropertyType)))
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0052: determines whether an event on a class/struct implicitly implements
    /// an interface event (same name on any implemented interface).
    /// </summary>
    private bool EventImplicitlyImplementsInterface(StructSymbol structSym, EventSymbol ev)
    {
        if (structSym.Interfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var iface in structSym.Interfaces)
        {
            if (iface.Events.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ifaceEvent in iface.Events)
            {
                if (ifaceEvent.Name == ev.Name)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0052: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on a type.
    /// </summary>
    /// <param name="structSym">The owning struct or class symbol whose instance events are emitted.</param>
    public void EmitEventAccessors(StructSymbol structSym)
    {
        if (structSym.Events.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in structSym.Events)
        {
            if (!this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit add_X MethodDef.
            var addMethod = this.EmitEventAddAccessor(structSym, ev);

            // Emit remove_X MethodDef.
            var removeMethod = this.EmitEventRemoveAccessor(structSym, ev);

            // Issue #257: emit raise_X MethodDef if present.
            MethodDefinitionHandle? raiseMethod = null;
            if (ev.RaiseMethodSymbol != null)
            {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: false);
            }

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.emitCtx.Metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod);
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod);
            if (raiseMethod.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod.Value);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        if (!firstEventDef.IsNil)
        {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }

    /// <summary>
    /// ADR-0052: resolves the EntityHandle for the event handler type used in the EventDef row.
    /// </summary>
    private EntityHandle GetEventTypeHandle(TypeSymbol type)
    {
        if (type is FunctionTypeSymbol fnType)
        {
            var clrType = fnType.ClrType;
            if (clrType != null)
            {
                return this.getTypeHandleForMember(clrType);
            }

            // Issue #1473: a function-type delegate whose closed type arguments include a
            // user-declared type has no runtime CLR Type, so ClrType is null. Build the concrete
            // closed delegate (Action`n / Func`n) TypeSpec via the same encodeTypeSymbol machinery
            // used by the backing-field signature and Interlocked.CompareExchange<T> spec, so the
            // EventDef type and the accessor-body castclass token agree with the CAS loop.
            return this.GetEventTypeSpecHandle(type);
        }

        // Issue #2066: a user-declared named delegate (`type X = delegate
        // func(...) ...`) has no runtime CLR Type — its TypeDef only exists
        // in the assembly being emitted — so the `type.ClrType != null`
        // branch below can't reach it and this previously fell through to
        // the "encode as System.Delegate" fallback. That token mismatched
        // the CAS-loop locals (typed as the named delegate itself), failing
        // IL verification on the generated add_/remove_ accessor bodies.
        // Route it through the same TypeSpec machinery the FunctionTypeSymbol
        // branch above uses (valid for both non-generic and constructed
        // generic named delegates).
        if (type is DelegateTypeSymbol)
        {
            return this.GetEventTypeSpecHandle(type);
        }

        if (type.ClrType != null)
        {
            return this.getTypeHandleForMember(type.ClrType);
        }

        if (type is StructSymbol structSym && this.cache.StructTypeDefs.TryGetValue(structSym, out var td))
        {
            return td;
        }

        if (type is InterfaceSymbol ifaceSym && this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var ifaceDef))
        {
            return ifaceDef;
        }

        // Fallback: encode as System.Delegate.
        return this.getTypeReference(typeof(System.Delegate));
    }

    /// <summary>
    /// Issue #1473: encodes the event handler type symbol into a TypeSpec EntityHandle, used when
    /// the type has no runtime CLR <see cref="Type"/> (e.g. a function-type delegate closed over a
    /// user-declared type argument). Mirrors the TypeSpec machinery in
    /// <see cref="GetInterlockedCompareExchangeSpec"/> and the backing-field signature.
    /// </summary>
    private EntityHandle GetEventTypeSpecHandle(TypeSymbol type)
    {
        var sigBlob = new BlobBuilder();
        this.encodeTypeSymbol(new BlobEncoder(sigBlob).TypeSpecificationSignature(), type);
        return this.emitCtx.Metadata.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #1611: emits the thread-safe CAS-loop body shared by the instance/static
    /// add/remove event accessors. Resolves the backing-field token through
    /// <see cref="resolveFieldToken"/> when the owning type is a generic type (mirrors
    /// the property fix for issue #989) so the emitted tokens are valid self-TypeSpec
    /// MemberRefs instead of bare FieldDefs on a generic type.
    /// </summary>
    /// <param name="structSym">The struct/class declaring the event.</param>
    /// <param name="ev">The field-like event being emitted.</param>
    /// <param name="backingHandle">The FieldDef handle for the backing field.</param>
    /// <param name="isStatic">Whether the accessor is static (ldsfld/ldsflda vs ldfld/ldflda, no `this`).</param>
    /// <param name="isAdd">Whether this is the add accessor (Delegate.Combine) or remove (Delegate.Remove).</param>
    private int EmitEventCasLoopBody(StructSymbol structSym, EventSymbol ev, FieldDefinitionHandle backingHandle, bool isStatic, bool isAdd)
    {
        var backingToken = ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
            ? this.resolveFieldToken(structSym, ev.BackingField)
            : (EntityHandle)backingHandle;

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

        // Static accessors have no `this`; the value parameter is argument 0 instead of 1.
        var valueArgIndex = isStatic ? 0 : 1;

        // load backingField; stloc.0
        if (!isStatic)
        {
            il.LoadArgument(0);
        }

        il.OpCode(isStatic ? ILOpCode.Ldsfld : ILOpCode.Ldfld);
        il.Token(backingToken);
        il.OpCode(ILOpCode.Stloc_0);

        // loop_start:
        var loopStart = il.DefineLabel();
        il.MarkLabel(loopStart);

        // ldloc.0; stloc.1
        il.OpCode(ILOpCode.Ldloc_0);
        il.OpCode(ILOpCode.Stloc_1);

        // ldloc.1; ldarg value; call Delegate.Combine/Remove; castclass T; stloc.2
        il.OpCode(ILOpCode.Ldloc_1);
        il.LoadArgument(valueArgIndex);
        il.OpCode(ILOpCode.Call);
        il.Token(isAdd ? this.wellKnown.GetDelegateCombineRef() : this.wellKnown.GetDelegateRemoveRef());
        il.OpCode(ILOpCode.Castclass);
        il.Token(eventTypeHandle);
        il.OpCode(ILOpCode.Stloc_2);

        // load backingField address; ldloc.2; ldloc.1
        if (!isStatic)
        {
            il.LoadArgument(0);
        }

        il.OpCode(isStatic ? ILOpCode.Ldsflda : ILOpCode.Ldflda);
        il.Token(backingToken);
        il.OpCode(ILOpCode.Ldloc_2);
        il.OpCode(ILOpCode.Ldloc_1);

        // call Interlocked.CompareExchange<T>; stloc.0
        il.OpCode(ILOpCode.Call);
        il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type));
        il.OpCode(ILOpCode.Stloc_0);

        // ldloc.0; ldloc.1; bne.un.s loop_start
        il.OpCode(ILOpCode.Ldloc_0);
        il.OpCode(ILOpCode.Ldloc_1);
        il.Branch(ILOpCode.Bne_un_s, loopStart);

        il.OpCode(ILOpCode.Ret);

        var localsSigBlob = new BlobBuilder();
        var localsEncoder = new BlobEncoder(localsSigBlob).LocalVariableSignature(3);
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type);
        var localsSignature = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob));

        return this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
    }

    /// <summary>
    /// ADR-0052: emits the add_X accessor MethodDef for an event.
    /// </summary>
    private MethodDefinitionHandle EmitEventAddAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: false, isAdd: true);
            }
            else if (ev.AddMethodSymbol != null && this.emitCtx.Program.Functions.TryGetValue(ev.AddMethodSymbol, out var addBody))
            {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                var handle = this.emitFunction(ev.AddMethodSymbol, addBody, false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        // ADR-0149: an explicit-interface qualifier clause field-like event's
        // add_ accessor is always private in CLR metadata (mirrors the
        // property getter/setter fix above); a custom (non-field-like)
        // explicit event's add accessor instead returns early above via
        // EmitFunction, whose own effectiveAccessibility already enforces
        // this, so this fallback only needs to cover the field-like case.
        var methodAttrs = (ev.HasExplicitInterfaceClause ? MethodAttributes.Private : MethodAttributes.Public)
            | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.EventImplicitlyImplementsInterface(structSym, ev))
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.ExplicitInterfaceMember != null)
        {
            // ADR-0149: mirrors the property MethodImpl-bridge promotion —
            // a MethodImpl body method must be Virtual per ECMA-335 §II.10.3.3;
            // Final additionally prevents an accidental by-name override.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
        }

        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        // ADR-0149: a collision-free metadata name, mirroring
        // EmitPropertyGetter/Setter's getterName/setterName synthesis.
        var addName = ev.HasExplicitInterfaceClause
            ? "add_" + ExplicitInterfaceMetadataNaming.GetMetadataName(ev.Name, ev.ExplicitInterfaceClauseTarget)
            : $"add_{ev.Name}";

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(addName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// ADR-0052: emits the remove_X accessor MethodDef for an event.
    /// </summary>
    private MethodDefinitionHandle EmitEventRemoveAccessor(StructSymbol structSym, EventSymbol ev)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (ev.IsFieldLike && ev.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(ev.BackingField, out var backingHandle))
            {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: false, isAdd: false);
            }
            else if (ev.RemoveMethodSymbol != null && this.emitCtx.Program.Functions.TryGetValue(ev.RemoveMethodSymbol, out var removeBody))
            {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                var handle = this.emitFunction(ev.RemoveMethodSymbol, removeBody, false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        // ADR-0149: see the matching visibility comment in EmitEventAddAccessor.
        var methodAttrs = (ev.HasExplicitInterfaceClause ? MethodAttributes.Private : MethodAttributes.Public)
            | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (this.EventImplicitlyImplementsInterface(structSym, ev))
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.ExplicitInterfaceMember != null)
        {
            // ADR-0149: see the matching comment in EmitEventAddAccessor.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
        }

        var firstParamHandle = this.nextParameterHandle();
        this.emitCtx.Metadata.AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("value"),
            sequenceNumber: 1);

        // ADR-0149: see the matching comment in EmitEventAddAccessor.
        var removeName = ev.HasExplicitInterfaceClause
            ? "remove_" + ExplicitInterfaceMetadataNaming.GetMetadataName(ev.Name, ev.ExplicitInterfaceClauseTarget)
            : $"remove_{ev.Name}";

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(removeName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #257: emits the raise_X accessor MethodDef for an event.
    /// The raise accessor body is always user-provided (explicit).
    /// </summary>
    private MethodDefinitionHandle EmitEventRaiseAccessor(StructSymbol structSym, EventSymbol ev, bool isStatic)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (ev.RaiseMethodSymbol != null && this.emitCtx.Program.Functions.TryGetValue(ev.RaiseMethodSymbol, out var raiseBody))
            {
                var handle = this.emitFunction(ev.RaiseMethodSymbol, raiseBody, false);
                return handle;
            }
            else
            {
                // Fallback: throw new NotImplementedException().
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
            }
        }

        // Build signature: parameters match the handler type's parameters, return void.
        int paramCount = 0;
        if (ev.Type is FunctionTypeSymbol fnType)
        {
            paramCount = fnType.ParameterTypes.Length;
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !isStatic)
            .Parameters(paramCount, r => r.Void(), ps =>
            {
                if (ev.Type is FunctionTypeSymbol fn)
                {
                    foreach (var pt in fn.ParameterTypes)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), pt);
                    }
                }
            });

        // ADR-0149: see the matching visibility comment in EmitEventAddAccessor
        // (this fallback is reached only when MetadataOnly suppresses the
        // EmitFunction path above, or when there is genuinely no raise
        // accessor body — a raise accessor is always user-provided).
        var methodAttrs = (ev.HasExplicitInterfaceClause ? MethodAttributes.Private : MethodAttributes.Public)
            | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
        if (isStatic)
        {
            methodAttrs |= MethodAttributes.Static;
        }
        else if (ev.IsVirtual)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot;
        }
        else if (ev.IsOverride)
        {
            methodAttrs |= MethodAttributes.Virtual;
        }
        else if (ev.ExplicitInterfaceMember != null)
        {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
        }

        var firstParamHandle = this.nextParameterHandle();
        for (int i = 0; i < paramCount; i++)
        {
            this.emitCtx.Metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString($"arg{i}"),
                sequenceNumber: i + 1);
        }

        // ADR-0149: see the matching comment in EmitEventAddAccessor.
        var raiseName = ev.HasExplicitInterfaceClause
            ? "raise_" + ExplicitInterfaceMetadataNaming.GetMetadataName(ev.Name, ev.ExplicitInterfaceClauseTarget)
            : $"raise_{ev.Name}";

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(raiseName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle);
    }

    /// <summary>
    /// Issue #256: produces a MethodSpec for Interlocked.CompareExchange&lt;EventType&gt;.
    /// </summary>
    private EntityHandle GetInterlockedCompareExchangeSpec(TypeSymbol eventType)
    {
        var openRef = this.wellKnown.GetInterlockedCompareExchangeOpenRef();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        var typeEncoder = argsEncoder.AddArgument();
        this.encodeTypeSymbol(typeEncoder, eventType);
        return this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #248: emits abstract accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for all properties declared on an interface.
    /// </summary>
    /// <param name="ifaceSym">The owning interface symbol whose property accessors are emitted as abstract MethodDefs.</param>
    public void EmitInterfacePropertyAccessors(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym.Properties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle))
        {
            return;
        }

        PropertyDefinitionHandle firstPropDef = default;
        foreach (var prop in ifaceSym.Properties)
        {
            if (!this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles))
            {
                continue;
            }

            // Emit abstract getter MethodDef.
            MethodDefinitionHandle? emittedGetter = null;
            if (prop.HasGetter && accessorHandles.Getter.HasValue)
            {
                // Issue #1030 / #2293: a default-bodied interface property
                // getter — static-virtual or ordinary instance — is a
                // non-abstract Virtual slot with a real IL body. Route it
                // through the regular function-emit pipeline (signature +
                // body + parameter rows), which stamps
                // Static|Virtual|NewSlot|SpecialName for a static accessor,
                // or Virtual|NewSlot|SpecialName (receiver = interface, no
                // Static) for an instance default accessor — mirroring how
                // default-interface *methods* are emitted (EmitFunction's
                // receiver-is-interface branch). The MethodDef row lands in
                // the planned accessor position because this runs in
                // accessor order.
                if (prop.GetterSymbol != null
                    && !prop.GetterSymbol.IsAbstract
                    && this.emitCtx.Program.Functions.TryGetValue(prop.GetterSymbol, out var getterBody))
                {
                    emittedGetter = this.emitFunction(prop.GetterSymbol, getterBody, false);
                }
                else
                {
                    var sigBlob = new BlobBuilder();
                    new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic)
                        .Parameters(
                            prop.Parameters.Length,
                            r => this.encodeTypeSymbol(r.Type(), prop.Type),
                            ps =>
                            {
                                // ADR-0149 (issue #944 follow-up): an abstract
                                // interface indexer getter carries its index
                                // parameters ahead of the return type, exactly
                                // like a struct/class indexer getter.
                                foreach (var indexParam in prop.Parameters)
                                {
                                    this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type);
                                }
                            });

                    var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
                        | MethodAttributes.Virtual | MethodAttributes.Abstract
                        | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                    if (prop.IsStatic)
                    {
                        attrs |= MethodAttributes.Static;
                    }

                    emittedGetter = this.emitCtx.Metadata.AddMethodDefinition(
                        attributes: attrs,
                        implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                        name: this.emitCtx.Metadata.GetOrAddString($"get_{prop.Name}"),
                        signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
                        bodyOffset: -1,
                        parameterList: this.nextParameterHandle());
                }
            }

            // Emit abstract setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                // Issue #1030 / #2293: default-bodied interface setter
                // (static-virtual or ordinary instance).
                if (prop.SetterSymbol != null
                    && !prop.SetterSymbol.IsAbstract
                    && this.emitCtx.Program.Functions.TryGetValue(prop.SetterSymbol, out var setterBody))
                {
                    emittedSetter = this.emitFunction(prop.SetterSymbol, setterBody, false);
                }
                else
                {
                    var sigBlob = new BlobBuilder();
                    new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic)
                        .Parameters(
                            prop.Parameters.Length + 1,
                            r => r.Void(),
                            ps =>
                            {
                                // ADR-0149 (issue #944 follow-up): an abstract
                                // interface indexer setter carries its index
                                // parameters ahead of the trailing `value`
                                // parameter, exactly like a struct/class
                                // indexer setter.
                                foreach (var indexParam in prop.Parameters)
                                {
                                    this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type);
                                }

                                this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type);
                            });

                    var attrs = MethodAttributes.Public | MethodAttributes.HideBySig
                        | MethodAttributes.Virtual | MethodAttributes.Abstract
                        | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                    if (prop.IsStatic)
                    {
                        attrs |= MethodAttributes.Static;
                    }

                    emittedSetter = this.emitCtx.Metadata.AddMethodDefinition(
                        attributes: attrs,
                        implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                        name: this.emitCtx.Metadata.GetOrAddString($"set_{prop.Name}"),
                        signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
                        bodyOffset: -1,
                        parameterList: this.nextParameterHandle());
                }
            }

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            if (prop.IsIndexer && !prop.Parameters.IsDefaultOrEmpty)
            {
                // ADR-0118 / ADR-0149 (issue #944 follow-up): an interface
                // indexer's PropertyDef signature carries its index parameter
                // types too, mirroring the struct/class indexer PropertyDef
                // emission above (EmitPropertyGetter/Setter's sibling path).
                var indexParams = prop.Parameters;
                new BlobEncoder(propertySignature)
                    .PropertySignature(isInstanceProperty: !prop.IsStatic)
                    .Parameters(
                        indexParams.Length,
                        returnType => this.encodeTypeSymbol(returnType.Type(), prop.Type),
                        parameters =>
                        {
                            foreach (var indexParam in indexParams)
                            {
                                this.encodeTypeSymbol(parameters.AddParameter().Type(), indexParam.Type);
                            }
                        });
            }
            else
            {
                new BlobEncoder(propertySignature)
                    .PropertySignature(isInstanceProperty: !prop.IsStatic)
                    .Parameters(0, returnType => this.encodeTypeSymbol(returnType.Type(), prop.Type), parameters => { });
            }

            var propDef = this.emitCtx.Metadata.AddProperty(
                attributes: PropertyAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(prop.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature));

            if (firstPropDef.IsNil)
            {
                firstPropDef = propDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter.Value);
            }

            if (emittedSetter.HasValue)
            {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter.Value);
            }

            this.emitNullableAttributeOnProperty(propDef, prop.Type);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property);
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if (!firstPropDef.IsNil)
        {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.cache.TypesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// ADR-0052: emits abstract add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on an interface.
    /// </summary>
    /// <param name="ifaceSym">The owning interface symbol whose event accessors are emitted as abstract MethodDefs.</param>
    public void EmitInterfaceEventAccessors(InterfaceSymbol ifaceSym)
    {
        if (ifaceSym.Events.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle))
        {
            return;
        }

        EventDefinitionHandle firstEventDef = default;
        foreach (var ev in ifaceSym.Events)
        {
            if (!this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles))
            {
                continue;
            }

            // Emit abstract add_X MethodDef.
            var addSigBlob = new BlobBuilder();
            new BlobEncoder(addSigBlob).MethodSignature(isInstanceMethod: true)
                .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

            var addAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                | MethodAttributes.Virtual | MethodAttributes.Abstract
                | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
            var emittedAdd = this.emitCtx.Metadata.AddMethodDefinition(
                attributes: addAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString($"add_{ev.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(addSigBlob),
                bodyOffset: -1,
                parameterList: this.nextParameterHandle());

            // Emit abstract remove_X MethodDef.
            var removeSigBlob = new BlobBuilder();
            new BlobEncoder(removeSigBlob).MethodSignature(isInstanceMethod: true)
                .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

            var removeAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                | MethodAttributes.Virtual | MethodAttributes.Abstract
                | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
            var emittedRemove = this.emitCtx.Metadata.AddMethodDefinition(
                attributes: removeAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString($"remove_{ev.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(removeSigBlob),
                bodyOffset: -1,
                parameterList: this.nextParameterHandle());

            // Emit EventDef row.
            var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

            var eventDef = this.emitCtx.Metadata.AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle);

            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event);

            if (firstEventDef.IsNil)
            {
                firstEventDef = eventDef;
            }

            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, emittedAdd);
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, emittedRemove);

            // Issue #257: emit abstract raise_X MethodDef if present.
            if (ev.RaiseMethodSymbol != null)
            {
                int raiseParamCount = 0;
                if (ev.Type is FunctionTypeSymbol fnType)
                {
                    raiseParamCount = fnType.ParameterTypes.Length;
                }

                var raiseSigBlob = new BlobBuilder();
                new BlobEncoder(raiseSigBlob).MethodSignature(isInstanceMethod: true)
                    .Parameters(raiseParamCount, r => r.Void(), ps =>
                    {
                        if (ev.Type is FunctionTypeSymbol fn)
                        {
                            foreach (var pt in fn.ParameterTypes)
                            {
                                this.encodeTypeSymbol(ps.AddParameter().Type(), pt);
                            }
                        }
                    });

                var raiseAttrs = MethodAttributes.Public | MethodAttributes.HideBySig
                    | MethodAttributes.Virtual | MethodAttributes.Abstract
                    | MethodAttributes.NewSlot | MethodAttributes.SpecialName;
                var emittedRaise = this.emitCtx.Metadata.AddMethodDefinition(
                    attributes: raiseAttrs,
                    implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                    name: this.emitCtx.Metadata.GetOrAddString($"raise_{ev.Name}"),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(raiseSigBlob),
                    bodyOffset: -1,
                    parameterList: this.nextParameterHandle());

                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, emittedRaise);
            }
        }

        // EventMap row: links the TypeDef to its first EventDef.
        if (!firstEventDef.IsNil)
        {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef);
        }
    }
}
