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

    public MemberDefEmitter(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        Func<FunctionSymbol, BoundBlockStatement, bool, MethodDefinitionHandle> emitFunction,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol,
        Func<ParameterHandle> nextParameterHandle,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<Type, EntityHandle> getTypeHandleForMember,
        Func<StructSymbol, FieldSymbol, EntityHandle> resolveFieldToken)
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
        }

        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if (!firstPropDef.IsNil)
        {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef);
            this.cache.TypesWithPropertyMap.Add(typeDefHandle);
        }
    }

    /// <summary>
    /// ADR-0051 Phase 6: emits a getter accessor MethodDef (get_PropertyName).
    /// For auto-properties: ldarg.0, ldfld backing, ret.
    /// For computed properties: emits the bound getter body IL.
    /// </summary>
    private MethodDefinitionHandle EmitPropertyGetter(StructSymbol structSym, PropertySymbol prop)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
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
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingToken);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
            else if (prop.GetterSymbol != null && this.emitCtx.Program.Functions.TryGetValue(prop.GetterSymbol, out var getterBody))
            {
                // Computed property with bound body: emit using EmitFunction infrastructure.
                var handle = this.emitFunction(prop.GetterSymbol, getterBody, false);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => this.encodeTypeSymbol(r.Type(), prop.Type), _ => { });

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
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

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"get_{prop.Name}"),
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
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                // Issue #989: self-TypeSpec field MemberRef for generic types.
                var backingToken = ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
                    ? this.resolveFieldToken(structSym, prop.BackingField)
                    : (EntityHandle)backingHandle;
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Stfld);
                il.Token(backingToken);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
            else if (prop.SetterSymbol != null && this.emitCtx.Program.Functions.TryGetValue(prop.SetterSymbol, out var setterBody))
            {
                // Computed property with bound body: emit using EmitFunction infrastructure.
                var handle = this.emitFunction(prop.SetterSymbol, setterBody, false);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
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

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
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

        // Emit a Parameter row for "value" so the setter has a named parameter.
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
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                // Issue #989: self-TypeSpec field MemberRef for generic types.
                var backingToken = ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
                    ? this.resolveFieldToken(structSym, prop.BackingField)
                    : (EntityHandle)backingHandle;
                var il = new InstructionEncoder(new BlobBuilder());
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingToken);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
            else if (prop.GetterSymbol != null && this.emitCtx.Program.Functions.TryGetValue(prop.GetterSymbol, out var getterBody))
            {
                var handle = this.emitFunction(prop.GetterSymbol, getterBody, false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
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
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            if (prop.IsAutoProperty && prop.BackingField != null
                && this.cache.StructFieldDefs.TryGetValue(prop.BackingField, out var backingHandle))
            {
                // Issue #989: self-TypeSpec field MemberRef for generic types.
                var backingToken = ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym)
                    ? this.resolveFieldToken(structSym, prop.BackingField)
                    : (EntityHandle)backingHandle;
                var il = new InstructionEncoder(new BlobBuilder());
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Stsfld);
                il.Token(backingToken);
                il.OpCode(ILOpCode.Ret);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
            else if (prop.SetterSymbol != null && this.emitCtx.Program.Functions.TryGetValue(prop.SetterSymbol, out var setterBody))
            {
                var handle = this.emitFunction(prop.SetterSymbol, setterBody, false);
                return handle;
            }
            else
            {
                var il = new InstructionEncoder(new BlobBuilder());
                var nieCtor = this.wellKnown.GetNotImplementedExceptionCtor();
                il.OpCode(ILOpCode.Newobj);
                il.Token(nieCtor);
                il.OpCode(ILOpCode.Throw);
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
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
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldsfld backingField; stloc.0
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.0; call Delegate.Combine; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(this.wellKnown.GetDelegateCombineRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldsflda backingField; ldloc.2; ldloc.1
                il.OpCode(ILOpCode.Ldsflda);
                il.Token(backingHandle);
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

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
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
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldsfld backingField; stloc.0
                il.OpCode(ILOpCode.Ldsfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.0; call Delegate.Remove; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Call);
                il.Token(this.wellKnown.GetDelegateRemoveRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldsflda backingField; ldloc.2; ldloc.1
                il.OpCode(ILOpCode.Ldsflda);
                il.Token(backingHandle);
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

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
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
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldarg.0; ldfld backingField; stloc.0
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.1; call Delegate.Combine; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Call);
                il.Token(this.wellKnown.GetDelegateCombineRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldarg.0; ldflda backingField; ldloc.2; ldloc.1
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldflda);
                il.Token(backingHandle);
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

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
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
                var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
                var eventTypeHandle = this.GetEventTypeHandle(ev.Type);

                // ldarg.0; ldfld backingField; stloc.0
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(backingHandle);
                il.OpCode(ILOpCode.Stloc_0);

                // loop_start:
                var loopStart = il.DefineLabel();
                il.MarkLabel(loopStart);

                // ldloc.0; stloc.1
                il.OpCode(ILOpCode.Ldloc_0);
                il.OpCode(ILOpCode.Stloc_1);

                // ldloc.1; ldarg.1; call Delegate.Remove; castclass T; stloc.2
                il.OpCode(ILOpCode.Ldloc_1);
                il.LoadArgument(1);
                il.OpCode(ILOpCode.Call);
                il.Token(this.wellKnown.GetDelegateRemoveRef());
                il.OpCode(ILOpCode.Castclass);
                il.Token(eventTypeHandle);
                il.OpCode(ILOpCode.Stloc_2);

                // ldarg.0; ldflda backingField; ldloc.2; ldloc.1
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldflda);
                il.Token(backingHandle);
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

                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: 3, localVariablesSignature: localsSignature);
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
            }
        }

        var sigBlob = new BlobBuilder();
        new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type));

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
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
                bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il);
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

        var methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig;
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

        var firstParamHandle = this.nextParameterHandle();
        for (int i = 0; i < paramCount; i++)
        {
            this.emitCtx.Metadata.AddParameter(
                attributes: ParameterAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString($"arg{i}"),
                sequenceNumber: i + 1);
        }

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString($"raise_{ev.Name}"),
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
                var sigBlob = new BlobBuilder();
                new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic)
                    .Parameters(0, r => this.encodeTypeSymbol(r.Type(), prop.Type), _ => { });

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

            // Emit abstract setter MethodDef.
            MethodDefinitionHandle? emittedSetter = null;
            if (prop.HasSetter && accessorHandles.Setter.HasValue)
            {
                var sigBlob = new BlobBuilder();
                new BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic)
                    .Parameters(1, r => r.Void(), ps =>
                    {
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

            // Emit PropertyDef row.
            var propertySignature = new BlobBuilder();
            new BlobEncoder(propertySignature)
                .PropertySignature(isInstanceProperty: !prop.IsStatic)
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
