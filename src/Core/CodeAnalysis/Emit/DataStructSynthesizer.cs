// <copyright file="DataStructSynthesizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'public' members should come before 'private' members (organized by feature: inline-struct group then data-struct group, each followed by its own private helpers)

using System;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// IL emission for the synthesized members of <c>inline struct</c> and
/// <c>data struct</c> types (ADR-0029). The two families are siblings —
/// both fabricate <c>Equals(object)</c>, <c>Equals(T)</c>,
/// <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c> /
/// <c>op_Inequality</c>, and <c>Deconstruct</c> — so they share a single
/// component. <c>inline struct</c> also gets a single-field primary
/// constructor; <c>data struct</c> piggy-backs on the existing primary-
/// constructor planning.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-6 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level <c>private</c> on
/// <see cref="ReflectionMetadataEmitter"/> (none lived inside the nested
/// <c>BodyEmitter</c>), so this extraction is a clean Option-A move with
/// no BodyEmitter seam issues like PR-E-5 had with the conversion
/// methods.
/// </para>
/// <para>
/// The methods moved are:
/// </para>
/// <list type="bullet">
/// <item><c>EmitInlineStructSynthesizedMembers</c></item>
/// <item><c>EmitInlineStructConstructor</c></item>
/// <item><c>EmitInlineEqualsObject</c></item>
/// <item><c>EmitInlineEqualsTyped</c></item>
/// <item><c>EmitInlineGetHashCode</c></item>
/// <item><c>EmitInlineToString</c></item>
/// <item><c>EmitInlineEqualityOperator</c></item>
/// <item><c>EmitInlineDeconstruct</c></item>
/// <item><c>EmitDataStructSynthesizedMembers</c></item>
/// <item><c>EmitDataStructEqualsObject</c></item>
/// <item><c>EmitDataStructEqualsTyped</c></item>
/// <item><c>EmitDataStructGetHashCode</c></item>
/// <item><c>EmitDataStructToString</c></item>
/// <item><c>EmitDataStructEqualityOperator</c></item>
/// <item><c>EmitDataStructDeconstruct</c></item>
/// </list>
/// <para>
/// Plus three helpers used exclusively by the methods above and the
/// per-emit <see cref="StandaloneSignatureHandle"/> they cache:
/// </para>
/// <list type="bullet">
/// <item><c>FinishInlineBody</c></item>
/// <item><c>GetHashCodeCombineObjectSpec</c></item>
/// <item><c>GetHashCodeAddObjectSpec</c></item>
/// <item><c>GetHashCodeLocalSignature</c> (with its <c>hashCodeLocalSig</c> cache)</item>
/// </list>
/// <para>
/// Like every other PR-E-* component, <c>DataStructSynthesizer</c> is
/// <c>internal sealed</c> and constructor-injected. It receives the same
/// <see cref="EmitContext"/>, <see cref="MetadataTokenCache"/>, and
/// <see cref="WellKnownReferences"/> as its peers, plus
/// <see cref="ConversionEmitter"/> (for <c>EmitBoxIfNeeded</c>) and
/// thin delegate callbacks bound to the four remaining
/// <see cref="ReflectionMetadataEmitter"/> helpers it depends on
/// (<c>EncodeTypeSymbol</c>, <c>GetElementTypeToken</c>,
/// <c>GetTypeReference</c>, and <c>NextParameterHandle</c>). The callbacks
/// mirror the pattern PR-E-4 <see cref="SlotPlanner"/> and PR-E-5
/// <see cref="ConversionEmitter"/> established to avoid hard back-references
/// to the root emitter.
/// </para>
/// <para>
/// The shared <see cref="MetadataTokenCache.DataStructOpEqualityHandles"/>
/// dictionary stays on the cache, not on this component, so future
/// consumers (e.g. the operator-lookup path in the body emitter) can keep
/// reading it without needing a reference to <c>DataStructSynthesizer</c>.
/// </para>
/// </remarks>
internal sealed class DataStructSynthesizer
{
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;
    private readonly WellKnownReferences wellKnown;
    private readonly ConversionEmitter conversionEmitter;
    private readonly Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol;
    private readonly Func<TypeSymbol, EntityHandle> getElementTypeToken;
    private readonly Func<Type, TypeReferenceHandle> getTypeReference;
    private readonly Func<ParameterHandle> nextParameterHandle;
    private readonly Func<StructSymbol, EntityHandle> resolveUserTypeToken;
    private readonly Func<StructSymbol, FieldSymbol, EntityHandle> resolveUserFieldToken;
    private readonly Func<StructSymbol, EntityHandle, string, BlobBuilder, EntityHandle> resolveUserMethodRef;

