// <copyright file="ConstructorBodyEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// PR-E-15 (#1361): constructor-body-bytes emitter. Owns the band that builds
/// the raw IL bodies for every synthesized or user-authored constructor shape:
/// static constructors (class and interface `.cctor`s, issue #262 /
/// #1030), the default/primary/base-initializer/explicit-body instance
/// constructors (issues #640/#306), and the class deinitializer (`Finalize`
/// override, ADR-0068 / issue #698), plus the instance-field-initializer
/// statement builders they all share.
/// @remarks Wired with a back-reference to the root emitter (the MethodBodyEmitter /
/// InterfaceImplEmitter idiom) because the bodies construct the still-private
/// (cref:ReflectionMetadataEmitter).`MethodBodyEmitSession` scaffold
/// (widened `private` → `internal` for this extraction) and resolve
/// field tokens via (cref:UserTokenResolver.ResolveFieldToken).
/// Direct fields hold the shared (cref:EmitContext) and
/// (cref:MetadataTokenCache); the interface-`.cctor` MethodDef's
/// parameter-list anchor comes in through the `nextParameterHandle`
/// callback (the same (cref:CustomAttributeEncoder.NextParameterHandle)
/// method-group TypeDefEmitter already receives).
///
/// The mutable `currentStaticConstructorOwner` flag (Issue #1525: which
/// type's `.cctor` is being emitted, consulted by
/// (cref:ReflectionMetadataEmitter.IsStaticFieldAddressLegalHere) for
/// the `initonly`-static-field receiver-spill decision) moved to
/// (cref:EmitContext.CurrentStaticConstructorOwner) so both this emitter
/// (which sets it) and the root predicate (which reads it) share one location.
/// Method bodies are verbatim moves; emitted PEs are byte-identical with the
/// pre-E-15 baseline.
internal class ConstructorBodyEmitter {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let nextParameterHandle() -> ParameterHandle

