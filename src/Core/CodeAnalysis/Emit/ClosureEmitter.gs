// <copyright file="ClosureEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.Threading
import System.Threading.Tasks

/// Closure-environment orchestration and display-class synthesis. Owns
/// the metadata that describes every lambda / `go` capture environment
/// emitted into the assembly, and owns the rewriter that lowers a captured-
/// variable read inside a lambda body into a `this.field` access against
/// the synthesized display class.
/// @remarks PR-E-9 introduces this component. Per the decomposition plan, the
/// closure-emit surface is split between two host types in the pre-refactor
/// source — exactly as PR-E-5 (cref:ConversionEmitter) handled the
/// conversion-emit surface:
///
/// - Stateless, top-level orchestration on (cref:ReflectionMetadataEmitter) (`SynthesizeClosures`,
/// `SynthesizeGoClosures`, `SynthesizeDisplayClass`) plus the nested helper classes
/// ((cref:ClosureInfo), (cref:CaptureRewriter), (cref:ConstructedTypeCollector)) and the closure-state
/// caches ((cref:ClosureInfos), (cref:GoClosureInfos), (cref:ClosureInvokeToInfo),
/// (cref:SynthesizedClosureClasses), (cref:Counter)). <strong>These move here.</strong>
/// - Body-emit-internal closure methods inside `BodyEmitter` (`EmitFunctionLiteral` [two overloads],
/// `EmitMethodGroup`, `EmitFunctionToDelegateConversion`, `EmitFunctionToNamedDelegateConversion`,
/// `EmitFunctionLiteralToNamedDelegate`, `EmitMethodGroupToNamedDelegate`, `EmitClrEventSubscription`,
/// `EmitUserEventSubscription`, `EmitCapturedVariableLoad`) that reference `BodyEmitter`'s private
/// `il`, `outer`, `locals`, `parameters`, `enclosingClosure` fields and call back into `EmitExpression`
/// / `EmitLoadVariable` for every captured value and method-group target. <strong>These are deferred to
/// PR-E-11 <c>MethodBodyEmitter</c></strong>, where `BodyEmitter` is promoted to its own top-level type
/// with its own partials (including `MethodBodyEmitter.Closures.cs`). Moving them in PR-E-9 would
/// require widening `BodyEmitter`'s private surface to expose all of those collaborators through an
/// `IBodyEmitContext` interface, only to take it apart again in PR-E-11. <strong>This is the same
/// Option B playbook PR-E-5 used</strong> for the same reason.
///
/// <b>Future home of the #567 / #503 unifying fix.</b> The plan calls this
/// PR out as "the structural home for the eventual #567 + #503 unifying
/// fix" — closure-environment emission unified with display-class
/// emission. The fix itself is deferred until PR-E-11 promotes
/// `BodyEmitter` to `MethodBodyEmitter`, because the fix needs to
/// span both the synthesis side (here) and the emit-time side
/// (`EmitCapturedVariableLoad` / `EmitFunctionLiteral`). Putting
/// the synthesis side in its own type today is the prerequisite that lets
/// PR-E-11 land that cross-cutting fix in one focused diff without
/// rummaging through the root emitter.
///
/// <b>What stays on <see cref="ReflectionMetadataEmitter" /></b>:
///
/// - The `lambdaBodies` dictionary. It is cross-cutting (populated by closure synthesis here AND by
/// every state-machine synthesizer in E-10), and the root emitter walks it from `EmitFunction`. Keeping
/// it on the root means E-9 and the future E-10 both write into it via the constructor-injected
/// dictionary reference, and the root keeps its existing read paths unchanged. The plan explicitly
/// nominates this option ("Pick (a) for this PR — it keeps the diff minimal").
/// - `RegisterConstructedTypeAliases`. It is a single-use caller of (cref:ConstructedTypeCollector)
/// that walks the root's program-function bodies and lambda bodies and writes into the
/// (cref:MetadataTokenCache); it is not closure orchestration in its own right. The collector type
/// moves here (it is closure-emit-side per PR-E-4's deferral note); the caller stays.
/// - The state-machine synthesizers (`SynthesizeIteratorStateMachines`,
/// `SynthesizeAsyncIteratorStateMachines`, `SynthesizeAsyncLambdaStateMachines`) and their nested
/// classes (`IteratorStateMachineInfo`, `IteratorEmitContext`). These move with PR-E-10
/// `StateMachineEmitter`. They share the (cref:Counter) field and append to
/// (cref:SynthesizedClosureClasses) from the root; both are exposed publicly here so the still-on-root
/// SM methods (and, once moved, the future `StateMachineEmitter`) can mutate them directly.
///
/// Like every other PR-E-* component, (cref:ClosureEmitter) is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) trio as its peers, plus the
/// (cref:SlotPlanner) for `go`-statement capture discovery
/// and a shared reference to the root's `lambdaBodies` dictionary so
/// it can register every synthesized closure-Invoke body without taking a
/// hard back-reference to (cref:ReflectionMetadataEmitter).
internal class ClosureEmitter {
    /// Monotonically increasing counter that disambiguates synthesized
    /// closure / state-machine class names. Public field (not property)
    /// so callers can pass it to (cref:System.Threading.Interlocked.Increment(ref int))
    /// directly. The root emitter's state-machine synthesizers
    /// (`SynthesizeIteratorStateMachines`,
    /// `SynthesizeAsyncIteratorStateMachines`) increment this
    /// counter alongside (cref:SynthesizeClosures) /
    /// (cref:SynthesizeGoClosures) so every synthesized class
    /// gets a globally unique name.
    var Counter int32

    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let slotPlanner SlotPlanner
    private let lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement]

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        slotPlanner SlotPlanner,
        lambdaBodies Dictionary[FunctionSymbol, BoundBlockStatement]
    ) {
        ClosureInfos = Dictionary[BoundFunctionLiteralExpression, ClosureInfo]()
        GenericLocalClosures = Dictionary[FunctionSymbol, (Literal BoundFunctionLiteralExpression, Info ClosureInfo)]()
        GoClosureInfos = Dictionary[BoundGoStatement, ClosureInfo]()
        GoClosureInfosBySyntax = Dictionary[SyntaxNode, ClosureInfo](ReferenceEqualityComparer.Instance)
        ClosureInvokeToInfo = Dictionary[FunctionSymbol, ClosureInfo]()
        SynthesizedClosureClasses = List[StructSymbol]()
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.slotPlanner = slotPlanner ?? throw ArgumentNullException("slotPlanner")
        this.lambdaBodies = lambdaBodies ?? throw ArgumentNullException("lambdaBodies")
    }

    /// Gets per-lambda closure metadata for every captured-variable function
    /// literal in the program. Populated by (cref:SynthesizeClosures)
    /// and read by both the root emitter (when wiring `BodyEmitter`'s
    /// `enclosingClosure`) and by `BodyEmitter` itself (for the
    /// `EmitFunctionLiteral` path).
    prop ClosureInfos Dictionary[BoundFunctionLiteralExpression, ClosureInfo] {
        get;
    }

    /// Gets, for every CAPTURING direct-call local function
    /// ((cref:FunctionSymbol.LocalDeclaration) non-null — a member of
    /// a generic OR (issue #4219 umbrella remainder) non-generic local-
    /// function-literal group — whose (cref:BoundFunctionLiteralExpression.CapturedVariables)
    /// is non-empty), its closure metadata. A direct `BoundCallExpression`
    /// naming such a function must dispatch through `Info.InvokeMethod`
    /// (see `MethodBodyEmitter.EmitCallExpression`) rather than a
    /// top-level MethodDef, because the literal itself was hosted as that
    /// closure's instance method, not as a standalone function.
    prop GenericLocalClosures Dictionary[FunctionSymbol, (Literal BoundFunctionLiteralExpression, Info ClosureInfo)] {
        get;
    }

    /// Gets per-`go`-site closure metadata. The display class wraps the
    /// `go` expression in an `InvokeAction` method (or
    /// `InvokeAsync` for async `go`) that `Task.Run` can
    /// bind to.
    prop GoClosureInfos Dictionary[BoundGoStatement, ClosureInfo] {
        get;
    }

    /// Gets the go closures by the go statement's syntax. A go statement inside an
    /// async or suspending body reaches the emitter as a node the state-machine
    /// rewriters rebuilt (its operand's locals became hoisted-field reads), so
    /// node identity alone cannot find the closure synthesized from the
    /// original body; the syntax can.
    prop GoClosureInfosBySyntax Dictionary[SyntaxNode, ClosureInfo] {
        get;
    }

    /// Gets the reverse map from a closure-invoke (cref:FunctionSymbol) to
    /// its (cref:ClosureInfo). The root emitter reads this when
    /// constructing a `BodyEmitter` so nested-closure transitive
    /// captures (issue #503 follow-up) route through the enclosing
    /// display class.
    prop ClosureInvokeToInfo Dictionary[FunctionSymbol, ClosureInfo] {
        get;
    }

    /// Gets every synthesized aggregate class emitted on behalf of a closure,
    /// `go` site, or state machine. The root emitter appends these
    /// to the program's user-struct list before TypeDef row planning;
    /// state-machine synthesizers (still on the root, moving with
    /// PR-E-10) also append to this list directly, which is why the
    /// collection is exposed as a mutable (cref:List{T}).
    prop SynthesizedClosureClasses List[StructSymbol] {
        get;
    }

    // Phase 4 emit parity (E2): for each lambda that captures outer variables,
    // synthesize a sealed closure class on the entry-point package with:
    //   - one public field per captured VariableSymbol (typed identically),
    //   - one instance method (the lambda body, with captured reads/writes
    //     rewritten to this.field reads/writes),
    //   - a default ctor (chains to object::.ctor() via the existing
    //     EmitClassDefaultConstructor path).
    // Capture semantics are snapshot-by-value at literal creation time — the
    // same semantics the interpreter implements (see
    // <c>EvaluateFunctionLiteralExpression</c>): writes inside the lambda
    // update the closure copy only, not the outer variable.
    //
    // Nested-lambda captures (a lambda that captures a variable already
    // captured by an enclosing closure) are not yet supported: detecting them
    // requires another rewrite layer. The synthesis throws a clear
    // NotSupportedException for that case.
    func SynthesizeClosures(literals List[BoundFunctionLiteralExpression], hostPackage PackageSymbol) {
        for literal in literals {
            if literal
                .Function
                .LocalDeclaration != nil &&
                literal
                .CapturedVariables
                .IsEmpty &&
                literal
                .Function
                .HasNonGenericLexicalOwner &&
                literal
                .Function
                .LexicalEnclosingType is {} localEnclosing {
                // Keep direct generic MethodDef/MethodSpec identity while sharing the
                // lexical type's accessibility domain. No delegate or host instance.
                let host = StructSymbol(
                    name: "<local_host_" + Interlocked.Increment(&this.Counter).ToString(CultureInfo.InvariantCulture) +
                        ">",
                    fields: ImmutableArray[FieldSymbol].Empty,
                    accessibility: Accessibility.Internal,
                    declaration: nil,
                    packageName: hostPackage.Name,
                    isData: false,
                    isInline: false,
                    isClass: true
                )
                host.SetContainingType(localEnclosing)
                literal.Function.IsStatic = true
                literal.Function.StaticOwnerType = host
                host.SetMethods(ImmutableArray.Create(literal.Function))
                this.SynthesizedClosureClasses.Add(host)
                continue
            }
            if literal.CapturedVariables.Length == 0 {
                // Issue #1469: a non-capturing lambda is normally hoisted to a
                // static method on the top-level `<Program>` host type. When the
                // lambda is lexically declared inside a member of a user type and
                // reads a `protected`/`private` member (e.g. a positional member
                // of a `protected` nested data class, or a private backing field),
                // the `<Program>`-hosted method is outside that member's
                // accessibility domain — producing an unverifiable `FieldAccess`/
                // `MethodAccess` ("not visible") IL site and a runtime
                // `FieldAccessException`/`MethodAccessException`. C# avoids this by
                // hosting the lambda in a display class nested inside the declaring
                // type, sharing its accessibility domain. Mirror that here by
                // routing the non-capturing lambda through a (fieldless) display
                // class nested in the enclosing user type, exactly as the
                // capture-bearing #1335 path does. Issue #2668 extends the same
                // placement to async lambdas so their MoveNext methods retain
                // access to private static members of the lexical encloser.
                // Issue #3933: generic enclosers used to be skipped here, because
                // a nested type must re-declare the encloser's type parameters
                // (ECMA-335 §II.10.3.1) and this synthesis did not model that.
                // The consequence was the exact bug #1469 exists to prevent, just
                // one type-parameter away: a capture-free lambda inside a GENERIC
                // type that reads a `private` member of that type stayed on
                // `<Program>`, was generic-promoted by #2118 so the field access
                // read `Node`1<!!T>::secret`, and failed ILVerify with
                // `FieldAccess: Field is not visible` / threw
                // `FieldAccessException` at the first call. The capturing sibling
                // has handled this since #1512 by reifying the display class over
                // the encloser's type parameters before nesting it, and the
                // reification (SynthesizedClosureReifier, driven from
                // SynthesizeDisplayClass) is entirely shape-independent of whether
                // the class carries capture fields. So the zero-capture host now
                // goes through the same machinery, passing the encloser's OWN
                // type-parameter list as `requiredTypeParameters` so the nested
                // host re-declares them positionally even when the lambda body
                // happens to reference only some of them (or none).
                // All other non-capturing lambdas keep the existing top-level
                // `<Program>` static placement.
                //
                // Issue #1886: a GENERIC local function (`let Name[T] = func
                // (...) ... {...}`) is declared as a real FunctionSymbol
                // resolved through direct `BoundCallExpression` calls, not
                // through the delegate-value indirect-call path that consults
                // ClosureInfos to redirect to `closure.InvokeMethod`. Nesting
                // it here would also require this display class's fieldless
                // Invoke method to itself be generic, which
                // SynthesizeDisplayClass does not model. A generic local
                // function MAY capture outer state (#4221), but a capturing
                // one is handled by its own dedicated branch below (a closure
                // class whose Invoke method carries the local function's own
                // generic parameters); this zero-field-host path always
                // excludes every generic local function, capturing or not,
                // and uses a direct static host above rather than an instance
                // Invoke method. A capture-free generic local function stays
                // on the top-level `<Program>` host instead (issue #4223:
                // UserTokenResolver.TryPromoteNonCapturingGenericLambda reifies
                // any ENCLOSING type parameter it references as an additional
                // method type parameter of its own MethodDef — no display-
                // class nesting is needed for that). A generic local function
                // that ALSO needs its lexical owner's accessibility domain
                // (private/protected member access) remains unsupported
                // (GS0586) when that owner is itself generic.
                if literal
                    .Function
                    .IsGeneric ||
                    literal
                    .Function
                    .LexicalEnclosingType is not{} zeroCaptureEnclosing ||
                    !((zeroCaptureEnclosing is StructSymbol || zeroCaptureEnclosing is InterfaceSymbol)) {
                    continue
                }
                let requiredTypeParameters = CollectOwnerTypeParameters(zeroCaptureEnclosing)
                let hostName = "<lambda_host_" + literal.Function.Name + "_" + Interlocked.Increment(&this.Counter)
                    .ToString(CultureInfo.InvariantCulture) + ">"
                let hostInfo = this.SynthesizeDisplayClass(
                    hostName,
                    ImmutableArray[VariableSymbol].Empty,
                    literal.Function.Parameters,
                    literal.Function.Type,
                    literal.Function.ReturnRefKind,
                    literal.Body,
                    hostPackage,
                    invokeName: "Invoke",
                    requiredTypeParameters: requiredTypeParameters
                )
                this.ClosureInfos[literal] = hostInfo
                if hostInfo.ClassSym.ContainingType == nil {
                    hostInfo.ClassSym.SetContainingType(zeroCaptureEnclosing)
                }
                continue
            }
            // Issue #4221, widened by #4219's umbrella remainder: handle
            // CAPTURING direct-call local functions — generic (#4221) or,
            // now, non-generic (a member of a 2+ non-generic local-function-
            // literal group, see StatementBinder.IsNonGenericLocalFunctionLiteralDeclaration) —
            // by routing through a closure class with an Invoke method,
            // preserving any own type parameters (empty for non-generic).
            // `Function.LocalDeclaration != null` is exactly the direct-call
            // signal set by LambdaBinder.PrepareGenericLocalFunctionDeclaration
            // for both shapes; a plain non-generic closure-valued lambda
            // (the ordinary `let f = func ...` delegate-cell path) never
            // sets it and keeps using the default closure branch below,
            // dispatched through its delegate value instead of a direct call.
            if literal.Function.LocalDeclaration != nil && literal.CapturedVariables.Length > 0 {
                let genericClosureName = "<closure_" + literal.Function.Name + "_" + Interlocked.Increment(
                    &this.Counter
                )
                    .ToString(CultureInfo.InvariantCulture) + ">"
                let requiredTypeParameters = if literal.Function.LexicalEnclosingType is {} genericOwner {
                    CollectOwnerTypeParameters(genericOwner)
                } else {
                    ImmutableArray[TypeParameterSymbol].Empty
                }
                let genericInfo = this.SynthesizeDisplayClass(
                    genericClosureName,
                    literal.CapturedVariables,
                    literal.Function.Parameters,
                    literal.Function.Type,
                    literal.Function.ReturnRefKind,
                    literal.Body,
                    hostPackage,
                    invokeName: "Invoke",
                    requiredTypeParameters: requiredTypeParameters,
                    excludedTypeParameters: literal.Function.TypeParameters
                )
                // Transfer the generic local's type parameters to the Invoke method
                genericInfo.InvokeMethod.TypeParameters = literal.Function.TypeParameters
                this.ClosureInfos[literal] = genericInfo
                this.GenericLocalClosures[literal.Function] = (literal, genericInfo)
                // Nest inside enclosing type if accessible
                if literal
                    .Function
                    .LexicalEnclosingType is {} genericEnclosing &&
                    (genericEnclosing is StructSymbol or InterfaceSymbol) &&
                    genericInfo
                    .ClassSym
                    .ContainingType == nil {
                    genericInfo.ClassSym.SetContainingType(genericEnclosing)
                }
                continue
            }
            let closureName = "<closure_" + literal.Function.Name + "_" + Interlocked.Increment(&this.Counter).ToString(
                CultureInfo.InvariantCulture
            ) +
                ">"
            let requiredClosureTypeParameters = if literal.Function.LexicalEnclosingType is {} owner {
                CollectOwnerTypeParameters(owner)
            } else {
                ImmutableArray[TypeParameterSymbol].Empty
            }
            let info = this.SynthesizeDisplayClass(
                closureName,
                literal.CapturedVariables,
                literal.Function.Parameters,
                literal.Function.Type,
                literal.Function.ReturnRefKind,
                literal.Body,
                hostPackage,
                invokeName: "Invoke",
                requiredTypeParameters: requiredClosureTypeParameters
            )
            this.ClosureInfos[literal] = info
            // Issue #1335: a closure declared inside a member of a user type must
            // be able to reach that type's `protected`/`private` members (matching
            // C#, which nests display classes inside the containing type). Emitting
            // the closure as a CLR type nested in the enclosing user type grants it
            // the CLR nested-type access to the encloser's family/private members
            // (and the encloser's inherited protected members). Without nesting the
            // synthesized Invoke method triggers MethodAccessException/
            // FieldAccessException at runtime.
            //
            // Issue #1512: this nesting must also apply when the enclosing type is
            // generic. A closure capturing a generic encloser is reified over a
            // clone of the encloser's type parameters (SynthesizedClosureReifier),
            // so the closure's own ordinal-aligned parameter list already matches
            // what a nested type inside the encloser must re-declare per
            // ECMA-335 §II.10.3.1 (e.g. `<closure>`1` nested in `Op`1` shares the
            // single `T`). Without nesting, the reified closure was emitted as a
            // top-level type and its Invoke could not read the generic encloser's
            // private captured field ("Field is not visible").
            if literal
                .Function
                .LexicalEnclosingType is {} enclosing &&
                (enclosing is StructSymbol or InterfaceSymbol) &&
                info
                .ClassSym
                .ContainingType == nil {
                info.ClassSym.SetContainingType(enclosing)
            }
        }
    }

    /// Finds the closure synthesized for [`go`](paramref), by node or by its syntax.
    /// @param go A go statement as it reaches the emitter.
    /// @param info The closure.
    /// @returns `true` when found.
    func TryGetGoClosure(
        $go BoundGoStatement,
        @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out info ClosureInfo?
    ) bool {
        if this.GoClosureInfos.TryGetValue($go, out info) {
            return true
        }
        if $go.Syntax != nil && this.GoClosureInfosBySyntax.TryGetValue($go.Syntax!!, out info) {
            return true
        }
        info = nil
        return false
    }

    func SynthesizeGoClosures(goStatements List[BoundGoStatement], hostPackage PackageSymbol) {
        for go_ in goStatements {
            let captured = this.slotPlanner.CollectCapturedVariables(go_.Expression)
            // When the go target is async (returns Task/Task<T>), the closure must
            // return Task so that Task.Run(Func<Task>) properly awaits completion.
            // Detection must be robust across assembly-load contexts: when the
            // compilation is cross-targeting (explicit /reference paths loaded
            // through a MetadataLoadContext), go.Expression.Type.ClrType is a
            // reference-pack Type whose identity differs from the gsc host's
            // System.Threading.Tasks.Task, so typeof(Task).IsAssignableFrom(...)
            // returns false. That mis-detection emits an Action thunk that
            // discards the spawned Task — breaking structured scope-join and
            // producing invalid IL when the async target captures arguments.
            // Compare by metadata name across the base-type chain instead.
            // ADR-0174 D5: the goroutine body yields a plain ValueTask that the
            // runtime's work item consumes exactly once. The binder shaped the
            // operand (Discard<T> / Wrap) so it is either ValueTask-typed or void.
            let valueTaskType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(ValueTask),
                NullabilityFreeReason.TypeLiteral
            )
            let returnType = valueTaskType
            let yieldsValueTask = go_.Expression.Type?.ClrType?.FullName == "System.Threading.Tasks.ValueTask"
            let body = if yieldsValueTask {
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, go_.Expression))
                )
            } else {
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(nil, go_.Expression),
                        BoundReturnStatement(nil, BoundDefaultExpression(nil, valueTaskType))
                    )
                )
            }
            let closureName = "<go_" + Interlocked.Increment(&this.Counter).ToString(CultureInfo.InvariantCulture) + ">"
            let enclosingType = go_.LexicalEnclosingType
            let requiredTypeParameters = if enclosingType is {} owner {
                CollectOwnerTypeParameters(owner)
            } else {
                ImmutableArray[TypeParameterSymbol].Empty
            }
            let info = this.SynthesizeDisplayClass(
                closureName,
                captured,
                ImmutableArray[ParameterSymbol].Empty,
                returnType,
                RefKind.None,
                body,
                hostPackage,
                invokeName: "InvokeAction",
                requiredTypeParameters: requiredTypeParameters
            )
            // A go operand was bound with the access rights of its lexical
            // member. Keep those rights after lowering by placing its helper in
            // the same CLR accessibility domain, as ordinary lambda hosts do.
            if (enclosingType is StructSymbol or InterfaceSymbol) {
                info.ClassSym.SetContainingType(enclosingType!!)
            }
            this.GoClosureInfos[go_] = info
            if go_.Syntax != nil {
                this.GoClosureInfosBySyntax[go_.Syntax!!] = info
            }
        }
    }

    func SynthesizeDisplayClass(
        closureName string,
        capturedVariables ImmutableArray[VariableSymbol],
        parameters ImmutableArray[ParameterSymbol],
        returnType TypeSymbol,
        returnRefKind RefKind,
        body BoundBlockStatement,
        hostPackage PackageSymbol,
        invokeName string,
        requiredTypeParameters ImmutableArray[TypeParameterSymbol] = default(ImmutableArray[TypeParameterSymbol]),
        excludedTypeParameters ImmutableArray[TypeParameterSymbol] = default(ImmutableArray[TypeParameterSymbol])
    ) ClosureInfo {
        let packageName = hostPackage?.Name ?? string.Empty
        let fieldBuilder = ImmutableArray.CreateBuilder[FieldSymbol](capturedVariables.Length)
        let captureFields = Dictionary[VariableSymbol, FieldSymbol]()
        for captured in capturedVariables {
            let field = FieldSymbol(captured.Name, captured.Type, Accessibility.Public)
            fieldBuilder.Add(field)
            captureFields[captured] = field
        }
        let closureClass = StructSymbol(
            name: closureName,
            fields: fieldBuilder.MoveToImmutable(),
            accessibility: Accessibility.Internal,
            declaration: nil,
            packageName: packageName,
            isData: false,
            isInline: false,
            isClass: true
        )
        let invokeMethod = FunctionSymbol(
            name: invokeName,
            parameters: parameters,
            type: returnType,
            declaration: nil,
            $package: hostPackage,
            accessibility: Accessibility.Public,
            receiverType: cast[TypeSymbol](closureClass)
        ){ReturnRefKind = returnRefKind}
        closureClass.SetMethods(ImmutableArray.Create(invokeMethod))
        // Issue #1477: when the lambda is declared inside a generic type (or
        // generic method) and captures a value whose type references an
        // enclosing type parameter (a `T`-typed value, `this` of `G[T]`, or a
        // boxed `Box[T]`), the display class must itself be generic over those
        // parameters — otherwise each capture field's `VAR` slot has no generic
        // parameter in scope, producing an illegal field type (TypeLoadException
        // at load) and unverifiable IL (`StackUnexpected`/`DelegateCtor`) at the
        // capture site. Reify the display class generic over exactly the
        // referenced enclosing parameters (mirroring the state-machine
        // treatment); the emitter's outer-TP → own-TP remap then routes every
        // field / Invoke signature and body through a valid `VAR(idx)` slot.
        // Issue #2894 extends discovery to parameters referenced only by the
        // body; they are otherwise absent from every signature while still
        // requiring a valid slot in Invoke. The
        // returned constructed instance carries the original parameters as type
        // arguments for the capture-site `newobj`/field stores/delegate ctor.
        let enclosingRefSink = List[TypeSymbol]()
        for captured in capturedVariables {
            enclosingRefSink.Add(captured.Type)
        }
        for parameter in parameters {
            enclosingRefSink.Add(parameter.Type)
        }
        enclosingRefSink.Add(returnType)
        let bodyTypeParameters = List[TypeParameterSymbol]()
        LambdaEnclosingTypeParameterCollector.Collect(body, bodyTypeParameters)
        enclosingRefSink.AddRange(bodyTypeParameters)
        var origTPs = SynthesizedClosureReifier
            .CollectOrdered(enclosingRefSink)
            .Where(
            (tp TypeParameterSymbol) -> excludedTypeParameters.IsDefaultOrEmpty || !excludedTypeParameters.Contains(tp)
        )
            .ToImmutableArray()
        // Issue #3933: when the display class is about to be nested inside a
        // GENERIC encloser, re-declare that encloser's type parameters
        // positionally (ECMA-335 §II.10.3.1, and what csc emits for `<>c`)
        // rather than trusting discovery.
        //
        // Discovery is signature- and body-driven, and for a CAPTURING closure
        // that is enough — it holds the encloser's parameters in its own capture
        // fields, so they are always in the scanned set. A CAPTURE-FREE host has
        // no such guarantee: the lambda may reference only SOME of the
        // encloser's parameters (inside `Pair[T, U]`, mentioning only `U`) or
        // none of them in any scanned position. The dangerous case is the last
        // one — a body that reaches the encloser only through a path the
        // collector does not walk, e.g. a call to a `private shared` member,
        // which the emitter renders as `Reg`1<!0>::Bump`. Reified from discovery
        // alone that host has arity 0, the `!0` has no slot, and the result
        // ILVERIFIES CLEAN and throws BadImageFormatException at the first call
        // (measured, not assumed). Seeding the ordered list with the encloser's
        // own parameters makes the re-declaration total and closes that hole for
        // every such path at once.
        //
        // The seed is a no-op whenever discovery already found exactly the
        // encloser's parameters — the common case, and the one #3933 reported —
        // because CollectOrdered emits class parameters ahead of method
        // parameters by ordinal, which is the same order the seed imposes.
        if !requiredTypeParameters.IsDefaultOrEmpty {
            let seeded = ImmutableArray.CreateBuilder[TypeParameterSymbol](
                requiredTypeParameters.Length + origTPs.Length
            )
            seeded.AddRange(requiredTypeParameters)
            for tp in origTPs {
                if !requiredTypeParameters.Contains(tp) {
                    seeded.Add(tp)
                }
            }
            origTPs = seeded.ToImmutable()
        }
        var constructedClass = closureClass
        if !origTPs.IsDefaultOrEmpty {
            // Issue #2037: project imported constructed-generic capture field
            // types across reflection contexts (MLC / cs2gs) before
            // MakeGenericType, mirroring #1958's InterfaceSymbol/StructSymbol fix.
            constructedClass = SynthesizedClosureReifier.Reify(
                closureClass,
                origTPs,
                this.emitCtx.References.MapClrTypeToReferences
            )
        }
        // Issue #2669: field accesses inside a reified generic closure's Invoke
        // must be parented at the constructed display-class TypeSpec, including
        // fields whose own type is non-generic.
        let rewriter = CaptureRewriter(
            constructedClass,
            captureFields,
            Invariant.Required(
                invokeMethod.ThisParameter,
                "a closure Invoke method has an instance receiver",
                expression: "invokeMethod.ThisParameter"
            )
        )
        let rewrittenBody = cast[BoundBlockStatement](rewriter.RewriteStatement(body))
        if rewriter.UnsupportedCapture != nil {
            throw NotSupportedException(
                "Synthesized closure '$closureName' captures '${rewriter.UnsupportedCapture!!.Name}' from a kind ('${rewriter.UnsupportedCaptureKind}') the emitter cannot currently rewrite. Run under the interpreter for now."
            )
        }
        this.lambdaBodies[invokeMethod] = cast[BoundBlockStatement](Lowerer.Lower(rewrittenBody))
        this.SynthesizedClosureClasses.Add(closureClass)
        let info = ClosureInfo(closureClass, invokeMethod, captureFields, constructedClass)
        this.ClosureInvokeToInfo[invokeMethod] = info
        return info
    }

    /// Captured-variable metadata for a single synthesized display class.
    /// Produced by (cref:SynthesizeDisplayClass); consumed by the
    /// root emitter when wiring `BodyEmitter` and by
    /// `BodyEmitter` itself when emitting captured-variable loads.
    class ClosureInfo {
        convenience init(
            classSym StructSymbol,
            invokeMethod FunctionSymbol,
            captureFields Dictionary[VariableSymbol, FieldSymbol]
        ) {
            init(classSym, invokeMethod, captureFields, classSym)
        }

        init(
            classSym StructSymbol,
            invokeMethod FunctionSymbol,
            captureFields Dictionary[VariableSymbol, FieldSymbol],
            constructedClassSym StructSymbol
        ) {
            this.ClassSym = classSym
            this.InvokeMethod = invokeMethod
            this.CaptureFields = captureFields
            this.ConstructedClassSym = constructedClassSym
        }

        prop ClassSym StructSymbol {
            get;
        }

        /// Gets the constructed display-class instance to reference at the
        /// capture site (`newobj` / field stores / delegate ctor /
        /// `ldftn Invoke`). Equals (cref:ClassSym) for a non-generic
        /// closure; for a generic-encloser closure it is the open definition
        /// constructed over the enclosing type parameters
        /// (`DisplayClass<!0,…>`) — issue #1477.
        prop ConstructedClassSym StructSymbol {
            get;
        }

        prop InvokeMethod FunctionSymbol {
            get;
        }

        prop CaptureFields Dictionary[VariableSymbol, FieldSymbol] {
            get;
        }
    }

    /// Rewrites a lambda body so every captured-variable reference is
    /// retargeted to a `this.field` access against the synthesized
    /// display class. Run once per closure during
    /// (cref:SynthesizeDisplayClass); the result is stored as the
    /// Invoke method's lambda body and threaded through the normal
    /// `EmitFunction` path.
    class CaptureRewriter : BoundTreeRewriter {
        private let closureClass StructSymbol
        private let captureFields Dictionary[VariableSymbol, FieldSymbol]
        private let thisParam ParameterSymbol

        init(
            closureClass StructSymbol,
            captureFields Dictionary[VariableSymbol, FieldSymbol],
            thisParam ParameterSymbol
        ) {
            this.closureClass = closureClass
            this.captureFields = captureFields
            this.thisParam = thisParam
        }

        // Set when the rewriter encounters a captured variable in a context
        // it cannot lower (e.g., as the target of a BoundIndexAssignmentExpression
        // or other shape that the BoundFieldAssignment node does not model).
        // Reported by SynthesizeClosures as a NotSupportedException.
        prop UnsupportedCapture VariableSymbol? {
            get;
            private set;
        }

        prop UnsupportedCaptureKind string? {
            get;
            private set;
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            if this.captureFields.TryGetValue(node.Variable, out var field) {
                // Issue #2442: a read-only narrowed binding (see LambdaBinder's
                // FilterNarrowingsSurvivingClosureCapture) carries a non-null
                // NarrowedType on the pre-rewrite BoundVariableExpression — e.g.
                // a nil-guarded named-delegate parameter narrowed from `T?` to
                // `T` before the closure captured it. The synthesized capture
                // field is always declared with the ORIGINAL (possibly
                // nullable) variable type, so without forwarding NarrowedType
                // here the rewritten field access reverts to that nullable
                // view. EmitIndirectCall keys its named-delegate-vs-type-erased
                // Invoke dispatch on the bound target expression's Type, so
                // losing the narrowing here — despite it having been proven
                // sound at bind time — causes the wrong Invoke overload to be
                // emitted and invalid IL (ILVerify StackUnexpected). Forwarding
                // the narrowed type mirrors the existing narrowed-field-access
                // mechanism (issue #208) and keeps the field handle itself
                // unchanged, so this only affects the static type surfaced to
                // later phases, not runtime storage.
                return BoundFieldAccessExpression(
                    nil,
                    BoundVariableExpression(nil, this.thisParam),
                    this.closureClass,
                    field,
                    node.NarrowedType
                )
            }
            return node
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if this.captureFields.TryGetValue(node.Variable, out var field) {
                let value = this.RewriteExpression(node.Expression)
                return BoundFieldAssignmentExpression(nil, this.thisParam, this.closureClass, field, value)
            }
            return base.RewriteAssignmentExpression(node)
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            // Lambda body declares its own locals — never the captured ones.
            // Still record an "unsupported capture" check in case a captured
            // VariableSymbol re-appears as a declaration shadow (binder bug).
            if this.captureFields.ContainsKey(node.Variable) {
                this.UnsupportedCapture = node.Variable
                this.UnsupportedCaptureKind = "BoundVariableDeclaration"
            }
            return base.RewriteVariableDeclaration(node)
        }
    }

    /// Collects every constructed (non-definition) (cref:StructSymbol)
    /// referenced anywhere in the bound program — function bodies, class
    /// methods, AND lambda bodies. PR-E-4 (cref:SlotPlanner)
    /// explicitly deferred this rewriter to PR-E-9 because it is a
    /// closure-emit-side helper (the lambda-body walk is what makes it
    /// closure-aware) rather than a slot walker. The root emitter's
    /// `RegisterConstructedTypeAliases` drives this collector to
    /// alias every constructed type into the same TypeDef / ctor / field
    /// rows as its definition.
    class ConstructedTypeCollector : BoundTreeRewriter {
        init() {
            Constructed = HashSet[StructSymbol]()
        }

        prop Constructed HashSet[StructSymbol] {
            get;
        }

        protected override func RewriteExpression(node BoundExpression) BoundExpression {
            this.TryAdd(node.Type)
            switch node {
                case sl is BoundStructLiteralExpression {
                    this.TryAdd(sl.StructType)
                    for init in sl.Initializers {
                        this.TryAdd(init.MemberType)
                    }
                }
                case fa is BoundFieldAccessExpression {
                    this.TryAdd(fa.StructType)
                    this.TryAdd(fa.Field.Type)
                }
                case fas is BoundFieldAssignmentExpression {
                    this.TryAdd(fas.StructType)
                    this.TryAdd(fas.Field.Type)
                }
                case pa is BoundPropertyAccessExpression {
                    this.TryAdd(pa.StructType)
                    this.TryAdd(pa.Property.Type)
                }
                case pas is BoundPropertyAssignmentExpression {
                    this.TryAdd(pas.StructType)
                    this.TryAdd(pas.Property.Type)
                }
                case cc is BoundConstructorCallExpression {
                    this.TryAdd(cc.StructType)
                }
                case ve is BoundVariableExpression {
                    this.TryAdd(ve.Variable.Type)
                }
            }
            return base.RewriteExpression(node)
        }

        private func TryAdd(type TypeSymbol?) {
            if type is StructSymbol s && !s.TypeArguments.IsDefaultOrEmpty {
                this.Constructed.Add(s)
            }
        }
    }

    shared {
        /// Determines whether a CLR type is (cref:System.Threading.Tasks.Task)
        /// or `Task<T>`, comparing by metadata name across the base-type
        /// chain so the result is independent of the assembly-load context the type
        /// originates from. `typeof(Task).IsAssignableFrom(t)` is unreliable
        /// here because cross-targeting compilations surface types through a
        /// (cref:System.Reflection.MetadataLoadContext), giving them a
        /// distinct (cref:Type) identity from the gsc host's BCL.
        /// @remarks Internal-static rather than private so the still-on-(cref:ReflectionMetadataEmitter)
        /// `BodyEmitter` can use it from its `EmitGoStatement` path
        /// when shape-deciding whether the spawned closure is a
        /// `Func<Task>` vs. an `Action`. Both call sites move
        /// into PR-E-11 `MethodBodyEmitter.Closures` alongside the rest of
        /// the BodyEmitter-internal closure-emit methods.
        /// @param clrType The CLR type to test (may be `null`).
        /// @returns `true` if [`clrType`](paramref) is (cref:System.Threading.Tasks.Task) or any subclass
        /// thereof (notably `Task<T>`); otherwise `false`.
        internal func IsTaskClrType(clrType Type?) bool {
            for var t Type? = clrType; t != nil; t = t!!.BaseType {
                if string.Equals(t.FullName, "System.Threading.Tasks.Task", StringComparison.Ordinal) {
                    return true
                }
            }
            return false
        }

        private func CollectOwnerTypeParameters(owner TypeSymbol) ImmutableArray[TypeParameterSymbol] -> StructSymbol
            .CollectEnclosingTypeParameters(owner).AddRange(
            switch owner {
                case enclosingStruct is StructSymbol: (enclosingStruct.Definition ?? enclosingStruct).TypeParameters
                case enclosingInterface is InterfaceSymbol: enclosingInterface.Definition!!.TypeParameters
                default: ImmutableArray[TypeParameterSymbol].Empty
            }
        )
    }
}
