// <copyright file="DataStructSynthesizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// IL emission for the synthesized members of `inline struct` and
/// `data struct` types (ADR-0029). The two families are siblings —
/// both fabricate `Equals(object)`, `Equals(T)`,
/// `GetHashCode`, `ToString`, `op_Equality` /
/// `op_Inequality`, and `Deconstruct` — so they share a single
/// component. `inline struct` also gets a single-field primary
/// constructor; `data struct` piggy-backs on the existing primary-
/// constructor planning.
/// @remarks PR-E-6 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level `private` on
/// (cref:ReflectionMetadataEmitter) (none lived inside the nested
/// `BodyEmitter`), so this extraction is a clean Option-A move with
/// no BodyEmitter seam issues like PR-E-5 had with the conversion
/// methods.
///
/// The methods moved are:
///
/// - `EmitInlineStructSynthesizedMembers`
/// - `EmitInlineStructConstructor`
/// - `EmitInlineEqualsObject`
/// - `EmitInlineEqualsTyped`
/// - `EmitInlineGetHashCode`
/// - `EmitInlineToString`
/// - `EmitInlineEqualityOperator`
/// - `EmitInlineDeconstruct`
/// - `EmitDataStructSynthesizedMembers`
/// - `EmitDataStructEqualsObject`
/// - `EmitDataStructEqualsTyped`
/// - `EmitDataStructGetHashCode`
/// - `EmitDataStructToString`
/// - `EmitDataStructEqualityOperator`
/// - `EmitDataStructDeconstruct`
///
/// Four helpers support the methods above. Only GetHashCodeLocalSignature
/// caches a per-emit (cref:StandaloneSignatureHandle), for the fold local.
/// The hash helpers use MetadataRowInterner to intern MethodSpec rows.
/// The interner keys each row by its method and encoded type arguments.
///
/// - `FinishInlineBody`
/// - `GetHashCodeCombineSpec`
/// - `GetHashCodeAddSpec`
/// - `GetHashCodeLocalSignature` (with its `hashCodeLocalSig` cache)
///
/// Like every other PR-E-* component, `DataStructSynthesizer` is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) as its peers, plus
/// (cref:ConversionEmitter) (for `EmitBoxIfNeeded`) and
/// thin delegate callbacks bound to the four remaining
/// (cref:ReflectionMetadataEmitter) helpers it depends on
/// (`EncodeTypeSymbol`, `GetElementTypeToken`,
/// `GetTypeReference`, and `NextParameterHandle`). The callbacks
/// mirror the pattern PR-E-4 (cref:SlotPlanner) and PR-E-5
/// (cref:ConversionEmitter) established to avoid hard back-references
/// to the root emitter.
///
/// The shared (cref:MetadataTokenCache.DataStructOpEqualityHandles)
/// dictionary stays on the cache, not on this component, so future
/// consumers (e.g. the operator-lookup path in the body emitter) can keep
/// reading it without needing a reference to `DataStructSynthesizer`.
internal class DataStructSynthesizer {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let conversionEmitter ConversionEmitter
    private let emitPrimaryConstructorBody(StructSymbol) -> int32
    private let encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    private let getElementTypeToken(TypeSymbol) -> EntityHandle
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let nextParameterHandle() -> ParameterHandle
    private let addPrimaryCtorParameters(ImmutableArray[ParameterSymbol]) -> (
        ParameterHandle,
        ImmutableArray[ParameterHandle]
    )
    private let resolveUserTypeToken(StructSymbol) -> EntityHandle
    private let resolveUserFieldToken(StructSymbol, FieldSymbol) -> EntityHandle
    private let resolveUserMethodRef(StructSymbol, EntityHandle, string, BlobBuilder) -> EntityHandle
    private let resolveImportedMethodRef(MethodInfo, TypeSymbol) -> EntityHandle
    private let emitInitializerConstructor(StructSymbol) -> MethodDefinitionHandle
    private let resolveUserInstanceMethodToken(StructSymbol, FunctionSymbol) -> EntityHandle
    private let emitMethodNullability(
        MethodDefinitionHandle,
        MethodNullabilityPlan,
        ParameterHandle?,
        ImmutableArray[ParameterHandle]
    ) -> void
    private let resolveImportedConstructorRef(ConstructorInfo, TypeSymbol?) -> MemberReferenceHandle
    private let resolveUserPropertyAccessorToken(StructSymbol, PropertySymbol, bool) -> EntityHandle
    private let equalityContractGetters Dictionary[StructSymbol, MethodDefinitionHandle] = Dictionary[
        StructSymbol,
        MethodDefinitionHandle
    ]()