    init(outer ReflectionMetadataEmitter, nextParameterHandle() -> ParameterHandle) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
        this.nextParameterHandle = nextParameterHandle ?? throw ArgumentNullException("nextParameterHandle")
    }

    /// Issue #262: builds the IL body for a static constructor (`.cctor`)
    /// that runs each (cref:StructSymbol.StaticFieldInitializers) in
    /// declaration order. Returns the resulting body offset.
    internal func EmitStaticConstructorBodyBytes(typeSym StructSymbol) int32 {
        if TryEmitInitialization(
            typeSym,
            isStatic: true,
            default(EntityHandle),
            default(ImmutableArray[RefKind]),
            out var planned
        ) {
            return planned
        }
        // Build a synthetic body: for each field with an initializer,
        // emit the expression + stsfld.
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        for field in typeSym.ConstFields {
            if ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(field.ConstantValue) {
                let assignment = BoundFieldAssignmentExpression(
                    nil,
                    receiver: nil,
                    typeSym,
                    field,
                    BoundLiteralExpression(nil, field.ConstantValue, field.Type)
                )
                statements.Add(BoundExpressionStatement(nil, assignment))
            }
        }
        for field in typeSym.StaticFields {
            if typeSym.StaticFieldInitializers.TryGetValue(field, out var initExpr) {
                // Synthesize: field = initExpr (as an expression statement).
                let assignment = BoundFieldAssignmentExpression(nil, nil, typeSym, field, initExpr)
                statements.Add(BoundExpressionStatement(nil, assignment))
            }
        }
        // ADR-0140 / issue #2131: append the type's `shared { init { … } }`
        // static-initializer statements after the field initializers, in source
        // order, so they run as part of the same `.cctor` (matching a C# static
        // constructor whose body follows the field initializers).
        if typeSym.HasStaticInitializerBlock {
            statements.AddRange(typeSym.StaticInitializerStatements)
        }
        let body = Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable()), typeSym)
        let previousOwner = this.emitCtx.CurrentStaticConstructorOwner
        this.emitCtx.CurrentStaticConstructorOwner = typeSym
        try {
            return this.EmitStaticConstructorBodyFromBlock(
                body,
                Invariant.Required(
                    typeSym.Declaration,
                    "a user static initializer has a declaration",
                    expression: "typeSym.Declaration"
                )
            )
        } finally {
            this.emitCtx.CurrentStaticConstructorOwner = previousOwner
        }
    }

    /// ADR-0089 / issue #1030: emits the interface `.cctor` (type
    /// initializer) running the interface's static-field initializers. Mirrors
    /// `TypeDefEmitter.EmitStaticConstructor` but resolves the body via the
    /// interface-specific body-bytes helper. The MethodDef lands in the row
    /// reserved by PlanInterfaceMethods (last in the interface's method run).
    /// @param ifaceSym The interface whose static constructor is emitted.
    internal func EmitInterfaceStaticConstructor(ifaceSym InterfaceSymbol) {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = this.EmitInterfaceStaticConstructorBodyBytes(ifaceSym)
        }
        let cctorSig = BlobBuilder()
        BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// Emits the package `<Program>` initializer for constants that require runtime storage.
    /// @param package The package whose `<Program>` owns the fields.
    /// @param constants Constants represented by static read-only fields.
    internal func EmitProgramStaticConstructor($package PackageSymbol, constants ImmutableArray[GlobalVariableSymbol]) {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let statements = ImmutableArray.CreateBuilder[BoundStatement](constants.Length)
            for constant in constants {
                let assignment = BoundAssignmentExpression(
                    nil,
                    constant,
                    BoundLiteralExpression(nil, constant.ConstantValue, constant.Type)
                )
                statements.Add(BoundExpressionStatement(nil, assignment))
            }
            let body = Lowerer.Lower(BoundBlockStatement(nil, statements.MoveToImmutable()))
            let previousOwner = this.emitCtx.CurrentStaticConstructorOwner
            this.emitCtx.CurrentStaticConstructorOwner = $package
            try {
                bodyOffset = this.EmitStaticConstructorBodyFromBlock(
                    body,
                    Invariant.Required(
                        constants[0].DeclaringSyntax,
                        "a package constant has declaring syntax",
                        expression: "constants[0].DeclaringSyntax"
                    )
                )
            } finally {
                this.emitCtx.CurrentStaticConstructorOwner = previousOwner
            }
        }
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: false).Parameters(
            0,
            (returns ReturnTypeEncoder) -> returns.Void(),
            (_ ParametersEncoder) -> { }
        )
        this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// ADR-0089 / issue #1030: builds the IL body for an interface
    /// `.cctor` running each interface static-field initializer in
    /// declaration order. Interface static fields are plain CLR static fields,
    /// so the synthesized assignment carries a `null` declaring struct and
    /// the emitter resolves the field handle by symbol identity.
    /// @param ifaceSym The interface whose static initializers run.
    /// @returns The resulting method body offset.
    private func EmitInterfaceStaticConstructorBodyBytes(ifaceSym InterfaceSymbol) int32 {
        if TryEmitInitialization(
            ifaceSym,
            isStatic: true,
            default(EntityHandle),
            default(ImmutableArray[RefKind]),
            out var planned
        ) {
            return planned
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        for field in ifaceSym.ConstFields {
            if ConstantFieldMetadataEmitter.RequiresRuntimeInitialization(field.ConstantValue) {
                let assignment = BoundFieldAssignmentExpression(
                    nil,
                    field,
                    ifaceSym,
                    BoundLiteralExpression(nil, field.ConstantValue, field.Type)
                )
                statements.Add(BoundExpressionStatement(nil, assignment))
            }
        }
        for field in ifaceSym.StaticFields {
            if ifaceSym.StaticFieldInitializers.TryGetValue(field, out var initExpr) {
                let assignment = BoundFieldAssignmentExpression(nil, field, ifaceSym, initExpr)
                statements.Add(BoundExpressionStatement(nil, assignment))
            }
        }
        let body = Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable()))
        let previousOwner = this.emitCtx.CurrentStaticConstructorOwner
        this.emitCtx.CurrentStaticConstructorOwner = ifaceSym
        try {
            return this.EmitStaticConstructorBodyFromBlock(body, ifaceSym.Declaration)
        } finally {
            this.emitCtx.CurrentStaticConstructorOwner = previousOwner
        }
    }

    /// Shared IL-emission core for a synthesized `.cctor` body (Issue #262
    /// / issue #1030). Plans locals/labels, emits the block, appends
    /// `ret`, and returns the resulting body offset.
    /// @param body The synthesized static-constructor block.
    /// @param anchor The declaring-type syntax used as the diagnostic anchor.
    /// @returns The resulting method body offset.
    private func EmitStaticConstructorBodyFromBlock(body BoundBlockStatement, anchor SyntaxNode) int32 {
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.Plan(body)
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(Dictionary[ParameterSymbol, int32]())
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let fallbackAnchor = emitter.CurrentAnchor ?? anchor
            EmitDiagnosticException.Wrap(fallbackAnchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Issue #640: builds the IL body for a default parameterless constructor
    /// that calls the base ctor and then evaluates instance field initializers
    /// in declaration order. Returns the resulting body offset.
    internal func EmitClassDefaultConstructorBodyBytes(classSym StructSymbol, baseCtorToken EntityHandle) int32 {
        if !classSym.HasPrimaryConstructor &&
            TryEmitInitialization(classSym, false, baseCtorToken, default(ImmutableArray[RefKind]), out var planned) {
            return planned
        }
        // Synthesize a `this` parameter for the field-initializer receiver.
        let thisParam = ParameterSymbol("this", classSym)
        // A primary-constructor class also carries a metadata-only default
        // constructor. Its source initializers may read primary parameters,
        // which do not exist in that hidden constructor; the callable primary
        // constructor runs those initializers after assigning its parameters.
        let statements = if classSym.HasPrimaryConstructor {
            ImmutableArray[BoundStatement].Empty
        } else {
            BuildInstanceFieldInitializerStatements(classSym, thisParam)
        }
        let body = Lowerer.Lower(BoundBlockStatement(nil, statements), classSym)
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.Plan(body)
        let parameters = Dictionary[ParameterSymbol, int32]{[thisParam] = 0}
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(parameters)
        // base()
        il.LoadArgument(0)
        il.OpCode(ILOpCode.Call)
        il.Token(baseCtorToken)
        // Instance field initializers
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? classSym.Declaration
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Issue #640: builds the IL body for a primary constructor that calls
    /// the base ctor, assigns primary-ctor parameters into their same-named
    /// fields, and then evaluates instance field initializers in declaration
    /// order. Returns the resulting body offset.
    internal func EmitClassPrimaryConstructorBodyBytes(classSym StructSymbol, baseCtorToken EntityHandle) int32 {
        if TryEmitInitialization(classSym, false, baseCtorToken, default(ImmutableArray[RefKind]), out var planned) {
            return planned
        }
        let parameters = classSym.PrimaryConstructorParameters
        // Synthesize a `this` parameter for the field-initializer receiver.
        let thisParam = ParameterSymbol("this", classSym)
        // Synthesize field-initializer assignment statements.
        let statements = BuildInstanceFieldInitializerStatements(classSym, thisParam)
        let body = Lowerer.Lower(BoundBlockStatement(nil, statements), classSym)
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.Plan(body)
        let paramSlots = Dictionary[ParameterSymbol, int32]{[thisParam] = 0}
        for var i = 0; i < parameters.Length; i++ {
            paramSlots[parameters[i]] = i + 1
        }
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(
            paramSlots,
            structThisParameter: if classSym.IsClass {
                default(ParameterSymbol?)
            } else {
                thisParam
            }
        )
        let richObject = classSym.Declaration?.IsSynthesizedRichAnonymousObject == true
        if !classSym.IsClass {
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Initobj)
            il.Token(this.outer.userTokens.ResolveUserTypeToken(classSym))
        } else if !richObject {
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Call)
            il.Token(baseCtorToken)
        }
        // Primary ctor parameter → field assignments. ADR-0087 §3 R3:
        // for a generic class the stfld must reference the field via
        // a MemberRef parented at the self-instantiation TypeSpec so
        // ilverify accepts the receiver type (`Box`1<!0>`).
        for var i = 0; i < parameters.Length; i++ {
            let param = parameters[i]
            if !ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(classSym, param.Name, out var field) {
                continue
            }
            let fieldHandle = this.outer.userTokens.ResolveFieldToken(classSym, field)
            il.LoadArgument(0)
            il.LoadArgument(i + 1)
            il.OpCode(ILOpCode.Stfld)
            il.Token(fieldHandle)
        }
        if richObject {
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Call)
            il.Token(baseCtorToken)
        }
        // Instance field initializers
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? classSym.Declaration
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Issue #3219: builds the IL body for the synthesized parameterless
    /// value-struct constructor — zero-initializes `this` (the caller's
    /// storage may be a reused local) and then evaluates the declared
    /// instance field initializers in declaration order, in-type, so
    /// non-public initialized fields never need a call-site store.
    /// Returns the resulting body offset.
    /// @param structSym The struct whose ctor body is being emitted.
    /// @returns The method-body stream offset.
    internal func EmitValueStructDefaultConstructorBodyBytes(structSym StructSymbol) int32 {
        let initializersRunInPrimaryConstructor = structSym.ValueStructDefaultCtorIsZeroInitialization
        if !initializersRunInPrimaryConstructor &&
            TryEmitInitialization(
            structSym,
            false,
            default(EntityHandle),
            default(ImmutableArray[RefKind]),
            out var planned
        ) {
            return planned
        }
        // Synthesize a `this` parameter for the field-initializer receiver.
        let thisParam = ParameterSymbol("this", structSym)
        // A data primary-constructor struct's ordinary initializers can read
        // parameters and run only in the primary constructor. Its zero-value
        // constructor still initializes collection fields, including private ones.
        let statements = BuildInstanceFieldInitializerStatements(
            structSym,
            thisParam,
            zeroInitialize: initializersRunInPrimaryConstructor
        )
        let body = BoundBlockStatement(nil, statements)
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.Plan(body)
        let parameters = Dictionary[ParameterSymbol, int32]{[thisParam] = 0}
        let localsSignature = session.BuildLocalsSignature()
        // arg0 of a value-type instance ctor is already a managed pointer;
        // structThisParameter makes the receiver loads use ldarg.0 (the
        // address) rather than ldarga (a pointer-to-pointer).
        let emitter = session.CreateEmitter(parameters, structThisParameter: thisParam)
        // `this` is a byref to caller storage (possibly a reused local):
        // zero the whole value before the initializers store into it. For a
        // generic struct the token is the self-instantiation TypeSpec
        // (`Box`1<!0>`), the same in-type reference the field stores use.
        il.LoadArgument(0)
        il.OpCode(ILOpCode.Initobj)
        il.Token(this.outer.userTokens.ResolveUserTypeToken(structSym))
        // Instance field initializers
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? structSym.Declaration
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Emits a data struct's primary constructor, including primary-parameter
    /// field stores and instance field initializers.
    /// @param structSym The data struct whose primary constructor is being emitted.
    /// @returns The resulting method-body stream offset.
    internal func EmitDataStructPrimaryConstructorBodyBytes(structSym StructSymbol) int32 {
        if TryEmitInitialization(
            structSym,
            false,
            default(EntityHandle),
            default(ImmutableArray[RefKind]),
            out var planned
        ) {
            return planned
        }
        let parameters = structSym.PrimaryConstructorParameters
        let thisParam = ParameterSymbol("this", structSym)
        let body = Lowerer.Lower(
            BoundBlockStatement(nil, BuildInstanceFieldInitializerStatements(structSym, thisParam)),
            structSym
        )
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.Plan(body)
        let parameterSlots = Dictionary[ParameterSymbol, int32]{[thisParam] = 0}
        for var i = 0; i < parameters.Length; i++ {
            parameterSlots[parameters[i]] = i + 1
        }
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(parameterSlots, structThisParameter: thisParam)
        il.LoadArgument(0)
        il.OpCode(ILOpCode.Initobj)
        il.Token(this.outer.userTokens.ResolveUserTypeToken(structSym))
        for var i = 0; i < parameters.Length; i++ {
            let parameter = parameters[i]
            if ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(structSym, parameter.Name, out var field) {
                il.LoadArgument(0)
                il.LoadArgument(i + 1)
                il.OpCode(ILOpCode.Stfld)
                il.Token(this.outer.userTokens.ResolveFieldToken(structSym, field))
            }
        }
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? structSym.Declaration
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Issue #306: builds the IL body for a forwarding constructor that
    /// runs `base(args)` before assigning the primary-constructor
    /// parameters into their same-named fields. Returns the resulting
    /// body offset.
    internal func EmitClassConstructorWithBaseInitializerBodyBytes(
        classSym StructSymbol,
        parameters ImmutableArray[ParameterSymbol],
        init BaseConstructorInitializer,
        baseCtorToken EntityHandle
    ) int32 {
        if TryEmitInitialization(classSym, false, baseCtorToken, init.ArgumentRefKinds, out var planned) {
            return planned
        }
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        // Synthesize a `this` parameter for the field-initializer receiver.
        let thisParam = ParameterSymbol("this", classSym)
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature.
        if !init.Arguments.IsDefaultOrEmpty {
            let synth = ImmutableArray.CreateBuilder[BoundStatement](init.Arguments.Length)
            for arg in init.Arguments {
                synth.Add(BoundExpressionStatement(nil, arg))
            }
            session.Plan(BoundBlockStatement(nil, synth.ToImmutable()))
        }
        // Issue #640: pre-scan instance field initializer expressions for locals.
        var fieldInitBody BoundBlockStatement? = nil
        if NeedsInstanceFieldInitializerStatements(classSym) {
            fieldInitBody = BoundBlockStatement(nil, BuildInstanceFieldInitializerStatements(classSym, thisParam))
            session.Plan(fieldInitBody)
        }
        let paramSlots = Dictionary[ParameterSymbol, int32]{[thisParam] = 0}
        for var i = 0; i < parameters.Length; i++ {
            paramSlots[parameters[i]] = i + 1
        }
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(paramSlots)
        let richObject = classSym.Declaration?.IsSynthesizedRichAnonymousObject == true
        if !richObject {
            il.LoadArgument(0)
            if !init.Arguments.IsDefaultOrEmpty {
                emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds)
            }
            il.OpCode(ILOpCode.Call)
            il.Token(baseCtorToken)
        }
        // this.<field> = arg; positional 1:1 with same-named fields.
        // Issue #2338 / ADR-0087 §3 R3: for a generic class the stfld must
        // reference the field via a MemberRef parented at the
        // self-instantiation TypeSpec (ResolveFieldToken), not the bare
        // open FieldDef, or ilverify rejects the constructed receiver.
        for var i = 0; i < parameters.Length; i++ {
            let param = parameters[i]
            if !ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(classSym, param.Name, out var field) {
                continue
            }
            let fieldHandle = this.outer.userTokens.ResolveFieldToken(classSym, field)
            il.LoadArgument(0)
            il.LoadArgument(i + 1)
            il.OpCode(ILOpCode.Stfld)
            il.Token(fieldHandle)
        }
        if richObject {
            il.LoadArgument(0)
            if !init.Arguments.IsDefaultOrEmpty {
                emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds)
            }
            il.OpCode(ILOpCode.Call)
            il.Token(baseCtorToken)
        }
        // Issue #640: emit instance field initializer assignments.
        if fieldInitBody != nil {
            try {
                emitter.EmitBlock(fieldInitBody)
            } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
                !(ex is OutOfMemoryException) &&
                !(ex is StackOverflowException) {
                let anchor = emitter.CurrentAnchor ?? classSym.Declaration
                EmitDiagnosticException.Wrap(anchor, ex)
            }
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    /// Issue #306 / #2766: builds the IL body for a class or plain-struct constructor materialized
    /// from an explicit `init(...)` declaration. Chains to the base
    /// (either the explicit `: base(args)` initializer or the
    /// conventional parameterless chain) and then runs the user-authored
    /// constructor body via (cref:MethodBodyEmitter.EmitBlock). Returns
    /// the resulting body offset.
    internal func EmitClassConstructorWithBodyBodyBytes(
        classSym StructSymbol,
        ctor ConstructorSymbol,
        init BaseConstructorInitializer?,
        baseCtorToken EntityHandle
    ) int32 {
        if TryEmitInitialization(
            ctor.Function,
            false,
            baseCtorToken,
            init?.ArgumentRefKinds ?? default(ImmutableArray[RefKind]),
            out var planned,
            ctor.IsConvenience
        ) {
            return planned
        }
        let function = ctor.Function
        let body = this.emitCtx.Program.Functions[function]
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        // Pre-scan the base arguments so any scratch slots they require are
        // allocated and registered in the locals signature. ADR-0065 §2:
        // convenience inits skip the base-call emission so their `init`
        // syntax-side `: base()` (if present, but rejected at bind time) and
        // the implicit empty-args case are irrelevant here.
        if !ctor.IsConvenience && init != nil && !init.Arguments.IsDefaultOrEmpty {
            let synth = ImmutableArray.CreateBuilder[BoundStatement](init.Arguments.Length)
            for arg in init.Arguments {
                synth.Add(BoundExpressionStatement(nil, arg))
            }
            session.Plan(BoundBlockStatement(nil, synth.ToImmutable()))
        }
        // Issue #640: pre-scan instance field initializer expressions for locals.
        // ADR-0065 §2: convenience inits skip field-init emission (the
        // chained-to designated init handles them), so don't reserve scratch
        // slots for those expressions either.
        var fieldInitBody BoundBlockStatement? = nil
        if !ctor.IsConvenience && NeedsInstanceFieldInitializerStatements(classSym) {
            fieldInitBody = BoundBlockStatement(
                nil,
                BuildInstanceFieldInitializerStatements(
                    classSym,
                    Invariant.Required(
                        function.ThisParameter,
                        "an instance constructor has an instance receiver",
                        expression: "function.ThisParameter"
                    )
                )
            )
            session.Plan(fieldInitBody)
        }
        session.CollectConstValues(body)
        session.Plan(body, function)
        // Slot 0 is the implicit `this`; user parameters shift up by one.
        let paramSlots = Dictionary[ParameterSymbol, int32]{
            [
                Invariant.Required(
                    function.ThisParameter,
                    "an instance constructor has an instance receiver",
                    expression: "function.ThisParameter"
                )
            ] = 0
        }
        for var i = 0; i < function.Parameters.Length; i++ {
            paramSlots[function.Parameters[i]] = i + 1
        }
        let localsSignature = session.BuildLocalsSignature()
        let structThisParameter = if classSym.IsClass {
            default(ParameterSymbol?)
        } else {
            Invariant.Required(
                function.ThisParameter,
                "a struct constructor has an instance receiver",
                expression: "function.ThisParameter"
            )
        }
        let emitter = session.CreateEmitter(paramSlots, structThisParameter: structThisParameter)
        // ADR-0065 §2: a `convenience init(...)` does NOT chain to the base
        // constructor itself — the user-authored body begins with an
        // `init(args)` self-delegation (BoundConstructorChainingExpression)
        // that calls a sibling constructor on the same aggregate. That sibling
        // is responsible for the base chain. We also skip the instance
        // field-initializer emit step here: the chained-to designated
        // initializer will run those initializers exactly once.
        if !ctor.IsConvenience {
            if classSym.IsClass {
                // base(args) — `this` followed by the (ref-kind aware) base arguments.
                il.LoadArgument(0)
                if init != nil && !init.Arguments.IsDefaultOrEmpty {
                    emitter.EmitBaseConstructorArguments(init.Arguments, init.ArgumentRefKinds)
                }
                il.OpCode(ILOpCode.Call)
                il.Token(baseCtorToken)
            } else {
                // CLR value-type constructors do not call System.ValueType::.ctor.
                // Zero the receiver first, matching C#'s definite-assignment/default
                // initialization semantics for fields the source body does not write.
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Initobj)
                il.Token(this.outer.userTokens.ResolveUserTypeToken(classSym))
            }
            // Issue #640: emit instance field initializer assignments before
            // the user-authored constructor body (matching C# semantics).
            if fieldInitBody != nil {
                try {
                    emitter.EmitBlock(fieldInitBody)
                } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
                    !(ex is OutOfMemoryException) &&
                    !(ex is StackOverflowException) {
                    let anchor = emitter.CurrentAnchor ?? classSym.Declaration
                    EmitDiagnosticException.Wrap(anchor, ex)
                }
            }
        }
        // Run the user-authored constructor body.
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    private func TryEmitInitialization(
        owner Symbol,
        isStatic bool,
        baseConstructor EntityHandle,
        argumentRefKinds ImmutableArray[RefKind],
        out offset int32,
        convenience bool = false
    ) bool {
        offset = -1
        if !this.emitCtx.Program.Initializers.TryGetValue((owner, isStatic), out var plan) {
            return false
        }
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.CollectConstValues(plan.Prologue)
        session.CollectConstValues(plan.Body)
        session.Plan(plan.Prologue, plan.Function)
        for argument in plan.Arguments {
            let argumentBody = BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, argument))
            )
            session.CollectConstValues(argumentBody)
            session.Plan(argumentBody)
        }
        session.Plan(plan.Body, plan.Function)
        let slots = Dictionary[ParameterSymbol, int32]()
        let receiver ParameterSymbol? = plan.Function.ThisParameter
        let aggregate = plan.Function.ReceiverType as StructSymbol
        if receiver != nil {
            slots[receiver] = 0
        }
        for var i = 0; i < plan.Function.Parameters.Length; i++ {
            slots[plan.Function.Parameters[i]] = i +
                (
                if isStatic {
                    0
                } else {
                    1
                }
            )
        }
        let signature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(
            slots,
            structThisParameter: if aggregate?.IsClass == false {
                receiver
            } else {
                default(ParameterSymbol?)
            }
        )
        let previousOwner = this.emitCtx.CurrentStaticConstructorOwner
        if isStatic {
            this.emitCtx.CurrentStaticConstructorOwner = owner
        }
        try {
            // Only parameter cells run before the existing base-call boundary.
            // User field initializers and primary stores still run after base.
            emitter.EmitBlock(plan.Prologue)
            if !isStatic && !convenience {
                il.LoadArgument(0)
                if aggregate?.IsClass == true {
                    emitter.EmitBaseConstructorArguments(plan.Arguments, argumentRefKinds)
                    il.OpCode(ILOpCode.Call)
                    il.Token(baseConstructor)
                } else {
                    il.OpCode(ILOpCode.Initobj)
                    il.Token(
                        this
                            .outer
                            .userTokens
                            .ResolveUserTypeToken(
                            Invariant.Required(
                                aggregate,
                                "instance initialization has an aggregate owner",
                                expression: "aggregate"
                            )
                        )
                    )
                }
            }
            emitter.EmitBlock(plan.Body)
            offset = this.AddCompletedMethodBody(il, emitter, signature)
            return true
        } finally {
            this.emitCtx.CurrentStaticConstructorOwner = previousOwner
        }
    }

    // ADR-0068 / issue #698: emits the body of the synthesized `Finalize`
    // override produced by a class `deinit { … }`. The body wraps the
    // lowered user body in `try { … } finally { base.Finalize(); }` exactly
    // as the C# compiler emits for `~Type()`. Mirrors the locals/labels
    // pre-scan scaffolding from `EmitClassConstructorWithBodyBodyBytes`.
    internal func EmitClassDeinitializerBodyBytes(
        classSym StructSymbol,
        deinit DeinitSymbol,
        body BoundBlockStatement,
        baseFinalizeRef EntityHandle
    ) int32 {
        let function = deinit.Function
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let session = ReflectionMetadataEmitter.MethodBodyEmitSession(this.outer, il)
        session.CollectConstValues(body)
        session.Plan(body, function)
        // Slot 0 is the implicit `this`; deinit has no user parameters.
        let paramSlots = Dictionary[ParameterSymbol, int32]{
            [
                Invariant.Required(
                    function.ThisParameter,
                    "an instance constructor has an instance receiver",
                    expression: "function.ThisParameter"
                )
            ] = 0
        }
        let localsSignature = session.BuildLocalsSignature()
        let emitter = session.CreateEmitter(paramSlots)
        // Wrap the user body in try { … } finally { base.Finalize(); }.
        // Matches the IL shape Roslyn emits for `~Type()`. The base
        // Finalize target is the closest user-declared base `deinit` (if
        // any) — emit a non-virtual `call` to its MethodDef — otherwise
        // chain straight to System.Object::Finalize().
        let tryStart = il.DefineLabel()
        let finallyStart = il.DefineLabel()
        let finallyEnd = il.DefineLabel()
        il.MarkLabel(tryStart)
        try {
            emitter.EmitBlock(body)
        } catch (ex Exception) when !(ex is EmitDiagnosticException) &&
            !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) {
            let anchor = emitter.CurrentAnchor ?? classSym.Declaration ?? body.Syntax
            EmitDiagnosticException.Wrap(anchor, ex)
        }
        il.Branch(ILOpCode.Leave, finallyEnd)
        il.MarkLabel(finallyStart)
        il.LoadArgument(0)
        il.OpCode(ILOpCode.Call)
        var baseFinalizeToken = baseFinalizeRef
        let ancestorChain = classSym.GetHierarchy()
        for var level = 1; level < ancestorChain.Count; level++ {
            let ancestor = ancestorChain[level]
            if ancestor.Deinitializer != nil &&
                this
                .cache
                .MethodHandles
                .TryGetValue(ancestor.Deinitializer!!.Function, out var ancestorHandle) {
                baseFinalizeToken = ancestorHandle
                break
            }
        }
        il.Token(baseFinalizeToken)
        il.OpCode(ILOpCode.Endfinally)
        il.MarkLabel(finallyEnd)
        Invariant.Required(
            il.ControlFlowBuilder,
            "the encoder for a constructor body with a protected region is created with a control-flow builder",
            expression: "il.ControlFlowBuilder"
        )
            .AddFinallyRegion(tryStart, finallyStart, finallyStart, finallyEnd)
        return this.AddCompletedMethodBody(il, emitter, localsSignature)
    }

    private func AddCompletedMethodBody(
        il InstructionEncoder,
        emitter MethodBodyEmitter,
        localsSignature StandaloneSignatureHandle
    ) int32 {
        // Every constructor-family body funnels through this helper so a
        // protected fixed return cannot leave its shared target unmarked.
        emitter.EmitFixedReturnEpilogue()
        il.OpCode(ILOpCode.Ret)
        return this
            .emitCtx
            .MethodBodyStream
            .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature)
    }

    shared {
        internal func NeedsInstanceFieldInitializerStatements(classSym StructSymbol) bool -> !classSym
            .InstanceFieldInitializers
            .IsEmpty

        /// Issue #3219: a value-kind struct whose declared field initializers
        /// include a NON-public field cannot be materialized by the historical
        /// call-site lowering (initobj + raw `stfld` per initializer) —
        /// the private-field store executes outside the type and the runtime
        /// rejects it with (cref:FieldAccessException). Such a struct
        /// gets a synthesized owning `.ctor` that runs ALL
        /// declared instance field initializers in-type (mirroring the class
        /// default-ctor path), and struct-literal sites construct through it.
        /// Generic structs also require in-type initialization: their definition-bound
        /// expressions cannot execute in the literal site's generic context (#4755).
        /// Primary structs use their primary signature so declaration initializers
        /// retain the actual constructor parameter scope (#4747).
        /// Non-generic structs whose initializers are all public keep the historical
        /// inline emission. Authored parameterless constructors remain separate
        /// through a hidden literal initializer signature. Imported CLR types
        /// and inline structs (fixed synthesized-member layout) are excluded.
        /// @param structSym The struct definition to probe.
        /// @returns `true` when an owning initializer ctor is required.
        internal func NeedsSynthesizedValueStructDefaultCtor(
            structSym StructSymbol
        ) bool -> structSym.NeedsSynthesizedValueStructDefaultCtor

        /// Issue #640: builds the bound assignment statements for all instance
        /// field initializers in declaration order. Used by the default, primary,
        /// forwarding, and explicit constructor body emitters.
        private func BuildInstanceFieldInitializerStatements(
            classSym StructSymbol,
            thisParam ParameterSymbol? = nil,
            zeroInitialize bool = false
        ) ImmutableArray[BoundStatement] {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            for field in classSym.Fields {
                let initExpr BoundExpression? = if zeroInitialize {
                    MagicCollectionZeroValue.TrySynthesizeInTypeZeroField(nil, classSym, field)
                } else {
                    classSym.InstanceFieldInitializers.GetValueOrDefault(field)
                }
                if initExpr != nil {
                    let assignment = BoundFieldAssignmentExpression(nil, thisParam, classSym, field, initExpr)
                    statements.Add(BoundExpressionStatement(nil, assignment))
                }
            }
            return statements.ToImmutable()
        }
    }
}
