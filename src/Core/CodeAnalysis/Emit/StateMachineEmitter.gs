// <copyright file="StateMachineEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks
import System.Threading.Tasks.Sources

/// Async/iterator state-machine synthesis and top-level MoveNext /
/// SetStateMachine / AwaitOnCompleted / async-kickoff IL emission.
/// Owns the state-machine plan inputs, the per-SM class metadata produced
/// by synthesis, and the helpers that build the MoveNextAsync / DisposeAsync /
/// GetAsyncEnumerator / IValueTaskSource<bool> bodies for async iterators.
/// @remarks PR-E-10 introduces this component. Per the decomposition plan, the
/// state-machine emit surface is split between two host types in the
/// pre-refactor source — exactly as PR-E-5 (cref:ConversionEmitter)
/// and PR-E-9 (cref:ClosureEmitter) handled their own surfaces:
///
/// - Stateless, top-level orchestration / IL-emit on (cref:ReflectionMetadataEmitter)
/// (`SynthesizeIteratorStateMachines`, `SynthesizeAsyncIteratorStateMachines`,
/// `SynthesizeAsyncLambdaStateMachines`, `EmitStateMachineMoveNext`, `EmitStateMachineSetStateMachine`,
/// `EmitAwaitOnCompletedCall`, `EmitAsyncKickoffBody`) plus the nested helper classes
/// ((cref:IteratorStateMachineInfo), (cref:IteratorEmitContext)) and the state-machine caches
/// ((cref:IteratorKickoffBodies), (cref:IteratorStateMachineInfos), (cref:AsyncStateMachinePlans),
/// (cref:IteratorPlans), (cref:AsyncIteratorPlans), (cref:AsyncIteratorInfos),
/// (cref:IteratorEmitContexts), (cref:AsyncSmEnclosingClosures)). <strong>These move here.</strong>
/// - Body-emit-internal state-machine methods inside `BodyEmitter` (`EmitStateMachineAwaitOnCompleted`,
/// `EmitAsyncIteratorBuilderMoveNext`) that reference `BodyEmitter`'s private `il`, `locals`,
/// `parameters`, `asyncPlan`, and `iteratorEmitCtx` fields and immediately call back into
/// `this.outer.stateMachines.EmitAwaitOnCompletedCall` for the actual emit. <strong>These are deferred
/// to PR-E-11 <c>MethodBodyEmitter</c></strong>, where `BodyEmitter` is promoted to its own top-level
/// type with its own partials. Moving them in PR-E-10 would require widening `BodyEmitter`'s private
/// surface only to take it apart again one PR later. <strong>This is the same Option B playbook PR-E-5
/// and PR-E-9 used</strong> for the same reason.
///
/// <b>What stays on <see cref="ReflectionMetadataEmitter" /></b>:
///
/// - The `lambdaBodies` dictionary. It is cross-cutting — populated by closure synthesis in PR-E-9
/// (cref:ClosureEmitter) AND by every state-machine synthesizer here — and the root emitter walks it
/// from `EmitFunction`. Keeping it on the root means (cref:ClosureEmitter) and
/// (cref:StateMachineEmitter) both write into it via the constructor-injected dictionary reference, and
/// the root keeps its existing read paths unchanged. This is the same plan nomination that PR-E-9
/// followed.
/// - `AddIteratorInterfaceImplementations` and `AddAsyncIteratorInterfaceImplementations`. They are
/// called from the root's `EmitCore` loop that walks `smClasses` and adds nested-type rows; they are
/// AddInterfaceImplementation glue, not state-machine synthesis or IL emission. They consume
/// (cref:IteratorStateMachineInfos) / (cref:AsyncIteratorInfos) via this component's public maps.
/// - The `BodyEmitter`-driven part of `EmitStateMachineMoveNext` is reached via the
/// (cref:MoveNextBodyResult) tuple returned from `BuildMoveNextBodyBytes` on the root. Same callback
/// pattern PR-E-8 (cref:TypeDefEmitter) used for the three constructor body-emit helpers — keeps
/// (cref:StateMachineEmitter) from needing visibility into the still-private `BodyEmitter` nested
/// class.
///
/// Like every other PR-E-* component, (cref:StateMachineEmitter) is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) trio as its peers, plus the
/// (cref:ClosureEmitter) (for the shared synthesized-class counter
/// and class-list it appends every SM class onto) and a shared reference to
/// the root's `lambdaBodies` dictionary so synthesis can register the
/// rewritten `MoveNext` / `get_Current` / etc. bodies without a
/// hard back-reference to (cref:ReflectionMetadataEmitter).
internal class StateMachineEmitter {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let closures ClosureEmitter
    private let lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement]

    // Injected delegate callbacks (same composition pattern as PR-E-5..E-9).
    private let getTypeReference(Type) -> TypeReferenceHandle

    private let getTypeHandleForMember(Type) -> EntityHandle
    private let getMethodEntityHandle(MethodInfo) -> EntityHandle
    private let getMethodEntityHandleForContainingType(MethodInfo, TypeSymbol) -> EntityHandle
    private let getMethodReference(MethodInfo) -> MemberReferenceHandle
    private let nextParameterHandle() -> ParameterHandle
    private let encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    private let encodeClrType(SignatureTypeEncoder, Type) -> void

    // Issue #1465: resolve a state-machine struct type token / field token
    // through the generic-aware path (TypeSpec / MemberRef when the SM is
    // reified over its enclosing type's parameters).
    private let getStructTypeToken(StructSymbol) -> EntityHandle

    private let resolveFieldToken(StructSymbol, FieldSymbol) -> EntityHandle

    // PR-E-8-style callback: drives the still-private BodyEmitter nested class
    // on RME to build the MoveNext body bytes (PDB metadata included). Returns
    // -1 bodyOffset under MetadataOnly.
    private let buildMoveNextBodyBytes(AsyncStateMachinePlan) -> MoveNextBodyResult

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        closures ClosureEmitter,
        lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement],
        getTypeReference(Type) -> TypeReferenceHandle,
        getTypeHandleForMember(Type) -> EntityHandle,
        getMethodEntityHandle(MethodInfo) -> EntityHandle,
        getMethodEntityHandleForContainingType(MethodInfo, TypeSymbol) -> EntityHandle,
        getMethodReference(MethodInfo) -> MemberReferenceHandle,
        nextParameterHandle() -> ParameterHandle,
        encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void,
        encodeClrType(SignatureTypeEncoder, Type) -> void,
        getStructTypeToken(StructSymbol) -> EntityHandle,
        resolveFieldToken(StructSymbol, FieldSymbol) -> EntityHandle,
        buildMoveNextBodyBytes(AsyncStateMachinePlan) -> MoveNextBodyResult
    ) {
        IteratorKickoffBodies = Dictionary[FunctionSymbol, BoundBlockStatement]()
        IteratorStateMachineInfos = Dictionary[StructSymbol, IteratorStateMachineInfo]()
        AsyncIteratorInfos = Dictionary[StructSymbol, AsyncIteratorPlan]()
        AsyncIteratorStateMachineGenericInfos = Dictionary[StructSymbol, IteratorStateMachineGenericInfo]()
        IteratorEmitContexts = Dictionary[StructSymbol, IteratorEmitContext]()
        AsyncSmEnclosingClosures = Dictionary[StructSymbol, StructSymbol]()
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.closures = closures ?? throw ArgumentNullException("closures")
        this.lambdaBodies = lambdaBodies ?? throw ArgumentNullException("lambdaBodies")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw ArgumentNullException("getTypeHandleForMember")
        this.getMethodEntityHandle = getMethodEntityHandle ?? throw ArgumentNullException("getMethodEntityHandle")
        this.getMethodEntityHandleForContainingType = getMethodEntityHandleForContainingType ??
            throw ArgumentNullException("getMethodEntityHandleForContainingType")
        this.getMethodReference = getMethodReference ?? throw ArgumentNullException("getMethodReference")
        this.nextParameterHandle = nextParameterHandle ?? throw ArgumentNullException("nextParameterHandle")
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw ArgumentNullException("encodeTypeSymbol")
        this.encodeClrType = encodeClrType ?? throw ArgumentNullException("encodeClrType")
        this.getStructTypeToken = getStructTypeToken ?? throw ArgumentNullException("getStructTypeToken")
        this.resolveFieldToken = resolveFieldToken ?? throw ArgumentNullException("resolveFieldToken")
        this.buildMoveNextBodyBytes = buildMoveNextBodyBytes ?? throw ArgumentNullException("buildMoveNextBodyBytes")
    }

    /// Gets the per-iterator-function kickoff bodies synthesized by
    /// (cref:SynthesizeIteratorStateMachines) and
    /// (cref:SynthesizeAsyncIteratorStateMachines). The root emitter's
    /// `EmitFunction` swaps in this body for the user-authored iterator
    /// function so the kickoff returns a freshly-constructed SM struct.
    prop IteratorKickoffBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }

    /// Gets per-iterator-SM metadata. Populated by
    /// (cref:SynthesizeIteratorStateMachines); the root reads it when
    /// walking the SM class list to attach `IEnumerable<T>` /
    /// `IEnumerator<T>` / `IDisposable` interface
    /// implementations.
    prop IteratorStateMachineInfos Dictionary[StructSymbol, IteratorStateMachineInfo] {
        get;
    }

    /// Gets per-async-iterator-SM plan. Populated by
    /// (cref:SynthesizeAsyncIteratorStateMachines); the root reads it
    /// when walking the SM class list to attach `IAsyncEnumerable<T>`
    /// / `IAsyncEnumerator<T>` / `IAsyncDisposable` /
    /// `IValueTaskSource<bool>` / `IAsyncStateMachine` interface
    /// implementations.
    prop AsyncIteratorInfos Dictionary[StructSymbol, AsyncIteratorPlan] {
        get;
    }

    /// Gets the per-async-iterator-SM generic reification info (issue #1489).
    /// Populated by (cref:SynthesizeAsyncIteratorStateMachines) only for
    /// async iterators whose kickoff method has type parameters in scope. The
    /// root reads it to register the outer-method-TP → class-TP-ordinal remap
    /// so field/method/interface signatures encode the SM class's own
    /// `Var(idx)` slots instead of the kickoff's `MVar(idx)`.
    prop AsyncIteratorStateMachineGenericInfos Dictionary[StructSymbol, IteratorStateMachineGenericInfo] {
        get;
    }

    /// Gets per-iterator-SM emit-time context. Sync iterators use the state
    /// machine and hoisted-field map; async iterators also use builder info.
    prop IteratorEmitContexts Dictionary[StructSymbol, IteratorEmitContext] {
        get;
    }

    /// Gets the map from a capture-bearing async lambda's SM struct to the
    /// closure display class it is nested inside (Subset A of the Roslyn
    /// nesting convention). SM structs NOT in this map nest inside the
    /// per-package `<Program>` class.
    prop AsyncSmEnclosingClosures Dictionary[StructSymbol, StructSymbol] {
        get;
    }

    /// Gets or sets the async state-machine plans produced by
    /// `AsyncStateMachineRewriter`. Assigned from the root emitter's
    /// `Emit` entry point when an async-rewrite result is supplied.
    private var _asyncStateMachinePlans ImmutableArray[AsyncStateMachinePlan] = ImmutableArray[
        AsyncStateMachinePlan
    ].Empty

    prop AsyncStateMachinePlans ImmutableArray[AsyncStateMachinePlan] {
        get {
            return _asyncStateMachinePlans
        }
        internal set {
            _asyncStateMachinePlans = value
        }
    }

    /// Gets or sets the iterator state-machine plans produced by
    /// `IteratorRewriter`. Assigned from the root emitter's `Emit`
    /// entry point when an iterator-rewrite result is supplied.
    private var _iteratorPlans ImmutableArray[IteratorStateMachinePlan] = ImmutableArray[IteratorStateMachinePlan].Empty

    prop IteratorPlans ImmutableArray[IteratorStateMachinePlan] {
        get {
            return _iteratorPlans
        }
        internal set {
            _iteratorPlans = value
        }
    }

    /// Gets or sets the async iterator state-machine plans produced by
    /// `AsyncIteratorRewriter`. Assigned from the root emitter's
    /// `Emit` entry point when an async-iterator-rewrite result is
    /// supplied.
    private var _asyncIteratorPlans ImmutableArray[AsyncIteratorPlan] = ImmutableArray[AsyncIteratorPlan].Empty

    prop AsyncIteratorPlans ImmutableArray[AsyncIteratorPlan] {
        get {
            return _asyncIteratorPlans
        }
        internal set {
            _asyncIteratorPlans = value
        }
    }

    class IteratorStateMachineInfo {
        convenience init(plan IteratorStateMachinePlan, classSym StructSymbol) {
            init(plan, classSym, ImmutableArray[TypeParameterSymbol].Empty, ImmutableArray[TypeParameterSymbol].Empty)
        }

        convenience init(
            plan IteratorStateMachinePlan,
            classSym StructSymbol,
            sourceTypeParameters ImmutableArray[TypeParameterSymbol],
            classTypeParameters ImmutableArray[TypeParameterSymbol]
        ) {
            init(
                plan,
                classSym,
                sourceTypeParameters,
                classTypeParameters,
                ImmutableArray[TypeParameterSymbol].Empty,
                0
            )
        }

        init(
            plan IteratorStateMachinePlan,
            classSym StructSymbol,
            sourceTypeParameters ImmutableArray[TypeParameterSymbol],
            classTypeParameters ImmutableArray[TypeParameterSymbol],
            sourceTypeParameterOrigins ImmutableArray[TypeParameterSymbol],
            sourceTypeParameterOriginOffset int32
        ) {
            this.Plan = plan
            this.ClassSym = classSym
            this.SourceTypeParameters = sourceTypeParameters
            this.ClassTypeParameters = classTypeParameters
            this.SourceTypeParameterOrigins = sourceTypeParameterOrigins
            this.SourceTypeParameterOriginOffset = sourceTypeParameterOriginOffset
        }

        prop Plan IteratorStateMachinePlan {
            get;
        }

        prop ClassSym StructSymbol {
            get;
        }

        /// Gets the original receiver and method type parameters that the
        /// state-machine class is reified over, in state-machine slot order.
        prop SourceTypeParameters ImmutableArray[TypeParameterSymbol] {
            get;
        }

        /// Gets the state-machine class's own type parameters (issue #810),
        /// constructed as ordinal-aligned mirrors of
        /// (cref:SourceTypeParameters) with
        /// (cref:TypeParameterSymbol.IsMethodTypeParameter) set to
        /// `false`. Empty for non-generic iterators.
        prop ClassTypeParameters ImmutableArray[TypeParameterSymbol] {
            get;
        }

        /// Gets, for a state machine whose containing type is a SYNTHESIZED
        /// closure / lambda host (issue #3933), the ORIGINAL lexically enclosing
        /// type parameters that the host's own parameters clone, in the same
        /// slot order (i.e. the host's
        /// (cref:StructSymbol.ReifiedFromTypeParameters)). The lowered
        /// iterator body still names those originals — it was bound against the
        /// user's `Factory[T]` / `make[U]`, not against the host's clones — so
        /// without an entry keyed by the original the encoder falls through to
        /// an `MVar` slot that does not exist inside MoveNext. This is the
        /// iterator counterpart of the async path's #2180
        /// `ReifiedFromTypeParameters` mapping. Empty for a real user
        /// receiver.
        prop SourceTypeParameterOrigins ImmutableArray[TypeParameterSymbol] {
            get;
        }

        /// Gets the first state-machine slot occupied by
        /// (cref:SourceTypeParameterOrigins).
        prop SourceTypeParameterOriginOffset int32 {
            get;
        }

        /// Issue #810 + #1465 + #2951: returns the emit-time remap from each
        /// original receiver/method type parameter to its corresponding
        /// class-type-parameter ordinal on the synthesized state machine, or
        /// `null` when none are in scope. Used by
        /// (cref:GenericRemapState.ActiveIteratorStateMachineRemap).
        func BuildRemap() Dictionary[TypeParameterSymbol, int32]? {
            if this.SourceTypeParameters.IsDefaultOrEmpty {
                return nil
            }
            let map_ = Dictionary[TypeParameterSymbol, int32](this.SourceTypeParameters.Length)
            for var i = 0; i < this.SourceTypeParameters.Length; i++ {
                map_[this.SourceTypeParameters[i]] = i
            }
            // Issue #3933: alias each ORIGINAL lexically enclosing parameter
            // onto the same slot its clone occupies — see
            // SourceTypeParameterOrigins for why the body names the originals.
            for var i = 0; i < this.SourceTypeParameterOrigins.Length; i++ {
                map_[this.SourceTypeParameterOrigins[i]] = this.SourceTypeParameterOriginOffset + i
            }
            return map_
        }
    }

    /// Issue #1489: minimal carrier for an async-iterator SM's generic
    /// reification — the source function's in-scope type parameters and the
    /// state-machine class's own ordinal-aligned type parameters. Used to
    /// build the source-TP → class-TP-ordinal remap (mirroring
    /// (cref:IteratorStateMachineInfo.BuildRemap)) without a sync
    /// iterator plan.
    class IteratorStateMachineGenericInfo {
        init(
            sourceTypeParameters ImmutableArray[TypeParameterSymbol],
            classTypeParameters ImmutableArray[TypeParameterSymbol]
        ) {
            this.SourceTypeParameters = sourceTypeParameters
            this.ClassTypeParameters = classTypeParameters
        }

        prop SourceTypeParameters ImmutableArray[TypeParameterSymbol] {
            get;
        }

        prop ClassTypeParameters ImmutableArray[TypeParameterSymbol] {
            get;
        }

        /// Returns the emit-time remap from each original receiver/method type
        /// parameter to its class-type-parameter ordinal on the synthesized
        /// state machine, or `null` when none are in scope.
        func BuildRemap() Dictionary[TypeParameterSymbol, int32]? {
            if this.SourceTypeParameters.IsDefaultOrEmpty {
                return nil
            }
            let map_ = Dictionary[TypeParameterSymbol, int32](this.SourceTypeParameters.Length)
            for var i = 0; i < this.SourceTypeParameters.Length; i++ {
                map_[this.SourceTypeParameters[i]] = i
            }
            return map_
        }
    }

    /// Lightweight emit-time context for iterator MoveNext methods.
    /// Carries the SM class and hoisted-variable map plus async-only builder
    /// state when applicable.
    class IteratorEmitContext {
        init(
            smClass StructSymbol,
            builderField FieldSymbol?,
            builderInfo AsyncMethodBuilderInfo?,
            fieldMap Dictionary[VariableSymbol, FieldSymbol]
        ) {
            this.SmClass = smClass
            this.BuilderField = builderField
            this.BuilderInfo = builderInfo
            this.FieldMap = fieldMap
        }

        prop SmClass StructSymbol {
            get;
        }

        /// Gets the async-iterator builder field, or `null`
        /// for the synchronous-iterator form, which has no builder at all.
        prop BuilderField FieldSymbol? {
            get;
        }

        /// Gets the resolved builder members, or `null` for
        /// the synchronous-iterator form. Set together with
        /// (cref:BuilderField).
        prop BuilderInfo AsyncMethodBuilderInfo? {
            get;
        }

        prop FieldMap Dictionary[VariableSymbol, FieldSymbol] {
            get;
        }
    }

    /// Tuple result returned by the `buildMoveNextBodyBytes` callback.
    /// Captures everything (cref:EmitStateMachineMoveNext) needs from
    /// the still-private `BodyEmitter` nested class on the root: the
    /// raw method-body offset and the PDB metadata (sequence points, locals,
    /// constants, IL size, and the locals signature).
    struct MoveNextBodyResult {
        init(
            bodyOffset int32,
            sequencePoints IReadOnlyList[SequencePoint]?,
            locals IReadOnlyList[LocalInfo]?,
            constants IReadOnlyList[LocalConstantInfo]?,
            codeSize int32,
            localsSignature StandaloneSignatureHandle,
            asyncStepping AsyncMethodSteppingInfo? = nil
        ) {
            this.BodyOffset = bodyOffset
            this.SequencePoints = sequencePoints
            this.Locals = locals
            this.Constants = constants
            this.CodeSize = codeSize
            this.LocalsSignature = localsSignature
            this.AsyncStepping = asyncStepping
        }

        prop BodyOffset int32 {
            get;
        }

        /// Gets the sequence points, or `null` for a metadata-only emit, which builds no body at all.
        prop SequencePoints IReadOnlyList[SequencePoint]? {
            get;
        }

        /// Gets the locals, or `null` for a metadata-only emit, which builds no body at all.
        prop Locals IReadOnlyList[LocalInfo]? {
            get;
        }

        /// Gets the local constants, or `null` for a metadata-only emit, which builds no body at all.
        prop Constants IReadOnlyList[LocalConstantInfo]? {
            get;
        }

        prop CodeSize int32 {
            get;
        }

        prop LocalsSignature StandaloneSignatureHandle {
            get;
        }

        prop AsyncStepping AsyncMethodSteppingInfo? {
            get;
        }
    }

    func SynthesizeIteratorStateMachines(hostPackage PackageSymbol) {
        if this.IteratorPlans.IsDefaultOrEmpty {
            return
        }
        for plan in this.IteratorPlans {
            // Issue #806: nest each iterator SM under its kickoff function's
            // package (<Program>), not the entry-point/host package. Falling
            // back to the host package only when the function has no package
            // keeps multi-namespace assemblies emitting correct NestedType
            // rows so CLR access checks succeed at runtime.
            let packageName = plan.Function.Package?.Name ?? hostPackage?.Name ?? string.Empty
            // Issue #810 + #1465: when the iterator method has type parameters
            // in scope — the enclosing GENERIC type's parameters and/or the
            // method's own type parameters — the synthesized state-machine
            // class must itself be generic over an ordinal-aligned copy of
            // them (mirroring Roslyn's `<Empty>d__0<T>`). The enclosing type's
            // parameters come first (ordinals 0..k-1), then the method's own
            // (ordinals k..). Class TPs (`IsMethodTypeParameter=false`) encode
            // as `Var(idx)`; a method-TP reference inside the body is
            // translated to the matching class-TP slot via the
            // activeIteratorStateMachineRemap encode-time hook. The class TPs
            // themselves are not used directly in any bound expression — the
            // substitution lives at the encoder.
            // Combined in-scope type parameters: flattened enclosing receiver
            // types first, then the receiver's own parameters, then method
            // parameters. Drives the SM's own generic parameters and the
            // self-instantiation type arguments used by the kickoff.
            let scopeTPs = GetIteratorTypeParametersInScope(plan.Function)
            var classTPs ImmutableArray[TypeParameterSymbol]
            if scopeTPs.IsDefaultOrEmpty {
                classTPs = ImmutableArray[TypeParameterSymbol].Empty
            } else {
                let b = ImmutableArray.CreateBuilder[TypeParameterSymbol](scopeTPs.Length)
                for var ti = 0; ti < scopeTPs.Length; ti++ {
                    let scopeTP = scopeTPs[ti]
                    let classTP = TypeParameterSymbol(
                        scopeTP.Name,
                        ti,
                        scopeTP.Constraint,
                        scopeTP.Variance,
                        scopeTP.InterfaceConstraint
                    ){
                        HasReferenceTypeConstraint = scopeTP.HasReferenceTypeConstraint,
                        HasValueTypeConstraint = scopeTP.HasValueTypeConstraint,
                        HasDefaultConstructorConstraint = scopeTP.HasDefaultConstructorConstraint,
                        ClrInterfaceConstraint = scopeTP.ClrInterfaceConstraint,
                        ClassConstraint = scopeTP.ClassConstraint,
                        TypeParameterBound = scopeTP.TypeParameterBound,
                        IsMethodTypeParameter = false
                    }
                    b.Add(classTP)
                }
                classTPs = b.MoveToImmutable()
            }
            let stateField = FieldSymbol("<>1__state", TypeSymbol.Int32, Accessibility.Public)
            let currentField = FieldSymbol("<>2__current", plan.ElementType, Accessibility.Public)
            let initialThreadField = FieldSymbol("<>l__initialThreadId", TypeSymbol.Int32, Accessibility.Public)
            let fields = ImmutableArray.CreateBuilder[FieldSymbol]()
            fields.Add(stateField)
            fields.Add(currentField)
            fields.Add(initialThreadField)
            let fieldMap = Dictionary[VariableSymbol, FieldSymbol]()
            let parameterFields = Dictionary[ParameterSymbol, FieldSymbol]()
            let replayFields = Dictionary[ParameterSymbol, FieldSymbol]()
            for parameter in plan.Function.Parameters {
                let field = FieldSymbol("<>w__" + parameter.Name, parameter.Type, Accessibility.Public)
                let replayField = FieldSymbol("<>3__" + parameter.Name, parameter.Type, Accessibility.Public)
                fields.Add(field)
                fields.Add(replayField)
                fieldMap[parameter] = field
                parameterFields[parameter] = field
                replayFields[parameter] = replayField
            }
            // Issue #641: hoist `this` (the user-class receiver) into a field
            // so the MoveNext body can access instance members of the enclosing
            // class across yield suspension points.
            var thisProxyField FieldSymbol? = nil
            var replayThisField FieldSymbol? = nil
            let receiverType = plan.Function.ReceiverType
            if plan.Function.ThisParameter != nil && receiverType != nil {
                let proxy = FieldSymbol("<>4__this", receiverType, Accessibility.Public)
                let replay = FieldSymbol("<>3__<>4__this", receiverType, Accessibility.Public)
                thisProxyField = proxy
                replayThisField = replay
                fields.Add(proxy)
                fields.Add(replay)
                fieldMap[plan.Function.ThisParameter!!] = proxy
            }
            let hoistedFields = Dictionary[VariableSymbol, FieldSymbol]()
            var hoistedOrdinal = 1
            for local in plan.HoistedLocals {
                if fieldMap.ContainsKey(local) {
                    continue
                }
                // Issue #3689: the hoisted-slot name must be unique per state
                // machine. Two distinct locals routinely share a name — every
                // lowered `for` loop introduces its own `$enum` temp — and the
                // MemberRef path for a generic state machine
                // (UserTokenResolver.GetUserStructFieldRef) resolves the
                // definition field BY NAME, so same-named slots with different
                // types all collapsed onto the first one's signature. In a
                // generic iterator with nested loops that produced
                // `IEnumerator<Node>` where `IEnumerator<T>` was expected
                // (ilverify StackUnexpected). Use the same
                // `<name>5__N` ordinal form the async builder already emits.
                let field = FieldSymbol(
                    GeneratedNames.HoistedLocalField(local.Name, hoistedOrdinal++),
                    local.Type,
                    Accessibility.Public
                )
                fields.Add(field)
                fieldMap[local] = field
                hoistedFields[local] = field
            }
            let smClass = StructSymbol(
                name: "<" + plan.Function.Name + ">d__" + Interlocked.Increment(&this.closures.Counter).ToString(
                    CultureInfo.InvariantCulture
                ),
                fields: fields.ToImmutable(),
                accessibility: Accessibility.Internal,
                declaration: nil,
                packageName: packageName,
                isData: false,
                isInline: false,
                isClass: true
            )
            // Issue #810: stamp the SM class with its class-level type
            // parameters so `EmitNestedStructTypeDef` mangles the name
            // (`<Empty>d__1` → `<Empty>d__1`1`) and emits `GenericParam`
            // rows. Done after construction so the StructSymbol's
            // internal generic flags are flipped without re-running the
            // (cached) `Construct` path.
            if !classTPs.IsDefaultOrEmpty {
                smClass.SetTypeParameters(classTPs)
            }
            let moveNext = FunctionSymbol(
                "MoveNext",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Bool,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let getCurrent = FunctionSymbol(
                "get_Current",
                ImmutableArray[ParameterSymbol].Empty,
                plan.ElementType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let getCurrentObject = FunctionSymbol(
                "get_Current",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral),
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            // Issue #810: when the element type contains an outer-method
            // type parameter, the `IEnumerator<T>` return for GetEnumerator
            // must encode as `IEnumerator<Var(idx)>` (not `IEnumerator<object>`).
            // Build a symbolic `ImportedTypeSymbol` so EncodeTypeSymbol's
            // existing R2 path emits the proper GENERICINST blob; the
            // emit-time remap then translates the outer-method TP to the
            // class's TP. Closed element types continue through the CLR
            // `MakeGenericType` path unchanged.
            // Issue #990: a user-declared element type (`class` / `data
            // struct`) has no ClrType, so the `MakeGenericType` path would
            // erase to `IEnumerator<object>`. Route it through the same
            // symbolic encoder so the GetEnumerator signature stays
            // strongly typed as `IEnumerator<Shape>`.
            let elementNeedsSymbolicEnumerator = TypeSymbol.RequiresSymbolicProjection(plan.ElementType) ||
                plan
                .ElementType
                .ClrType == nil ||
                (plan.ElementType is NullableTypeSymbol and {UnderlyingType: {ClrType: {IsValueType: true}}})
            let getEnumeratorType = if elementNeedsSymbolicEnumerator {
                cast[TypeSymbol](
                    ImportedTypeSymbol.GetConstructed(
                        typeof(System.Collections.Generic.IEnumerator[_]).MakeGenericType(typeof(object)),
                        typeof(System.Collections.Generic.IEnumerator[_]),
                        ImmutableArray.Create[TypeSymbol](plan.ElementType)
                    )
                )
            } else {
                TypeSymbol.FromClrTypeWithoutNullability(
                    typeof(System.Collections.Generic.IEnumerator[_]).MakeGenericType(
                        plan.ElementType.ClrType ?? typeof(object)
                    ),
                    NullabilityFreeReason.TypeLiteral
                )
            }
            let getEnumerator = FunctionSymbol(
                "GetEnumerator",
                ImmutableArray[ParameterSymbol].Empty,
                getEnumeratorType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let getEnumeratorObject = FunctionSymbol(
                "GetEnumerator",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(IEnumerator), NullabilityFreeReason.TypeLiteral),
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let dispose = FunctionSymbol(
                "Dispose",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let reset = FunctionSymbol(
                "Reset",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            smClass.SetMethods(
                ImmutableArray.Create(
                    moveNext,
                    getCurrent,
                    getCurrentObject,
                    getEnumerator,
                    getEnumeratorObject,
                    dispose,
                    reset
                )
            )
            let moveNextBody = IteratorMoveNextBodyBuilder.BuildWithFieldAccess(
                plan,
                stateField,
                currentField,
                Invariant.Required(
                    moveNext.ThisParameter,
                    "a state-machine method has an instance receiver",
                    expression: "moveNext.ThisParameter"
                ),
                smClass,
                fieldMap
            )
                .Body
            this.lambdaBodies[moveNext] = moveNextBody
            this.lambdaBodies[getCurrent] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            BoundFieldAccessExpression(
                                nil,
                                BoundVariableExpression(
                                    nil,
                                    Invariant.Required(
                                        getCurrent.ThisParameter,
                                        "a state-machine method has an instance receiver",
                                        expression: "getCurrent.ThisParameter"
                                    )
                                ),
                                smClass,
                                currentField
                            )
                        )
                    )
                )
            )
            this.lambdaBodies[getCurrentObject] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            BoundConversionExpression(
                                nil,
                                TypeSymbol.FromClrTypeWithoutNullability(
                                    typeof(object),
                                    NullabilityFreeReason.TypeLiteral
                                ),
                                BoundFieldAccessExpression(
                                    nil,
                                    BoundVariableExpression(
                                        nil,
                                        Invariant.Required(
                                            getCurrentObject.ThisParameter,
                                            "a state-machine method has an instance receiver",
                                            expression: "getCurrentObject.ThisParameter"
                                        )
                                    ),
                                    smClass,
                                    currentField
                                )
                            )
                        )
                    )
                )
            )
            this.lambdaBodies[dispose] = IteratorMoveNextBodyBuilder.BuildDisposeBody(
                plan,
                stateField,
                Invariant.Required(
                    dispose.ThisParameter,
                    "a state-machine method has an instance receiver",
                    expression: "dispose.ThisParameter"
                ),
                smClass,
                fieldMap
            )
            this.lambdaBodies[reset] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(
                            nil,
                            BoundFieldAssignmentExpression(
                                nil,
                                Invariant.Required(
                                    reset.ThisParameter,
                                    "a state-machine method has an instance receiver",
                                    expression: "reset.ThisParameter"
                                ),
                                smClass,
                                stateField,
                                BoundLiteralExpression(nil, -1)
                            )
                        ),
                        BoundReturnStatement(nil, nil)
                    )
                )
            )
            // Issue #810: when the SM is generic, a fresh literal must target the CONSTRUCTED instance
            // `<Empty>d__1<MVar(0)>` so the emitted `newobj`/`stfld` tokens
            // land on a TypeSpec carrying the right type arguments. The
            // GetEnumerator overloads run on `this` (an instance of the
            // open SM definition, which encodes as a self-instantiation
            // `<Empty>d__1<Var(0)>`); we pass the open `smClass` to the
            // CreateIteratorStateMachineLiteral helper and let the encoder
            // routing decide. The kickoff body lives inside the user's
            // generic method whose type parameters are still active
            // (`MVar(0)`), so we explicitly construct the SM type over every
            // type parameter in scope.
            let kickoffSmType = if classTPs.IsDefaultOrEmpty {
                smClass
            } else {
                StructSymbol.Construct(
                    smClass,
                    scopeTPs.CastArray[TypeSymbol](),
                    this.emitCtx.References.MapClrTypeToReferences
                )!!
            }
            this.lambdaBodies[getEnumerator] = this.BuildIteratorGetEnumeratorBody(
                getEnumerator,
                smClass,
                stateField,
                initialThreadField,
                parameterFields,
                replayFields,
                plan.Function.Parameters,
                thisProxyField,
                replayThisField
            )
            this.lambdaBodies[getEnumeratorObject] = this.BuildIteratorGetEnumeratorBody(
                getEnumeratorObject,
                smClass,
                stateField,
                initialThreadField,
                parameterFields,
                replayFields,
                plan.Function.Parameters,
                thisProxyField,
                replayThisField
            )
            let parameterValueFactory(ParameterSymbol) -> BoundExpression = (
                parameter ParameterSymbol
            ) -> BoundVariableExpression(nil, parameter)
            let thisProxyValue BoundExpression? = if plan.Function.ThisParameter != nil {
                BoundVariableExpression(nil, plan.Function.ThisParameter)
            } else {
                default(BoundVariableExpression?)
            }
            this.IteratorKickoffBodies[plan.Function] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            this.CreateIteratorStateMachineLiteral(
                                kickoffSmType,
                                stateField,
                                initialThreadField,
                                if IteratorRewriter.ReturnsEnumerable(plan.Function.Type) {
                                    -2
                                } else {
                                    0
                                },
                                parameterFields,
                                replayFields,
                                plan.Function.Parameters,
                                parameterValueFactory,
                                thisProxyField,
                                replayThisField,
                                thisProxyValue
                            )
                        )
                    )
                )
            )
            this.IteratorStateMachineInfos[smClass] = IteratorStateMachineInfo(
                plan,
                smClass,
                scopeTPs,
                classTPs,
                GetIteratorSourceTypeParameterOrigins(plan.Function),
                GetIteratorSourceTypeParameterOriginOffset(plan.Function)
            )
            // Issue #2907: closure materialization inside the SYNC MoveNext body is
            // emitter-owned and bypasses IteratorMoveNextBodyBuilder's variable->field
            // substitution, so it needs the hoisted-field map. Three consumers read
            // this context: closure materialization needs FieldMap; field-token
            // resolution safely uses SmClass; EmitAwaitOnCompletedCall needs builder
            // state but only fires on `await`, which a sync iterator cannot contain.
            this.IteratorEmitContexts[smClass] = IteratorEmitContext(smClass, nil, nil, fieldMap)
            this.closures.SynthesizedClosureClasses.Add(smClass)
        }
    }

    private func BuildIteratorGetEnumeratorBody(
        method FunctionSymbol,
        smClass StructSymbol,
        stateField FieldSymbol,
        initialThreadField FieldSymbol,
        parameterFields Dictionary[ParameterSymbol, FieldSymbol],
        replayFields Dictionary[ParameterSymbol, FieldSymbol],
        parameters ImmutableArray[ParameterSymbol],
        thisProxyField FieldSymbol?,
        replayThisField FieldSymbol?
    ) BoundBlockStatement {
        let thisParameter = Invariant.Required(
            method.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "method.ThisParameter"
        )
        let Read = func (field FieldSymbol) BoundExpression {
            return BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, field)
        }
        let Write = func (field FieldSymbol, value BoundExpression) BoundStatement {
            return BoundExpressionStatement(
                nil,
                BoundFieldAssignmentExpression(nil, thisParameter, smClass, field, value)
            )
        }
        let equal = Invariant.Required(
            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
            "int32 equality exists for iterator reuse"
        )
        let unused = BoundBinaryExpression(nil, Read(stateField), equal, BoundLiteralExpression(nil, -2))
        let sameThread = BoundBinaryExpression(nil, Read(initialThreadField), equal, this.IteratorThreadId())
        let eligible = BoundBinaryExpression(
            nil,
            unused,
            Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                "boolean conjunction exists for iterator reuse"
            ),
            sameThread
        )
        let reuse = ImmutableArray.CreateBuilder[BoundStatement]()
        reuse.Add(Write(stateField, BoundLiteralExpression(nil, 0)))
        // MoveNext can mutate working fields. Replay always starts from separate, unchanged captures.
        for parameter in parameters {
            reuse.Add(Write(parameterFields[parameter], Read(replayFields[parameter])))
        }
        let thisValue = if replayThisField != nil {
            Read(replayThisField)
        } else {
            default(BoundExpression?)
        }
        if thisProxyField != nil && thisValue != nil {
            reuse.Add(Write(thisProxyField, thisValue))
        }
        reuse.Add(BoundReturnStatement(nil, BoundVariableExpression(nil, thisParameter)))
        let ReadParameter = func (parameter ParameterSymbol) BoundExpression {
            return Read(replayFields[parameter])
        }
        return Lowerer.Lower(
            BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundIfStatement(nil, eligible, BoundBlockStatement(nil, reuse.ToImmutable()), nil),
                    BoundReturnStatement(
                        nil,
                        this.CreateIteratorStateMachineLiteral(
                            smClass,
                            stateField,
                            initialThreadField,
                            0,
                            parameterFields,
                            replayFields,
                            parameters,
                            ReadParameter,
                            thisProxyField,
                            replayThisField,
                            thisValue
                        )
                    )
                )
            )
        )
    }

    private func IteratorThreadId() BoundExpression -> BoundClrStaticCallExpression(
        nil,
        BclMember.Method(typeof(Environment), "get_CurrentManagedThreadId"),
        TypeSymbol.Int32,
        ImmutableArray[BoundExpression].Empty
    )

    private func CreateIteratorStateMachineLiteral(
        smClass StructSymbol,
        stateField FieldSymbol,
        initialThreadField FieldSymbol,
        initialState int32,
        parameterFields Dictionary[ParameterSymbol, FieldSymbol],
        replayFields Dictionary[ParameterSymbol, FieldSymbol],
        parameters ImmutableArray[ParameterSymbol],
        parameterValueFactory(ParameterSymbol) -> BoundExpression,
        thisProxyField FieldSymbol? = nil,
        replayThisField FieldSymbol? = nil,
        thisProxyValue BoundExpression? = nil
    ) BoundStructLiteralExpression {
        let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer]()
        initializers.Add(BoundFieldInitializer(stateField, BoundLiteralExpression(nil, initialState)))
        if initialState == -2 {
            initializers.Add(BoundFieldInitializer(initialThreadField, this.IteratorThreadId()))
        }
        for parameter in parameters {
            let value = parameterValueFactory(parameter)
            initializers.Add(BoundFieldInitializer(replayFields[parameter], value))
            if initialState == 0 {
                initializers.Add(BoundFieldInitializer(parameterFields[parameter], value))
            }
        }
        // Issue #641: capture or propagate `this` into <>4__this.
        if replayThisField != nil && thisProxyValue != nil {
            initializers.Add(BoundFieldInitializer(replayThisField, thisProxyValue))
            if initialState == 0 && thisProxyField != nil {
                initializers.Add(BoundFieldInitializer(thisProxyField, thisProxyValue))
            }
        }
        return BoundStructLiteralExpression(nil, smClass, initializers.ToImmutable())
    }

    func SynthesizeAsyncIteratorStateMachines(hostPackage PackageSymbol) {
        if this.AsyncIteratorPlans.IsDefaultOrEmpty {
            return
        }
        for plan in this.AsyncIteratorPlans {
            // Issue #806: same fix as sync iterators — prefer the kickoff
            // function's package so the SM nests under the correct
            // <Program>.
            let packageName = plan.Function.Package?.Name ?? hostPackage?.Name ?? string.Empty
            let elementType = plan.ElementType
            // Issue #1489 (async sibling of #810/#1465): when the async
            // iterator method has type parameters in scope — the enclosing
            // GENERIC type's parameters and/or the method's own type
            // parameters — the synthesized state-machine class must itself be
            // generic over an ordinal-aligned copy of them (mirroring the sync
            // iterator path and Roslyn's `<gen>d__0<T>`). The enclosing type's
            // parameters come first (ordinals 0..k-1), then the method's own
            // (ordinals k..). A method-TP reference inside a field/method
            // signature is translated to the matching class-TP slot via the
            // activeIteratorStateMachineRemap encode-time hook (registered in
            // RME from AsyncIteratorStateMachineGenericInfos).
            let scopeTPs = GetIteratorTypeParametersInScope(plan.Function)
            var classTPs ImmutableArray[TypeParameterSymbol]
            if scopeTPs.IsDefaultOrEmpty {
                classTPs = ImmutableArray[TypeParameterSymbol].Empty
            } else {
                let tpb = ImmutableArray.CreateBuilder[TypeParameterSymbol](scopeTPs.Length)
                for var ti = 0; ti < scopeTPs.Length; ti++ {
                    let scopeTP = scopeTPs[ti]
                    tpb.Add(
                        TypeParameterSymbol(
                            scopeTP.Name,
                            ti,
                            scopeTP.Constraint,
                            scopeTP.Variance,
                            scopeTP.InterfaceConstraint
                        ){
                            HasReferenceTypeConstraint = scopeTP.HasReferenceTypeConstraint,
                            HasValueTypeConstraint = scopeTP.HasValueTypeConstraint,
                            HasDefaultConstructorConstraint = scopeTP.HasDefaultConstructorConstraint,
                            ClrInterfaceConstraint = scopeTP.ClrInterfaceConstraint,
                            ClassConstraint = scopeTP.ClassConstraint,
                            TypeParameterBound = scopeTP.TypeParameterBound,
                            IsMethodTypeParameter = false
                        }
                    )
                }
                classTPs = tpb.MoveToImmutable()
            }
            // Fields
            let stateField = FieldSymbol("<>1__state", TypeSymbol.Int32, Accessibility.Public)
            let currentField = FieldSymbol("<>2__current", elementType, Accessibility.Public)
            let promiseFieldType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(ManualResetValueTaskSourceCore[bool]),
                NullabilityFreeReason.TypeLiteral
            )
            let promiseField = FieldSymbol("<>v__promiseOfValueOrEnd", promiseFieldType, Accessibility.Public)
            let disposeModeField = FieldSymbol("<>w__disposeMode", TypeSymbol.Bool, Accessibility.Public)
            let disposeExceptionField = FieldSymbol(
                "<>w__disposeException",
                TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral),
                Accessibility.Public
            )
            let builderFieldType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(AsyncIteratorMethodBuilder),
                NullabilityFreeReason.TypeLiteral
            )
            let builderField = FieldSymbol("<>t__builder", builderFieldType, Accessibility.Public)
            let fields = ImmutableArray.CreateBuilder[FieldSymbol]()
            fields.Add(stateField)
            fields.Add(currentField)
            fields.Add(promiseField)
            fields.Add(disposeModeField)
            fields.Add(disposeExceptionField)
            fields.Add(builderField)
            let fieldMap = Dictionary[VariableSymbol, FieldSymbol]()
            let parameterFields = Dictionary[ParameterSymbol, FieldSymbol]()
            for parameter in plan.Function.Parameters {
                let field = FieldSymbol("<>3__" + parameter.Name, parameter.Type, Accessibility.Public)
                fields.Add(field)
                fieldMap[parameter] = field
                parameterFields[parameter] = field
            }
            // Issue #641: hoist `this` (the user-class receiver) into a field
            // so the MoveNext body can access instance members of the enclosing
            // class across yield/await suspension points.
            var thisProxyField FieldSymbol? = nil
            if plan.Function.ThisParameter != nil && plan.Function.ReceiverType != nil {
                thisProxyField = FieldSymbol("<>4__this", plan.Function.ReceiverType, Accessibility.Public)
                fields.Add(thisProxyField)
                fieldMap[plan.Function.ThisParameter!!] = thisProxyField
            }
            var hoistedOrdinal = 1
            for local in plan.HoistedLocals {
                if fieldMap.ContainsKey(local) {
                    continue
                }
                // Issue #3689: see the sync-iterator builder above — hoisted
                // slot names must be unique, because the generic state
                // machine's field MemberRefs are resolved by name.
                let field = FieldSymbol(
                    GeneratedNames.HoistedLocalField(local.Name, hoistedOrdinal++),
                    local.Type,
                    Accessibility.Public
                )
                fields.Add(field)
                fieldMap[local] = field
            }
            // Awaiter pool fields
            let awaiterPoolFields = Dictionary[Type, FieldSymbol]()
            var awaiterOrdinal = 1
            for (poolKey, fieldType) in plan.AwaiterTypes {
                let fieldName = "<>u__" + awaiterOrdinal++.ToString()
                let field = FieldSymbol(fieldName, fieldType, Accessibility.Public)
                fields.Add(field)
                awaiterPoolFields[poolKey] = field
            }
            let smClass = StructSymbol(
                name: "<" + plan.Function.Name + ">d__" + Interlocked.Increment(&this.closures.Counter).ToString(
                    CultureInfo.InvariantCulture
                ),
                fields: fields.ToImmutable(),
                accessibility: Accessibility.Internal,
                declaration: nil,
                packageName: packageName,
                isData: false,
                isInline: false,
                isClass: true
            )
            // Issue #1489: stamp the async-iterator SM class with its
            // class-level type parameters so `EmitNestedStructTypeDef` mangles
            // the name (`<gen>d__1` → `<gen>d__1`1`) and emits `GenericParam`
            // rows. Done after construction so the StructSymbol's internal
            // generic flags are flipped without re-running the cached
            // `Construct` path. The matching outer-method-TP → class-TP remap
            // is registered by RME from `AsyncIteratorStateMachineGenericInfos`.
            if !classTPs.IsDefaultOrEmpty {
                smClass.SetTypeParameters(classTPs)
                this.AsyncIteratorStateMachineGenericInfos[smClass] = IteratorStateMachineGenericInfo(
                    scopeTPs,
                    classTPs
                )
            }
            // Methods: MoveNext, get_Current, MoveNextAsync, DisposeAsync, GetAsyncEnumerator
            let moveNext = FunctionSymbol(
                "MoveNext",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let getCurrent = FunctionSymbol(
                "get_Current",
                ImmutableArray[ParameterSymbol].Empty,
                elementType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let valueTaskBoolType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(ValueTask[bool]),
                NullabilityFreeReason.TypeLiteral
            )
            let moveNextAsync = FunctionSymbol(
                "MoveNextAsync",
                ImmutableArray[ParameterSymbol].Empty,
                valueTaskBoolType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let valueTaskType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(ValueTask),
                NullabilityFreeReason.TypeLiteral
            )
            let disposeAsync = FunctionSymbol(
                "DisposeAsync",
                ImmutableArray[ParameterSymbol].Empty,
                valueTaskType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            let methods = ImmutableArray.CreateBuilder[FunctionSymbol]()
            methods.Add(moveNext)
            methods.Add(getCurrent)
            methods.Add(moveNextAsync)
            methods.Add(disposeAsync)
            var getAsyncEnumerator FunctionSymbol? = nil
            if plan.IsEnumerable {
                // Issue #1002/#3412 (parallel to #990 sync iterators): an
                // element containing a same-compilation user type can have no
                // ClrType or an object-erased constructed ClrType, so the CLR
                // path below can erase its nested user type. That makes
                // `shapes()` (signature `IAsyncEnumerable<Shape>`) return an SM
                // whose `GetAsyncEnumerator` advertises `IAsyncEnumerator<object>`
                // — invalid under generic invariance (ilverify StackUnexpected).
                // Route such element types through the symbolic
                // `ImportedTypeSymbol.GetConstructed` so the encoder emits a
                // strongly-typed `IAsyncEnumerator<Shape>` GENERICINST blob
                // referencing the user TypeDef.
                let enumeratorType = if TypeSymbol.RequiresSymbolicProjection(elementType) ||
                    elementType.ClrType == nil ||
                    (elementType is NullableTypeSymbol and {UnderlyingType: {ClrType: {IsValueType: true}}}) {
                    cast[TypeSymbol](
                        ImportedTypeSymbol.GetConstructed(
                            typeof(System.Collections.Generic.IAsyncEnumerator[_]).MakeGenericType(typeof(object)),
                            typeof(System.Collections.Generic.IAsyncEnumerator[_]),
                            ImmutableArray.Create[TypeSymbol](elementType)
                        )
                    )
                } else {
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(System.Collections.Generic.IAsyncEnumerator[_]).MakeGenericType(
                            elementType.ClrType ?? typeof(object)
                        ),
                        NullabilityFreeReason.TypeLiteral
                    )
                }
                let ctParam = ParameterSymbol(
                    "cancellationToken",
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(CancellationToken),
                        NullabilityFreeReason.TypeLiteral
                    )
                )
                getAsyncEnumerator = FunctionSymbol(
                    "GetAsyncEnumerator",
                    ImmutableArray.Create(ctParam),
                    enumeratorType,
                    nil,
                    hostPackage,
                    Accessibility.Public,
                    cast[TypeSymbol](smClass)
                )
                methods.Add(getAsyncEnumerator)
            }
            // IValueTaskSource<bool> methods
            let shortType = TypeSymbol.FromClrTypeWithoutNullability(typeof(int16), NullabilityFreeReason.TypeLiteral)
            let vtsStatusType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(ValueTaskSourceStatus),
                NullabilityFreeReason.TypeLiteral
            )
            let getStatusParam = ParameterSymbol("token", shortType)
            let getStatus = FunctionSymbol(
                "GetStatus",
                ImmutableArray.Create(getStatusParam),
                vtsStatusType,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            methods.Add(getStatus)
            let getResultParam = ParameterSymbol("token", shortType)
            let getResult = FunctionSymbol(
                "GetResult",
                ImmutableArray.Create(getResultParam),
                TypeSymbol.Bool,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            methods.Add(getResult)
            let onCompletedParams = ImmutableArray.Create(
                ParameterSymbol(
                    "continuation",
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof((object) -> void),
                        NullabilityFreeReason.TypeLiteral
                    )
                ),
                ParameterSymbol(
                    "state",
                    TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
                ),
                ParameterSymbol("token", shortType),
                ParameterSymbol(
                    "flags",
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(ValueTaskSourceOnCompletedFlags),
                        NullabilityFreeReason.TypeLiteral
                    )
                )
            )
            let onCompleted = FunctionSymbol(
                "OnCompleted",
                onCompletedParams,
                TypeSymbol.Void,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            methods.Add(onCompleted)
            // IAsyncStateMachine.SetStateMachine (no-op for class-based SM)
            let setSmParam = ParameterSymbol(
                "stateMachine",
                TypeSymbol.FromClrTypeWithoutNullability(typeof(IAsyncStateMachine), NullabilityFreeReason.TypeLiteral)
            )
            let setStateMachine = FunctionSymbol(
                "SetStateMachine",
                ImmutableArray.Create(setSmParam),
                TypeSymbol.Void,
                nil,
                hostPackage,
                Accessibility.Public,
                cast[TypeSymbol](smClass)
            )
            methods.Add(setStateMachine)
            smClass.SetMethods(methods.ToImmutable())
            // Build MoveNext body (handles both yield and await).
            let moveNextBody = AsyncIteratorMoveNextBodyBuilder.Build(
                plan,
                smClass,
                Invariant.Required(
                    moveNext.ThisParameter,
                    "a state-machine method has an instance receiver",
                    expression: "moveNext.ThisParameter"
                ),
                stateField,
                currentField,
                promiseField,
                disposeModeField,
                disposeExceptionField,
                builderField,
                fieldMap,
                awaiterPoolFields
            )
            this.lambdaBodies[moveNext] = Lowerer.Lower(moveNextBody)
            // get_Current: return this.<>2__current;
            this.lambdaBodies[getCurrent] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            BoundFieldAccessExpression(
                                nil,
                                BoundVariableExpression(
                                    nil,
                                    Invariant.Required(
                                        getCurrent.ThisParameter,
                                        "a state-machine method has an instance receiver",
                                        expression: "getCurrent.ThisParameter"
                                    )
                                ),
                                smClass,
                                currentField
                            )
                        )
                    )
                )
            )
            // MoveNextAsync: reset promise, call builder.MoveNext(ref this), return ValueTask<bool>
            // For simplicity: directly set result. The builder calls MoveNext synchronously first;
            // if it suspends, the continuation will complete the promise.
            // Implementation:
            //   if (state == -2) return new ValueTask<bool>(false);
            //   promise.Reset();
            //   builder.MoveNext(ref this);
            //   short version = promise.Version;
            //   return new ValueTask<bool>(this, version);
            // But this requires IValueTaskSource<bool> which we implement.
            // Simpler approach for this slice: call MoveNext directly and check if
            // the promise has a result. Actually the simplest correct approach:
            // Promise-based ValueTask construction requires implementing IValueTaskSource<bool>.
            // For this slice, we'll use a simpler approach: just run MoveNext and construct
            // the ValueTask from the result.
            // Actually the cleanest: use Task.FromResult pattern via the direct promise.
            this.lambdaBodies[moveNextAsync] = this.BuildMoveNextAsyncBody(
                moveNextAsync,
                smClass,
                stateField,
                promiseField,
                builderField,
                moveNext
            )
            // DisposeAsync: set disposeMode = true; call MoveNextAsync-style; return ValueTask
            this.lambdaBodies[disposeAsync] = this.BuildDisposeAsyncBody(
                disposeAsync,
                smClass,
                stateField,
                disposeModeField,
                promiseField,
                builderField,
                moveNext
            )
            // GetAsyncEnumerator: return this (with state set to -1)
            if getAsyncEnumerator != nil {
                this.lambdaBodies[getAsyncEnumerator] = this.BuildGetAsyncEnumeratorBody(
                    getAsyncEnumerator,
                    smClass,
                    stateField,
                    disposeModeField,
                    plan.Function.Parameters,
                    parameterFields
                )
            }
            // IValueTaskSource<bool>.GetStatus(short token): return promise.GetStatus(token);
            this.lambdaBodies[getStatus] = this.BuildVtsGetStatusBody(getStatus, smClass, promiseField)
            // IValueTaskSource<bool>.GetResult(short token): return promise.GetResult(token);
            this.lambdaBodies[getResult] = this.BuildVtsGetResultBody(getResult, smClass, promiseField)
            // IValueTaskSource<bool>.OnCompleted(...): promise.OnCompleted(continuation, state, token, flags);
            this.lambdaBodies[onCompleted] = this.BuildVtsOnCompletedBody(onCompleted, smClass, promiseField)
            // IAsyncStateMachine.SetStateMachine: no-op (just return)
            this.lambdaBodies[setStateMachine] = Lowerer.Lower(
                BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, nil)))
            )
            // Kickoff body: new SM { state = -3, params..., <>4__this = this }.
            // Issue #1489: when the SM is generic, the kickoff literal target
            // must be the CONSTRUCTED instance `<gen>d__1<MVar(0),…>` (over the
            // type parameters still in scope at the kickoff method) so the
            // emitted `newobj`/`stfld` tokens land on a TypeSpec carrying the
            // right type arguments. Non-generic iterators keep the open class.
            let kickoffSmType = if classTPs.IsDefaultOrEmpty {
                smClass
            } else {
                StructSymbol.Construct(
                    smClass,
                    scopeTPs.CastArray[TypeSymbol](),
                    this.emitCtx.References.MapClrTypeToReferences
                )!!
            }
            this.IteratorKickoffBodies[plan.Function] = Lowerer.Lower(
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundReturnStatement(
                            nil,
                            this.CreateAsyncIteratorKickoffLiteral(
                                kickoffSmType,
                                stateField,
                                builderField,
                                parameterFields,
                                plan.Function.Parameters,
                                thisProxyField,
                                plan.Function
                            )
                        )
                    )
                )
            )
            this.AsyncIteratorInfos[smClass] = plan
            this.closures.SynthesizedClosureClasses.Add(smClass)
            // Resolve builder info for the async iterator's emit context. Issue #1489:
            // a generic async iterator's return type is an AsyncSequenceTypeSymbol
            // over an open type parameter, whose ClrType is null — but the
            // builder for EVERY async iterator is the element-agnostic,
            // non-generic AsyncIteratorMethodBuilder. Resolve against a closed
            // IAsyncEnumerable<object> placeholder so the builder members
            // (Create / MoveNext / AwaitOnCompleted / AwaitUnsafeOnCompleted)
            // are always bound regardless of element shape.
            let returnClrType = plan.Function.Type?.ClrType ?? typeof(IAsyncEnumerable[object])
            let aiBuilderInfo = AsyncMethodBuilderInfo.Resolve(returnClrType, this.emitCtx.References)
            this.IteratorEmitContexts[smClass] = IteratorEmitContext(smClass, builderField, aiBuilderInfo, fieldMap)
        }
    }

    private func BuildMoveNextAsyncBody(
        moveNextAsync FunctionSymbol,
        smClass StructSymbol,
        stateField FieldSymbol,
        promiseField FieldSymbol,
        builderField FieldSymbol,
        moveNextMethod FunctionSymbol
    ) BoundBlockStatement {
        let thisParam = Invariant.Required(
            moveNextAsync.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "moveNextAsync.ThisParameter"
        )
        let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
        // if (state == -2) return default(ValueTask<bool>); // completed
        let finishedLabel = BoundLabel("<>mna_notFinished")
        stmts.Add(
            BoundConditionalGotoStatement(
                nil,
                finishedLabel,
                BoundBinaryExpression(
                    nil,
                    BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, stateField),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 equality operator exists for state-machine completion",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    BoundLiteralExpression(nil, StateMachineStates.FinishedState)
                ),
                jumpIfTrue: false
            )
        )
        // Return a completed ValueTask<bool>(false)
        stmts.Add(
            BoundReturnStatement(
                nil,
                BoundDefaultExpression(
                    nil,
                    TypeSymbol.FromClrTypeWithoutNullability(typeof(ValueTask[bool]), NullabilityFreeReason.TypeLiteral)
                )
            )
        )
        stmts.Add(BoundLabelStatement(nil, finishedLabel))
        // promise.Reset();
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let resetMethod = BclMember.Method(promiseType, "Reset")
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        stmts.Add(
            BoundExpressionStatement(
                nil,
                BoundImportedInstanceCallExpression(
                    nil,
                    promiseAddr,
                    resetMethod,
                    TypeSymbol.Void,
                    ImmutableArray[BoundExpression].Empty
                )
            )
        )
        // builder.MoveNext(ref this); — uses marker node for MethodSpec emission
        stmts.Add(
            BoundExpressionStatement(nil, BoundStateMachineBuilderMoveNext(nil, builderField, thisParam, smClass))
        )
        // short version = promise.Version;
        let versionGetter = BclMember.Getter(promiseType, "Version")
        let promiseAddr2 = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        let versionCall = BoundImportedInstanceCallExpression(
            nil,
            promiseAddr2,
            versionGetter,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(int16), NullabilityFreeReason.TypeLiteral),
            ImmutableArray[BoundExpression].Empty
        )
        let versionLocal = LocalVariableSymbol(
            "<>version",
            isReadOnly: false,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(int16), NullabilityFreeReason.TypeLiteral)
        )
        stmts.Add(BoundVariableDeclaration(nil, versionLocal, versionCall))
        // return new ValueTask<bool>(this, version);
        // The ValueTask<bool>(IValueTaskSource<bool>, short) constructor
        let vtCtor = BclMember.Ctor(typeof(ValueTask[bool]), typeof(IValueTaskSource[bool]), typeof(int16))
        let vtConstruct = BoundClrConstructorCallExpression(
            nil,
            typeof(ValueTask[bool]),
            vtCtor,
            ImmutableArray.Create[BoundExpression](
                BoundVariableExpression(nil, thisParam),
                BoundVariableExpression(nil, versionLocal)
            ),
            TypeSymbol.FromClrTypeWithoutNullability(typeof(ValueTask[bool]), NullabilityFreeReason.TypeLiteral)
        )
        stmts.Add(BoundReturnStatement(nil, vtConstruct))
        return Lowerer.Lower(BoundBlockStatement(nil, stmts.ToImmutable()))
    }

    private func BuildDisposeAsyncBody(
        disposeAsync FunctionSymbol,
        smClass StructSymbol,
        stateField FieldSymbol,
        disposeModeField FieldSymbol,
        promiseField FieldSymbol,
        builderField FieldSymbol,
        moveNextMethod FunctionSymbol
    ) BoundBlockStatement {
        let thisParam = Invariant.Required(
            disposeAsync.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "disposeAsync.ThisParameter"
        )
        let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
        // if (state == -2) return default(ValueTask);
        let finishedCheck = BoundBinaryExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, stateField),
            Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 equality operator exists for state-machine disposal",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            ),
            BoundLiteralExpression(nil, StateMachineStates.FinishedState)
        )
        let earlyReturn = BoundReturnStatement(
            nil,
            BoundDefaultExpression(
                nil,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(ValueTask), NullabilityFreeReason.TypeLiteral)
            )
        )
        stmts.Add(BoundIfStatement(nil, finishedCheck, earlyReturn, nil))
        // this.<>w__disposeMode = true;
        stmts.Add(
            BoundExpressionStatement(
                nil,
                BoundFieldAssignmentExpression(
                    nil,
                    thisParam,
                    smClass,
                    disposeModeField,
                    BoundLiteralExpression(nil, true)
                )
            )
        )
        // promise.Reset();
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let resetMethod = BclMember.Method(promiseType, "Reset")
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        stmts.Add(
            BoundExpressionStatement(
                nil,
                BoundImportedInstanceCallExpression(
                    nil,
                    promiseAddr,
                    resetMethod,
                    TypeSymbol.Void,
                    ImmutableArray[BoundExpression].Empty
                )
            )
        )
        // builder.MoveNext(ref this); — uses marker node for MethodSpec emission
        stmts.Add(
            BoundExpressionStatement(nil, BoundStateMachineBuilderMoveNext(nil, builderField, thisParam, smClass))
        )
        let versionGetter = BclMember.Getter(promiseType, "Version")
        let versionCall = BoundImportedInstanceCallExpression(
            nil,
            BoundAddressOfExpression(
                nil,
                BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
            ),
            versionGetter,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(int16), NullabilityFreeReason.TypeLiteral),
            ImmutableArray[BoundExpression].Empty
        )
        let versionLocal = LocalVariableSymbol(
            "<>disposeVersion",
            isReadOnly: false,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(int16), NullabilityFreeReason.TypeLiteral)
        )
        stmts.Add(BoundVariableDeclaration(nil, versionLocal, versionCall))
        let valueTaskBoolType = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(ValueTask[bool]),
            NullabilityFreeReason.TypeLiteral
        )
        let valueTaskBool = BoundClrConstructorCallExpression(
            nil,
            typeof(ValueTask[bool]),
            BclMember.Ctor(typeof(ValueTask[bool]), typeof(IValueTaskSource[bool]), typeof(int16)),
            ImmutableArray.Create[BoundExpression](
                BoundVariableExpression(nil, thisParam),
                BoundVariableExpression(nil, versionLocal)
            ),
            valueTaskBoolType
        )
        let valueTaskBoolLocal = LocalVariableSymbol("<>disposeTask", isReadOnly: false, valueTaskBoolType)
        stmts.Add(BoundVariableDeclaration(nil, valueTaskBoolLocal, valueTaskBool))
        let asTask = BoundImportedInstanceCallExpression(
            nil,
            BoundAddressOfExpression(nil, BoundVariableExpression(nil, valueTaskBoolLocal)),
            BclMember.Method(typeof(ValueTask[bool]), "AsTask", Type.EmptyTypes),
            TypeSymbol.FromClrTypeWithoutNullability(typeof(Task[bool]), NullabilityFreeReason.TypeLiteral),
            ImmutableArray[BoundExpression].Empty
        )
        let valueTask = BoundClrConstructorCallExpression(
            nil,
            typeof(ValueTask),
            BclMember.Ctor(typeof(ValueTask), typeof(Task)),
            ImmutableArray.Create[BoundExpression](asTask),
            TypeSymbol.FromClrTypeWithoutNullability(typeof(ValueTask), NullabilityFreeReason.TypeLiteral)
        )
        stmts.Add(BoundReturnStatement(nil, valueTask))
        return Lowerer.Lower(BoundBlockStatement(nil, stmts.ToImmutable()))
    }

    private func BuildGetAsyncEnumeratorBody(
        getAsyncEnumerator FunctionSymbol,
        smClass StructSymbol,
        stateField FieldSymbol,
        disposeModeField FieldSymbol,
        userParameters ImmutableArray[ParameterSymbol],
        parameterFields Dictionary[ParameterSymbol, FieldSymbol]
    ) BoundBlockStatement {
        let thisParam = Invariant.Required(
            getAsyncEnumerator.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "getAsyncEnumerator.ThisParameter"
        )
        let ctParam = getAsyncEnumerator.Parameters[0]
        let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
        // this.<>1__state = -1; (running state)
        stmts.Add(
            BoundExpressionStatement(
                nil,
                BoundFieldAssignmentExpression(
                    nil,
                    thisParam,
                    smClass,
                    stateField,
                    BoundLiteralExpression(nil, StateMachineStates.NotStartedOrRunningState)
                )
            )
        )
        // this.<>w__disposeMode = false; (reset dispose flag for re-enumeration)
        stmts.Add(
            BoundExpressionStatement(
                nil,
                BoundFieldAssignmentExpression(
                    nil,
                    thisParam,
                    smClass,
                    disposeModeField,
                    BoundLiteralExpression(nil, false)
                )
            )
        )
        // Issue #180 / ADR-0040: thread the runtime-supplied cancellation
        // token into the user's @EnumeratorCancellation parameter. The C#
        // semantics combine the original kickoff token with the per-enumerator
        // token via CancellationTokenSource.CreateLinkedTokenSource; for this
        // slice we adopt the conservative "override when meaningful" rule:
        // if the caller passed a real (cancellable) token via WithCancellation,
        // assign it to the parameter field; otherwise keep the kickoff value.
        //     if (cancellationToken.CanBeCanceled) {
        //         this.<param> = cancellationToken;
        //     }
        if !userParameters.IsDefaultOrEmpty {
            for userParam in userParameters {
                let ecAttr BoundAttribute? = KnownAttributes.FindEnumeratorCancellation(userParam.Attributes)
                if ecAttr == nil {
                    continue
                }
                if userParam.Type?.ClrType.IsSameAs(typeof(CancellationToken)) != true {
                    // Binder already reported GS0207; skip emit-time threading.
                    continue
                }
                if !parameterFields.TryGetValue(userParam, out var paramField) {
                    continue
                }
                let canBeCanceledGetter = BclMember.Getter(typeof(CancellationToken), "CanBeCanceled")
                let canBeCanceledCall = BoundImportedInstanceCallExpression(
                    nil,
                    BoundAddressOfExpression(nil, BoundVariableExpression(nil, ctParam)),
                    canBeCanceledGetter,
                    TypeSymbol.Bool,
                    ImmutableArray[BoundExpression].Empty
                )
                let assign = BoundExpressionStatement(
                    nil,
                    BoundFieldAssignmentExpression(
                        nil,
                        thisParam,
                        smClass,
                        paramField,
                        BoundVariableExpression(nil, ctParam)
                    )
                )
                stmts.Add(
                    BoundIfStatement(
                        nil,
                        canBeCanceledCall,
                        BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](assign)),
                        elseStatement: nil
                    )
                )
                // Only one parameter may carry the marker; if a user wrote
                // multiple, the binder accepts the first and downstream emit
                // honours that same parameter.
                break
            }
        }
        // return this;
        stmts.Add(BoundReturnStatement(nil, BoundVariableExpression(nil, thisParam)))
        return Lowerer.Lower(BoundBlockStatement(nil, stmts.ToImmutable()))
    }

    private func BuildVtsGetStatusBody(
        $func FunctionSymbol,
        smClass StructSymbol,
        promiseField FieldSymbol
    ) BoundBlockStatement {
        // return promise.GetStatus(token);
        let thisParam = Invariant.Required(
            $func.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "func.ThisParameter"
        )
        let tokenParam = $func.Parameters[0]
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let method = BclMember.Method(promiseType, "GetStatus", typeof(int16))
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        let call = BoundImportedInstanceCallExpression(
            nil,
            promiseAddr,
            method,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(ValueTaskSourceStatus), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, tokenParam))
        )
        return Lowerer.Lower(
            BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, call)))
        )
    }

    private func BuildVtsGetResultBody(
        $func FunctionSymbol,
        smClass StructSymbol,
        promiseField FieldSymbol
    ) BoundBlockStatement {
        // return promise.GetResult(token);
        let thisParam = Invariant.Required(
            $func.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "func.ThisParameter"
        )
        let tokenParam = $func.Parameters[0]
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let method = BclMember.Method(promiseType, "GetResult", typeof(int16))
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        let call = BoundImportedInstanceCallExpression(
            nil,
            promiseAddr,
            method,
            TypeSymbol.Bool,
            ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, tokenParam))
        )
        return Lowerer.Lower(
            BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, call)))
        )
    }

    private func BuildVtsOnCompletedBody(
        $func FunctionSymbol,
        smClass StructSymbol,
        promiseField FieldSymbol
    ) BoundBlockStatement {
        // promise.OnCompleted(continuation, state, token, flags);
        let thisParam = Invariant.Required(
            $func.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "func.ThisParameter"
        )
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let method = BclMember.Method(promiseType, "OnCompleted")
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        let args = ImmutableArray.Create[BoundExpression](
            BoundVariableExpression(nil, $func.Parameters[0]),
            BoundVariableExpression(nil, $func.Parameters[1]),
            BoundVariableExpression(nil, $func.Parameters[2]),
            BoundVariableExpression(nil, $func.Parameters[3])
        )
        let call = BoundImportedInstanceCallExpression(nil, promiseAddr, method, TypeSymbol.Void, args)
        return Lowerer.Lower(
            BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundExpressionStatement(nil, call),
                    BoundReturnStatement(nil, nil)
                )
            )
        )
    }

    private func BuildVtsGetResultVoidBody(
        $func FunctionSymbol,
        smClass StructSymbol,
        promiseField FieldSymbol
    ) BoundBlockStatement {
        // promise.GetResult(token); // discard bool
        let thisParam = Invariant.Required(
            $func.ThisParameter,
            "a state-machine method has an instance receiver",
            expression: "func.ThisParameter"
        )
        let tokenParam = $func.Parameters[0]
        let promiseType = typeof(ManualResetValueTaskSourceCore[bool])
        let method = BclMember.Method(promiseType, "GetResult", typeof(int16))
        let promiseAddr = BoundAddressOfExpression(
            nil,
            BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParam), smClass, promiseField)
        )
        let call = BoundImportedInstanceCallExpression(
            nil,
            promiseAddr,
            method,
            TypeSymbol.Bool,
            ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, tokenParam))
        )
        return Lowerer.Lower(
            BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundExpressionStatement(nil, call),
                    BoundReturnStatement(nil, nil)
                )
            )
        )
    }

    private func CreateAsyncIteratorKickoffLiteral(
        smClass StructSymbol,
        stateField FieldSymbol,
        builderField FieldSymbol,
        parameterFields Dictionary[ParameterSymbol, FieldSymbol],
        parameters ImmutableArray[ParameterSymbol],
        thisProxyField FieldSymbol?,
        kickoffFunction FunctionSymbol
    ) BoundStructLiteralExpression {
        let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer]()
        initializers.Add(
            BoundFieldInitializer(stateField, BoundLiteralExpression(nil, StateMachineStates.InitialAsyncIteratorState))
        )
        // Builder: AsyncIteratorMethodBuilder.Create()
        let createMethod = BclMember.Method(typeof(AsyncIteratorMethodBuilder), "Create", Type.EmptyTypes)
        initializers.Add(
            BoundFieldInitializer(
                builderField,
                BoundClrStaticCallExpression(
                    nil,
                    createMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(AsyncIteratorMethodBuilder),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray[BoundExpression].Empty
                )
            )
        )
        for parameter in parameters {
            initializers.Add(BoundFieldInitializer(parameterFields[parameter], BoundVariableExpression(nil, parameter)))
        }
        // Issue #641: capture `this` into <>4__this so MoveNext can access
        // instance members of the enclosing class.
        if thisProxyField != nil && kickoffFunction.ThisParameter != nil {
            initializers.Add(
                BoundFieldInitializer(thisProxyField, BoundVariableExpression(nil, kickoffFunction.ThisParameter))
            )
        }
        return BoundStructLiteralExpression(nil, smClass, initializers.ToImmutable())
    }

    /// For each async lambda, runs the async state-machine pipeline on its body
    /// and produces an (cref:AsyncStateMachinePlan). For no-capture lambdas
    /// the kickoff method is the lambda's own FunctionSymbol; for capture-bearing
    /// lambdas the kickoff is the closure class's Invoke method.
    func SynthesizeAsyncLambdaStateMachines(literals List[BoundFunctionLiteralExpression], hostPackage PackageSymbol) {
        let packageName = hostPackage?.Name ?? this.emitCtx.Program.PackageName ?? string.Empty
        let plans = this.AsyncStateMachinePlans.ToBuilder()
        for literal in literals {
            if !literal.Function.IsAsync {
                continue
            }
            var kickoffFunction FunctionSymbol
            var body BoundBlockStatement?
            if this.closures.ClosureInfos.TryGetValue(literal, out var closure) {
                // Capture-bearing async lambda: the closure's Invoke method is the kickoff.
                kickoffFunction = closure.InvokeMethod
                kickoffFunction.IsAsync = true
                kickoffFunction.IsAsyncVoid = literal.Function.IsAsyncVoid
                kickoffFunction.AsyncReturnsValueTask = literal.Function.AsyncReturnsValueTask
                if !this.lambdaBodies.TryGetValue(kickoffFunction, out body) {
                    continue
                }
            } else {
                // No-capture async lambda: the lambda's own function symbol is the kickoff.
                kickoffFunction = literal.Function
                if !this.lambdaBodies.TryGetValue(kickoffFunction, out body) {
                    body = literal.Body
                }
            }
            // Lambda bodies are not pre-lowered (the Lowerer doesn't descend into
            // BoundFunctionLiteralExpression). Lower before the async pipeline.
            body = cast[BoundBlockStatement](Lowerer.Lower(body!!))
            let plan AsyncStateMachinePlan? = AsyncStateMachineRewriter.RewriteSingle(
                kickoffFunction,
                body,
                this.emitCtx.References,
                packageName
            )
            if plan == nil {
                continue
            }
            // Record nesting: capture-bearing async lambda SMs nest inside
            // their closure class (Subset A of the Roslyn nesting convention).
            if this.closures.ClosureInfos.TryGetValue(literal, out var closureForNesting) {
                let smStruct = plan.StateMachine.MaterializeAsStructSymbol()
                this.AsyncSmEnclosingClosures[smStruct] = closureForNesting.ClassSym
            }
            plans.Add(plan)
        }
        this.AsyncStateMachinePlans = plans.ToImmutable()
    }

    /// Emits the `MoveNext()` method body for an async state machine, using
    /// the rewritten bound-tree body produced by `MoveNextBodyRewriter`.
    func EmitStateMachineMoveNext(plan AsyncStateMachinePlan) {
        let bodyResult = this.buildMoveNextBodyBytes(plan)
        // MoveNext signature: void MoveNext() (instance)
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        let moveNextHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("MoveNext"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyResult.BodyOffset,
            parameterList: this.nextParameterHandle()
        )
        // Phase 4/5 (ADR-0027 §7.7a): MoveNext is the visible body for an async
        // method post-lowering; sequence points and locals captured here surface
        // in debugger stack traces, locals window, and `step` commands across
        // `await` points.
        this
            .emitCtx
            .Pdb
            ?.RecordMethod(
            moveNextHandle,
            bodyResult.SequencePoints,
            bodyResult.Locals,
            bodyResult.Constants,
            bodyResult.CodeSize,
            bodyResult.LocalsSignature,
            plan.KickoffMethod?.Declaration?.SyntaxTree,
            bodyResult.AsyncStepping
        )
    }

    /// Emits the `SetStateMachine(IAsyncStateMachine)` method for an
    /// async state machine. For struct state machines, this is a no-op body.
    func EmitStateMachineSetStateMachine(plan AsyncStateMachinePlan) {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let iAsyncSmType = typeof(IAsyncStateMachine)
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                this.encodeClrType(ps.AddParameter().Type(), iAsyncSmType)
            }
        )
        this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot | MethodAttributes.Final,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("SetStateMachine"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// Emits the kickoff body for an async function: creates the state-machine
    /// local, initializes fields, calls `builder.Start(ref sm)`, and
    /// returns `builder.Task` (or returns void for async void).
    /// @param function The kickoff function symbol.
    /// @param plan The async state-machine plan.
    /// @param driveSynchronously Issue #1904: when `true` (the async function is the
    /// CLR entry point), the CLR requires a `void`/`int32`/`uint32`
    /// return — never `Task`/`Task<T>` (the runtime rejects such
    /// an entry point with `MethodAccessException` at process start).
    /// Instead of returning `builder.Task`, block on it right here with
    /// the same `GetAwaiter().GetResult()` drive C# generates for
    /// `async Task Main()`, then return void/the unwrapped result.
    func EmitAsyncKickoffBody(
        function FunctionSymbol,
        plan AsyncStateMachinePlan,
        driveSynchronously bool = false
    ) int32 {
        let smStruct = plan.StateMachine.MaterializeAsStructSymbol()
        // Issue #2030 (gap 2): when the kickoff method (or its enclosing
        // type) is generic, `smStruct` carries its OWN reified type
        // parameters (set by RegisterStateMachineEnclosingGenerics) — these
        // encode as Var(idx) when referenced from WITHIN an SM member
        // (MoveNext etc., a legitimate self-instantiation). But this kickoff
        // body is NOT a member of the SM struct: it is a member of the
        // kickoff's own (possibly non-generic) enclosing type. Referencing
        // the SM type here must instantiate it over the kickoff's ORIGINAL
        // in-scope type parameters (enclosing class TPs as Var, the
        // kickoff's own TPs as MVar) — mirroring the iterator kickoff's
        // `kickoffSmType` pattern elsewhere in this file — otherwise the
        // emitted `!0` self-instantiation is meaningless outside the SM
        // struct (BadImageFormatException at load).
        //
        // Issue #3939: this instantiation must be exactly the list the struct
        // was REIFIED from, so it comes from the shared
        // GetAsyncKickoffTypeParametersInScope primitive rather than being
        // recomputed here. Recomputing it is how the two drifted: this site
        // read only `ReceiverType`, so a `shared async func Fetch[U]()` on a
        // generic `Holder[T]` produced a 1-argument instantiation of a
        // 2-parameter state machine (`TypeLoadException`, "used with the wrong
        // number of generic arguments"), while the instance form on the same
        // type and the `shared` form of a NON-generic method were both fine.
        let kickoffScopeTPs = GetAsyncKickoffTypeParametersInScope(function)
        let kickoffSmStruct = if kickoffScopeTPs.IsDefaultOrEmpty {
            smStruct
        } else {
            StructSymbol.Construct(smStruct, kickoffScopeTPs.CastArray[TypeSymbol]())!!
        }
        let smTypeDef = this.getStructTypeToken(kickoffSmStruct)
        let builderInfo = plan.StateMachine.BuilderInfo
        let stateFieldHandle = this.resolveFieldToken(kickoffSmStruct, plan.FieldMap.StateField)
        let builderFieldHandle = this.resolveFieldToken(kickoffSmStruct, plan.FieldMap.BuilderField)
        let il = InstructionEncoder(BlobBuilder())
        // Local 0: the state-machine struct instance.
        // ldloca.s 0 / initobj SM  — zero-initialize the struct.
        il.LoadLocalAddress(0)
        il.OpCode(ILOpCode.Initobj)
        il.Token(smTypeDef)
        // sm.<>t__builder = AsyncTaskMethodBuilder[<T>].Create()
        il.LoadLocalAddress(0)
        let createRef = this.getMethodEntityHandleForContainingType(
            Invariant.Required(
                builderInfo.CreateMethod,
                "a state machine is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, which requires Create",
                expression: "builderInfo.CreateMethod"
            ),
            plan.FieldMap.BuilderField.Type
        )
        il.OpCode(ILOpCode.Call)
        il.Token(createRef)
        il.OpCode(ILOpCode.Stfld)
        il.Token(builderFieldHandle)
        // Copy this (for instance methods)
        if plan.FieldMap.ThisField != nil && function.IsInstanceMethod {
            let thisFieldHandle = this.resolveFieldToken(kickoffSmStruct, plan.FieldMap.ThisField!!)
            il.LoadLocalAddress(0)
            il.LoadArgument(0)
            if function.ReceiverType is StructSymbol{IsClass: false} receiverStruct {
                il.OpCode(ILOpCode.Ldobj)
                il.Token(this.getStructTypeToken(receiverStruct))
            }
            il.OpCode(ILOpCode.Stfld)
            il.Token(thisFieldHandle)
        }
        // Copy parameters
        let paramSlotShift = if function.IsInstanceMethod {
            1
        } else {
            0
        }
        var paramIndex = 0
        for copy in plan.KickoffPlan.ParameterCopies {
            let fieldHandle = this.resolveFieldToken(kickoffSmStruct, copy.Field)
            il.LoadLocalAddress(0)
            il.LoadArgument(paramIndex + paramSlotShift)
            il.OpCode(ILOpCode.Stfld)
            il.Token(fieldHandle)
            paramIndex++
        }
        // sm.<>1__state = -1
        il.LoadLocalAddress(0)
        il.LoadConstantI4(StateMachineStates.NotStartedOrRunningState)
        il.OpCode(ILOpCode.Stfld)
        il.Token(stateFieldHandle)
        // sm.<>t__builder.Start<SM>(ref sm)
        // ldloca 0  (address of sm for ldflda builder)
        // ldflda <>t__builder
        // ldloca 0  (ref sm as argument)
        // call Start<SM>(ref SM)
        il.LoadLocalAddress(0)
        il.OpCode(ILOpCode.Ldflda)
        il.Token(builderFieldHandle)
        il.LoadLocalAddress(0)
        // Start is generic: Start<TStateMachine>(ref TStateMachine).
        // We need a MethodSpec for Start<SM>.
        let startMethodSpec = this.GetStateMachineStartMethodSpec(
            Invariant.Required(
                builderInfo.StartMethod,
                "a state machine is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, which requires Start",
                expression: "builderInfo.StartMethod"
            ),
            kickoffSmStruct,
            plan.FieldMap.BuilderField.Type
        )
        il.OpCode(ILOpCode.Call)
        il.Token(startMethodSpec)
        // Return builder.Task or void
        var awaiterClrType Type? = nil
        var getResultMethod MethodInfo? = nil
        if builderInfo.TaskProperty != nil {
            // ldloca 0, ldflda builder, call get_Task
            il.LoadLocalAddress(0)
            il.OpCode(ILOpCode.Ldflda)
            il.Token(builderFieldHandle)
            let getTaskMethod = Invariant.Required(
                builderInfo.TaskProperty!!.GetGetMethod(),
                "the builder's Task property is a public instance property of a BCL builder type, so it declares a public getter",
                expression: "builderInfo.TaskProperty.GetGetMethod()"
            )
            let getTaskRef = this.getMethodEntityHandleForContainingType(getTaskMethod, plan.FieldMap.BuilderField.Type)
            il.OpCode(ILOpCode.Call)
            il.Token(getTaskRef)
            // Issue #1904: the CLR entry point must return void/int32/uint32,
            // never Task/Task<T> — the runtime throws MethodAccessException
            // at process start otherwise. Block on the task here (the same
            // GetAwaiter().GetResult() drive C# generates for `async Task
            // Main()`) instead of returning it.
            if driveSynchronously {
                let taskClrType = builderInfo.TaskProperty!!.PropertyType
                let getAwaiterMethod = BclMember.Method(taskClrType, "GetAwaiter", Type.EmptyTypes)
                awaiterClrType = getAwaiterMethod.ReturnType
                getResultMethod = BclMember.Method(awaiterClrType, "GetResult", Type.EmptyTypes)
                il.OpCode(ILOpCode.Callvirt)
                il.Token(this.getMethodEntityHandle(getAwaiterMethod))
                il.StoreLocal(1)
                il.LoadLocalAddress(1)
                il.OpCode(ILOpCode.Call)
                il.Token(this.getMethodEntityHandle(getResultMethod))
            }
        }
        il.OpCode(ILOpCode.Ret)
        // Locals: one local of the state-machine struct type, plus (for a
        // synchronously-driven async entry point) a second local holding the
        // task awaiter struct so GetResult() can be called on its address.
        // Issue #1465: encode through EncodeTypeSymbol so a generic SM is
        // written as the self-instantiated GENERICINST rather than a bare
        // VALUETYPE token.
        let localsSigBlob = BlobBuilder()
        let localsEncoder = BlobEncoder(localsSigBlob).LocalVariableSignature(
            if awaiterClrType != nil {
                2
            } else {
                1
            }
        )
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), kickoffSmStruct)
        if awaiterClrType != nil {
            this.encodeClrType(localsEncoder.AddVariable().Type(), awaiterClrType)
        }
        let localsSignature = this
            .emitCtx
            .Metadata
            .AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob))
        return this
            .emitCtx
            .MethodBodyStream
            .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature)
    }

    /// Gets a MethodSpec for `builder.Start<SM>(ref SM)` where SM
    /// is the state-machine struct TypeDef.
    private func GetStateMachineStartMethodSpec(
        startOpenMethod MethodInfo,
        smStruct StructSymbol,
        builderFieldType TypeSymbol
    ) EntityHandle {
        // Start is an open generic instance method on the builder struct.
        // We need: MemberRef for Start<T>(ref T) on the builder type,
        // then a MethodSpec instantiating it with the SM TypeDef.
        let openRef = this.getMethodEntityHandleForContainingType(
            if startOpenMethod.IsGenericMethod {
                startOpenMethod.GetGenericMethodDefinition()
            } else {
                startOpenMethod
            },
            builderFieldType
        )
        // Build MethodSpec signature: instantiation with the SM struct type.
        // Issue #1465: encode through EncodeTypeSymbol so a generic SM is
        // written as the self-instantiated GENERICINST<SM><!0,…>.
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(1)
        this.encodeTypeSymbol(argsEncoder.AddArgument(), smStruct)
        return this.emitCtx.MetadataRows.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Emits the `builder.AwaitUnsafeOnCompleted<TAwaiter, TSM>(ref awaiter, ref this)`
    /// or `AwaitOnCompleted` call from within MoveNext. Requires manual MethodSpec
    /// construction because TStateMachine is the synthesized SM TypeDef.
    func EmitAwaitOnCompletedCall(
        il InstructionEncoder,
        locals Dictionary[VariableSymbol, int32],
        parameters Dictionary[ParameterSymbol, int32],
        node BoundStateMachineAwaitOnCompleted,
        currentPlan AsyncStateMachinePlan? = nil,
        iteratorCtx IteratorEmitContext? = nil
    ) {
        var currentPlan = currentPlan
        // Use the explicitly-passed plan when available; fall back to the
        // legacy search for backward compatibility with top-level async.
        if currentPlan == nil && iteratorCtx == nil {
            for plan in this.AsyncStateMachinePlans {
                if plan.FieldMap.StateField != nil {
                    if this.cache.StructFieldDefs.ContainsKey(plan.FieldMap.BuilderField) {
                        currentPlan = plan
                        break
                    }
                }
            }
        }
        var builderField FieldSymbol
        var smStruct StructSymbol
        var builderInfo AsyncMethodBuilderInfo
        var smIsValueType bool
        if iteratorCtx != nil {
            // Only the synchronous-iterator form leaves the builder members
            // unset, and a synchronous iterator has no await to complete, so
            // it never reaches this emitter.
            builderField = Invariant.Required(
                iteratorCtx.BuilderField,
                "an await inside an iterator means the async-iterator form, which carries a builder field",
                expression: "iteratorCtx.BuilderField"
            )
            smStruct = iteratorCtx.SmClass
            builderInfo = Invariant.Required(
                iteratorCtx.BuilderInfo,
                "an await inside an iterator means the async-iterator form, which carries resolved builder members",
                expression: "iteratorCtx.BuilderInfo"
            )
            smIsValueType = false // async iterator SM is a class

        } else if currentPlan != nil {
            builderField = currentPlan.FieldMap.BuilderField
            smStruct = currentPlan.StateMachine.MaterializeAsStructSymbol()
            builderInfo = currentPlan.StateMachine.BuilderInfo
            smIsValueType = !smStruct.IsClass
        } else {
            throw InvalidOperationException("Cannot emit AwaitOnCompleted: no active async plan.")
        }
        let builderFieldHandle = this.resolveFieldToken(smStruct, builderField)
        // ldarg.0 (this)
        // ldflda builder
        il.LoadArgument(0)
        il.OpCode(ILOpCode.Ldflda)
        il.Token(builderFieldHandle)
        // ldloca awaiter
        let awaiterSlot = locals[node.AwaiterLocal]
        il.LoadLocalAddress(awaiterSlot)
        // ref this: for struct SM ldarg.0 is already a managed pointer;
        // for class SM we need ldarga.s 0 (address of the 'this' arg slot).
        if smIsValueType {
            il.LoadArgument(0)
        } else {
            il.OpCode(ILOpCode.Ldarga_s)
            il.CodeBuilder.WriteByte(0)
        }
        // Build MethodSpec for AwaitUnsafeOnCompleted<TAwaiter, TSM> or AwaitOnCompleted<TAwaiter, TSM>
        // AwaitOnCompleted / AwaitUnsafeOnCompleted are among the four members
        // AsyncMethodBuilderInfo.IsValid requires, and a state machine is only
        // built for a builder that passed it -- the same establisher
        // KickoffBodyBuilder cites for Create/Start.
        let openMethod = Invariant.Required(
            if node.UseCritical {
                builderInfo.AwaitUnsafeOnCompletedMethod
            } else {
                builderInfo.AwaitOnCompletedMethod
            },
            "a state machine is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, which requires both await-completion members",
            expression: "node.UseCritical ? builderInfo.AwaitUnsafeOnCompletedMethod : builderInfo.AwaitOnCompletedMethod"
        )
        let openRef = this.getMethodEntityHandleForContainingType(
            if openMethod.IsGenericMethod {
                openMethod.GetGenericMethodDefinition()
            } else {
                openMethod
            },
            builderField.Type
        )
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(2)
        // First type arg: TAwaiter
        if node.AwaiterTypeSymbol != nil {
            this.encodeTypeSymbol(argsEncoder.AddArgument(), node.AwaiterTypeSymbol)
        } else {
            this.encodeClrType(argsEncoder.AddArgument(), node.AwaiterClrType)
        }
        // Second type arg: TStateMachine. Issue #1465: encode through
        // EncodeTypeSymbol so a generic SM is written as the self-instantiated
        // GENERICINST<SM><!0,…> rather than a bare TypeDef token.
        this.encodeTypeSymbol(argsEncoder.AddArgument(), smStruct)
        let methodSpec = this
            .emitCtx
            .MetadataRows
            .AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
        il.OpCode(ILOpCode.Call)
        il.Token(methodSpec)
    }

    shared {
        /// Issue #3939: the single place that decides which type parameters are in
        /// scope at an ASYNC kickoff method — the owning type's, then the kickoff's
        /// own, in Roslyn order. Two emit paths depend on this list agreeing
        /// exactly: `ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics`
        /// reifies the state-machine struct at this ARITY, and
        /// (cref:EmitAsyncKickoffBody) self-instantiates the struct with
        /// this INSTANTIATION. They used to compute it independently, and the
        /// second read only `ReceiverType` — so a `shared async func
        /// Fetch[U]()` on a generic `Holder[T]` was reified at arity 2 and
        /// then referenced as `<Fetch>d__0`2<!!0>`, which the
        /// runtime rejects with `TypeLoadException` ("used with the wrong
        /// number of generic arguments"). This is the same `StaticOwnerType`
        /// gap #3932 root C closed on the reification side, still open on the
        /// kickoff side; both now route through here, so they cannot drift again.
        /// The ITERATOR sibling has always had this property — its kickoff
        /// constructs over the very `scopeTPs` the class was reified from.
        /// @param kickoff The async kickoff method, or `null`.
        /// @returns The owning type's definition, its type parameters, and the kickoff's own.
        internal func GetAsyncKickoffGenericScope(kickoff FunctionSymbol?)(
            OwnerDefinition StructSymbol?,
            ClassTypeParameters ImmutableArray[TypeParameterSymbol],
            MethodTypeParameters ImmutableArray[TypeParameterSymbol]
        ) {
            // `StaticOwnerType` is the static counterpart of `ReceiverType`: a
            // `shared` method has no receiver but still lives on the owning type.
            let owner StructSymbol? = (kickoff?.ReceiverType as StructSymbol) ??
                (kickoff?.StaticOwnerType as StructSymbol)
            let ownerDefinition = if owner == nil {
                default(StructSymbol?)
            } else {
                owner.Definition ?? owner
            }
            var classTPs = ownerDefinition?.TypeParameters ?? ImmutableArray[TypeParameterSymbol].Empty
            if classTPs.IsDefault {
                classTPs = ImmutableArray[TypeParameterSymbol].Empty
            }
            let methodTPs = if kickoff == nil || kickoff.TypeParameters.IsDefaultOrEmpty {
                ImmutableArray[TypeParameterSymbol].Empty
            } else {
                kickoff.TypeParameters
            }
            return (ownerDefinition, classTPs, methodTPs)
        }

        /// Issue #3939: the flattened form of (cref:GetAsyncKickoffGenericScope)
        /// — the state machine's slot order, class parameters before method
        /// parameters.
        /// @param kickoff The async kickoff method, or `null`.
        /// @returns The in-scope type parameters in state-machine slot order.
        internal func GetAsyncKickoffTypeParametersInScope(kickoff FunctionSymbol?) ImmutableArray[
            TypeParameterSymbol
        ] {
            let (_, classTPs, methodTPs) = GetAsyncKickoffGenericScope(kickoff)
            return classTPs.AddRange(methodTPs)
        }

        private func GetIteratorTypeParametersInScope(function FunctionSymbol) ImmutableArray[TypeParameterSymbol] {
            let builder = ImmutableArray.CreateBuilder[TypeParameterSymbol]()
            let containingType StructSymbol? = function.ReceiverType as StructSymbol ??
                function.StaticOwnerType as StructSymbol
            if containingType != nil {
                let definition = containingType.Definition ?? containingType
                // Issue #3933: a SYNTHESIZED closure / lambda host that was reified
                // over its lexical encloser's type parameters ALREADY re-declares
                // them as its own (that is what ReifiedFromTypeParameters records),
                // and #1512/#3933 then nest it inside that encloser so it shares the
                // encloser's accessibility domain. Walking the enclosing chain here
                // as well would count each of those parameters TWICE — for a lambda
                // inside `Factory`1[T]`'s `make[U]` the state machine came out at
                // arity 3 (`T`, `T'`, `U'`) instead of 2, and the extra slot made
                // every hoisted field's signature name a parameter the kickoff's
                // self-instantiation never supplies: `TypeLoadException` ("has a
                // field of an illegal type") at the first call. A real user nested
                // type has an empty reified list and still needs the chain, so this
                // narrows to the synthesized case only.
                if definition.ReifiedFromTypeParameters.IsDefaultOrEmpty {
                    builder.AddRange(StructSymbol.CollectEnclosingTypeParameters(definition))
                }
                if !definition.TypeParameters.IsDefaultOrEmpty {
                    builder.AddRange(definition.TypeParameters)
                }
            }
            if !function.TypeParameters.IsDefaultOrEmpty {
                builder.AddRange(function.TypeParameters)
            }
            return builder.ToImmutable()
        }

        /// Issue #3933: the ORIGINAL lexically enclosing type parameters that the
        /// containing SYNTHESIZED closure / lambda host re-declared as its own,
        /// aligned 1:1 with the leading entries of
        /// (cref:GetIteratorTypeParametersInScope). Empty for a real user
        /// receiver, which has nothing to alias.
        /// @param function The iterator kickoff function.
        /// @returns The originals in state-machine slot order, or empty.
        private func GetIteratorSourceTypeParameterOrigins(function FunctionSymbol) ImmutableArray[
            TypeParameterSymbol
        ] {
            let containingType StructSymbol? = function.ReceiverType as StructSymbol ??
                function.StaticOwnerType as StructSymbol
            let definition = if containingType == nil {
                default(StructSymbol?)
            } else {
                containingType.Definition ?? containingType
            }
            return definition?.ReifiedFromTypeParameters ?? ImmutableArray[TypeParameterSymbol].Empty
        }

        private func GetIteratorSourceTypeParameterOriginOffset(function FunctionSymbol) int32 {
            let containingType StructSymbol? = function.ReceiverType as StructSymbol ??
                function.StaticOwnerType as StructSymbol
            let definition = if containingType == nil {
                default(StructSymbol?)
            } else {
                containingType.Definition ?? containingType
            }
            return definition?.ReifiedTypeParameterOrdinalOffset ?? 0
        }
    }
}