    // Per-emit standalone signature cache for the >8-field GetHashCode fold
    // path's local. Mirrors the pre-refactor field on
    // ReflectionMetadataEmitter; instance-scoped because both the cache
    // and the metadata builder it indexes into are per-emit.
    private var hashCodeLocalSig StandaloneSignatureHandle

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        conversionEmitter ConversionEmitter,
        emitPrimaryConstructorBody(StructSymbol) -> int32,
        encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void,
        getElementTypeToken(TypeSymbol) -> EntityHandle,
        getTypeReference(Type) -> TypeReferenceHandle,
        nextParameterHandle() -> ParameterHandle,
        addPrimaryCtorParameters(ImmutableArray[ParameterSymbol]) -> (ParameterHandle, ImmutableArray[ParameterHandle]),
        resolveUserTypeToken(StructSymbol) -> EntityHandle,
        resolveUserFieldToken(StructSymbol, FieldSymbol) -> EntityHandle,
        resolveUserMethodRef(StructSymbol, EntityHandle, string, BlobBuilder) -> EntityHandle,
        resolveImportedMethodRef(MethodInfo, TypeSymbol) -> EntityHandle,
        emitInitializerConstructor(StructSymbol) -> MethodDefinitionHandle,
        resolveUserInstanceMethodToken(StructSymbol, FunctionSymbol) -> EntityHandle,
        emitMethodNullability(
            MethodDefinitionHandle,
            MethodNullabilityPlan,
            ParameterHandle?,
            ImmutableArray[ParameterHandle]
        ) -> void,
        resolveImportedConstructorRef(ConstructorInfo, TypeSymbol?) -> MemberReferenceHandle,
        resolveUserPropertyAccessorToken(StructSymbol, PropertySymbol, bool) -> EntityHandle
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.conversionEmitter = conversionEmitter ?? throw ArgumentNullException("conversionEmitter")
        this.emitPrimaryConstructorBody = emitPrimaryConstructorBody ??
            throw ArgumentNullException("emitPrimaryConstructorBody")
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw ArgumentNullException("encodeTypeSymbol")
        this.getElementTypeToken = getElementTypeToken ?? throw ArgumentNullException("getElementTypeToken")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.nextParameterHandle = nextParameterHandle ?? throw ArgumentNullException("nextParameterHandle")
        this.addPrimaryCtorParameters = addPrimaryCtorParameters ??
            throw ArgumentNullException("addPrimaryCtorParameters")
        this.resolveUserTypeToken = resolveUserTypeToken ?? throw ArgumentNullException("resolveUserTypeToken")
        this.resolveUserFieldToken = resolveUserFieldToken ?? throw ArgumentNullException("resolveUserFieldToken")
        this.resolveUserMethodRef = resolveUserMethodRef ?? throw ArgumentNullException("resolveUserMethodRef")
        this.resolveImportedMethodRef = resolveImportedMethodRef ??
            throw ArgumentNullException("resolveImportedMethodRef")
        this.emitInitializerConstructor = emitInitializerConstructor ??
            throw ArgumentNullException("emitInitializerConstructor")
        this.resolveUserInstanceMethodToken = resolveUserInstanceMethodToken ??
            throw ArgumentNullException("resolveUserInstanceMethodToken")
        this.emitMethodNullability = emitMethodNullability ?? throw ArgumentNullException("emitMethodNullability")
        this.resolveImportedConstructorRef = resolveImportedConstructorRef ??
            throw ArgumentNullException("resolveImportedConstructorRef")
        this.resolveUserPropertyAccessorToken = resolveUserPropertyAccessorToken ??
            throw ArgumentNullException("resolveUserPropertyAccessorToken")
    }

    func EmitInlineStructSynthesizedMembers(structSym StructSymbol) {
        let field = structSym.Fields[0]
        let fieldHandle = this.resolveUserFieldToken(structSym, field)
        let typeDef = this.resolveUserTypeToken(structSym)
        this.cache.ClassPrimaryCtorHandles[structSym] = this.EmitInlineStructConstructor(structSym, field, fieldHandle)
        this.EmitInlineEqualsObject(structSym, field, fieldHandle, typeDef)
        this.EmitInlineEqualsTyped(structSym, field, fieldHandle)
        this.EmitInlineGetHashCode(structSym, field, fieldHandle)
        this.EmitInlineToString(structSym, field, fieldHandle)
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: false)
        this.EmitInlineEqualityOperator(structSym, field, fieldHandle, isInequality: true)
        this.EmitInlineDeconstruct(structSym, field, fieldHandle)
    }

    private func EmitInlineStructConstructor(
        structSym StructSymbol,
        field FieldSymbol,
        fieldHandle EntityHandle
    ) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Stfld)
            il.Token(fieldHandle)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), field.Type)
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Void,
            ImmutableArray.Create(ParameterSymbol(field.Name, field.Type))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
        return synthesizedMethod
    }

    private func FinishInlineBody(il InstructionEncoder) int32 {
        return if this.emitCtx.MetadataOnly {
            -1
        } else {
            this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
    }

    private func EmitInlineEqualsObject(
        structSym StructSymbol,
        field FieldSymbol,
        fieldHandle EntityHandle,
        typeDef EntityHandle
    ) {
        // Issue #420 (P3-10): the IL below uses `unbox` to obtain a managed pointer
        // to the inline struct's field after `isinst`. `unbox` is only legal on
        // value types; if reference-type structs/records are ever introduced,
        // this helper must switch to `castclass` (and skip the boxed indirection
        // entirely). Assert the value-type assumption explicitly so a future
        // reference-type StructSymbol fails loudly in Debug builds instead of
        // silently producing invalid IL.
        Debug.Assert(
            !structSym.IsClass,
            "Equals(object) emit assumes value-type struct; reference-type records require castclass instead of unbox"
        )
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        if !this.emitCtx.MetadataOnly {
            let hasValue = il.DefineLabel()
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Isinst)
            il.Token(typeDef)
            il.OpCode(ILOpCode.Dup)
            il.Branch(ILOpCode.Brtrue, hasValue)
            il.OpCode(ILOpCode.Pop)
            il.LoadConstantI4(0)
            il.OpCode(ILOpCode.Ret)
            il.MarkLabel(hasValue)
            il.OpCode(ILOpCode.Pop)
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Unbox)
            il.Token(typeDef)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.Call(this.wellKnown.GetObjectStaticEqualsReference())
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> ps.AddParameter().Type().Object()
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(ParameterSymbol("obj", NullableTypeSymbol.Get(TypeSymbol.Object)))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("Equals"),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    private func EmitInlineEqualsTyped(structSym StructSymbol, field FieldSymbol, fieldHandle EntityHandle) {
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
            "EmitInlineEqualsTyped precondition violated: StructSymbol must be a value-type struct — see issue #420 / P3-10."
        )
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.LoadArgumentAddress(1)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.Call(this.wellKnown.GetObjectStaticEqualsReference())
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(ParameterSymbol("other", structSym))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("Equals"),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    private func EmitInlineGetHashCode(structSym StructSymbol, field FieldSymbol, fieldHandle EntityHandle) {
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetObjectInstanceGetHashCodeReference())
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Int32(),
            (_ ParametersEncoder) -> { }
        )
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.Int32, ImmutableArray[ParameterSymbol].Empty)
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("GetHashCode"),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    private func EmitInlineToString(structSym StructSymbol, field FieldSymbol, fieldHandle EntityHandle) {
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(structSym.Name + "(" + field.Name + "="))
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetObjectInstanceToStringReference())
            il.Call(this.wellKnown.GetStringConcatReference())
            il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(")"))
            il.Call(this.wellKnown.GetStringConcatReference())
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().String(),
            (_ ParametersEncoder) -> { }
        )
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.String, ImmutableArray[ParameterSymbol].Empty)
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("ToString"),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    private func EmitInlineEqualityOperator(
        structSym StructSymbol,
        field FieldSymbol,
        fieldHandle EntityHandle,
        isInequality bool
    ) {
        // Issue #420 / #455 (P3-10): the emitted IL uses `ldarga` on both
        // operands to read fields directly, which requires the operands to be
        // value-type structs. If reference-type structs/records are ever
        // introduced this helper must switch to `ldarg` / `ldfld` chains and
        // re-encode the parameter signature; assert the value-type precondition
        // explicitly so any future change trips loudly in Debug.
        Debug.Assert(
            !structSym.IsClass,
            "EmitInlineEqualityOperator precondition violated: StructSymbol must be a value-type struct — see issue #420 / P3-10."
        )
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            il.LoadArgumentAddress(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.LoadArgumentAddress(1)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
            il.Call(this.wellKnown.GetObjectStaticEqualsReference())
            if isInequality {
                il.LoadConstantI4(0)
                il.OpCode(ILOpCode.Ceq)
            }
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> {
                this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
                this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
            }
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(ParameterSymbol("left", structSym), ParameterSymbol("right", structSym))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this
                .emitCtx
                .Metadata
                .GetOrAddString(
                if isInequality {
                    "op_Inequality"
                } else {
                    "op_Equality"
                }
            ),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    private func EmitInlineDeconstruct(structSym StructSymbol, field FieldSymbol, fieldHandle EntityHandle) {
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            il.LoadArgument(1)
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Ldfld)
            il.Token(fieldHandle)
            // ADR-0087 §3 R3: TypeParameterSymbol fields are now encoded
            // as VAR(idx) (not erased to Object); the indirect store
            // must use `Stobj` against the VAR TypeSpec, not `Stind_ref`.
            if field.Type is TypeParameterSymbol || ReflectionMetadataEmitter.IsValueTypeSymbol(field.Type) {
                il.OpCode(ILOpCode.Stobj)
                il.Token(this.getElementTypeToken(field.Type))
            } else {
                il.OpCode(ILOpCode.Stind_ref)
            }
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(isByRef: true), field.Type)
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Void,
            ImmutableArray.Create(ParameterSymbol(field.Name, field.Type, refKind: RefKind.Out))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("Deconstruct"),
            this.emitCtx.Metadata.GetOrAddBlob(sig),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    /// Issue #410 / ADR-0029: emits the synthesized members for a
    /// `data struct` type — up to seven, depending on which are
    /// applicable: `Equals(Name)`, `Equals(object)`,
    /// `GetHashCode`, `ToString`, `op_Equality`,
    /// `op_Inequality`, `Deconstruct`. The MethodDef rows are
    /// added in a fixed order so they align 1:1 with the rows reserved by
    /// the method-row planner.
    /// `Equals(Name)` is emitted first so its MethodDef handle is
    /// available when `Equals(object)` is emitted.
    /// Issue #2361: when the type declares a compatible hand-written
    /// `ToString` ((cref:HasUserToStringOverride)), the
    /// synthesized `ToString` body/row is skipped here — the user's own
    /// method is emitted through the ordinary user-method path instead,
    /// taking over that vtable slot (see
    /// `ReflectionMetadataEmitter.EmitFunction`'s
    /// `isDataToStringOverride` handling for the Virtual/Final
    /// attributes that make the slot line up with the synthesized siblings).
    /// Issue #2363: `Deconstruct` is skipped entirely for a type with no
    /// logical deconstruction members
    /// type ((cref:HasZeroDeconstructionMembers)) — there is nothing to
    /// deconstruct. The two skips are independent and compose: a zero-field
    /// type with a user ToString override emits five rows.
    /// @param structSym The data-struct symbol to emit members for.
    func EmitDataStructSynthesizedMembers(structSym StructSymbol) {
        let typeDef = this.resolveUserTypeToken(structSym)
        if structSym.IsClass {
            let equalityContractGetter = this.EmitDataClassEqualityContractGetter(structSym)
            this.equalityContractGetters[structSym] = equalityContractGetter
            let copyConstructor = this.EmitDataClassCopyConstructor(structSym)
            this.EmitDataClassClone(structSym, copyConstructor)
        }
        let equalsTypedHandle = this.EmitDataStructEqualsTyped(structSym)
        this.cache.MethodHandles[structSym.DataEqualsSelf] = equalsTypedHandle
        this.EmitDataStructEqualsObject(structSym, typeDef, equalsTypedHandle)
        if structSym.DataEqualsBase is {} baseEquals {
            this.EmitDataClassEqualsBase(structSym, baseEquals)
        }
        this.EmitDataStructGetHashCode(structSym)
        // Issue #2361: skip the synthesized ToString body/row when the type
        // declares a compatible hand-written one — it is emitted through the
        // ordinary user-method path instead (see EmitClassMethodBodies /
        // EmitStructMethodBodies), which now reserves only six synthesized
        // rows for this type (see PlanClassMethods / PlanStructMethods).
        if !HasUserToStringOverride(structSym) {
            this.EmitDataStructToString(structSym)
        }
        this.cache.DataStructOpEqualityHandles[structSym] = this.EmitDataStructEqualityOperator(
            structSym,
            isInequality: false
        )
        this.EmitDataStructEqualityOperator(structSym, isInequality: true)
        // Issue #2363 / ADR-0029: `Deconstruct` is skipped entirely for a
        // data class/struct with no logical members — there is nothing to deconstruct, and
        // a `Deconstruct()` overload with zero `out` parameters would be
        // meaningless (no arity ever binds to it). The row-count planner
        // (ReflectionMetadataEmitter) reserves one fewer MethodDef row for
        // such types to match.
        if !HasZeroDeconstructionMembers(structSym) {
            this.EmitDataStructDeconstruct(structSym)
        }
        // ADR-0199: the C#-record `PrintMembers(StringBuilder)` slot. It is the
        // LAST synthesized row (after Deconstruct) in both the class and the
        // struct planner, and is skipped when the type declares its own
        // (emitted through the ordinary user-method path) or is an anonymous
        // literal.
        if structSym.DataPrintMembers is {} printMembersSlot {
            this.EmitDataStructPrintMembers(structSym, printMembersSlot)
        }
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
        if !structSym.IsClass && structSym.HasDeclaredPrimaryConstructor {
            this.cache.ClassPrimaryCtorHandles[structSym] = this.EmitDataStructPrimaryConstructor(structSym)
        }
    }

    func EmitDataClassEqualityContractProperty(structSym StructSymbol) {
        let signature = BlobBuilder()
        BlobEncoder(signature).PropertySignature(isInstanceProperty: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Type(
                this.getTypeReference(this.emitCtx.CoreSystemType),
                isValueType: false
            ),
            (_ ParametersEncoder) -> { }
        )
        let property = this
            .emitCtx
            .Metadata
            .AddProperty(
            PropertyAttributes.None,
            this.emitCtx.Metadata.GetOrAddString("EqualityContract"),
            this.emitCtx.Metadata.GetOrAddBlob(signature)
        )
        this
            .emitCtx
            .Metadata
            .AddMethodSemantics(property, MethodSemanticsAttributes.Getter, this.equalityContractGetters[structSym])
        let typeDef = this.cache.StructTypeDefs[structSym]
        if this.cache.TypesWithPropertyMap.Add(typeDef) {
            this.emitCtx.Metadata.AddPropertyMap(typeDef, property)
        }
    }

    private func EmitDataClassEqualityContractGetter(structSym StructSymbol) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.OpCode(ILOpCode.Ldtoken)
            il.Token(this.resolveUserTypeToken(structSym))
            il.Call(this.wellKnown.GetTypeFromHandleReference())
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Type(
                this.getTypeReference(this.emitCtx.CoreSystemType),
                isValueType: false
            ),
            (_ ParametersEncoder) -> { }
        )
        var attributes = MethodAttributes.HideBySig | MethodAttributes.SpecialName
        if structSym.BaseClass?.IsData == true {
            attributes |= MethodAttributes.Family | MethodAttributes.Virtual
        } else if IsDataTypeSealed(structSym) {
            attributes |= MethodAttributes.Private
        } else {
            attributes |= MethodAttributes.Family | MethodAttributes.Virtual | MethodAttributes.NewSlot
        }
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.FromClrTypeWithoutNullability(
                this.emitCtx.CoreSystemType,
                NullabilityFreeReason.CompilerProduced
            ),
            ImmutableArray[ParameterSymbol].Empty
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("get_EqualityContract"),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
        return synthesizedMethod
    }

    /// Emits the copy constructor shared by data classes and non-data
    /// intermediary classes in a data-class inheritance chain.
    /// @param structSym The class whose fields are copied.
    /// @returns The emitted copy-constructor MethodDef.
    func EmitDataClassCopyConstructor(structSym StructSymbol) MethodDefinitionHandle {
        // Validate reference-only output too; only an actual object-root class
        // may use Object::.ctor instead of copying its direct base subobject.
        let hasBaseCopyConstructor = this.TryResolveBaseCopyConstructorToken(structSym, out var baseCopyConstructor)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            if hasBaseCopyConstructor {
                il.LoadArgument(1)
                il.OpCode(ILOpCode.Call)
                il.Token(baseCopyConstructor)
            } else {
                il.OpCode(ILOpCode.Call)
                il.Token(this.wellKnown.ObjectCtorRef)
            }
            for field in GetSynthesisFields(structSym) {
                let fieldHandle = this.resolveUserFieldToken(structSym, field)
                il.LoadArgument(0)
                il.LoadArgument(1)
                il.OpCode(ILOpCode.Ldfld)
                il.Token(fieldHandle)
                il.OpCode(ILOpCode.Stfld)
                il.Token(fieldHandle)
            }
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
        )
        let visibility = if IsDataTypeSealed(structSym) {
            MethodAttributes.Private
        } else {
            MethodAttributes.Family
        }
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Void,
            ImmutableArray.Create(ParameterSymbol("original", structSym))
        )
        let copyConstructor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            visibility | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            synthesizedRows.First
        )
        this.StampSynthesized(copyConstructor, synthesizedRows)
        if this
            .cache
            .DataClassCopyConstructorHandles
            .TryGetValue(structSym, out var plannedCopyConstructor) &&
            copyConstructor != plannedCopyConstructor {
            throw InvalidOperationException(
                "Class '${structSym.Name}' copy-constructor MethodDef row ${MetadataTokens.GetRowNumber(copyConstructor)} did not match the planned row ${MetadataTokens.GetRowNumber(plannedCopyConstructor)}."
            )
        }
        return copyConstructor
    }

    private func EmitDataClassClone(structSym StructSymbol, copyConstructor MethodDefinitionHandle) {
        let hasBaseClone = this.TryResolveBaseCloneToken(structSym, out var baseClone)
        var bodyOffset = -1
        if !structSym.IsAbstract && !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Newobj)
            il.Token(this.ResolveCopyConstructorToken(structSym, copyConstructor))
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> this.encodeTypeSymbol(r.Type(), structSym),
            (_ ParametersEncoder) -> { }
        )
        var attributes = MethodAttributes.Public | MethodAttributes.HideBySig
        if structSym.IsAbstract || hasBaseClone || !IsDataTypeSealed(structSym) {
            // Covariant returns differ at the CLR-signature level. Match
            // Roslyn: emit a new virtual slot, then bind it explicitly to the
            // base clone with a MethodImpl row.
            attributes |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        }
        if structSym.IsAbstract {
            attributes |= MethodAttributes.Abstract
        }
        let synthesizedRows = this.AddSynthesizedRows(structSym, ImmutableArray[ParameterSymbol].Empty)
        let cloneMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("<Clone>$$"),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            synthesizedRows.First
        )
        this.StampSynthesized(cloneMethod, synthesizedRows)
        if this
            .cache
            .DataClassCloneHandles
            .TryGetValue(structSym, out var plannedClone) &&
            cloneMethod != plannedClone {
            throw InvalidOperationException(
                "Data class '${structSym.Name}' <Clone>$$ MethodDef row ${MetadataTokens.GetRowNumber(cloneMethod)} did not match the planned row ${MetadataTokens.GetRowNumber(plannedClone)}."
            )
        }
        if hasBaseClone {
            this.emitCtx.Metadata.AddMethodImplementation(this.cache.StructTypeDefs[structSym], cloneMethod, baseClone)
            let valueBlob = BlobBuilder()
            valueBlob.WriteUInt16(0x0001)
            valueBlob.WriteUInt16(0)
            this
                .emitCtx
                .Metadata
                .AddCustomAttribute(
                cloneMethod,
                this.wellKnown.GetPreserveBaseOverridesAttributeCtorRef(),
                this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
            )
        }
    }

    private func TryResolveBaseCloneToken(structSym StructSymbol, out cloneToken EntityHandle) bool {
        cloneToken = default(EntityHandle)
        let baseClass StructSymbol? = structSym.GetDataCloneAncestor()
        if baseClass == nil {
            return false
        }
        if baseClass.ClrType is {} importedBase {
            var cloneMethod MethodInfo? = nil
            for method in ClrTypeUtilities.SafeGetMethods(
                importedBase,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            ) {
                if method.Name != "<Clone>$$" || method.IsGenericMethod || method.GetParameters()
                    .Length != 0 ||
                    !method.IsVirtual ||
                    !ClrTypeUtilities.AreSame(method.ReturnType, importedBase) {
                    continue
                }
                if cloneMethod != nil {
                    return false
                }
                cloneMethod = method
            }
            if cloneMethod == nil {
                return false
            }
            cloneToken = this.resolveImportedMethodRef(cloneMethod, baseClass)
            return true
        }
        if !this.cache.DataClassCloneHandles.TryGetValue(baseClass.Definition!!, out var baseClone) {
            return false
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(baseClass) {
            cloneToken = baseClone
            return true
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> this.encodeTypeSymbol(r.Type(), baseClass.Definition!!),
            (_ ParametersEncoder) -> { }
        )
        cloneToken = this.resolveUserMethodRef(baseClass, baseClone, "<Clone>$$", signature)
        return true
    }

    private func TryResolveBaseCopyConstructorToken(
        structSym StructSymbol,
        out copyConstructorToken EntityHandle
    ) bool {
        copyConstructorToken = default(EntityHandle)
        let baseClass StructSymbol? = structSym.BaseClass
        if baseClass == nil {
            if structSym.ImportedBaseType is {} importedBase {
                let clrBase = importedBase.ClrType ??
                    throw InvalidOperationException(
                    "Class '${structSym.Name}' imported direct base has no CLR representation."
                )
                if ClrTypeUtilities.AreSame(clrBase, this.emitCtx.CoreObjectType) {
                    return false
                }
                for constructor in ClrTypeUtilities.SafeGetConstructors(
                    clrBase,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                ) {
                    let parameters = constructor.GetParameters()
                    if parameters.Length == 1 &&
                        parameters[0].ParameterType == clrBase &&
                        ClrMemberVisibility
                        .IsVisibleFromDerived(
                        constructor,
                        this.emitCtx.References.CanAccessInternalMembers(clrBase.Assembly)
                    ) {
                        copyConstructorToken = this.resolveImportedConstructorRef(constructor, importedBase)
                        return true
                    }
                }
                throw InvalidOperationException(
                    "Class '${structSym.Name}' has no accessible copy constructor for imported direct base '${importedBase.Name}'."
                )
            }
            return false
        }
        let baseDefinition = baseClass.Definition ?? baseClass
        if !this.cache.DataClassCopyConstructorHandles.TryGetValue(baseDefinition, out var baseCopyConstructor) {
            throw InvalidOperationException(
                "Class '${structSym.Name}' has no planned copy constructor for direct base '${baseClass.Name}'."
            )
        }
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(baseClass) {
            copyConstructorToken = baseCopyConstructor
            return true
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), baseDefinition)
        )
        copyConstructorToken = this.resolveUserMethodRef(baseClass, baseCopyConstructor, ".ctor", signature)
        return true
    }

    /// Rubber-duck follow-up to issue #2224: emits the primary instance
    /// constructor for an anonymous-class literal's synthesized backing type
    /// — `ldarg.0; ldarg.N; stfld <backing field N>` per primary-ctor
    /// parameter, in declaration order, then `ret`. No base-ctor call is
    /// emitted: like every other value-type instance constructor in this
    /// emitter (see `EmitInlineStructConstructor`), a struct ctor never
    /// chains to `System.ValueType::.ctor` in IL.
    private func EmitDataStructPrimaryConstructor(structSym StructSymbol) MethodDefinitionHandle {
        if structSym.NeedsSynthesizedValueStructDefaultCtor && !structSym.ValueStructDefaultCtorIsZeroInitialization {
            return this.emitInitializerConstructor(structSym)
        }
        let parameters = structSym.PrimaryConstructorParameters
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if !structSym.InstanceFieldInitializers.IsEmpty {
                bodyOffset = this.emitPrimaryConstructorBody(structSym)
            } else {
                let il = InstructionEncoder(BlobBuilder())
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Initobj)
                il.Token(this.resolveUserTypeToken(structSym))
                for var i = 0; i < parameters.Length; i++ {
                    if ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(
                        structSym,
                        parameters[i].Name,
                        out var field
                    ) {
                        let fieldHandle = this.resolveUserFieldToken(structSym, field)
                        il.LoadArgument(0)
                        il.LoadArgument(i + 1)
                        il.OpCode(ILOpCode.Stfld)
                        il.Token(fieldHandle)
                    }
                }
                il.OpCode(ILOpCode.Ret)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            parameters.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for param in parameters {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), param.Type)
                }
            }
        )
        // Issue #4988: the rows come from the shared primary-constructor helper
        // (names, `params`, user annotations); their nullability from the plan.
        let (primaryFirst, primaryRows) = this.addPrimaryCtorParameters(parameters)
        let synthesizedRows = SignatureRows(
            primaryFirst,
            MethodNullabilityPlan.ForParameters(TypeSymbol.Void, parameters),
            nil,
            TypeSymbol.Void,
            parameters,
            primaryRows
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
        return synthesizedMethod
    }

    /// Issue #410 / ADR-0029: emits
    /// `public override bool Equals(object other)` that performs
    /// `other is Name p && this.Equals(p)`. The override remains
    /// non-final: sealed owners already prevent derivation, while open data
    /// classes must allow a derived record to re-override it.
    private func EmitDataStructEqualsObject(
        structSym StructSymbol,
        typeDef EntityHandle,
        equalsTypedHandle MethodDefinitionHandle
    ) {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        if !this.emitCtx.MetadataOnly {
            let retFalse = il.DefineLabel()
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Isinst)
            il.Token(typeDef)
            il.Branch(ILOpCode.Brfalse, retFalse)
            il.LoadArgument(0)
            il.LoadArgument(1)
            // Issue #2228: `isinst` re-narrows the reference-typed `other`
            // argument to the data-class type (already validated non-null
            // above by the `isinst`/`brfalse` pair); a data STRUCT's `other`
            // is boxed, so it needs `unbox_any` to copy the value back out.
            il.OpCode(
                if structSym.IsClass {
                    ILOpCode.Isinst
                } else {
                    ILOpCode.Unbox_any
                }
            )
            il.Token(typeDef)
            il.OpCode(ILOpCode.Call)
            il.Token(this.ResolveEqualsTypedToken(structSym, equalsTypedHandle))
            il.OpCode(ILOpCode.Ret)
            il.MarkLabel(retFalse)
            il.LoadConstantI4(0)
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> ps.AddParameter().Type().Object()
        )
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(structSym.DataEqualsObject.Parameters[0])
        )
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: DataObjectOverrideAttributes(structSym),
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(handle, synthesizedRows)
        this.cache.MethodHandles[structSym.DataEqualsObject] = handle
    }

    /// Issue #410 / ADR-0029: emits
    /// `public bool Equals(Name other)` that compares fields in source
    /// declaration order via `EqualityComparer<T>.Default.Equals`,
    /// short-circuiting on the first inequality without boxing field operands.
    /// @returns The MethodDef handle of the emitted method, so callers can
    /// reference it from other synthesized members.
    private func EmitDataStructEqualsTyped(structSym StructSymbol) MethodDefinitionHandle {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        if !this.emitCtx.MetadataOnly {
            let retFalse = il.DefineLabel()
            // Issue #2228: a data-class `other` is a reference and may be
            // null (a data-struct's `other` is a value, never null); a null
            // `other` is unequal to `this` (record-class semantics).
            if structSym.IsClass {
                il.LoadArgument(1)
                il.Branch(ILOpCode.Brfalse, retFalse)
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Callvirt)
                il.Token(this.ResolveEqualityContractGetterToken(structSym))
                il.LoadArgument(1)
                il.OpCode(ILOpCode.Callvirt)
                il.Token(this.ResolveEqualityContractGetterToken(structSym))
                il.OpCode(ILOpCode.Ceq)
                il.Branch(ILOpCode.Brfalse, retFalse)
                if this.TryResolveDirectBaseEqualsToken(structSym, out var baseEqualsToken) {
                    il.LoadArgument(0)
                    il.LoadArgument(1)
                    il.OpCode(ILOpCode.Call)
                    il.Token(baseEqualsToken)
                    il.Branch(ILOpCode.Brfalse, retFalse)
                }
            }
            let comparerDefault = Invariant.Required(
                typeof(EqualityComparer[object]).GetProperty("Default")?.GetMethod,
                "EqualityComparer<T> declares the Default getter"
            )
            let comparerEquals = Invariant.Required(
                typeof(EqualityComparer[object]).GetMethod("Equals", []Type{typeof(object), typeof(object)}),
                "EqualityComparer<T> declares Equals(T, T)"
            )
            for field in GetSynthesisFields(structSym) {
                let comparer = ImportedTypeSymbol.GetConstructed(
                    typeof(EqualityComparer[object]),
                    typeof(EqualityComparer[_]),
                    ImmutableArray.Create(field.Type)
                )
                let fieldHandle = this.resolveUserFieldToken(structSym, field)
                il.OpCode(ILOpCode.Call)
                il.Token(this.resolveImportedMethodRef(comparerDefault, comparer))
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Ldfld)
                il.Token(fieldHandle)
                // Issue #2228: `other` is already a reference for a data
                // class — `ldfld` reads straight off it. A data struct's
                // `other` is passed by value, so its field is read off the
                // argument's address instead.
                if structSym.IsClass {
                    il.LoadArgument(1)
                } else {
                    il.LoadArgumentAddress(1)
                }
                il.OpCode(ILOpCode.Ldfld)
                il.Token(fieldHandle)
                il.OpCode(ILOpCode.Callvirt)
                il.Token(this.resolveImportedMethodRef(comparerEquals, comparer))
                il.Branch(ILOpCode.Brfalse, retFalse)
            }
            il.LoadConstantI4(1)
            il.OpCode(ILOpCode.Ret)
            il.MarkLabel(retFalse)
            il.LoadConstantI4(0)
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
        )
        var attributes = MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot
        if IsDataTypeSealed(structSym) {
            attributes |= MethodAttributes.Final
        }
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(structSym.DataEqualsSelf.Parameters[0])
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: attributes,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Equals"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
        return synthesizedMethod
    }

    private func EmitDataClassEqualsBase(structSym StructSymbol, method FunctionSymbol) {
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            // The base typed slot must dispatch to the most-derived object
            // equality. Self equality's base-field call remains nonvirtual.
            il.LoadArgument(0)
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Callvirt)
            let objectEquals = Invariant.Required(
                typeof(object).GetMethod("Equals", []Type{typeof(object)}),
                "System.Object declares instance Equals",
                expression: "typeof(object).GetMethod(\"Equals\", new[] { typeof(object) })"
            )
            il.Token(this.resolveImportedMethodRef(objectEquals, TypeSymbol.Object))
            il.OpCode(ILOpCode.Ret)
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), method.Parameters[0].Type)
        )
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.Bool, ImmutableArray.Create(method.Parameters[0]))
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Public | MethodAttributes.Final | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString("Equals"),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            this.FinishInlineBody(il),
            synthesizedRows.First
        )
        this.StampSynthesized(handle, synthesizedRows)
        this.cache.MethodHandles[method] = handle
        if !this.TryResolveDirectBaseEqualsToken(structSym, out var baseEqualsToken) {
            throw InvalidOperationException("Data class '${structSym.Name}' has no direct typed-base equality slot.")
        }
        this.emitCtx.Metadata.AddMethodImplementation(this.cache.StructTypeDefs[structSym], handle, baseEqualsToken)
    }

    private func TryResolveDirectBaseEqualsToken(owner StructSymbol, out token EntityHandle) bool {
        let directBase = DataEqualityMemberModel.GetDirectBase(owner, out var importedMethod)
        token = switch directBase {
            case nil: default(EntityHandle)
            case _ when importedMethod != nil: this.resolveImportedMethodRef(importedMethod!!, directBase!!)
            case sourceBase is StructSymbol: this.resolveUserInstanceMethodToken(sourceBase, sourceBase.DataEqualsSelf)
            default: throw InvalidOperationException(
                "Data class '${owner.Name}' has an unsupported direct equality owner."
            )
        }
        return !token.IsNil
    }

    /// Issue #4988: mints a synthesized member's `Param` rows and plans its
    /// nullability through the same plan every MethodDef uses. Call it
    /// immediately before `AddMethodDefinition` and pass the result to
    /// (cref:StampSynthesized) afterwards.
    /// @param returnType The member's return type.
    /// @param parameters The member's parameters, in order.
    /// @returns The rows and their plan.
    private func AddSynthesizedRows(
        returnType TypeSymbol,
        parameters ImmutableArray[ParameterSymbol]
    ) SignatureRows -> ParameterMetadataEmitter.AddSignatureRows(this.emitCtx, returnType, RefKind.None, parameters)

    /// Issue #4988: stamps the nullability (cref:AddSynthesizedRows) planned.
    /// @param handle The synthesized member's MethodDef.
    /// @param rows The rows minted for it.
    private func StampSynthesized(handle MethodDefinitionHandle, rows SignatureRows) -> this.emitMethodNullability(
        handle,
        rows.Nullability,
        rows.ReturnRow,
        rows.Rows
    )

    /// Issue #410 / ADR-0029: emits
    /// `public override int GetHashCode()`. For up to 8 fields the
    /// implementation calls field-typed `HashCode.Combine`;
    /// for >8 fields it folds via a stack-allocated
    /// `HashCode` local using field-typed `HashCode.Add` per field
    /// and finishes with `ToHashCode()`.
    private func EmitDataStructGetHashCode(structSym StructSymbol) {
        let fields = GetSynthesisFields(structSym)
        let useFold = fields.Length > 8
        let il = InstructionEncoder(BlobBuilder())
        var localsSignature = default(StandaloneSignatureHandle)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if fields.IsDefaultOrEmpty {
                // Issue #2363: `HashCode.Combine()` has no zero-arity
                // overload, so a zero-field data class/struct can't route
                // through the ordinary fold. All instances of the type are
                // "equal" (see EmitDataStructEqualsTyped), so the hash need
                // only be a fixed constant satisfying the Equals/GetHashCode
                // contract; a deterministic (non-randomized) FNV-1a hash of
                // the type name gives distinct constants across distinct
                // zero-field types instead of colliding them all on the same
                // value.
                il.LoadConstantI4(unchecked(int32(Fnv1aHash(structSym.Name))))
                il.OpCode(ILOpCode.Ret)
            } else if !useFold {
                for field in fields {
                    let fieldHandle = this.resolveUserFieldToken(structSym, field)
                    il.LoadArgument(0)
                    il.OpCode(ILOpCode.Ldfld)
                    il.Token(fieldHandle)
                }
                il.OpCode(ILOpCode.Call)
                il.Token(this.GetHashCodeCombineSpec(fields))
                il.OpCode(ILOpCode.Ret)
            } else {
                // ldloca.s 0; initobj HashCode
                il.LoadLocalAddress(0)
                il.OpCode(ILOpCode.Initobj)
                il.Token(this.wellKnown.GetHashCodeTypeReference())
                for field in fields {
                    let fieldHandle = this.resolveUserFieldToken(structSym, field)
                    il.LoadLocalAddress(0)
                    il.LoadArgument(0)
                    il.OpCode(ILOpCode.Ldfld)
                    il.Token(fieldHandle)
                    il.OpCode(ILOpCode.Call)
                    il.Token(this.GetHashCodeAddSpec(field.Type))
                }
                il.LoadLocalAddress(0)
                il.Call(this.wellKnown.GetHashCodeToHashCodeReference())
                il.OpCode(ILOpCode.Ret)
                localsSignature = this.GetHashCodeLocalSignature()
            }
            bodyOffset = this
                .emitCtx
                .MethodBodyStream
                .AddMethodBody(
                il,
                maxStack: MaxStackTracker.ComputeMaxStack(il),
                localVariablesSignature: localsSignature
            )
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Int32(),
            (_ ParametersEncoder) -> { }
        )
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.Int32, ImmutableArray[ParameterSymbol].Empty)
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: DataObjectOverrideAttributes(structSym),
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("GetHashCode"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    /// ADR-0199: emits the C#-record `PrintMembers(StringBuilder)`: it
    /// first lets the base slot print (writing `", "` only when the base
    /// printed something), then writes `Name = value` for every printable
    /// member, and returns whether anything was printed. Values are rendered
    /// with `ToString()` under the current culture, exactly as Roslyn's
    /// synthesized member does (see (cref:EmitAppendMember)).
    private func EmitDataStructPrintMembers(structSym StructSymbol, slot FunctionSymbol) {
        let members = DataPrintMembersModel.GetPrintableMembers(structSym)
        let hasBase = this.TryResolveBasePrintMembersToken(structSym, out var baseToken)
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let temps = List[TypeSymbol]()
        var localsSignature = default(StandaloneSignatureHandle)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if hasBase && members.IsDefaultOrEmpty {
                il.LoadArgument(0)
                il.LoadArgument(1)
                il.OpCode(ILOpCode.Call)
                il.Token(baseToken)
                il.OpCode(ILOpCode.Ret)
            } else {
                if hasBase {
                    let basePrintedNothing = il.DefineLabel()
                    il.LoadArgument(0)
                    il.LoadArgument(1)
                    il.OpCode(ILOpCode.Call)
                    il.Token(baseToken)
                    il.Branch(ILOpCode.Brfalse, basePrintedNothing)
                    this.EmitAppendLiteral(il, () -> il.LoadArgument(1), ", ")
                    il.MarkLabel(basePrintedNothing)
                }
                for var i = 0; i < members.Length; i++ {
                    this.EmitAppendMember(
                        il,
                        structSym,
                        members[i],
                        () -> il.LoadArgument(1),
                        (
                            if i == 0 {
                                string.Empty
                            } else {
                                ", "
                            }
                        ) +
                            members[i].Name +
                            " = ",
                        temps,
                        firstTempIndex: 0
                    )
                }
                il.LoadConstantI4(
                    if members.IsDefaultOrEmpty {
                        0
                    } else {
                        1
                    }
                )
                il.OpCode(ILOpCode.Ret)
            }
            localsSignature = this.BuildLocalsSignature(includeBuilder: false, temps)
            bodyOffset = this
                .emitCtx
                .MethodBodyStream
                .AddMethodBody(
                il,
                maxStack: MaxStackTracker.ComputeMaxStack(il),
                localVariablesSignature: localsSignature
            )
        }
        let builderRef = this.wellKnown.GetStringBuilderTypeReference()
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> ps.AddParameter().Type().Type(builderRef, isValueType: false)
        )
        var attributes = MethodAttributes.HideBySig
        if IsPrintMembersVirtual(structSym) {
            attributes |= MethodAttributes.Family | MethodAttributes.Virtual
            if IsPrintMembersNewSlot(structSym) {
                attributes |= MethodAttributes.NewSlot
            }
        } else {
            attributes |= MethodAttributes.Private
        }
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.Bool, ImmutableArray.Create(slot.Parameters[0]))
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: attributes,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(DataPrintMembersModel.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(handle, synthesizedRows)
        if this.cache.MethodHandles.TryGetValue(slot, out var planned) && planned != handle {
            throw InvalidOperationException(
                "Data type '${structSym.Name}' PrintMembers MethodDef row ${MetadataTokens.GetRowNumber(handle)} did not match the planned row ${MetadataTokens.GetRowNumber(planned)}."
            )
        }
    }

    private func TryResolveBasePrintMembersToken(structSym StructSymbol, out token EntityHandle) bool {
        if DataPrintMembersModel.IsBaseSlotAbstract(structSym) {
            // An abstract base slot has no body to call; the override still reuses its slot.
            token = default(EntityHandle)
            return false
        }
        let directBase = DataPrintMembersModel.GetBase(structSym, out var importedMethod)
        token = switch directBase {
            case nil: default(EntityHandle)
            case _ when importedMethod != nil: this.resolveImportedMethodRef(importedMethod!!, directBase!!)
            case sourceBase is StructSymbol: this.resolveUserInstanceMethodToken(
                sourceBase,
                GetPrintMembersSlot(sourceBase)
            )
            default: throw InvalidOperationException(
                "Data class '${structSym.Name}' has an unsupported print-members base."
            )
        }
        return !token.IsNil
    }

    /// Appends a string literal to the builder produced by [`loadBuilder`](paramref).
    private func EmitAppendLiteral(il InstructionEncoder, loadBuilder() -> void, text string) {
        loadBuilder()
        il.LoadString(this.emitCtx.Metadata.GetOrAddUserString(text))
        il.OpCode(ILOpCode.Callvirt)
        il.Token(this.wellKnown.GetStringBuilderAppendStringReference())
        il.OpCode(ILOpCode.Pop)
    }

    /// Appends [`label`](paramref) and then the member's value to the
    /// builder produced by [`loadBuilder`](paramref), as Roslyn's
    /// synthesized `PrintMembers` does: a non-nullable value-typed member
    /// (or a value-type-constrained type parameter) is rendered by a
    /// `constrained.` `ToString()` call on its address, so a
    /// mutating `ToString` and a ref-like value are honoured; any other
    /// member (references, unconstrained type parameters, `Nullable<T>`)
    /// is appended as `object`, where null prints nothing. A value-typed
    /// property or readonly field is copied into a temporary so its address can
    /// be taken without exposing the original to a mutating `ToString`.
    private func EmitAppendMember(
        il InstructionEncoder,
        structSym StructSymbol,
        member DataPrintMembersModel.PrintableMember,
        loadBuilder() -> void,
        label string,
        temps List[TypeSymbol],
        firstTempIndex int32
    ) {
        this.EmitAppendLiteral(il, loadBuilder, label)
        loadBuilder()
        let type = member.Type
        let printsThroughAddress = ReflectionMetadataEmitter.IsValueTypeSymbol(type) && !(type is NullableTypeSymbol)
        if member.Field is {} field {
            // A readonly field is copied before ToString runs, as C# does: taking
            // its address would let a mutating ToString change the readonly field.
            let copiesReadonlyField = printsThroughAddress && field.IsReadOnly
            il.LoadArgument(0)
            il.OpCode(
                if printsThroughAddress && !copiesReadonlyField {
                    ILOpCode.Ldflda
                } else {
                    ILOpCode.Ldfld
                }
            )
            il.Token(this.resolveUserFieldToken(structSym, field))
            if copiesReadonlyField {
                let temp = firstTempIndex + temps.Count
                temps.Add(type)
                il.StoreLocal(temp)
                il.LoadLocalAddress(temp)
            }
        } else {
            let property = Invariant.Required(
                member.Property,
                "a printable member is a field or a property",
                expression: "member.Property"
            )
            il.LoadArgument(0)
            il.OpCode(
                if property.IsVirtual || property.IsOverride || property.IsAbstract {
                    ILOpCode.Callvirt
                } else {
                    ILOpCode.Call
                }
            )
            il.Token(this.resolveUserPropertyAccessorToken(structSym, property, false))
            if property.ReturnRefKind != RefKind.None {
                // A ref-returning getter leaves the value's address. A mutable ref to a
                // value type is printed through it directly; a readonly ref is copied
                // first (C# makes a defensive copy); anything else is loaded through it.
                let copiesReadonlyRef = printsThroughAddress && property.ReturnRefKind != RefKind.Ref
                if !printsThroughAddress || copiesReadonlyRef {
                    il.OpCode(ILOpCode.Ldobj)
                    il.Token(this.getElementTypeToken(type))
                }
                if copiesReadonlyRef {
                    let temp = firstTempIndex + temps.Count
                    temps.Add(type)
                    il.StoreLocal(temp)
                    il.LoadLocalAddress(temp)
                }
            } else if printsThroughAddress {
                let temp = firstTempIndex + temps.Count
                temps.Add(type)
                il.StoreLocal(temp)
                il.LoadLocalAddress(temp)
            }
        }
        if printsThroughAddress {
            il.OpCode(ILOpCode.Constrained)
            il.Token(this.getElementTypeToken(type))
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetObjectInstanceToStringReference())
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetStringBuilderAppendStringReference())
        } else {
            this.conversionEmitter.EmitBoxIfNeeded(il, type)
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetStringBuilderAppendObjectReference())
        }
        il.OpCode(ILOpCode.Pop)
    }

    /// Builds the standalone local-variable signature of a synthesized
    /// print body: an optional leading `StringBuilder` followed by one
    /// temporary per value-typed property that was read through its address.
    private func BuildLocalsSignature(includeBuilder bool, temps List[TypeSymbol]) StandaloneSignatureHandle {
        let count = temps.Count +
            (
            if includeBuilder {
                1
            } else {
                0
            }
        )
        if count == 0 {
            return default(StandaloneSignatureHandle)
        }
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).LocalVariableSignature(count)
        if includeBuilder {
            encoder.AddVariable().Type().Type(this.wellKnown.GetStringBuilderTypeReference(), isValueType: false)
        }
        for temp in temps {
            this.encodeTypeSymbol(encoder.AddVariable().Type(), temp)
        }
        return this.emitCtx.Metadata.AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// ADR-0199: emits `public override string ToString()` in the C#
    /// record format. A declared data type renders `Name { X = 1, Y = 2 }`
    /// (`Name { }` when empty) by building the text in a
    /// (cref:System.Text.StringBuilder) around its `PrintMembers` slot, so
    /// derived types contribute the inherited members. An anonymous literal
    /// renders the C# anonymous-type form `{ X = 1, Y = 2 }` with no type
    /// name and no `PrintMembers`.
    private func EmitDataStructToString(structSym StructSymbol) {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let temps = List[TypeSymbol]()
        var localsSignature = default(StandaloneSignatureHandle)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            il.OpCode(ILOpCode.Newobj)
            il.Token(this.wellKnown.GetStringBuilderCtorReference())
            il.StoreLocal(0)
            let LoadBuilder = func () {
                il.LoadLocal(0)
            }
            if structSym.IsAnonymousLiteral {
                let members = DataPrintMembersModel.GetPrintableMembers(structSym)
                if members.IsDefaultOrEmpty {
                    this.EmitAppendLiteral(il, LoadBuilder, "{ }")
                } else {
                    this.EmitAppendLiteral(il, LoadBuilder, "{ ")
                    for var i = 0; i < members.Length; i++ {
                        this.EmitAppendMember(
                            il,
                            structSym,
                            members[i],
                            LoadBuilder,
                            (
                                if i == 0 {
                                    string.Empty
                                } else {
                                    ", "
                                }
                            ) +
                                members[i].Name +
                                " = ",
                            temps,
                            firstTempIndex: 1
                        )
                    }
                    this.EmitAppendLiteral(il, LoadBuilder, " }")
                }
            } else {
                let slot = GetPrintMembersSlot(structSym)
                let skipSeparator = il.DefineLabel()
                this.EmitAppendLiteral(il, LoadBuilder, structSym.Name)
                this.EmitAppendLiteral(il, LoadBuilder, " { ")
                il.LoadArgument(0)
                LoadBuilder()
                il.OpCode(
                    if IsPrintMembersVirtual(structSym) {
                        ILOpCode.Callvirt
                    } else {
                        ILOpCode.Call
                    }
                )
                il.Token(this.resolveUserInstanceMethodToken(structSym, slot))
                il.Branch(ILOpCode.Brfalse, skipSeparator)
                this.EmitAppendLiteral(il, LoadBuilder, " ")
                il.MarkLabel(skipSeparator)
                this.EmitAppendLiteral(il, LoadBuilder, "}")
            }
            LoadBuilder()
            il.OpCode(ILOpCode.Callvirt)
            il.Token(this.wellKnown.GetStringBuilderToStringReference())
            il.OpCode(ILOpCode.Ret)
            localsSignature = this.BuildLocalsSignature(includeBuilder: true, temps)
            bodyOffset = this
                .emitCtx
                .MethodBodyStream
                .AddMethodBody(
                il,
                maxStack: MaxStackTracker.ComputeMaxStack(il),
                localVariablesSignature: localsSignature
            )
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().String(),
            (_ ParametersEncoder) -> { }
        )
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.String, ImmutableArray[ParameterSymbol].Empty)
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: DataObjectOverrideAttributes(structSym),
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("ToString"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    /// Issue #410 / ADR-0029: emits
    /// `public static bool op_Equality(Name left, Name right)` (or
    /// `op_Inequality` when [`isInequality`](paramref) is true).
    /// Both delegate to (cref:EmitDataStructEqualsTyped) via
    /// `Object.Equals(object, object)` on every field — equivalent to
    /// calling `left.Equals(right)`, but avoids needing the
    /// MethodDef handle for `Equals(Name)` ahead of time.
    /// @returns The MethodDef handle of the emitted operator.
    private func EmitDataStructEqualityOperator(structSym StructSymbol, isInequality bool) MethodDefinitionHandle {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        if !this.emitCtx.MetadataOnly {
            let retFalse = il.DefineLabel()
            // Issue #2228: both operands of a data-class op_Equality are
            // references and either may be null (record-class semantics:
            // null == null is true; null == non-null is false) — a data
            // struct's operands are values and never null, so this whole
            // block is struct-N/A.
            if structSym.IsClass {
                let leftNotNull = il.DefineLabel()
                let bothNull = il.DefineLabel()
                il.LoadArgument(0)
                il.Branch(ILOpCode.Brtrue, leftNotNull)
                il.LoadArgument(1)
                il.Branch(ILOpCode.Brfalse, bothNull)
                il.Branch(ILOpCode.Br, retFalse)
                il.MarkLabel(bothNull)
                il.LoadConstantI4(
                    if isInequality {
                        0
                    } else {
                        1
                    }
                )
                il.OpCode(ILOpCode.Ret)
                il.MarkLabel(leftNotNull)
                il.LoadArgument(1)
                il.Branch(ILOpCode.Brfalse, retFalse)
                il.LoadArgument(0)
                il.LoadArgument(1)
                il.OpCode(ILOpCode.Callvirt)
                il.Token(this.resolveUserInstanceMethodToken(structSym, structSym.DataEqualsSelf))
                if isInequality {
                    il.LoadConstantI4(0)
                    il.OpCode(ILOpCode.Ceq)
                }
                il.OpCode(ILOpCode.Ret)
                il.MarkLabel(retFalse)
                il.LoadConstantI4(
                    if isInequality {
                        1
                    } else {
                        0
                    }
                )
                il.OpCode(ILOpCode.Ret)
            } else {
                for field in GetSynthesisFields(structSym) {
                    let fieldHandle = this.resolveUserFieldToken(structSym, field)
                    il.LoadArgumentAddress(0)
                    il.OpCode(ILOpCode.Ldfld)
                    il.Token(fieldHandle)
                    this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
                    il.LoadArgumentAddress(1)
                    il.OpCode(ILOpCode.Ldfld)
                    il.Token(fieldHandle)
                    this.conversionEmitter.EmitBoxIfNeeded(il, field.Type)
                    il.Call(this.wellKnown.GetObjectStaticEqualsReference())
                    il.Branch(ILOpCode.Brfalse, retFalse)
                }
                il.LoadConstantI4(
                    if isInequality {
                        0
                    } else {
                        1
                    }
                )
                il.OpCode(ILOpCode.Ret)
                il.MarkLabel(retFalse)
                il.LoadConstantI4(
                    if isInequality {
                        1
                    } else {
                        0
                    }
                )
                il.OpCode(ILOpCode.Ret)
            }
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: false).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> {
                this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
                this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
            }
        )
        // Issue #4988: a data class's operands are references either of which may
        // be nil — the body above tests both, as C#'s record `==(R? left, R? right)`
        // does — so the declared parameters are `R?`. A data struct's are values.
        let operand = if structSym.IsClass {
            cast[TypeSymbol](NullableTypeSymbol.Get(structSym))
        } else {
            cast[TypeSymbol](structSym)
        }
        let synthesizedRows = this.AddSynthesizedRows(
            TypeSymbol.Bool,
            ImmutableArray.Create(ParameterSymbol("left", operand), ParameterSymbol("right", operand))
        )
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.SpecialName | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this
                .emitCtx
                .Metadata
                .GetOrAddString(
                if isInequality {
                    "op_Inequality"
                } else {
                    "op_Equality"
                }
            ),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
        return synthesizedMethod
    }

    private func EmitDataStructDeconstruct(structSym StructSymbol) {
        let members = TypeMemberModel.GetDataDeconstructionMembers(structSym)
        let il = InstructionEncoder(BlobBuilder())
        if !this.emitCtx.MetadataOnly {
            for var i = 0; i < members.Length; i++ {
                let memberType = GetDeconstructionMemberType(members[i])
                let field FieldSymbol? = GetDeconstructionBackingField(members[i])
                il.LoadArgument(i + 1)
                il.LoadArgument(0)
                if field != nil &&
                    members[i] is not(PropertySymbol and {IsVirtual: true}) &&
                    members[i] is not(PropertySymbol and {IsOverride: true}) {
                    il.OpCode(ILOpCode.Ldfld)
                    il.Token(this.resolveUserFieldToken(structSym, field))
                } else {
                    let signature = BlobBuilder()
                    BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
                        0,
                        (result ReturnTypeEncoder) -> {
                            let property = cast[PropertySymbol](members[i])
                            if property.ReturnRefKind == RefKind.RefReadOnly {
                                result.CustomModifiers().AddModifier(
                                    this.wellKnown.GetInAttributeTypeRef(),
                                    isOptional: false
                                )
                            }
                            this.encodeTypeSymbol(
                                result.Type(isByRef: property.ReturnRefKind != RefKind.None),
                                memberType
                            )
                        },
                        (_ ParametersEncoder) -> { }
                    )
                    let getter = this
                        .emitCtx
                        .MetadataRows
                        .AddMemberReference(
                        this.resolveUserTypeToken(structSym),
                        this.emitCtx.Metadata.GetOrAddString("get_" + members[i].Name),
                        this.emitCtx.Metadata.GetOrAddBlob(signature)
                    )
                    il.OpCode(
                        if structSym.IsClass {
                            ILOpCode.Callvirt
                        } else {
                            ILOpCode.Call
                        }
                    )
                    il.Token(getter)
                    if (members[i] is PropertySymbol and {ReturnRefKind: not RefKind.None}) {
                        il.OpCode(ILOpCode.Ldobj)
                        il.Token(this.getElementTypeToken(memberType))
                    }
                }
                // ADR-0087 §3 R3: TypeParameterSymbol fields are now
                // encoded as VAR(idx) (not erased to Object); the
                // indirect store must use `Stobj` against the VAR
                // TypeSpec, not `Stind_ref`.
                if memberType is TypeParameterSymbol {
                    il.OpCode(ILOpCode.Stobj)
                    il.Token(this.getElementTypeToken(memberType))
                } else if ReflectionMetadataEmitter.IsValueTypeSymbol(memberType) {
                    il.OpCode(ILOpCode.Stobj)
                    il.Token(this.getElementTypeToken(memberType))
                } else {
                    il.OpCode(ILOpCode.Stind_ref)
                }
            }
            il.OpCode(ILOpCode.Ret)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            members.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for member in members {
                    this.encodeTypeSymbol(ps.AddParameter().Type(isByRef: true), GetDeconstructionMemberType(member))
                }
            }
        )
        let deconstructParameters = ImmutableArray.CreateBuilder[ParameterSymbol](members.Length)
        for member in members {
            deconstructParameters.Add(
                ParameterSymbol(member.Name, GetDeconstructionMemberType(member), refKind: RefKind.Out)
            )
        }
        let synthesizedRows = this.AddSynthesizedRows(TypeSymbol.Void, deconstructParameters.MoveToImmutable())
        let synthesizedMethod = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Deconstruct"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: this.FinishInlineBody(il),
            parameterList: synthesizedRows.First
        )
        this.StampSynthesized(synthesizedMethod, synthesizedRows)
    }

    /// ADR-0087 §3 R3: resolves the right token for the call to
    /// `Equals(StructType)` from `Equals(object)`. Returns
    /// the bare MethodDef for a non-generic data struct; for a generic
    /// data struct returns a MemberRef parented at the self-instantiation
    /// TypeSpec.
    private func ResolveEqualsTypedToken(
        structSym StructSymbol,
        equalsTypedHandle MethodDefinitionHandle
    ) EntityHandle {
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
            return equalsTypedHandle
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Type().Boolean(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), structSym.Definition ?? structSym)
        )
        return this.resolveUserMethodRef(structSym, equalsTypedHandle, "Equals", sig)
    }

    private func ResolveCopyConstructorToken(
        structSym StructSymbol,
        copyConstructor MethodDefinitionHandle
    ) EntityHandle {
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
            return copyConstructor
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), structSym)
        )
        return this.resolveUserMethodRef(structSym, copyConstructor, ".ctor", signature)
    }

    private func ResolveEqualityContractGetterToken(structSym StructSymbol) EntityHandle {
        let getter = this.equalityContractGetters[structSym]
        if !ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
            return getter
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Type().Type(
                this.getTypeReference(this.emitCtx.CoreSystemType),
                isValueType: false
            ),
            (_ ParametersEncoder) -> { }
        )
        return this.resolveUserMethodRef(structSym, getter, "get_EqualityContract", signature)
    }

    /// Issue #410 / ADR-0029: produces a MethodSpec for
    /// `HashCode.Combine<T1,...,Tn>` with field types in declaration order.
    private func GetHashCodeCombineSpec(fields ImmutableArray[FieldSymbol]) EntityHandle {
        let openRef = this.wellKnown.GetHashCodeCombineOpenReference(fields.Length)
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(fields.Length)
        for field in fields {
            this.encodeTypeSymbol(argsEncoder.AddArgument(), field.Type)
        }
        return this.emitCtx.MetadataRows.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #410 / ADR-0029: produces a MethodSpec for
    /// `HashCode.Add<T>(T)` with the field's type.
    private func GetHashCodeAddSpec(fieldType TypeSymbol) EntityHandle {
        let openRef = this.wellKnown.GetHashCodeAddOpenReference()
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(1)
        this.encodeTypeSymbol(argsEncoder.AddArgument(), fieldType)
        return this.emitCtx.MetadataRows.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #410 / ADR-0029: returns a standalone signature with one
    /// `System.HashCode` local, used by the >8-field
    /// `GetHashCode` fold path.
    private func GetHashCodeLocalSignature() StandaloneSignatureHandle {
        if !this.hashCodeLocalSig.IsNil {
            return this.hashCodeLocalSig
        }
        let hashCodeRef = this.wellKnown.GetHashCodeTypeReference()
        let sigBlob = BlobBuilder()
        let encoder = BlobEncoder(sigBlob).LocalVariableSignature(1)
        encoder.AddVariable().Type().Type(hashCodeRef, isValueType: true)
        this.hashCodeLocalSig = this
            .emitCtx
            .Metadata
            .AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        return this.hashCodeLocalSig
    }

    shared {
        /// Rubber-duck follow-up to issue #2224: the ordered list of backing
        /// (cref:FieldSymbol)s the Equals/GetHashCode/ToString/Deconstruct
        /// synthesis below should read/compare. A user-declared data struct
        /// (ADR-0029) always has plain public (cref:StructSymbol.Fields)
        /// plus every auto-(cref:StructSymbol.Properties) backing field.
        /// This includes property-bodied records and anonymous-class literals.
        /// Issue #2363: since a zero-field data class/struct is now legal, a
        /// user-declared type can ALSO have empty (cref:StructSymbol.Fields)
        /// while still declaring ordinary (non-auto) (cref:StructSymbol.Properties)
        /// — e.g. a virtual/override computed property with no backing field at
        /// all (`PropertySymbol.BackingField == null`). Such properties
        /// don't participate in equality/hash/ToString/Deconstruct (there is
        /// nothing to read), so they are filtered out here rather than added as
        /// a null field entry (which previously crashed field-token resolution).
        private func GetSynthesisFields(structSym StructSymbol) ImmutableArray[FieldSymbol] {
            let builder = ImmutableArray.CreateBuilder[FieldSymbol](
                structSym.Fields.Length + structSym.Properties.Length
            )
            builder.AddRange(structSym.Fields)
            for property in structSym.Properties {
                if property.BackingField != nil && !builder.Contains(property.BackingField!!) {
                    builder.Add(property.BackingField!!)
                }
            }
            return builder.ToImmutable()
        }

        /// Issue #2363: true when [`structSym`](paramref) is a data
        /// class/struct with no logical deconstruction members — used by the
        /// row-count planner
        /// (`ReflectionMetadataEmitter.PlanClassMethods` /
        /// `PlanStructMethods`) to reserve six MethodDef rows instead of
        /// seven, since (cref:EmitDataStructDeconstruct) is skipped for
        /// such a type.
        /// @param structSym The data-struct/data-class symbol to check.
        /// @returns `true` if the type has no deconstruction members; otherwise `false`.
        func HasZeroDeconstructionMembers(structSym StructSymbol) bool -> TypeMemberModel.GetDataDeconstructionMembers(
            structSym
        )
            .IsDefaultOrEmpty

        /// Issue #2361: `true` when [`structSym`](paramref)
        /// declared a compatible hand-written `ToString` (the binder only
        /// ever lets a "ToString"-named method land in
        /// (cref:StructSymbol.Methods) for an `IsData` type when its
        /// shape exactly matches `public string ToString()` — see
        /// `DeclarationBinder.IsCompatibleDataToStringOverride`). Both the
        /// method-row planner (`ReflectionMetadataEmitter.PlanClassMethods` /
        /// `PlanStructMethods`) and (cref:EmitDataStructSynthesizedMembers)
        /// call this so the reserved-row count and the emitted member set agree:
        /// six synthesized rows plus the user's own ToString (emitted through the
        /// ordinary user-method path) instead of seven synthesized rows.
        /// @param structSym The data class/struct symbol to check.
        /// @returns `true` when a compatible user-declared ToString is present.
        func HasUserToStringOverride(structSym StructSymbol) bool {
            return !structSym.Methods.IsDefaultOrEmpty && structSym.Methods.Any(
                (m FunctionSymbol) -> m.Name == "ToString"
            )
        }

        /// Returns the (cref:MethodAttributes) for a synthesized
        /// `Object`-virtual override (`Equals(object)`,
        /// `GetHashCode()`, `ToString()`) on a data type. The containing
        /// TypeDef already prevents further overrides when it is sealed, so these
        /// slots remain non-final, matching Roslyn record metadata.
        private func DataObjectOverrideAttributes(structSym StructSymbol) MethodAttributes {
            var attrs = MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig
            if IsDataObjectOverrideFinal(structSym) {
                attrs |= MethodAttributes.Final
            }
            return attrs
        }

        /// Issue #2361: extracted from (cref:DataObjectOverrideAttributes)
        /// so `ReflectionMetadataEmitter.EmitFunction` can apply the exact
        /// same finality rule to a user-declared `ToString` override on a
        /// data class/struct (which is emitted through the ordinary user-method
        /// path, not through this synthesizer) — the vtable-slot lifecycle for
        /// the "ToString" name must be identical whether the compiler or the
        /// user wrote the body. See the doc comment on
        /// (cref:DataObjectOverrideAttributes) for the full rationale.
        /// @param structSym The data class/struct symbol to check.
        /// @returns `false`; object overrides do not need a redundant final flag.
        func IsDataObjectOverrideFinal(structSym StructSymbol?) bool {
            return false
        }

        private func IsDataTypeSealed(structSym StructSymbol) bool -> !structSym.IsClass ||
            (!structSym.IsOpen && !structSym.IsSealedHierarchy)

        /// ADR-0199: tests whether the synthesized (or hand-written) print-members
        /// slot of [`structSym`](paramref) is a CLR virtual method. A sealed
        /// type that starts the slot keeps it `private` and non-virtual;
        /// every other data class has a `protected virtual` slot.
        /// @param structSym The data type.
        /// @returns `true` when the slot is virtual.
        func IsPrintMembersVirtual(structSym StructSymbol) bool -> DataPrintMembersModel.GetRequiredAccessibility(
            structSym
        ) != Accessibility.Private

        /// ADR-0199: tests whether the print-members slot starts a new vtable slot
        /// (an open root) rather than overriding the base type's slot.
        /// @param structSym The data type.
        /// @returns `true` when the slot is `newslot`.
        func IsPrintMembersNewSlot(structSym StructSymbol) bool -> IsPrintMembersVirtual(structSym) &&
            DataPrintMembersModel.GetBase(structSym, out _) == nil

        /// Gets the synthesized or hand-written print-members slot of a declared data type.
        private func GetPrintMembersSlot(structSym StructSymbol) FunctionSymbol -> DataPrintMembersModel.FindDeclared(
            structSym
        ) ??
            Invariant
            .Required(
            structSym.DataPrintMembers,
            "a data type owns a print-members slot",
            expression: "structSym.DataPrintMembers"
        )

        private func GetDeconstructionMemberType(member Symbol) TypeSymbol -> switch member {
            case field is FieldSymbol: field.Type
            case property is PropertySymbol: property.Type
            default: TypeSymbol.Error
        }

        private func GetDeconstructionBackingField(member Symbol) FieldSymbol? -> switch member {
            case field is FieldSymbol: field
            case property is PropertySymbol: property.BackingField
            default: default(FieldSymbol?)
        }

        /// Issue #2363: a deterministic (build-reproducible, not process-
        /// randomized) 32-bit FNV-1a hash of [`value`](paramref), used as
        /// the fixed `GetHashCode()` constant for a zero-field data
        /// class/struct. Unlike (cref:string.GetHashCode()) (randomized
        /// per process by default), this always produces the same IL constant
        /// for the same type name across builds.
        private func Fnv1aHash(value string) uint32 {
            const offsetBasis = 2166136261U
            const prime uint32 = uint32(16777619)
            var hash = offsetBasis
            for c in value {
                hash ^= uint32(c)
                hash *= prime
            }
            return hash
        }
    }
}