    // Per-emit standalone signature cache for the >8-field GetHashCode fold
    // path's local. Mirrors the pre-refactor field on
    // ReflectionMetadataEmitter; instance-scoped because both the cache
    // and the metadata builder it indexes into are per-emit.
    private StandaloneSignatureHandle hashCodeLocalSig;

    public DataStructSynthesizer(
        EmitContext emitCtx,
        MetadataTokenCache cache,
        WellKnownReferences wellKnown,
        ConversionEmitter conversionEmitter,
        Action<SignatureTypeEncoder, TypeSymbol> encodeTypeSymbol,
        Func<TypeSymbol, EntityHandle> getElementTypeToken,
        Func<Type, TypeReferenceHandle> getTypeReference,
        Func<ParameterHandle> nextParameterHandle,
        Func<StructSymbol, EntityHandle> resolveUserTypeToken,
        Func<StructSymbol, FieldSymbol, EntityHandle> resolveUserFieldToken,
        Func<StructSymbol, EntityHandle, string, BlobBuilder, EntityHandle> resolveUserMethodRef)
    {
        this.emitCtx = emitCtx ?? throw new ArgumentNullException(nameof(emitCtx));
        this.cache = cache ?? throw new ArgumentNullException(nameof(cache));
        this.wellKnown = wellKnown ?? throw new ArgumentNullException(nameof(wellKnown));
        this.conversionEmitter = conversionEmitter ?? throw new ArgumentNullException(nameof(conversionEmitter));
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw new ArgumentNullException(nameof(encodeTypeSymbol));
        this.getElementTypeToken = getElementTypeToken ?? throw new ArgumentNullException(nameof(getElementTypeToken));
        this.getTypeReference = getTypeReference ?? throw new ArgumentNullException(nameof(getTypeReference));
        this.nextParameterHandle = nextParameterHandle ?? throw new ArgumentNullException(nameof(nextParameterHandle));
        this.resolveUserTypeToken = resolveUserTypeToken ?? throw new ArgumentNullException(nameof(resolveUserTypeToken));
        this.resolveUserFieldToken = resolveUserFieldToken ?? throw new ArgumentNullException(nameof(resolveUserFieldToken));
        this.resolveUserMethodRef = resolveUserMethodRef ?? throw new ArgumentNullException(nameof(resolveUserMethodRef));
    }

    /// <summary>
    /// Rubber-duck follow-up to issue #2224: the ordered list of backing
    /// <see cref="FieldSymbol"/>s the Equals/GetHashCode/ToString/Deconstruct
    /// synthesis below should read/compare. A user-declared data struct
    /// (ADR-0029) always has plain public <see cref="StructSymbol.Fields"/>
    /// (auto-properties are rejected on data structs by the binder — see
    /// <c>Diagnostics.ReportAutoPropertyInDataStruct</c>); an anonymous-class
    /// literal's synthesized type (<see cref="Binding.AnonymousTypeCache"/>)
    /// instead has get-only auto-<see cref="StructSymbol.Properties"/> with no
    /// plain fields, so its members are their <see cref="PropertySymbol.BackingField"/>s.
    /// These two shapes are mutually exclusive today, so checking
    /// <see cref="StructSymbol.Fields"/> first is unambiguous.
    /// </summary>
    private static ImmutableArray<FieldSymbol> GetSynthesisFields(StructSymbol structSym)
    {
        if (!structSym.Fields.IsDefaultOrEmpty)
        {
            return structSym.Fields;
        }

        if (structSym.Properties.IsDefaultOrEmpty)
        {
            return ImmutableArray<FieldSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FieldSymbol>(structSym.Properties.Length);
        foreach (var property in structSym.Properties)
        {
            builder.Add(property.BackingField);
        }

        return builder.MoveToImmutable();
    }

    public void EmitInlineStructSynthesizedMembers(StructSymbol structSym)
    {
        var field = structSym.Fields[0];
        var fieldHandle = this.resolveUserFieldToken(structSym, field);
        var typeDef = this.resolveUserTypeToken(structSym);
        this.cache.ClassPrimaryCtorHandles[structSym] = this.EmitInlineStructConstructor(structSym, field, fieldHandle);
        this.EmitInlineEqualsObject(structSym, field, fieldHandle, typeDef);
        this.EmitInlineEqualsTyped(structSym, field, fieldHandle);
        this.EmitInlineGetHashCode(structSym, field, fieldHandle);
        this.EmitInlineToString(structSym, field, fieldHandle);
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: false);
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: true);
        this.EmitInlineDeconstruct(structSym, field, fieldHandle);
    }

    private MethodDefinitionHandle EmitInlineStructConstructor(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle)
    {
        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            il.LoadArgument(0);
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Stfld);
            il.Token(fieldHandle);
            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                1,
                r => r.Void(),
                ps => this.encodeTypeSymbol(ps.AddParameter().Type(), field.Type));

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    private int FinishInlineBody(InstructionEncoder il)
    {
        return this.emitCtx.MetadataOnly ? -1 : this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
    }

    private void EmitInlineEqualsObject(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle, EntityHandle typeDef)
    {
        // Issue #420 (P3-10): the IL below uses `unbox` to obtain a managed pointer
        // to the inline struct's field after `isinst`. `unbox` is only legal on
        // value types; if reference-type structs/records are ever introduced,
        // this helper must switch to `castclass` (and skip the boxed indirection
        // entirely). Assert the value-type assumption explicitly so a future
        // reference-type StructSymbol fails loudly in Debug builds instead of
        // silently producing invalid IL.
        Debug.Assert(
            !structSym.IsClass,
            "Equals(object) emit assumes value-type struct; reference-type records require castclass instead of unbox");

        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            var hasValue = il.DefineLabel();
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Isinst);
            il.Token(typeDef);
            il.OpCode(ILOpCode.Dup);
            il.Branch(ILOpCode.Brtrue, hasValue);
            il.OpCode(ILOpCode.Pop);
            il.LoadConstantI4(0);
            il.OpCode(ILOpCode.Ret);
            il.MarkLabel(hasValue);
            il.OpCode(ILOpCode.Pop);
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Unbox);
            il.Token(typeDef);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.wellKnown.GetObjectStaticEqualsReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Type().Boolean(), ps => ps.AddParameter().Type().Object());
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString("Equals"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    private void EmitInlineEqualsTyped(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle)
    {
        // Issue #420 / #455 (P3-10): the emitted IL takes the receiver and the
        // typed argument by address (`ldarga`) and reads the field directly.
        // The signature encoded below also passes the typed argument by value
        // through EncodeTypeSymbol, which assumes a value-type StructSymbol.
        // If reference-type structs/records are ever introduced the IL and the
        // signature both need to switch (load by reference, no `ldarga`); make
        // the value-type precondition explicit so a future change trips loudly
        // in Debug instead of producing invalid IL.
        Debug.Assert(
            !structSym.IsClass,
            "EmitInlineEqualsTyped precondition violated: StructSymbol must be a value-type struct — see issue #420 / P3-10.");

        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgumentAddress(1);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.wellKnown.GetObjectStaticEqualsReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Type().Boolean(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), structSym));
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString("Equals"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    private void EmitInlineGetHashCode(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.OpCode(ILOpCode.Callvirt);
            il.Token(this.wellKnown.GetObjectInstanceGetHashCodeReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(0, r => r.Type().Int32(), _ => { });
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString("GetHashCode"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    private void EmitInlineToString(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(structSym.Name + "(" + field.Name + "="));
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.OpCode(ILOpCode.Callvirt);
            il.Token(this.wellKnown.GetObjectInstanceToStringReference());
            il.Call(this.wellKnown.GetStringConcatReference());
            il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(")"));
            il.Call(this.wellKnown.GetStringConcatReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(0, r => r.Type().String(), _ => { });
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString("ToString"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    private void EmitInlineEqualityOperator(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle, bool isInequality)
    {
        // Issue #420 / #455 (P3-10): the emitted IL uses `ldarga` on both
        // operands to read fields directly, which requires the operands to be
        // value-type structs. If reference-type structs/records are ever
        // introduced this helper must switch to `ldarg` / `ldfld` chains and
        // re-encode the parameter signature; assert the value-type precondition
        // explicitly so any future change trips loudly in Debug.
        Debug.Assert(
            !structSym.IsClass,
            "EmitInlineEqualityOperator precondition violated: StructSymbol must be a value-type struct — see issue #420 / P3-10.");

        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            il.LoadArgumentAddress(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.LoadArgumentAddress(1);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
            il.Call(this.wellKnown.GetObjectStaticEqualsReference());
            if (isInequality)
            {
                il.LoadConstantI4(0);
                il.OpCode(ILOpCode.Ceq);
            }

            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), structSym);
                    this.encodeTypeSymbol(ps.AddParameter().Type(), structSym);
                });
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString(isInequality ? "op_Inequality" : "op_Equality"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    private void EmitInlineDeconstruct(StructSymbol structSym, FieldSymbol field, EntityHandle fieldHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            il.LoadArgument(1);
            il.LoadArgument(0);
            il.OpCode(ILOpCode.Ldfld);
            il.Token(fieldHandle);

            // ADR-0087 §3 R3: TypeParameterSymbol fields are now encoded
            // as VAR(idx) (not erased to Object); the indirect store
            // must use `Stobj` against the VAR TypeSpec, not `Stind_ref`.
            if (field.Type is TypeParameterSymbol
                || ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type))
            {
                il.OpCode(ILOpCode.Stobj);
                il.Token(this.getElementTypeToken(field.Type));
            }
            else
            {
                il.OpCode(ILOpCode.Stind_ref);
            }

            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(1, r => r.Void(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(isByRef: true), field.Type));
        this.emitCtx.Metadata.AddMethodDefinition(MethodAttributes.Public | MethodAttributes.HideBySig, MethodImplAttributes.IL | MethodImplAttributes.Managed, this.emitCtx.Metadata.GetOrAddString("Deconstruct"), this.emitCtx.Metadata.GetOrAddBlob(sig), this.FinishInlineBody(il), this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits the seven synthesized members for a
    /// <c>data struct</c> type. The MethodDef rows are added in a fixed
    /// order so they align 1:1 with the rows reserved by the method-row
    /// planner: <c>Equals(Name)</c>, <c>Equals(object)</c>,
    /// <c>GetHashCode</c>, <c>ToString</c>, <c>op_Equality</c>,
    /// <c>op_Inequality</c>, <c>Deconstruct</c>.
    /// <c>Equals(Name)</c> is emitted first so its MethodDef handle is
    /// available when <c>Equals(object)</c> is emitted.
    /// </summary>
    /// <param name="structSym">The data-struct symbol to emit members for.</param>
    public void EmitDataStructSynthesizedMembers(StructSymbol structSym)
    {
        // ADR-0029: data structs must have at least one field (or, for a
        // synthesized anonymous-class type, at least one property — see
        // GetSynthesisFields). This is enforced by the binder; assert here so
        // the emit IL stays simple.
        Debug.Assert(
            !GetSynthesisFields(structSym).IsDefaultOrEmpty,
            "Data structs must have at least one field; the binder should have rejected an empty data struct.");

        var typeDef = this.resolveUserTypeToken(structSym);
        var equalsTypedHandle = this.EmitDataStructEqualsTyped(structSym);
        this.EmitDataStructEqualsObject(structSym, typeDef, equalsTypedHandle);
        this.EmitDataStructGetHashCode(structSym);
        this.EmitDataStructToString(structSym);
        this.cache.DataStructOpEqualityHandles[structSym] = this.EmitDataStructEqualityOperator(structSym, isInequality: false);
        this.EmitDataStructEqualityOperator(structSym, isInequality: true);
        this.EmitDataStructDeconstruct(structSym);

        // Rubber-duck follow-up to issue #2224: an anonymous-class literal's
        // synthesized type has no plain fields (only get-only auto-properties
        // — see Binding.AnonymousTypeCache), so its primary-ctor "call" sugar
        // can't be routed through BoundStructLiteralExpression's
        // field-initializer emission like an ordinary `data struct Foo(x
        // int32)` does — that one keeps Fields non-empty and OverloadResolver
        // routes its call syntax to a struct literal instead, so it never
        // needs a real .ctor row (see the comment near
        // `!classType.IsClass` there). An anonymous-class literal is instead
        // bound directly as a BoundConstructorCallExpression (see
        // ExpressionBinder.BindAnonymousClassExpression), which needs a real
        // newobj-callable instance constructor — both for ordinary compiled
        // code and for ExpressionTreeLowerer.BuildUserConstructorExpression's
        // runtime `Type.GetConstructor` lookup.
        if (structSym.Fields.IsDefaultOrEmpty && structSym.HasPrimaryConstructor)
        {
            this.cache.ClassPrimaryCtorHandles[structSym] = this.EmitDataStructPrimaryConstructor(structSym);
        }
    }

    /// <summary>
    /// Rubber-duck follow-up to issue #2224: emits the primary instance
    /// constructor for an anonymous-class literal's synthesized backing type
    /// — <c>ldarg.0; ldarg.N; stfld &lt;backing field N&gt;</c> per primary-ctor
    /// parameter, in declaration order, then <c>ret</c>. No base-ctor call is
    /// emitted: like every other value-type instance constructor in this
    /// emitter (see <c>EmitInlineStructConstructor</c>), a struct ctor never
    /// chains to <c>System.ValueType::.ctor</c> in IL.
    /// </summary>
    private MethodDefinitionHandle EmitDataStructPrimaryConstructor(StructSymbol structSym)
    {
        var parameters = structSym.PrimaryConstructorParameters;
        var fields = GetSynthesisFields(structSym);

        int bodyOffset = -1;
        if (!this.emitCtx.MetadataOnly)
        {
            var il = new InstructionEncoder(new BlobBuilder());
            for (var i = 0; i < parameters.Length; i++)
            {
                var fieldHandle = this.resolveUserFieldToken(structSym, fields[i]);
                il.LoadArgument(0);
                il.LoadArgument(i + 1);
                il.OpCode(ILOpCode.Stfld);
                il.Token(fieldHandle);
            }

            il.OpCode(ILOpCode.Ret);
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il));
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                parameters.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var param in parameters)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), param.Type);
                    }
                });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public sealed override bool Equals(object other)</c> that performs
    /// <c>other is Name p &amp;&amp; this.Equals(p)</c>. Sealed because struct
    /// methods cannot be overridden in user code anyway, but the metadata
    /// flag communicates intent.
    /// </summary>
    private void EmitDataStructEqualsObject(StructSymbol structSym, EntityHandle typeDef, MethodDefinitionHandle equalsTypedHandle)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            var retFalse = il.DefineLabel();
            il.LoadArgument(1);
            il.OpCode(ILOpCode.Isinst);
            il.Token(typeDef);
            il.Branch(ILOpCode.Brfalse, retFalse);
            il.LoadArgument(0);
            il.LoadArgument(1);

            // Issue #2228: `isinst` re-narrows the reference-typed `other`
            // argument to the data-class type (already validated non-null
            // above by the `isinst`/`brfalse` pair); a data STRUCT's `other`
            // is boxed, so it needs `unbox_any` to copy the value back out.
            il.OpCode(structSym.IsClass ? ILOpCode.Isinst : ILOpCode.Unbox_any);
            il.Token(typeDef);
            il.OpCode(ILOpCode.Call);
            il.Token(this.ResolveEqualsTypedToken(structSym, equalsTypedHandle));
            il.OpCode(ILOpCode.Ret);
            il.MarkLabel(retFalse);
            il.LoadConstantI4(0);
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Type().Boolean(), ps => ps.AddParameter().Type().Object());

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public bool Equals(Name other)</c> that compares fields in source
    /// declaration order via <c>Object.Equals(object, object)</c>, short
    /// circuiting on first inequality. Value-type fields are boxed; type
    /// parameters and reference-type fields are passed as objects directly.
    /// </summary>
    /// <returns>The MethodDef handle of the emitted method, so callers can
    /// reference it from other synthesized members.</returns>
    private MethodDefinitionHandle EmitDataStructEqualsTyped(StructSymbol structSym)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            var retFalse = il.DefineLabel();

            // Issue #2228: a data-class `other` is a reference and may be
            // null (a data-struct's `other` is a value, never null); a null
            // `other` is unequal to `this` (record-class semantics).
            if (structSym.IsClass)
            {
                il.LoadArgument(1);
                il.Branch(ILOpCode.Brfalse, retFalse);
            }

            foreach (var field in GetSynthesisFields(structSym))
            {
                var fieldHandle = this.resolveUserFieldToken(structSym, field);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);
                this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);

                // Issue #2228: `other` is already a reference for a data
                // class — `ldfld` reads straight off it. A data struct's
                // `other` is passed by value, so its field is read off the
                // argument's address instead.
                if (structSym.IsClass)
                {
                    il.LoadArgument(1);
                }
                else
                {
                    il.LoadArgumentAddress(1);
                }

                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);
                this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
                il.Call(this.wellKnown.GetObjectStaticEqualsReference());
                il.Branch(ILOpCode.Brfalse, retFalse);
            }

            il.LoadConstantI4(1);
            il.OpCode(ILOpCode.Ret);
            il.MarkLabel(retFalse);
            il.LoadConstantI4(0);
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Type().Boolean(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), structSym));

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public sealed override int GetHashCode()</c>. For up to 8 fields the
    /// implementation calls <c>HashCode.Combine&lt;object,...,object&gt;</c>
    /// after boxing each field; for &gt;8 fields it folds via a stack-allocated
    /// <c>HashCode</c> local using <c>HashCode.Add&lt;object&gt;</c> per field
    /// and finishes with <c>ToHashCode()</c>.
    /// </summary>
    private void EmitDataStructGetHashCode(StructSymbol structSym)
    {
        var fields = GetSynthesisFields(structSym);
        bool useFold = fields.Length > 8;

        var il = new InstructionEncoder(new BlobBuilder());
        StandaloneSignatureHandle localsSignature = default;
        int bodyOffset = -1;

        if (!this.emitCtx.MetadataOnly)
        {
            if (!useFold)
            {
                foreach (var field in fields)
                {
                    var fieldHandle = this.resolveUserFieldToken(structSym, field);
                    il.LoadArgument(0);
                    il.OpCode(ILOpCode.Ldfld);
                    il.Token(fieldHandle);
                    this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
                }

                il.OpCode(ILOpCode.Call);
                il.Token(this.GetHashCodeCombineObjectSpec(fields.Length));
                il.OpCode(ILOpCode.Ret);
            }
            else
            {
                // ldloca.s 0; initobj HashCode
                il.LoadLocalAddress(0);
                il.OpCode(ILOpCode.Initobj);
                il.Token(this.wellKnown.GetHashCodeTypeReference());

                var addSpec = this.GetHashCodeAddObjectSpec();
                foreach (var field in fields)
                {
                    var fieldHandle = this.resolveUserFieldToken(structSym, field);
                    il.LoadLocalAddress(0);
                    il.LoadArgument(0);
                    il.OpCode(ILOpCode.Ldfld);
                    il.Token(fieldHandle);
                    this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
                    il.OpCode(ILOpCode.Call);
                    il.Token(addSpec);
                }

                il.LoadLocalAddress(0);
                il.Call(this.wellKnown.GetHashCodeToHashCodeReference());
                il.OpCode(ILOpCode.Ret);

                localsSignature = this.GetHashCodeLocalSignature();
            }

            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().Int32(), _ => { });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("GetHashCode"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public sealed override string ToString()</c> rendering
    /// <c>Name(F1=v1, F2=v2, …)</c>. Field values are converted via
    /// <c>Convert.ToString(object, IFormatProvider)</c> with
    /// <see cref="System.Globalization.CultureInfo.InvariantCulture"/> so
    /// null reference fields render as the empty string and value-type
    /// formatting is locale-independent. Pieces are assembled with
    /// <c>String.Concat(string[])</c>.
    /// </summary>
    private void EmitDataStructToString(StructSymbol structSym)
    {
        var fields = GetSynthesisFields(structSym);
        int pieceCount = (2 * fields.Length) + 1;

        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            var stringTypeRef = this.getTypeReference(this.emitCtx.CoreStringType);

            il.LoadConstantI4(pieceCount);
            il.OpCode(ILOpCode.Newarr);
            il.Token(stringTypeRef);

            // Piece 0: "Name(F1="
            il.OpCode(ILOpCode.Dup);
            il.LoadConstantI4(0);
            il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(structSym.Name + "(" + fields[0].Name + "="));
            il.OpCode(ILOpCode.Stelem_ref);

            for (int i = 0; i < fields.Length; i++)
            {
                var field = fields[i];
                var fieldHandle = this.resolveUserFieldToken(structSym, field);

                // Piece 2*i + 1: Convert.ToString(this.Fi, InvariantCulture)
                il.OpCode(ILOpCode.Dup);
                il.LoadConstantI4((2 * i) + 1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);
                this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
                il.Call(this.wellKnown.GetCultureInvariantGetterReference());
                il.Call(this.wellKnown.GetConvertToStringReference());
                il.OpCode(ILOpCode.Stelem_ref);

                // Piece 2*i + 2: separator (", F{i+1}=" if more fields, else ")")
                il.OpCode(ILOpCode.Dup);
                il.LoadConstantI4((2 * i) + 2);
                string separator = i + 1 < fields.Length
                    ? ", " + fields[i + 1].Name + "="
                    : ")";
                il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(separator));
                il.OpCode(ILOpCode.Stelem_ref);
            }

            il.Call(this.wellKnown.GetStringConcatArrayReference());
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Type().String(), _ => { });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("ToString"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public static bool op_Equality(Name left, Name right)</c> (or
    /// <c>op_Inequality</c> when <paramref name="isInequality"/> is true).
    /// Both delegate to <see cref="EmitDataStructEqualsTyped"/> via
    /// <c>Object.Equals(object, object)</c> on every field — equivalent to
    /// calling <c>left.Equals(right)</c>, but avoids needing the
    /// MethodDef handle for <c>Equals(Name)</c> ahead of time.
    /// </summary>
    /// <returns>The MethodDef handle of the emitted operator.</returns>
    private MethodDefinitionHandle EmitDataStructEqualityOperator(StructSymbol structSym, bool isInequality)
    {
        var il = new InstructionEncoder(new BlobBuilder(), new ControlFlowBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            var retFalse = il.DefineLabel();

            // Issue #2228: both operands of a data-class op_Equality are
            // references and either may be null (record-class semantics:
            // null == null is true; null == non-null is false) — a data
            // struct's operands are values and never null, so this whole
            // block is struct-N/A.
            if (structSym.IsClass)
            {
                var leftNotNull = il.DefineLabel();
                var bothNull = il.DefineLabel();
                il.LoadArgument(0);
                il.Branch(ILOpCode.Brtrue, leftNotNull);
                il.LoadArgument(1);
                il.Branch(ILOpCode.Brfalse, bothNull);
                il.Branch(ILOpCode.Br, retFalse);
                il.MarkLabel(bothNull);
                il.LoadConstantI4(isInequality ? 0 : 1);
                il.OpCode(ILOpCode.Ret);
                il.MarkLabel(leftNotNull);
                il.LoadArgument(1);
                il.Branch(ILOpCode.Brfalse, retFalse);
            }

            foreach (var field in GetSynthesisFields(structSym))
            {
                var fieldHandle = this.resolveUserFieldToken(structSym, field);
                if (structSym.IsClass)
                {
                    il.LoadArgument(0);
                }
                else
                {
                    il.LoadArgumentAddress(0);
                }

                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);
                this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);

                if (structSym.IsClass)
                {
                    il.LoadArgument(1);
                }
                else
                {
                    il.LoadArgumentAddress(1);
                }

                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);
                this.conversionEmitter.EmitBoxIfNeeded(il, field.Type);
                il.Call(this.wellKnown.GetObjectStaticEqualsReference());
                il.Branch(ILOpCode.Brfalse, retFalse);
            }

            il.LoadConstantI4(isInequality ? 0 : 1);
            il.OpCode(ILOpCode.Ret);
            il.MarkLabel(retFalse);
            il.LoadConstantI4(isInequality ? 1 : 0);
            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: false)
            .Parameters(
                2,
                r => r.Type().Boolean(),
                ps =>
                {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), structSym);
                    this.encodeTypeSymbol(ps.AddParameter().Type(), structSym);
                });

        return this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(isInequality ? "op_Inequality" : "op_Equality"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// Issue #410 / ADR-0029: emits
    /// <c>public void Deconstruct(out T1 F1, out T2 F2, …)</c> assigning each
    /// field to the corresponding out parameter. Field names match the
    /// declaration order so C# users get meaningful tooling hints when
    /// destructuring positionally.
    /// </summary>
    private void EmitDataStructDeconstruct(StructSymbol structSym)
    {
        var fields = GetSynthesisFields(structSym);
        var il = new InstructionEncoder(new BlobBuilder());
        if (!this.emitCtx.MetadataOnly)
        {
            for (int i = 0; i < fields.Length; i++)
            {
                var field = fields[i];
                var fieldHandle = this.resolveUserFieldToken(structSym, field);
                il.LoadArgument(i + 1);
                il.LoadArgument(0);
                il.OpCode(ILOpCode.Ldfld);
                il.Token(fieldHandle);

                // ADR-0087 §3 R3: TypeParameterSymbol fields are now
                // encoded as VAR(idx) (not erased to Object); the
                // indirect store must use `Stobj` against the VAR
                // TypeSpec, not `Stind_ref`.
                if (field.Type is TypeParameterSymbol)
                {
                    il.OpCode(ILOpCode.Stobj);
                    il.Token(this.getElementTypeToken(field.Type));
                }
                else if (ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type))
                {
                    il.OpCode(ILOpCode.Stobj);
                    il.Token(this.getElementTypeToken(field.Type));
                }
                else
                {
                    il.OpCode(ILOpCode.Stind_ref);
                }
            }

            il.OpCode(ILOpCode.Ret);
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(
                fields.Length,
                r => r.Void(),
                ps =>
                {
                    foreach (var field in fields)
                    {
                        this.encodeTypeSymbol(ps.AddParameter().Type(isByRef: true), field.Type);
                    }
                });

        this.emitCtx.Metadata.AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Deconstruct"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: this.nextParameterHandle());
    }

    /// <summary>
    /// ADR-0087 §3 R3: resolves the right token for the call to
    /// <c>Equals(StructType)</c> from <c>Equals(object)</c>. Returns
    /// the bare MethodDef for a non-generic data struct; for a generic
    /// data struct returns a MemberRef parented at the self-instantiation
    /// TypeSpec.
    /// </summary>
    private EntityHandle ResolveEqualsTypedToken(StructSymbol structSym, MethodDefinitionHandle equalsTypedHandle)
    {
        if (!ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym))
        {
            return equalsTypedHandle;
        }

        var sig = new BlobBuilder();
        new BlobEncoder(sig).MethodSignature(isInstanceMethod: true)
            .Parameters(1, r => r.Type().Boolean(), ps => this.encodeTypeSymbol(ps.AddParameter().Type(), structSym));
        return this.resolveUserMethodRef(structSym, equalsTypedHandle, "Equals", sig);
    }

    /// <summary>
    /// Issue #410 / ADR-0029: produces a MethodSpec for
    /// <c>HashCode.Combine&lt;object,...,object&gt;</c> with
    /// <paramref name="arity"/> type arguments (1..8).
    /// </summary>
    private EntityHandle GetHashCodeCombineObjectSpec(int arity)
    {
        var openRef = this.wellKnown.GetHashCodeCombineOpenReference(arity);
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(arity);
        for (int i = 0; i < arity; i++)
        {
            argsEncoder.AddArgument().Object();
        }

        return this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #410 / ADR-0029: produces a MethodSpec for
    /// <c>HashCode.Add&lt;object&gt;(object)</c>.
    /// </summary>
    private EntityHandle GetHashCodeAddObjectSpec()
    {
        var openRef = this.wellKnown.GetHashCodeAddOpenReference();
        var sigBlob = new BlobBuilder();
        var argsEncoder = new BlobEncoder(sigBlob).MethodSpecificationSignature(1);
        argsEncoder.AddArgument().Object();
        return this.emitCtx.Metadata.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
    }

    /// <summary>
    /// Issue #410 / ADR-0029: returns a standalone signature with one
    /// <c>System.HashCode</c> local, used by the &gt;8-field
    /// <c>GetHashCode</c> fold path.
    /// </summary>
    private StandaloneSignatureHandle GetHashCodeLocalSignature()
    {
        if (!this.hashCodeLocalSig.IsNil)
        {
            return this.hashCodeLocalSig;
        }

        var hashCodeRef = this.wellKnown.GetHashCodeTypeReference();
        var sigBlob = new BlobBuilder();
        var encoder = new BlobEncoder(sigBlob).LocalVariableSignature(1);
        encoder.AddVariable().Type().Type(hashCodeRef, isValueType: true);
        this.hashCodeLocalSig = this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob));
        return this.hashCodeLocalSig;
    }
}
