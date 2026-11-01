// <copyright file="LambdaBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import System.Diagnostics.CodeAnalysis
import System.Threading

/// PR-B-6: the binder-side facade that owns all function-literal
/// (lambda) binding. Wraps (cref:BindFunctionLiteralExpression),
/// the erased-adapter rewriter / synthesizer
/// ((cref:CreateErasedFunctionLiteralAdapter) and its nested
/// (cref:ErasedFunctionLiteralAdapterRewriter)), the captured-
/// variable analysis ((cref:CapturedVariableCollector)), the
/// async-return-type widening helper ((cref:WrapAsTask)), and
/// the (cref:TryGetFunctionLiteral) unwrap helper that
/// previously lived directly on (cref:Binder).
/// @remarks This type is the binder-side wrapper: it consumes
/// (cref:BinderContext) for the diagnostics bag, the (mutable)
/// scope, and the synthetic-local counter, and
/// (cref:ConversionClassifier) for the lambda-parameter default-
/// value binding ((cref:ConversionClassifier.BindAndAttachParameterDefaultValue)).
/// It never back-references (cref:Binder); the callbacks it
/// needs (binding the lambda body, binding type / return-type clauses,
/// detecting async-iterator return types, mapping a CLR generic-argument
/// type to the reference resolver's load-context, and reading / writing
/// the current (cref:FunctionSymbol) while a lambda body is being
/// bound) are injected through narrow (cref:Func{T, TResult}) /
/// (cref:Action{T}) seams in the constructor — the same pattern
/// established by (cref:ConversionClassifier) in PR-B-3,
/// (cref:OverloadResolver) in PR-B-4, and
/// (cref:PatternBinder) in PR-B-5.
///
/// This PR is structural only; the underlying open bug #567 (closure
/// reads a field on a captured ref-type local → GS9998) is left alone
/// here. Consolidating function-literal binding into a single owner is
/// the setup the eventual `ClosureEmitter` extraction (PR-E-9)
/// needs so the emit-side fix can assume a clean
/// (cref:BoundFunctionLiteralExpression) contract.
///
/// (cref:TryGetFunctionLiteral) is exposed as `public
/// static` so (cref:Binder) can keep forwarding it as the
/// (cref:OverloadResolver.TryGetFunctionLiteralDelegate) wired
/// into (cref:OverloadResolver)'s constructor (the resolver
/// uses it from three argument-shaping paths and never gains a
/// (cref:LambdaBinder) reference). Likewise
/// (cref:CreateErasedFunctionLiteralAdapter) and
/// (cref:WrapAsTask) are exposed as `public` instance
/// methods so the remaining call sites in (cref:Binder) can
/// route through the `lambdas` field without widening any other
/// helper's visibility.
internal class LambdaBinder {
    private let binderCtx BinderContext
    private let conversions ConversionClassifier
    private let bindBlockStatement(BlockStatementSyntax) -> BoundStatement
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let bindReturnTypeClause(TypeClauseSyntax, bool) -> TypeSymbol?
    private let isIteratorReturnType(TypeSymbol) -> bool
    private let isAsyncIteratorReturnType(TypeSymbol) -> bool
    private let resolveClrTypeForGenericArg(TypeSymbol) -> Type?
    private let getCurrentFunction() -> FunctionSymbol?
    private let setCurrentFunction(FunctionSymbol?) -> void
    private let bindParameterAttributes(ParameterSyntax) -> ImmutableArray[BoundAttribute]
    private let reportUnsafeBackwardGotoNarrowings() -> void
    private let isolateExternalCallableAliases() -> HashSet[VariableSymbol]
    private let restoreExternalCallableAliases(HashSet[VariableSymbol]) -> void
    private let bindLambdaBodyExpression((ExpressionSyntax, TypeSymbol?) -> BoundExpression)?
    private let bindTypeParameterList((TypeParameterListSyntax) -> ImmutableArray[TypeParameterSymbol])?

    // ADR-0185: declares a single ordinary local (mirrors StatementBinder's
    // own bindLocalVariable callback). Used directly for the arity<2
    // error-recovery path of a destructured arrow-lambda parameter — the
    // reusable prelude helper below always assumes a genuine tuple/data-
    // struct element type, so an already-Error-typed pattern is declared
    // straight through this instead.
    private let bindLocalVariable(SyntaxToken, bool, TypeSymbol) -> VariableSymbol

    // ADR-0185: reuses StatementBinder.BindForTupleLoopPrelude — written for
    // `for (a, b) in coll` to declare each destructured name as a local of a
    // VariableSymbol that already holds the tuple (no extra synthetic temp
    // needed) — for a destructured arrow-lambda parameter, whose underlying
    // whole-tuple ParameterSymbol plays exactly that already-holds-the-tuple
    // role.
    private let bindTupleDestructuringPrelude(
        GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        TextLocation,
        TextLocation,
        VariableSymbol
    ) -> ImmutableArray[BoundStatement]

    /// Issue #4221: every function literal's captured-variable set, keyed by
    /// its own (cref:FunctionSymbol), as of the most recent time it was
    /// (re)computed. A generic local function is called directly through its
    /// (cref:FunctionSymbol) rather than through a delegate value, so a
    /// sibling calling it (`BoundCallExpression`) carries no reference to
    /// its (cref:BoundFunctionLiteralExpression) the way a physically
    /// nested literal does. (cref:CapturedVariableCollector) consults
    /// this map to fold a callee's already-known captures into its caller's
    /// own set — the same transitive folding
    /// (cref:CapturedVariableCollector.RewriteFunctionLiteralExpression)
    /// already does for a literal nested directly in the body being walked.
    /// Consecutive generic local-function declarations bind their bodies in
    /// source order (see (cref:StatementBinder.BindBlockStatements)),
    /// so a callee declared earlier in the same group is already present here
    /// when its caller's body binds; (cref:ReconcileGenericLocalFunctionGroupCaptures)
    /// re-converges the whole group afterward to cover a callee declared
    /// later (forward reference) or a call cycle.
    private let localFunctionCapturedVariables Dictionary[FunctionSymbol, ImmutableArray[VariableSymbol]] = Dictionary[
        FunctionSymbol,
        ImmutableArray[VariableSymbol]
    ]()

    /// Initializes a new instance of the (cref:LambdaBinder)
    /// class.
    /// @param binderCtx The shared binder context that exposes
    /// the diagnostics bag, the (mutable) root scope, and the synthetic-
    /// local counter used to name `<lambdaN>` /
    /// `<lambda_erasedN>` synthetic function symbols.
    /// @param conversions The binder-side conversion classifier
    /// used by (cref:BindFunctionLiteralExpression) to bind and
    /// attach each lambda parameter's default value
    /// (ADR-0063 §5).
    /// @param bindBlockStatement Callback to bind the lambda
    /// body against the synthetic function symbol that
    /// (cref:BindFunctionLiteralExpression) pushes onto the
    /// binder state.
    /// @param bindTypeClause Callback to bind each lambda
    /// parameter's type clause to a (cref:TypeSymbol).
    /// @param bindReturnTypeClause Callback to bind a lambda's
    /// declared return-type clause, with the `isAsync` flag so
    /// the still-on-Binder helper can apply the async-specific
    /// validation it already performs.
    /// @param isIteratorReturnType Callback that returns
    /// `true` when the supplied return type is an iterator shape
    /// and therefore does not require an ordinary value return.
    /// @param isAsyncIteratorReturnType Callback that returns
    /// `true` when the supplied return type is an async-iterator
    /// shape (ADR-0041) and therefore does NOT participate in the
    /// `Task` / `Task<T>` widening that
    /// (cref:WrapAsTask) performs.
    /// @param resolveClrTypeForGenericArg Callback that maps a
    /// (cref:TypeSymbol) to the CLR (cref:Type) the
    /// reference resolver's load context expects when it is used as a
    /// generic type-argument (issue #530). Used by
    /// (cref:WrapAsTask) when constructing
    /// `Task<T>`.
    /// @param getCurrentFunction Callback that returns the
    /// (cref:FunctionSymbol) currently being bound on the
    /// owning (cref:Binder).
    /// (cref:BindFunctionLiteralExpression) snapshots it,
    /// replaces it with the synthetic lambda function while binding
    /// the body, then restores it.
    /// @param setCurrentFunction Callback that writes the
    /// owning (cref:Binder)'s current
    /// (cref:FunctionSymbol). Used by
    /// (cref:BindFunctionLiteralExpression) to push the
    /// synthetic lambda function for the duration of the body bind
    /// and to restore the outer function on exit.
    /// @param bindParameterAttributes Callback that binds user
    /// annotations on a lambda parameter using the declaration binder's
    /// standard parameter-target validation.
    /// @param reportUnsafeBackwardGotoNarrowings Callback that reports
    /// deferred backward-goto narrowing diagnostics before nested-frame state
    /// is restored.
    /// @param isolateExternalCallableAliases Callback that snapshots and
    /// clears the enclosing function's callable-alias provenance.
    /// @param restoreExternalCallableAliases Callback that restores the
    /// enclosing function's callable-alias provenance.
    /// @param bindLambdaBodyExpression ADR-0074 / issue #714:
    /// optional callback that binds an arrow-lambda body expression, with the
    /// contextual return type available for nested lambda bodies.
    /// Required only when (cref:BindLambdaExpression) is
    /// invoked; the function-literal pipeline does not need it.
    /// @param bindTypeParameterList Issue #1886: callback that
    /// binds a `[T, U, ...]` type-parameter list to
    /// (cref:TypeParameterSymbol)s, reusing
    /// (cref:DeclarationBinder.BindTypeParameterList(TypeParameterListSyntax)).
    /// Required only when (cref:PrepareGenericLocalFunctionDeclaration)
    /// is invoked.
    /// @param bindLocalVariable ADR-0185: callback that declares a
    /// single ordinary local, reusing `DeclarationBinder.BindVariableDeclaration`
    /// (the same delegate (cref:StatementBinder) is constructed with).
    /// Used for a destructured arrow-lambda parameter's arity-<2
    /// error-recovery path.
    /// @param bindTupleDestructuringPrelude ADR-0185: callback that
    /// reuses (cref:StatementBinder.BindForTupleLoopPrelude) to declare
    /// each destructured name of a tuple-destructuring arrow-lambda parameter
    /// as an ordinary local and produce the field-extraction statements to
    /// prepend to the lambda body.
    init(
        binderCtx BinderContext,
        conversions ConversionClassifier,
        bindBlockStatement(BlockStatementSyntax) -> BoundStatement,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        bindReturnTypeClause(TypeClauseSyntax, bool) -> TypeSymbol?,
        isIteratorReturnType(TypeSymbol) -> bool,
        isAsyncIteratorReturnType(TypeSymbol) -> bool,
        resolveClrTypeForGenericArg(TypeSymbol) -> Type?,
        getCurrentFunction() -> FunctionSymbol?,
        setCurrentFunction(FunctionSymbol?) -> void,
        bindParameterAttributes(ParameterSyntax) -> ImmutableArray[BoundAttribute],
        reportUnsafeBackwardGotoNarrowings() -> void,
        isolateExternalCallableAliases() -> HashSet[VariableSymbol],
        restoreExternalCallableAliases(HashSet[VariableSymbol]) -> void,
        bindLocalVariable(SyntaxToken, bool, TypeSymbol) -> VariableSymbol,
        bindTupleDestructuringPrelude(
            GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
            TextLocation,
            TextLocation,
            VariableSymbol
        ) -> ImmutableArray[BoundStatement],
        bindLambdaBodyExpression((ExpressionSyntax, TypeSymbol?) -> BoundExpression)? = nil,
        bindTypeParameterList((TypeParameterListSyntax) -> ImmutableArray[TypeParameterSymbol])? = nil
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        this.bindBlockStatement = bindBlockStatement ?? throw ArgumentNullException("bindBlockStatement")
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.bindReturnTypeClause = bindReturnTypeClause ?? throw ArgumentNullException("bindReturnTypeClause")
        this.isIteratorReturnType = isIteratorReturnType ?? throw ArgumentNullException("isIteratorReturnType")
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ??
            throw ArgumentNullException("isAsyncIteratorReturnType")
        this.bindLocalVariable = bindLocalVariable ?? throw ArgumentNullException("bindLocalVariable")
        this.bindTupleDestructuringPrelude = bindTupleDestructuringPrelude ??
            throw ArgumentNullException("bindTupleDestructuringPrelude")
        this.resolveClrTypeForGenericArg = resolveClrTypeForGenericArg ??
            throw ArgumentNullException("resolveClrTypeForGenericArg")
        this.getCurrentFunction = getCurrentFunction ?? throw ArgumentNullException("getCurrentFunction")
        this.setCurrentFunction = setCurrentFunction ?? throw ArgumentNullException("setCurrentFunction")
        this.bindParameterAttributes = bindParameterAttributes ?? throw ArgumentNullException("bindParameterAttributes")
        this.reportUnsafeBackwardGotoNarrowings = reportUnsafeBackwardGotoNarrowings ??
            throw ArgumentNullException("reportUnsafeBackwardGotoNarrowings")
        this.isolateExternalCallableAliases = isolateExternalCallableAliases ??
            throw ArgumentNullException("isolateExternalCallableAliases")
        this.restoreExternalCallableAliases = restoreExternalCallableAliases ??
            throw ArgumentNullException("restoreExternalCallableAliases")
        this.bindLambdaBodyExpression = bindLambdaBodyExpression
        this.bindTypeParameterList = bindTypeParameterList
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    private prop Scope BoundScope {
        get -> binderCtx.RootScope
        set -> this.binderCtx.RootScope = value
    }

    /// Binds a (cref:FunctionLiteralExpressionSyntax)
    /// (`[async] func(p1 T1, p2 T2) R { body }`) to a
    /// (cref:BoundFunctionLiteralExpression). Binds the
    /// parameters (including their ADR-0063 default values), pushes a
    /// new scope so outer locals are visible by lexical lookup
    /// (closure capture), binds the body against a synthetic
    /// (cref:FunctionSymbol) whose return type is the declared
    /// return clause (or (cref:TypeSymbol.Void)), then collects
    /// the captured outer variables by inspecting the bound body.
    /// @param syntax The function-literal syntax node.
    /// @param explicitName Issue #1886: when non-null, names the
    /// synthetic (cref:FunctionSymbol) after this value (e.g. the
    /// identifier of a `let Name[T] = func (...) ... { ... }` generic
    /// local-function declaration) instead of the default
    /// `<lambdaN>` synthetic name, so scope-based name lookup
    /// ((cref:BoundScope.TryDeclareFunction)) can find it.
    /// @param onSignatureBound Issue #3501 A2: when non-null, invoked
    /// once the literal's signature (parameters + return type) is bound —
    /// with the synthetic (cref:FunctionSymbol) and the literal's
    /// natural (cref:FunctionTypeSymbol) — BEFORE the body-binding
    /// scope is pushed. A named-binding caller (`let f = func ...`)
    /// uses this to declare `f` into the enclosing scope so the body
    /// can reference itself (recursion through the captured variable, the
    /// G# local-function idiom).
    /// @returns The bound function-literal expression.
    func BindFunctionLiteralExpression(
        syntax FunctionLiteralExpressionSyntax,
        explicitName string? = nil,
        onSignatureBound((FunctionSymbol, FunctionTypeSymbol) -> void)? = nil
    ) BoundExpression {
        // Issue #4219 (umbrella remainder): this general entry point is used
        // for a plain lambda argument, a `var`-declared literal, and the
        // ordinary (non-group) `let f = func ...` self-recursion path — none
        // of which have a stable callable identity a `ref` return could be
        // attached to (that requires the direct-call local-function path,
        // see PrepareGenericLocalFunctionDeclaration). allowRefReturn: false
        // reports GS0588 instead of silently accepting it.
        let signature = PrepareFunctionLiteralSignature(syntax, explicitName, allowRefReturn: false)
        if signature == nil {
            return BoundErrorExpression(syntax)
        }
        let (synthetic, fnType) = signature
        onSignatureBound?(synthetic, fnType)
        return BindFunctionLiteralBody(syntax, synthetic, fnType)
    }

    private func PrepareFunctionLiteralSignature(
        syntax FunctionLiteralExpressionSyntax,
        explicitName string?,
        allowRefReturn bool = false
    )(Function FunctionSymbol, Type FunctionTypeSymbol)? {
        // The signature is independent of the body, so generic siblings can
        // register their callable symbols before any recursive call binds.
        let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](syntax.Parameters.Count)
        let parameterSymbols = ImmutableArray.CreateBuilder[ParameterSymbol](syntax.Parameters.Count)
        let seen = HashSet[string]()
        for p in syntax.Parameters {
            // ADR-0185: a function-literal parameter is parsed via
            // Parser.Members.cs's ParseParameter, never the destructured
            // arrow-lambda path (that path is ParseLambdaParameter-only, and
            // function literals never go through it — see ADR-0185 Decision
            // point 2), so Identifier is always set here.
            let pname = p.Identifier!!.ValueText
            // The pre-migration code was `bindTypeClause(p.Type) ?? TypeSymbol.Error`.
            // Restored: a parameter whose type clause fails to bind should
            // degrade to Error so the binder's own diagnostic surfaces, not
            // raise GS9998. Asserting here claims a contract bindTypeClause
            // does not declare.
            let ptype = if p.Type is TypeClauseSyntax type {
                bindTypeClause(type) ?? TypeSymbol.Error
            } else {
                TypeSymbol.Error
            }
            // ADR-0101 follow-up / issue #812, generalized by ADR-0173 / issue
            // #3627: variadic parameters are accepted on function-literal
            // lambdas. The body sees the resolved carrier type — the array
            // wrap for a plain element type, or the written type itself when
            // it is already a supported carrier (`List[T]`, `Span[T]`, …) —
            // matching named-function/delegate declarations so a lambda's
            // carrier lines up with the delegate it is assigned to
            // (issue #4235). Pack/pass-through for a bare-array call still
            // happens on the indirect-call path inside OverloadResolver.
            let isVariadic = p.IsVariadic
            var parameterType = ptype
            if isVariadic && parameterType != TypeSymbol.Error {
                parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
            }
            // Issue #1262: the discard identifier `_` is not a real binding —
            // C# allows repeated `_` discard parameters (e.g. `(_, _) => ...`).
            // Skip the uniqueness check for `_` so a second discard is not a
            // duplicate; each `_` still occupies its positional slot below.
            if pname != "_" && !seen.Add(pname) {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname)
            }
            let lambdaParam = ParameterSymbol(
                pname,
                parameterType,
                isVariadic,
                declaringSyntax: p.Identifier,
                isScoped: p.IsScoped,
                refKind: conversions.BindAndValidateParameterRefKind(
                    p,
                    pname,
                    parameterType,
                    isVariadic,
                    if syntax.IsAsync {
                        "async"
                    } else {
                        default(string?)
                    }
                )
            )
            // ADR-0063 §5: function-literal (lambda) parameters can declare a
            // default value; lambdas can be invoked through their delegate type
            // which honors the default at the call site.
            conversions.BindAndAttachParameterDefaultValue(p, lambdaParam)
            AttachParameterAttributes(p, lambdaParam)
            parameterSymbols.Add(lambdaParam)
            parameterTypes.Add(parameterType)
        }
        // ADR-0101 follow-up / issue #812: enforce variadic structural rules.
        ValidateVariadicParameterShape(syntax.Parameters)
        var returnType TypeSymbol? = if syntax.ReturnTypeClause != nil {
            bindReturnTypeClause(syntax.ReturnTypeClause, syntax.IsAsync)
        } else {
            TypeSymbol.Void
        }
        returnType ??= TypeSymbol.Void
        let isAsyncVoid = syntax.IsAsync && syntax.ReturnTypeClause != nil && object.ReferenceEquals(
            returnType,
            TypeSymbol.Void
        )
        let isAsync = syntax.IsAsync ||
            (isAsyncIteratorReturnType(returnType!!) && IteratorDetection.ContainsYield(syntax.Body))
        // Issue #1918 / #3907: an `async func` may spell its return-type clause
        // as the explicit `Task` / `Task[T]` / `ValueTask` / `ValueTask[T]`
        // wrapper instead of the bare awaited result. DeclarationBinder has
        // normalized that form for named functions since #1918
        // (NormalizeAsyncDeclaredReturnType); a function LITERAL took the
        // clause literally, so `async func (p ValueTask[T]) ValueTask[T] { …
        // return t }` rejected its own body (GS0155 `T` -> `ValueTask[T]`) and
        // then handed callers a doubly-wrapped `Task[ValueTask[T]]`. Unwrap
        // here so FunctionSymbol.Type holds the awaited result for a lambda
        // exactly as it does for a named function, and remember which wrapper
        // was asked for so the observable type below rebuilds the same one.
        var asyncReturnsValueTask = false
        if syntax.IsAsync &&
            !isAsyncIteratorReturnType(returnType!!) &&
            AsyncReturnTypeNormalizer
            .TryUnwrapTaskReturnType(returnType, out var awaitedReturnType, out var declaredValueTask) {
            returnType = awaitedReturnType
            asyncReturnsValueTask = declaredValueTask
        }
        if isAsync && isAsyncIteratorReturnType(returnType!!) {
            Diagnostics.ReportAsyncIteratorFunctionLiteralNotSupported(syntax.Location, returnType!!)
            return nil
        }
        // ADR-0058: a managed-pointer (*T) cannot be used as a lambda return type
        // because CLR Func<> delegates cannot carry by-ref type arguments.
        if returnType is ByRefTypeSymbol && syntax.ReturnTypeClause != nil {
            Diagnostics.ReportByRefCannotEscape(
                syntax.ReturnTypeClause.Location,
                "a managed pointer (*T) cannot be the return type of a function literal"
            )
            returnType = TypeSymbol.Error
        }
        // For async lambdas, the observable return type (from the caller's
        // perspective) is Task or Task<T>, matching top-level async functions —
        // with the iterator carve-out (ADR-0041): an async iterator lambda
        // returning IAsyncEnumerable[T] does not get a Task wrap.
        var observableReturnType = returnType
        if isAsync && !isAsyncVoid && !isAsyncIteratorReturnType(returnType!!) {
            observableReturnType = WrapAsTask(returnType!!, asyncReturnsValueTask)
        }
        let fnType = FunctionTypeSymbol.Get(
            parameterTypes.MoveToImmutable(),
            BuildVariadicFlagsIfAny(parameterSymbols),
            observableReturnType
        )
        let synthetic = FunctionSymbol(
            explicitName ?? "<lambda${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            parameterSymbols.ToImmutable(),
            returnType!!
        )
        synthetic.IsAsync = isAsync
        synthetic.IsAsyncVoid = isAsyncVoid
        synthetic.AsyncReturnsValueTask = asyncReturnsValueTask
        synthetic.ReturnRefKind = ValidateFunctionLiteralReturnRefKind(syntax, returnType!!, allowRefReturn)
        return (synthetic, fnType)
    }

    /// Issue #4219 (umbrella remainder): validates a function LITERAL's
    /// optional `ref` return modifier and yields the resulting
    /// (cref:RefKind). Deliberately mirrors
    /// `DeclarationBinder.ValidateReturnRefKind` (the named-function
    /// counterpart) rule-for-rule — the two syntax types ((cref:FunctionLiteralExpressionSyntax)
    /// vs `FunctionDeclarationSyntax`) share no common interface for
    /// their ref-modifier tokens, so this is a small parallel
    /// implementation rather than a shared one.
    /// @param syntax The function-literal syntax node.
    /// @param returnType The literal's already-bound (pre-async-wrap) return type.
    /// @param allowRefReturn Whether this literal's calling context supports a by-ref return at all (only a
    /// direct-call local-function declaration does today — GS0588 otherwise).
    private func ValidateFunctionLiteralReturnRefKind(
        syntax FunctionLiteralExpressionSyntax,
        returnType TypeSymbol,
        allowRefReturn bool
    ) RefKind {
        if !syntax.IsRefReturn {
            return RefKind.None
        }
        let location = syntax.ReturnRefModifier?.Location ?? syntax.Location
        if !allowRefReturn {
            Diagnostics.ReportRefReturningFunctionLiteralRequiresDirectLocalFunction(location)
            return RefKind.None
        }
        if syntax.ReturnTypeClause == nil {
            Diagnostics.ReportRefReturnRequiresReturnType(location)
            return RefKind.None
        }
        if syntax.IsAsync {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "async")
            return RefKind.None
        }
        if returnType is SequenceTypeSymbol {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "sequence")
            return RefKind.None
        }
        if returnType is AsyncSequenceTypeSymbol {
            Diagnostics.ReportRefReturnOnAsyncOrIterator(location, "async sequence")
            return RefKind.None
        }
        if returnType is ByRefTypeSymbol {
            Diagnostics.ReportRefReturnOfByRefType(location)
            return RefKind.None
        }
        return if syntax.ReturnReadOnlyModifier != nil {
            RefKind.RefReadOnly
        } else {
            RefKind.Ref
        }
    }

    private func BindFunctionLiteralBody(
        syntax FunctionLiteralExpressionSyntax,
        synthetic FunctionSymbol,
        fnType FunctionTypeSymbol
    ) BoundFunctionLiteralExpression {
        // Snapshot current binder state, then push a child scope and bind
        // the body as if we were inside this synthetic function.
        let outerScope = Scope
        let outerFunction = getCurrentFunction()
        Scope = BoundScope(outerScope)
        setCurrentFunction(synthetic)
        synthetic.LexicalEnclosingType = ResolveLexicalEnclosingType(outerFunction)
        for ps in synthetic.Parameters {
            // Issue #1262: discard parameters (`_`) are non-referenceable —
            // do not add them to the lookup scope so `_` in the body does not
            // resolve to a parameter (and repeated `_` slots never collide).
            if ps.Name == "_" {
                continue
            }
            Scope.TryDeclareVariable(ps)
        }
        // ADR-0069 / issue #700, amended by issue #2442: a smart-cast
        // narrowing on a MUTABLE binding does not survive into a closure
        // body — the narrowed variable could be reassigned by the enclosing
        // scope between when the closure is created and when it runs. A
        // narrowing on a read-only plain-variable binding (`let`, or a
        // by-value/`in` parameter) is different: it can never be reassigned
        // anywhere, so it survives unconditionally — see
        // FilterNarrowingsSurvivingClosureCapture. Save the full outer
        // frame stack so it can be restored verbatim once binding leaves the
        // closure; only the filtered copy is visible while the body binds.
        let savedNarrowed = binderCtx.NarrowedVariables.ToList()
        let survivingNarrowed = FilterNarrowingsSurvivingClosureCapture(savedNarrowed)
        binderCtx.NarrowedVariables.Clear()
        binderCtx.NarrowedVariables.AddRange(survivingNarrowed)
        let savedShadowOverlay = binderCtx.ShadowOverlay
        binderCtx.ShadowOverlay = savedShadowOverlay.ForClosureBody()
        // Issue #2027: a function literal (lambda OR local function — this
        // method binds both) is its own goto/label frame; isolate it from
        // the enclosing function's labels and loop stack.
        let savedFrame = EnterNestedFrame(syntax.Body)
        var body BoundStatement
        try {
            body = bindBlockStatement(syntax.Body)
            FinalizeNestedFrameLabels()
        } finally {
            binderCtx.NarrowedVariables.Clear()
            binderCtx.NarrowedVariables.AddRange(savedNarrowed)
            binderCtx.ShadowOverlay = savedShadowOverlay
            RestoreNestedFrame(savedFrame)
        }
        Scope = outerScope
        setCurrentFunction(outerFunction)
        // Issue #893: a value-returning function literal `func(p T) R { ... <expr> }`
        // whose block body ends in a bare trailing expression treats that expression
        // as the implicit return value (mirroring arrow-lambda semantics). Without
        // this rewrite the trailing expression binds to a BoundExpressionStatement
        // that the emitter pops and discards, leaving a non-void method body with no
        // `ret` — invalid IL that the CLR rejects with InvalidProgramException at
        // runtime. Rewrite the trailing expression-statement into a converted
        // `return` so the literal actually returns its value. Void literals keep the
        // existing statement-body handling (no implicit return) so the #889
        // Action-style void-delegate path is preserved.
        //
        // Issue #4219 (umbrella remainder): a `ref`-returning literal is
        // skipped here — the synthesized `BoundReturnStatement` is always a
        // VALUE return, so rewriting a trailing expression into one for a
        // by-ref-returning function produced a ref/value mismatch the
        // emitter cannot reconcile (confirmed by direct repro: silent
        // internal-error crash, not a diagnostic). A ref-returning literal
        // must spell its return explicitly (`return ref expr`); leaving the
        // trailing expression as a plain statement instead means
        // CheckAllPathsReturn below reports the ordinary
        // not-every-path-returns diagnostic for it.
        if synthetic.ReturnRefKind == RefKind.None {
            body = SynthesizeFunctionLiteralTrailingReturn(cast[BoundBlockStatement](body), syntax, synthetic.Type)
        }
        CheckAllPathsReturn(cast[BoundBlockStatement](body), synthetic.Type, syntax.Body.Location)
        let captured = CollectCapturedVariables(body, synthetic)
        // Issue #367: a by-ref-like (`ref struct`) local cannot be captured by a
        // closure; the capture would hoist it into a heap-allocated display
        // class, which the CLR forbids.
        // ADR-0058 / issue #376: a managed-pointer (*T / ByRefTypeSymbol) local also
        // cannot be captured — the closure may outlive the pointed-to variable.
        // Issue #2330: an unmanaged pointer (PointerTypeSymbol) bound by a
        // `fixed` statement is likewise rejected — see ReportFixedPointerCannotEscape.
        // Issue #4259: a `ref`/`out`/`in` PARAMETER of the enclosing function is
        // likewise rejected — see ReportRefParameterCannotBeCaptured.
        // Issue #4271: a `ref`/`var ref` LOCAL alias of the enclosing function is
        // the sibling gap #4259 deliberately left open — see
        // ReportRefLocalAliasCannotBeCaptured.
        // Copilot review of PR #4273: the full check is factored into
        // ClosureCaptureLegalityChecker so the `go`-statement closure path
        // (StatementBinder.BindGoStatement) applies the exact same rules.
        ClosureCaptureLegalityChecker.CheckCapturedVariables(captured, Diagnostics, syntax.Location)
        return BoundFunctionLiteralExpression(nil, synthetic, fnType, cast[BoundBlockStatement](body), captured)
    }

    /// Issue #4223 follow-up: a NON-generic, zero-capture, ASYNC local function
    /// (`let`/`var`/`const Name = async func (...) ... {...}`, no
    /// `[T, ...]` of its own) whose OWN PARAMETER TYPE references an
    /// enclosing method/class type parameter still reports GS0468. Every other
    /// enclosing-type-parameter shape #4223 enables — the same local's return
    /// type or body, the GENERIC-own-type-parameter local/async case, and the
    /// sync route entirely — is unaffected and NOT gated here.
    ///
    /// Root cause this narrow gate avoids: this specific shape is emitted
    /// through the async "erased delegate" adapter (predates issue #2118, used
    /// whenever a function-literal's declared type mentions an open type
    /// parameter) rather than through
    /// `ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics`'s
    /// reification, which only ever sees the promoted method's OWN (cloned)
    /// type parameters and the state-machine class's remap — neither of which
    /// the adapter consults. The adapter's parameter-unboxing conversion has a
    /// confirmed defect for a value-typed instantiation: confirmed by direct
    /// repro, `func Outer[U](seed U) U { let Local = async func (x U) U {
    /// return x }; return Local(seed).Result }` compiles clean and
    /// `Outer("hi")` succeeds, but `Outer(42)` throws
    /// (cref:System.NullReferenceException) at the first call. The
    /// identical crash reproduces on an already-legal CAPTURING async lambda of
    /// the same shape (confirmed on this repository's `main`, predating #4223
    /// entirely), so the adapter defect itself is pre-existing and unrelated to
    /// this issue — but relaxing GS0468 for the ZERO-CAPTURE sibling without
    /// this gate would newly route a previously-rejected program (this exact
    /// shape was unconditionally GS0468 before #4223) through the same broken
    /// adapter, trading a compile-time diagnostic for a runtime crash. The
    /// issue's own guidance is explicit: "Relax GS0468 only for routes with
    /// proven valid emission." This is not such a route yet; fixing the
    /// erased-delegate adapter itself is tracked as a separate, pre-existing
    /// defect.
    ///
    /// Footprint note: this gate must not reject anything that was legal
    /// BEFORE #4223. A zero-capture local nested inside a NON-generic user
    /// type (`class`/`struct` with no type parameters of its own)
    /// routes through `ClosureEmitter.SynthesizeClosures`'s display-class
    /// path rather than the top-level hoist the erased-delegate adapter
    /// belongs to, and the pre-#4223 gate excluded it for exactly that reason
    /// — this deliberately mirrors that exclusion rather than widening it.
    /// (That display-class path has its own, separately pre-existing instance
    /// of the identical adapter defect — confirmed by direct repro on this
    /// repository's `main`, predating #4223 entirely — but it was never
    /// covered by GS0468 either before or after this issue, so gating it here
    /// would be a new, out-of-scope rejection of previously-legal code.)
    /// @param location The text location of the declaring `let`/`var`/`const` identifier.
    /// @param name The local function's declared name.
    /// @param literal The already-bound function-literal expression.
    func CheckAsyncNonGenericLocalFunctionEnclosingTypeParameterInParameter(
        location TextLocation,
        name string,
        literal BoundFunctionLiteralExpression
    ) {
        if literal?.Function is not{IsAsync: true, IsGeneric: false} function ||
            literal
            .CapturedVariables
            .Length > 0 ||
            binderCtx.CurrentTypeParameters is not{Count: > 0} enclosingTypeParametersInScope ||
            (
            function.LexicalEnclosingType is StructSymbol enclosingStruct &&
                enclosingStruct
                .TypeParameters
                .IsDefaultOrEmpty
        ) {
            return
        }
        let walker = EnclosingTypeParameterReferenceWalker(
            enclosingTypeParametersInScope.Values.ToImmutableArray(),
            checkOwners: false
        )
        for parameter in function.Parameters {
            walker.CheckType(parameter.Type)
        }
        if walker.Found is {} offender {
            Diagnostics.ReportLocalFunctionCannotReferenceEnclosingTypeParameter(location, name, offender.Name)
        }
    }

    /// Prepares a generic local-function declaration
    /// `let Name[T, U, ...] = func (a T, b U) ... { ... }`. A CLR
    /// delegate cannot close over an unbound generic method, so this registers
    /// a directly callable signature, not a delegate variable. The returned
    /// continuation binds the body using the same symbol and its own type
    /// parameters after sibling signatures have been registered (#4219).
    /// @param syntax The `let Name[T, ...] = ...` variable declaration syntax.
    /// @returns The body-binding continuation; preparation never binds a body.
    func PrepareGenericLocalFunctionDeclaration(syntax VariableDeclarationSyntax)() -> BoundStatement {
        let name = syntax.Identifier.ValueText
        if syntax
            .Keyword
            ?.Kind != SyntaxKind.LetKeyword ||
            syntax.Initializer is not FunctionLiteralExpressionSyntax literalSyntax {
            Diagnostics.ReportGenericLocalFunctionMustBeLetBoundLiteral(syntax.Identifier.Location, name)
            return () -> BoundBlockStatement(syntax, ImmutableArray[BoundStatement].Empty)
        }
        let previousTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
        // Issue #4223: seed the scope bindTypeParameterList resolves
        // constraint types against with the ENCLOSING type parameters (not an
        // empty dictionary) so a constraint like `[T IComparable[U]]` — U
        // owned by an enclosing generic method or class — resolves instead of
        // reporting GS0113 ("Type 'U' doesn't exist"). Own names still shadow
        // same-named enclosing ones: bindTypeParameterList overwrites each
        // entry as it declares the local's own list, identically to the
        // re-establishment below for the parameter/return/body clauses.
        this.binderCtx.CurrentTypeParameters = if previousTypeParameters == nil {
            Dictionary[string, TypeParameterSymbol]()
        } else {
            Dictionary[string, TypeParameterSymbol](previousTypeParameters)
        }
        var typeParameters ImmutableArray[TypeParameterSymbol]
        try {
            // Issue #4219 (umbrella remainder): this method also prepares a
            // NON-generic local-function-literal group member (a run of two
            // or more consecutive `let name = func ... {...}` declarations,
            // see StatementBinder.IsNonGenericLocalFunctionLiteralDeclaration)
            // — it has no `[T, ...]` list at all, so there is nothing to bind.
            typeParameters = if syntax.TypeParameterList != nil {
                Invariant.Required(
                    bindTypeParameterList,
                    "generic local-function binding has a type-parameter callback",
                    expression: "bindTypeParameterList"
                )(syntax.TypeParameterList!!)
            } else {
                ImmutableArray[TypeParameterSymbol].Empty
            }
            // Re-establish the type-parameter scope merged with any enclosing
            // ones (mirrors DeclarationBinder.BindDelegateDeclaration) so the
            // literal's parameter/return/body clauses resolve T, U, ….
            this.binderCtx.CurrentTypeParameters = if previousTypeParameters == nil {
                Dictionary[string, TypeParameterSymbol]()
            } else {
                Dictionary[string, TypeParameterSymbol](previousTypeParameters)
            }
            for tp in typeParameters {
                binderCtx.CurrentTypeParameters!![tp.Name] = tp
            }
            // Issue #4219 (umbrella remainder): a ref-returning literal is
            // only accepted for the NON-generic direct-call shape here — a
            // GENERIC ref-returning local function would additionally need
            // ref-aware MethodSpec/signature-encoding paths that have not
            // been verified and are left for a follow-up (GS0588).
            let signature = PrepareFunctionLiteralSignature(
                literalSyntax,
                name,
                allowRefReturn: syntax.TypeParameterList == nil
            )
            if signature == nil {
                return () -> BoundBlockStatement(syntax, ImmutableArray[BoundStatement].Empty)
            }
            let (function, functionType) = signature
            function.TypeParameters = typeParameters
            function.LocalDeclaration = syntax
            if !Scope.TryDeclareFunction(function) {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name)
            }
            let bodyTypeParameters = binderCtx.CurrentTypeParameters
            let enclosingTypeParameters = if previousTypeParameters == nil {
                ImmutableArray[TypeParameterSymbol].Empty
            } else {
                previousTypeParameters.Values.ToImmutableArray()
            }
            return () -> {
                let savedTypeParameters = binderCtx.CurrentTypeParameters
                this.binderCtx.CurrentTypeParameters = bodyTypeParameters
                try {
                    let literal = BindFunctionLiteralBody(literalSyntax, function, functionType)
                    // Issue #4223: a reference to an enclosing method/class type
                    // parameter here used to be rejected outright (GS0468, issue
                    // #1940), on the theory that the emitted method owns only its
                    // own generic slots. UserTokenResolver.TryPromoteNonCapturingGenericLambda
                    // now extends the enclosing-type-parameter reification it
                    // already performs for non-generic zero-capture literals
                    // (issue #2118) to a local function that ALSO declares its own
                    // `[T, ...]` list: every referenced enclosing type parameter is
                    // cloned as an additional method type parameter alongside the
                    // local's own, so no bind-time rejection is needed. The lexical-
                    // owner accessibility restriction below (GS0586) is unrelated
                    // and unaffected — it still requires the offending owner to be
                    // (transitively) non-generic before a direct generic local may
                    // nest inside it.
                    let offender TypeParameterSymbol? = FindEnclosingTypeParameterReference(
                        function,
                        literal.Body,
                        enclosingTypeParameters,
                        out var requiresLexicalOwner
                    )
                    // Issue #4223: a ZERO-CAPTURE generic local function is
                    // hosted directly as a top-level generic MethodDef/
                    // MethodSpec, and UserTokenResolver.TryPromoteNonCapturingGenericLambda
                    // now reifies any enclosing type parameter it references
                    // (in its own parameter/return types, body, OR an own
                    // type parameter's constraint) as an additional method
                    // type parameter alongside its own — no bind-time
                    // rejection is needed for that shape.
                    //
                    // A CAPTURING generic local function (issue #4221/#4252)
                    // is hosted differently — its own type parameters live on
                    // a synthesized closure class's Invoke method — and that
                    // path has NOT been extended the same way: composing
                    // enclosing-type-parameter reification with capture
                    // support is left for a follow-up (the #4223 issue itself
                    // calls out composing with captures as a later concern).
                    // Confirmed by direct repro: `let Keep[T] = func (x T, y
                    // U) ... { <captures something> }` compiled clean but
                    // crashed (TypeLoadException / invalid IL) the moment
                    // `Outer` executed. Keep reporting GS0468 for that shape.
                    if offender != nil && literal.CapturedVariables.Length > 0 {
                        Diagnostics.ReportLocalFunctionCannotReferenceEnclosingTypeParameter(
                            syntax.Identifier.Location,
                            name,
                            offender.Name
                        )
                        literal.EnclosingTypeParameterDiagnosticReported = true
                    } else if function.LexicalEnclosingType is {} owner &&
                        requiresLexicalOwner &&
                        !function
                        .HasNonGenericLexicalOwner {
                        Diagnostics.ReportGenericLocalFunctionUnsupportedOwner(syntax.Identifier.Location, name, owner)
                    }
                    // Issue #4221/#4223 merge follow-up: this literal's
                    // CapturedVariables may still be empty here purely
                    // because a sibling it calls (a forward reference, or a
                    // call cycle) hasn't been bound yet — CollectCapturedVariables
                    // only folds a callee's captures into a caller declared
                    // AFTER it. ReconcileGenericLocalFunctionGroupCaptures
                    // widens this set to a fixed point once every group
                    // member has bound, which can turn an apparently
                    // capture-free literal into a capturing one AFTER this
                    // check already ran. Cache the offender (regardless of
                    // whether it tripped the check above) so that widening
                    // can re-evaluate the exclusion instead of silently
                    // reaching the emitter with an enclosing type parameter
                    // its capturing-closure host has no slot for.
                    if offender != nil {
                        literal.EnclosingTypeParameterOffender = offender
                        literal.EnclosingTypeParameterOffenderLocation = syntax.Identifier.Location
                    }
                    return BoundLocalFunctionDeclaration(syntax, literal)
                } finally {
                    this.binderCtx.CurrentTypeParameters = savedTypeParameters
                }
            }
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
        }
    }

    /// Issue #4221: re-converges a group of consecutive generic local-function
    /// declarations' captured-variable sets after every member's body has
    /// been bound once in source order.
    /// (cref:CollectCapturedVariables(BoundStatement, FunctionSymbol))
    /// (via (cref:CapturedVariableCollector)) already folds a callee's
    /// captures into its caller when the callee was declared — and therefore
    /// bound — earlier in the group. That leaves shapes unhandled by a single
    /// in-order pass: a call to a sibling declared LATER in the group
    /// (forward reference), a call cycle between two members, and — the
    /// reason this also walks into each member's body rather than stopping
    /// at its top-level literal — a plain or generic local function declared
    /// INSIDE a member's own body that itself calls a sibling. That inner
    /// literal's own (cref:BoundFunctionLiteralExpression.CapturedVariables)
    /// was fixed the moment it was bound, which can be before the callee's
    /// capture set has finished converging; leaving it stale would make the
    /// enclosing member's own re-walk below (which folds a nested literal's
    /// *cached* `CapturedVariables` via
    /// (cref:CapturedVariableCollector.RewriteFunctionLiteralExpression),
    /// without re-descending into it) keep missing the transitive capture
    /// forever. All of this is legal now that generic local functions may
    /// capture at all (#4252 removed the blanket GS0463 rejection); this
    /// widens every reachable literal's captured set to a fixed point by
    /// recomputing it, in a loop, against the whole group's current
    /// best-known sets, until nothing grows. Termination is guaranteed
    /// because a set only ever grows and is bounded by the (finite) set of
    /// variables in scope; the reachable-literal count is typically small,
    /// so the pass count is bounded to be defensive against a bug in the
    /// fixed-point logic itself, not because the algorithm needs it.
    /// @param group Every member of one consecutive run of
    /// `let Name[T, ...] = func (...) ... { ... }` declarations, in
    /// source order, after each one's body has been bound.
    func ReconcileGenericLocalFunctionGroupCaptures(group IReadOnlyList[BoundFunctionLiteralExpression]) {
        if group.Count < 2 {
            // A single generic local function has no sibling to call, so the
            // in-order pass inside CollectCapturedVariables already saw
            // everything it ever will. (A local function nested inside that
            // lone member still can't reach a sibling that doesn't exist.)
            return
        }
        let literals = List[BoundFunctionLiteralExpression](group)
        for member in group {
            CollectNestedFunctionLiterals(member.Body, literals)
        }
        let maxPasses = Math.Max(8, literals.Count * literals.Count)
        for var pass = 0; pass < maxPasses; pass++ {
            var changed = false
            for literal in literals {
                let recomputed = CollectCapturedVariables(literal.Body, literal.Function)
                if !HashSet[VariableSymbol](literal.CapturedVariables).SetEquals(recomputed) {
                    literal.CapturedVariables = recomputed
                    changed = true
                }
            }
            if !changed {
                break
            }
        }
        // Issue #4221/#4223 merge follow-up: a literal that referenced an
        // enclosing type parameter looked capture-free when its own gate
        // check ran (see PrepareGenericLocalFunctionDeclaration) — the
        // in-order pass hadn't yet seen a forward-referenced or cyclic
        // sibling's capture — and so was silently accepted as eligible for
        // the zero-capture enclosing-type-parameter reification path. The
        // fixed point above can have since widened its CapturedVariables,
        // which routes it to the capturing closure-class path instead (a
        // combination that path does not support). Re-evaluate the
        // exclusion now that every member's final capture set is known.
        for literal in literals {
            if literal.EnclosingTypeParameterOffender is {} offender &&
                !literal.EnclosingTypeParameterDiagnosticReported &&
                literal
                .CapturedVariables
                .Length > 0 {
                Diagnostics.ReportLocalFunctionCannotReferenceEnclosingTypeParameter(
                    literal.EnclosingTypeParameterOffenderLocation,
                    literal.Function.Name,
                    offender.Name
                )
                literal.EnclosingTypeParameterDiagnosticReported = true
            }
        }
    }

    /// ADR-0074 / issue #714: binds an arrow-lambda expression
    /// `[async] (p1 T1, p2 T2) -> body` to a
    /// (cref:BoundFunctionLiteralExpression). Reuses every piece
    /// of (cref:BindFunctionLiteralExpression)'s plumbing — scope,
    /// synthetic function, captured-variable analysis, smart-cast
    /// narrowing snapshot — but the body is an expression (or a
    /// (cref:BlockExpressionSyntax)) rather than a
    /// (cref:BlockStatementSyntax). The return type is inferred
    /// from the bound body's type; a (cref:TypeSymbol.Void) body
    /// yields a void return.
    ///
    /// ADR-0076 / issue #716 extends this in three ways:
    ///
    /// - <b>Optional async modifier</b> — when (cref:LambdaExpressionSyntax.IsAsync) is set, the body is
    /// bound under an async synthetic function and the function- type's return slot is widened to `Task` /
    /// `Task[T]` exactly as a function-literal would.
    /// - <b>Block-body return-type inference</b> — the placeholder synthetic function is marked
    /// (cref:FunctionSymbol.IsReturnTypeInferred), the return statements inside the block bind without a
    /// void or declared- return-type check, and a post-bind pass computes the common type and applies a
    /// single conversion to each return expression.
    /// - <b>Target-typed parameter inference</b> — when [`targetFunctionType`](paramref) is non-null, an
    /// omitted parameter type clause is filled in from the corresponding slot of the target. With no target
    /// type, a missing parameter type is reported as GS0304.
    /// @param syntax The lambda-expression syntax node.
    /// @param targetFunctionType Optional target function type
    /// supplied by the caller (e.g. an explicit variable type clause)
    /// when the parameter types should be inferred from a target. When
    /// non-null and arity matches, omitted parameter type clauses are
    /// filled in from this target.
    /// @param inferReturnTypeFromBody Follow-up to issue #891: when `true`,
    /// the target's return slot is ignored for return-type inference — the
    /// lambda's return type is computed purely from its body. Used by the
    /// deferred-lambda partial-inference path, where the target carries only
    /// closed parameter types (the delegate's return type is an un-inferred
    /// method type parameter and a placeholder occupies the target's return
    /// slot).
    /// @param acceptsNaturalType Issue #5569: when set, another overload candidate can take the literal's natural
    /// function type. A block body then binds once with its return conversions deferred. When a `return` value
    /// does not convert to the target and this callback accepts the natural function type, the literal keeps
    /// that type and the target conversion diagnostics go to [`discardedTargetDiagnostics`](paramref).
    /// @param discardedTargetDiagnostics Receives the target conversion diagnostics of a literal that keeps its
    /// natural type.
    /// @returns The bound lambda as a (cref:BoundFunctionLiteralExpression).
    func BindLambdaExpression(
        syntax LambdaExpressionSyntax,
        targetFunctionType FunctionTypeSymbol? = nil,
        inferReturnTypeFromBody bool = false,
        acceptsNaturalType((TypeSymbol) -> bool)? = nil,
        discardedTargetDiagnostics List[ImmutableArray[Diagnostic]]? = nil
    ) BoundExpression {
        let startMark = Diagnostics.Count
        if bindLambdaBodyExpression == nil {
            throw InvalidOperationException(
                "LambdaBinder was constructed without a bindLambdaBodyExpression callback; arrow-lambda binding is unavailable."
            )
        }
        let bindLambdaBodyExpression = bindLambdaBodyExpression!!
        let isAsync = syntax.IsAsync
        let arityMatchesTarget = targetFunctionType != nil && targetFunctionType.Arity == syntax.Parameters.Count
        // Issue #5569: a speculative literal whose parameters are all written can fall back to its natural type.
        let naturalTypeAvailable = acceptsNaturalType != nil && syntax.Parameters.All(
            (parameter ParameterSyntax) -> parameter.Type != nil
        )
        if naturalTypeAvailable && targetFunctionType != nil && !arityMatchesTarget {
            let arityMark = Diagnostics.Count
            Diagnostics.ReportWrongArgumentCount(
                syntax.Location,
                "lambda",
                targetFunctionType.Arity,
                syntax.Parameters.Count
            )
            let arityDiagnostics = Diagnostics.Skip(arityMark).ToImmutableArray()
            Diagnostics.TruncateTo(arityMark)
            if TryBindNaturalFallback(
                syntax,
                arityDiagnostics,
                acceptsNaturalType!!,
                discardedTargetDiagnostics,
                out var natural
            ) {
                return natural!!
            }
            Diagnostics.AddRange(arityDiagnostics)
            return BoundErrorExpression(nil)
        }
        if targetFunctionType != nil && !arityMatchesTarget {
            Diagnostics.ReportWrongArgumentCount(
                syntax.Location,
                "lambda",
                targetFunctionType.Arity,
                syntax.Parameters.Count
            )
        }
        let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](syntax.Parameters.Count)
        let parameterSymbols = ImmutableArray.CreateBuilder[ParameterSymbol](syntax.Parameters.Count)
        let seen = HashSet[string]()
        var hasIncompatibleExplicitParameter = false
        // Issue #5569: the parameter diagnostics that only the target causes, for a speculative literal.
        let parameterTargetDiagnostics = List[Diagnostic]()
        var needsExplicitParameterAdapter = false
        let exactTargetParameterSlots = [syntax.Parameters.Count]bool
        // ADR-0185: every destructured parameter's pattern, recorded here so
        // its element locals can be declared (and their extraction
        // statements produced) once the lambda's own scope is pushed below —
        // a destructured parameter is not itself referenceable by name, so
        // there is nothing more to do with it until then.
        var destructuredParameters List[
            (TupleParameter ParameterSymbol, Pattern TupleDeconstructionPatternSyntax)
        ]? = nil
        for var i = 0; i < syntax.Parameters.Count; i++ {
            let p = syntax.Parameters[i]
            if p.DeconstructionPattern is {} pattern {
                // ADR-0185: `(x T1, y T2, ...) -> body`. The parameter LIST's
                // overall slot type is still the tuple type — a pure
                // binding-time convenience, not a signature change (Decision
                // point 3) — so bind each element's type and build that
                // tuple type here; the element LOCALS themselves are only
                // declared once the lambda's own scope exists, below.
                let elementTypes = ImmutableArray.CreateBuilder[TypeSymbol](pattern.Elements.Count)
                for element in pattern.Elements {
                    let elementType = if element.Type is {} elementTypeSyntax {
                        bindTypeClause(elementTypeSyntax) ?? TypeSymbol.Error
                    } else {
                        TypeSymbol.Error
                    }
                    elementTypes.Add(elementType)
                }
                var tupleParameterType TypeSymbol
                if pattern.Elements.Count < 2 {
                    // G# has no 1-tuples (mirrors ParseTupleTypeClause's
                    // existing `(T)` grouping / stray tuple-element-name
                    // diagnostic for the tuple TYPE grammar) — a
                    // single-element destructuring pattern can never
                    // correspond to a real tuple-typed argument. Reported at
                    // bind time (the pattern itself parses cleanly either
                    // way) rather than duplicating this check into the
                    // parser's lookahead.
                    Diagnostics.ReportDestructuringParameterRequiresAtLeastTwoElements(
                        pattern.CloseParenToken.Location,
                        pattern.Elements.Count
                    )
                    tupleParameterType = TypeSymbol.Error
                } else {
                    tupleParameterType = TupleTypeSymbol.Get(elementTypes.MoveToImmutable())
                }
                // Issue #2810 (ported to the destructured shape): an explicit
                // parameter type is a contract the target delegate's slot
                // type must convert implicitly TO, exactly like an ordinary
                // explicitly-typed parameter below — a destructured
                // parameter's written type is its built tuple type.
                if arityMatchesTarget && tupleParameterType != TypeSymbol.Error && Invariant.Required(
                    targetFunctionType,
                    "an explicitly typed lambda with a target has a target function type",
                    expression: "targetFunctionType"
                )
                    .ParameterTypes[i] is TypeSymbol targetParameterTypeForPattern &&
                    targetParameterTypeForPattern != TypeSymbol
                    .Error {
                    let runtimeEquivalent = TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                        targetParameterTypeForPattern,
                        tupleParameterType
                    )
                    let conversion = Conversion.ClassifyNonStructural(targetParameterTypeForPattern, tupleParameterType)
                    let compatible = runtimeEquivalent ||
                        conversion.IsImplicit ||
                        conversions.HasUserDefinedImplicitConversion(targetParameterTypeForPattern, tupleParameterType)
                    if !compatible {
                        if conversion.Exists {
                            Diagnostics.ReportCannotConvertImplicitly(
                                pattern.Location,
                                targetParameterTypeForPattern,
                                tupleParameterType
                            )
                        } else {
                            Diagnostics.ReportCannotConvert(
                                pattern.Location,
                                targetParameterTypeForPattern,
                                tupleParameterType
                            )
                        }
                        hasIncompatibleExplicitParameter = true
                    } else if !runtimeEquivalent {
                        needsExplicitParameterAdapter = true
                        exactTargetParameterSlots[i] = true
                    }
                }
                // The CLR parameter itself needs SOME name for signature
                // metadata, but it is never referenceable from G# source —
                // the body only ever sees the destructured element names,
                // declared below once the lambda's scope exists. Mirrors
                // this file's own `<lambdaN>` / BindForTupleRangeStatementCore's
                // `<fortupleN>` synthetic-name convention for a compiler-
                // internal binding with no source name of its own (NOT the
                // `__q{N}` scheme ADR-0185 retires: that name was emitted
                // into cs2gs's TRANSLATED G# SOURCE TEXT and so was a real
                // synthetic identifier; this one never appears in any G#
                // source a person reads).
                let tupleParameterName = "<destructured${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
                let tupleParameter = ParameterSymbol(
                    tupleParameterName,
                    tupleParameterType,
                    isVariadic: false,
                    declaringSyntax: pattern,
                    isScoped: false,
                    refKind: RefKind.None
                )
                // ADR-0063/ADR-0047: an annotation written before a
                // destructured parameter's pattern (`@Attr ((x T, y U)) ->
                // ...`) still lives on `p.Annotations` — WithAnnotations is
                // called generically by ParseLambdaParameter for both the
                // ordinary and destructured shapes — so it must be attached
                // here too, exactly like the ordinary-parameter path below
                // does, or it is silently dropped along with whatever
                // attribute-target validation AttachParameterAttributes
                // performs.
                AttachParameterAttributes(p, tupleParameter)
                parameterSymbols.Add(tupleParameter)
                parameterTypes.Add(tupleParameterType)
                (
                    (
                        if destructuredParameters == nil {
                            (
                                destructuredParameters = List[
                                    (TupleParameter ParameterSymbol, Pattern TupleDeconstructionPatternSyntax)
                                ]()
                            )
                        } else {
                            destructuredParameters
                        }
                    )!!
                )
                    .Add((tupleParameter, pattern))
                continue
            }
            let pname = p.Identifier!!.ValueText
            var ptype TypeSymbol?
            if p.Type != nil {
                let explicitType = p.Type
                ptype = bindTypeClause(
                    Invariant.Required(
                        explicitType,
                        "an explicitly typed lambda parameter has a type clause",
                        expression: "explicitType"
                    )
                ) ??
                    TypeSymbol.Error
            } else if arityMatchesTarget {
                // ADR-0076 / issue #716: target-typed parameter inference —
                // an omitted parameter type is filled in from the target's
                // corresponding slot.
                ptype = Invariant.Required(
                    targetFunctionType,
                    "a target-typed lambda has a target function type",
                    expression: "targetFunctionType"
                )
                    .ParameterTypes[i] ??
                    TypeSymbol.Error
            } else {
                // ADR-0076 / issue #716: no parameter type and no target to
                // infer it from — GS0304.
                Diagnostics.ReportLambdaBindingTypeCannotBeInferred(p.Location, pname)
                ptype = TypeSymbol.Error
            }
            // ADR-0101 follow-up / issue #812, generalized by ADR-0173 / issue
            // #3627: variadic parameters are accepted on arrow lambdas. An
            // explicitly typed `...T` parameter resolves to the same carrier
            // a named function or delegate would declare — the array wrap
            // around a plain element type, or the written type itself when it
            // is already a supported carrier — so an explicitly typed lambda
            // parameter carries the same declared type as the delegate it is
            // assigned to (issue #4235: `xs ...List[int32]` must bind as
            // `List[int32]`, not `[]List[int32]`).
            //
            // Target-typed inference (p.Type == null) is untouched: the slot
            // type already comes straight from the target's Nth parameter,
            // which is itself already a resolved carrier.
            let isVariadic = p.IsVariadic
            if isVariadic && ptype != nil && ptype != TypeSymbol.Error && p.Type != nil {
                ptype = VariadicCarriers.ResolveDeclaredParameterType(ptype)
            }
            let parameterType = Invariant.Required(
                ptype,
                "lambda parameter binding produces a type",
                expression: "ptype"
            )
            let refKind = conversions.BindAndValidateParameterRefKind(
                p,
                pname,
                parameterType,
                isVariadic,
                if isAsync {
                    "async"
                } else {
                    default(string?)
                }
            )
            // Issue #2810: an explicit lambda parameter type is a contract,
            // not a hint. The target delegate supplies its slot type, so that
            // type must convert implicitly to the written parameter type before
            // an adapter may be synthesized. By-reference parameters require a
            // runtime-identical type because a value conversion cannot preserve
            // aliasing. Reference nullability and named-delegate/function
            // pairs retain their existing runtime-compatible behavior.
            if p.Type != nil && arityMatchesTarget && parameterType != TypeSymbol.Error && Invariant.Required(
                targetFunctionType,
                "an explicitly typed lambda with a target has a target function type",
                expression: "targetFunctionType"
            )
                .ParameterTypes[i] is TypeSymbol targetParameterType &&
                targetParameterType != TypeSymbol
                .Error {
                let runtimeEquivalent = TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    targetParameterType,
                    parameterType
                )
                let conversion = Conversion.ClassifyNonStructural(targetParameterType, parameterType)
                let structurallyCompatibleDelegate = parameterType is FunctionTypeSymbol writtenFunctionType &&
                    !(targetParameterType is FunctionTypeSymbol) &&
                    MemberLookup.TryGetDelegateFunctionTypeFromSymbol(
                    targetParameterType,
                    out var targetDelegateFunctionType
                ) &&
                    Conversion
                    .ClassifyNonStructural(targetDelegateFunctionType!!, writtenFunctionType).IsImplicit
                let compatible = runtimeEquivalent ||
                    structurallyCompatibleDelegate ||
                    (
                    refKind == RefKind.None &&
                        (
                        conversion.IsImplicit || conversions.HasUserDefinedImplicitConversion(
                            targetParameterType,
                            parameterType
                        )
                    )
                )
                if !compatible {
                    let parameterMark = Diagnostics.Count
                    if conversion.Exists {
                        Diagnostics.ReportCannotConvertImplicitly(p.Type!!.Location, targetParameterType, parameterType)
                    } else {
                        Diagnostics.ReportCannotConvert(p.Type!!.Location, targetParameterType, parameterType)
                    }
                    if naturalTypeAvailable {
                        parameterTargetDiagnostics.AddRange(Diagnostics.Skip(parameterMark))
                        Diagnostics.TruncateTo(parameterMark)
                    }
                    hasIncompatibleExplicitParameter = true
                } else if !runtimeEquivalent && !structurallyCompatibleDelegate {
                    needsExplicitParameterAdapter = true
                    exactTargetParameterSlots[i] = true
                }
            }
            // Issue #1262: skip the uniqueness check for the discard `_` so a
            // second discard parameter is permitted (C# `(_, _) => ...`). Each
            // `_` still occupies its positional slot.
            if pname != "_" && !seen.Add(pname) {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname)
            }
            let lambdaParam = ParameterSymbol(
                pname,
                parameterType,
                isVariadic,
                declaringSyntax: p.Identifier,
                isScoped: p.IsScoped,
                refKind: refKind
            )
            // ADR-0063 §5: arrow-lambda parameters can also declare a default
            // value; the conversion classifier validates the constant-folded
            // default at bind time the same way it does for function-literal
            // parameters.
            conversions.BindAndAttachParameterDefaultValue(p, lambdaParam)
            AttachParameterAttributes(p, lambdaParam)
            parameterSymbols.Add(lambdaParam)
            parameterTypes.Add(parameterType)
        }
        if hasIncompatibleExplicitParameter {
            // Issue #5569: the target bind stops here without binding the body, so the natural bind is the only one.
            if parameterTargetDiagnostics.Count > 0 {
                let held = parameterTargetDiagnostics.ToImmutableArray()
                if TryBindNaturalFallback(
                    syntax,
                    held,
                    acceptsNaturalType!!,
                    discardedTargetDiagnostics,
                    out var natural
                ) {
                    return natural!!
                }
                Diagnostics.AddRange(held)
            }
            return BoundErrorExpression(nil)
        }
        // ADR-0101 follow-up / issue #812: enforce variadic structural rules.
        ValidateVariadicParameterShape(syntax.Parameters)
        var contextualReturnType TypeSymbol? = targetFunctionType?.ReturnType
        if isAsync && contextualReturnType != nil {
            contextualReturnType = UnwrapTaskReturnType(contextualReturnType)
        }
        // A fully target-typed lambda exposes its awaited return type while its
        // statements bind, allowing explicit return expressions (including
        // nested lambdas) to receive the same context as declared functions.
        // Partial generic inference still uses the poisoned placeholder and
        // infers the return from the body.
        let syntheticName = "<lambda${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let placeholderReturnType = if !inferReturnTypeFromBody &&
            contextualReturnType != nil &&
            !TypeSymbol.ContainsTypeParameter(contextualReturnType) &&
            contextualReturnType
            .ClrType
            ?.ContainsGenericParameters != true {
            contextualReturnType
        } else {
            TypeSymbol.Error
        }
        let placeholder = FunctionSymbol(syntheticName, parameterSymbols.ToImmutable(), placeholderReturnType)
        placeholder.IsAsync = isAsync
        placeholder.IsReturnTypeInferred = placeholderReturnType == TypeSymbol.Error
        // Issue #5569: a speculative bind converts its `return` values after the body, so the body binds once for
        // both the target and the natural function type.
        let defersReturnConversion = acceptsNaturalType != nil &&
            !isAsync &&
            placeholderReturnType != TypeSymbol.Error &&
            placeholderReturnType != TypeSymbol.Void
        placeholder.DeferredReturns = if defersReturnConversion {
            DeferredReturnState()
        } else {
            default(DeferredReturnState?)
        }
        let outerScope = Scope
        let outerFunction = getCurrentFunction()
        Scope = BoundScope(outerScope)
        setCurrentFunction(placeholder)
        placeholder.LexicalEnclosingType = ResolveLexicalEnclosingType(outerFunction)
        for ps in placeholder.Parameters {
            // Issue #1262: discard parameters (`_`) are non-referenceable —
            // do not add them to the lookup scope so `_` in the body does not
            // resolve to a parameter (and repeated `_` slots never collide).
            if ps.Name == "_" {
                continue
            }
            Scope.TryDeclareVariable(ps)
        }
        // ADR-0185: now that the lambda's own scope exists and every
        // ordinary parameter is declared into it, declare each destructured
        // parameter's element names as ordinary locals too (so a later
        // destructured pattern can see an earlier ordinary parameter, and
        // vice versa) and collect the field-extraction statements to prepend
        // to the body below — the same reuse of BindForTupleLoopPrelude
        // described where destructuredParameters above is populated.
        let destructuringPrelude = ImmutableArray.CreateBuilder[BoundStatement]()
        if destructuredParameters != nil {
            for (tupleParameter, pattern) in destructuredParameters {
                if tupleParameter.Type == TypeSymbol.Error {
                    // Arity < 2 already reported when the tuple type could
                    // not be built; declare each element directly as an
                    // Error-typed local (skipping `_`) so the body doesn't
                    // cascade "undefined variable" diagnostics, without
                    // going through BindForTupleLoopPrelude — that helper
                    // always assumes a genuine tuple/data-struct element
                    // type and would report ITS OWN (less precise)
                    // "requires a tuple or data struct" diagnostic on top.
                    for element in pattern.Elements {
                        let elementIdentifier = element.Identifier!!
                        if elementIdentifier.ValueText != "_" {
                            bindLocalVariable(elementIdentifier, true, TypeSymbol.Error)
                        }
                    }
                    continue
                }
                let identifierNodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
                for var elementIndex = 0; elementIndex < pattern.Elements.Count; elementIndex++ {
                    identifierNodesAndSeparators.Add(pattern.Elements[elementIndex].Identifier!!)
                    let separator SyntaxToken? = pattern.Elements.GetSeparator(elementIndex)
                    if separator != nil {
                        identifierNodesAndSeparators.Add(separator)
                    }
                }
                let elementIdentifiers = GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SeparatedSyntaxList[SyntaxToken](identifierNodesAndSeparators.ToImmutable())
                destructuringPrelude.AddRange(
                    bindTupleDestructuringPrelude(
                        elementIdentifiers,
                        pattern.CloseParenToken.Location,
                        pattern.OpenParenToken.Location,
                        tupleParameter
                    )
                )
            }
        }
        // ADR-0069 / issue #700, amended by issue #2442: see the matching
        // comment in BindFunctionLiteralExpression — a read-only
        // plain-variable narrowing survives into the arrow-lambda body
        // unconditionally; every other narrowing (mutable `var` locals,
        // ref/out parameters, member-access paths) is dropped exactly as
        // before.
        let savedNarrowed = binderCtx.NarrowedVariables.ToList()
        let survivingNarrowed = FilterNarrowingsSurvivingClosureCapture(savedNarrowed)
        binderCtx.NarrowedVariables.Clear()
        binderCtx.NarrowedVariables.AddRange(survivingNarrowed)
        let savedShadowOverlay = binderCtx.ShadowOverlay
        binderCtx.ShadowOverlay = savedShadowOverlay.ForClosureBody()
        // Issue #2027: an arrow lambda is its own goto/label frame — a
        // block-bodied arrow lambda (`x => { ...; goto foo; foo: ...; }`)
        // can contain loops and labels of its own, so isolate it from the
        // enclosing function's labels and loop stack exactly like the
        // function-literal path above.
        let savedFrame = EnterNestedFrame(syntax.Body)
        var boundBody BoundExpression
        try {
            var bodyTargetType TypeSymbol? = contextualReturnType
            if bodyTargetType == TypeSymbol.Void {
                bodyTargetType = nil
            }
            boundBody = Invariant.Required(
                bindLambdaBodyExpression,
                "lambda binding has a body-expression callback",
                expression: "bindLambdaBodyExpression"
            )(syntax.Body, bodyTargetType)
            FinalizeNestedFrameLabels()
        } finally {
            binderCtx.NarrowedVariables.Clear()
            binderCtx.NarrowedVariables.AddRange(savedNarrowed)
            binderCtx.ShadowOverlay = savedShadowOverlay
            RestoreNestedFrame(savedFrame)
        }
        Scope = outerScope
        setCurrentFunction(outerFunction)
        // ADR-0076 / issue #716: infer the lambda's return type from
        // (a) the bound body's trailing-expression type, combined with
        // (b) the types of any `return` statements in the body. For a block-
        // body lambda with explicit `return` statements, the void trailing
        // produced by the body-binding pipeline is replaced by the common
        // type of all return-statement expressions.
        var returnType = InferLambdaReturnType(
            boundBody,
            syntax,
            if inferReturnTypeFromBody {
                default(FunctionTypeSymbol?)
            } else {
                targetFunctionType
            },
            isAsync
        )
        if defersReturnConversion {
            // Issue #5569: convert the returns as an eager target bind does. When a return or the trailing value
            // does not convert, the literal keeps its natural type only if no other error occurred and another
            // candidate accepts it. The return values whose target typing failed bound again with their natural
            // type; the target-typed values and their diagnostics are in the placeholder's state.
            let deferredReturns = Invariant.Required(
                placeholder.DeferredReturns,
                "a deferred return conversion has a state",
                expression: "placeholder.DeferredReturns"
            )
            let targetBody = deferredReturns.WithTargetOperands(boundBody)
            let trialMark = Diagnostics.Count
            let converted = ApplyInferredReturnTypeConversion(targetBody, syntax, placeholderReturnType, true)
            let targetDiagnostics = deferredReturns.OperandDiagnostics().AddRange(Diagnostics.Skip(trialMark))
            Diagnostics.TruncateTo(trialMark)
            // The body fits the target only when the target-typed inference adopts the target return type, which
            // also checks a trailing value that is not a `return`.
            let fitsTarget = !targetDiagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) &&
                InferLambdaReturnType(converted, syntax, targetFunctionType, isAsync) == placeholderReturnType
            let naturalReturnType = if !fitsTarget {
                InferLambdaReturnType(boundBody, syntax, nil, isAsync)
            } else {
                TypeSymbol.Error
            }
            if naturalReturnType != TypeSymbol.Error && !Diagnostics.Skip(startMark).Any(
                (diagnostic Diagnostic) -> diagnostic.IsError
            ) &&
                acceptsNaturalType!!(
                FunctionTypeSymbol.Get(
                    parameterTypes.ToImmutable(),
                    BuildVariadicFlagsIfAny(parameterSymbols),
                    naturalReturnType
                )
            ) {
                discardedTargetDiagnostics?.Add(targetDiagnostics)
                Diagnostics.AddRange(deferredReturns.NaturalDiagnostics())
                returnType = naturalReturnType
                // The natural literal keeps its written parameter types, so no adapter to the target applies.
                needsExplicitParameterAdapter = false
            } else {
                Diagnostics.AddRange(targetDiagnostics)
                boundBody = converted
                returnType = InferLambdaReturnType(boundBody, syntax, targetFunctionType, isAsync)
            }
        }
        if isAsync && isAsyncIteratorReturnType(returnType) {
            Diagnostics.ReportAsyncIteratorFunctionLiteralNotSupported(syntax.Location, returnType)
            return BoundErrorExpression(syntax)
        }
        // ADR-0058: a managed-pointer (*T) cannot be used as a lambda return
        // type because CLR Func<> delegates cannot carry by-ref type arguments.
        if returnType is ByRefTypeSymbol {
            Diagnostics.ReportByRefCannotEscape(
                syntax.Body.Location,
                "a managed pointer (*T) cannot be the return type of a lambda expression"
            )
            returnType = TypeSymbol.Error
        }
        // For async lambdas, the observable function-type (from the caller's
        // perspective) is Task / Task<T>, matching async function literals.
        var observableReturnType = returnType
        var asyncReturnsValueTask = false
        if isAsync && !isAsyncIteratorReturnType(returnType) && returnType != TypeSymbol.Error {
            asyncReturnsValueTask = targetFunctionType != nil && AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(
                targetFunctionType.ReturnType,
                out _,
                out var targetUsesValueTask
            ) &&
                targetUsesValueTask
            observableReturnType = WrapAsTask(returnType, asyncReturnsValueTask)
        }
        let synthetic = FunctionSymbol(syntheticName, placeholder.Parameters, returnType)
        synthetic.IsAsync = isAsync
        synthetic.AsyncReturnsValueTask = asyncReturnsValueTask
        synthetic.LexicalEnclosingType = placeholder.LexicalEnclosingType
        // ADR-0076 / issue #716: rewrite the bound body so every return
        // statement's expression is converted to the inferred return type.
        // We deferred the conversion in BindReturnStatement; apply it now.
        boundBody = ApplyInferredReturnTypeConversion(boundBody, syntax, returnType, defersReturnConversion)
        // Synthesize the lambda's BoundBlockStatement body: for void bodies, an
        // ExpressionStatement; for value bodies, a ReturnStatement.
        let bodyStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        // ADR-0185: a destructured parameter's element-extraction statements
        // run first, unpacking the tuple argument before anything else in
        // the body — the same position a statement-form `let (x, y) = e`
        // deconstruction would occupy if the caller had to write one by
        // hand. This works uniformly whether the lambda's own body was
        // written as a plain expression or a `{ ... }` block: either way
        // `bodyStatements` is the single list every body-statement,
        // including this prelude, is collected into below.
        bodyStatements.AddRange(destructuringPrelude)
        if boundBody is BoundBlockExpression blockExpr && syntax.Body is BlockExpressionSyntax {
            // Block body — emit the prefix statements, then either a return-
            // statement on the trailing expression (when the lambda returns a
            // value) or an expression-statement + void return (when it doesn't).
            for stmt in blockExpr.Statements {
                bodyStatements.Add(stmt)
            }
            EmitTrailingExpression(bodyStatements, syntax, blockExpr.Expression, returnType)
        } else {
            EmitTrailingExpression(bodyStatements, syntax, boundBody, returnType)
        }
        let bodyBlock = BoundBlockStatement(syntax.Body, bodyStatements.ToImmutable())
        CheckAllPathsReturn(bodyBlock, returnType, syntax.Body.Location)
        let fnType = FunctionTypeSymbol.Get(
            parameterTypes.MoveToImmutable(),
            BuildVariadicFlagsIfAny(parameterSymbols),
            observableReturnType
        )
        let captured = CollectCapturedVariables(bodyBlock, synthetic)
        // Issue #367 / ADR-0058: by-ref-like or managed-pointer locals cannot
        // be captured by a closure; mirror the function-literal checks.
        // Issue #2330: same for an unmanaged `fixed` pointer.
        // Issue #4259: same for a `ref`/`out`/`in` PARAMETER of the enclosing
        // function.
        // Issue #4271: a `ref`/`var ref` LOCAL alias is a distinct capture kind
        // (a plain LocalVariableSymbol, not a ParameterSymbol) that #4259 left
        // unhandled — it is now rejected too, for the same reason (its slot
        // holds a managed pointer that CaptureBoxingRewriter.IsBoxable refuses
        // to hoist into a shared box, so the capture would otherwise silently
        // fall back to a by-value snapshot and lose write-through).
        // Copilot review of PR #4273: the full check is factored into
        // ClosureCaptureLegalityChecker so the `go`-statement closure path
        // (StatementBinder.BindGoStatement) applies the exact same rules.
        ClosureCaptureLegalityChecker.CheckCapturedVariables(captured, Diagnostics, syntax.Location)
        let literal = BoundFunctionLiteralExpression(syntax, synthetic, fnType, bodyBlock, captured)
        if !needsExplicitParameterAdapter {
            return literal
        }
        let target = Invariant.Required(
            targetFunctionType,
            "an explicit lambda parameter adapter has a target function type",
            expression: "targetFunctionType"
        )
        let adapterTarget = FunctionTypeSymbol.Get(target.ParameterTypes, target.IsVariadic, observableReturnType)
        return CreateErasedFunctionLiteralAdapter(
            literal,
            adapterTarget,
            ImmutableArray.Create(exactTargetParameterSlots)
        )
    }

    /// Synthesizes an "erased" function-literal adapter: a wrapper
    /// (cref:BoundFunctionLiteralExpression) whose parameter
    /// types and return type are the erased-delegate slot shapes of
    /// the supplied [`targetFunctionType`](paramref), and whose
    /// body forwards into the original literal through value-converting
    /// (cref:BoundConversionExpression)s on each parameter
    /// reference and (for non-`void` returns) on the return
    /// value. Generic (cref:TypeParameterSymbol) slots widen
    /// to (cref:TypeSymbol.Object) via
    /// (cref:GetErasedDelegateSlotType).
    /// @param literal The original bound function literal whose
    /// signature needs to widen to a delegate-typed target.
    /// @param targetFunctionType The function-type shape the
    /// adapter must present to the delegate-typed parameter.
    /// @param exactTargetParameterSlots Parameter slots that must use
    /// their target type without generic-erasure preservation.
    /// @param exactTargetReturnType Whether the adapter must expose the
    /// target return type exactly instead of preserving symbolic erasure.
    /// @returns The adapter literal; its
    /// (cref:BoundFunctionLiteralExpression.CapturedVariables)
    /// match the original literal's captures.
    func CreateErasedFunctionLiteralAdapter(
        literal BoundFunctionLiteralExpression,
        targetFunctionType FunctionTypeSymbol,
        exactTargetParameterSlots ImmutableArray[bool] = default(ImmutableArray[bool]),
        exactTargetReturnType bool = false
    ) BoundFunctionLiteralExpression {
        // ADR-0087 §3 R6: if the literal's declared signature already
        // matches the (possibly substituted) target, the adapter would
        // be an identity wrapper that erased type-parameter slots to
        // System.Object without need. Skip it — the literal flows
        // through with its concrete signature so the emitted lambda
        // MethodDef matches the runtime delegate's Invoke shape.
        if IsIdentityAdapter(literal, targetFunctionType) {
            return literal
        }
        let adapterParameters = ImmutableArray.CreateBuilder[ParameterSymbol](literal.Function.Parameters.Length)
        let replacementMap = Dictionary[VariableSymbol, BoundExpression]()
        let adapterPrefix = ImmutableArray.CreateBuilder[BoundStatement]()
        // Issue #2861: a nested literal inside the body captures the ORIGINAL
        // parameter symbol, which does not exist in the adapter method. Such a
        // capture needs a real variable to bind against, so the inline
        // `BoundConversionExpression` replacement below is not usable for it —
        // collect the nested captures up front and force the converted-local
        // path for every parameter one of them captures.
        let nestedCaptures = CollectNestedCapturedVariables(literal.Body)
        let nestedSubstitution = Dictionary[VariableSymbol, VariableSymbol]()
        for var i = 0; i < literal.Function.Parameters.Length; i++ {
            let original = literal.Function.Parameters[i]
            let targetSlot = if i < targetFunctionType.ParameterTypes.Length {
                targetFunctionType.ParameterTypes[i]
            } else {
                TypeSymbol.Object
            }
            let useExactTargetParameterType = !exactTargetParameterSlots.IsDefault &&
                i < exactTargetParameterSlots.Length &&
                exactTargetParameterSlots[i]
            let adapterParameterType = if useExactTargetParameterType {
                targetSlot
            } else {
                GetAdapterSlotType(original.Type, targetSlot)
            }
            let adapterParameter = ParameterSymbol(original, adapterParameterType, original.DeclaringSyntax)
            adapterParameter.SetAttributes(original.Attributes)
            adapterParameters.Add(adapterParameter)
            let adapterRead = BoundVariableExpression(nil, adapterParameter)
            let bindConvertedLocal = (
                useExactTargetParameterType && !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    adapterParameterType,
                    original.Type
                )
            ) ||
                conversions.HasUserDefinedImplicitConversion(adapterParameterType, original.Type) ||
                (original.RefKind == RefKind.None && nestedCaptures.Contains(original))
            if bindConvertedLocal {
                let converted = conversions.BindConversion(
                    original.DeclaringSyntax?.Location ?? Invariant.Required(
                        literal.Syntax,
                        "an adapted function literal has syntax",
                        expression: "literal.Syntax"
                    )
                        .Location,
                    adapterRead,
                    original.Type
                )
                let declaringSyntax = original.DeclaringSyntax ?? Invariant.Required(
                    literal.Syntax,
                    "an adapted function literal has syntax",
                    expression: "literal.Syntax"
                )
                let convertedLocal = LocalVariableSymbol(
                    "<lambda_parameter${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: true,
                    original.Type,
                    declaringSyntax
                )
                adapterPrefix.Add(BoundVariableDeclaration(original.DeclaringSyntax, convertedLocal, converted))
                replacementMap[original] = BoundVariableExpression(nil, convertedLocal)
                if original.RefKind == RefKind.None && nestedCaptures.Contains(original) {
                    nestedSubstitution[original] = convertedLocal
                }
            } else {
                replacementMap[original] = BoundConversionExpression(nil, original.Type, adapterRead)
            }
        }
        let adapterReturnType = if targetFunctionType.ReturnType == TypeSymbol.Void {
            TypeSymbol.Void
        } else {
            (
                if exactTargetReturnType {
                    targetFunctionType.ReturnType
                } else {
                    GetAdapterSlotType(literal.Function.Type, targetFunctionType.ReturnType)
                }
            )
        }
        // Issue #2180: an async literal carries a DUAL return shape — the
        // FunctionSymbol's result type is the UNWRAPPED value (`T`), while its
        // observable delegate return is the `Task[T]` wrapper. Treating the
        // target's observable Task as the FunctionSymbol result would wrap it
        // again as Task<Task> during async lowering. For a type-parameter
        // result, erasure also produces an async state machine whose
        // builder / SetResult are `AsyncTaskMethodBuilder[object]` and forces a
        // bogus `(Task[T])(object)` reference-cast at the call site — correct
        // for reference `T` but a silent miscompile for a value-type `T`
        // (the boxed result is reinterpreted, not unboxed). A generic closure
        // reifies per instantiation exactly like the SYNC generic-lambda path,
        // so keep the async result symbolic: the FunctionSymbol result stays
        // the unwrapped `T` (threaded into the SM as `Var(idx)`), while the
        // delegate observable return keeps the target `Task`/`Task[T]` wrapper.
        var adapterResultType = adapterReturnType
        var adapterDelegateReturnType = adapterReturnType
        if literal
            .Function
            .IsAsync &&
            targetFunctionType.ReturnType != TypeSymbol.Void &&
            literal
            .Function
            .Type != nil {
            adapterResultType = literal.Function.Type
            adapterDelegateReturnType = targetFunctionType.ReturnType
        }
        // ADR-0102 follow-up / issue #818: preserve the target's variadic
        // flag shape through the erased adapter so call-site dispatch keeps
        // its pack / pass-through semantics.
        let adapterFunctionType = FunctionTypeSymbol.Get(
            adapterParameters.Select((p ParameterSymbol) -> p.Type).ToImmutableArray(),
            targetFunctionType.IsVariadic,
            adapterDelegateReturnType
        )
        let adapterFunction = FunctionSymbol(
            "<lambda_erased${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            adapterParameters.ToImmutable(),
            adapterResultType,
            $package: literal.Function.Package
        )
        adapterFunction.IsAsync = literal.Function.IsAsync
        adapterFunction.IsAsyncVoid = literal.Function.IsAsyncVoid
        adapterFunction.AsyncReturnsValueTask = literal.Function.AsyncReturnsValueTask
        // Issue #2381: propagate the original literal's lexical enclosing
        // type so a capturing adapter is nested inside the SAME user type as
        // the literal it replaces (see the closure-nesting rule in
        // ClosureEmitter.SynthesizeClosures, issue #1335). Without this the
        // adapter's synthesized FunctionSymbol reports a null
        // LexicalEnclosingType, so the emitted closure class falls back to a
        // top-level placement outside the enclosing type's accessibility
        // domain — an adapter that (like the original literal) reads a
        // `private`/`protected` member of that type then produces an
        // unverifiable FieldAccess/MethodAccess IL site.
        adapterFunction.LexicalEnclosingType = literal.Function.LexicalEnclosingType
        var body = cast[BoundBlockStatement](
            ErasedFunctionLiteralAdapterRewriter(
                replacementMap,
                nestedSubstitution,
                adapterResultType
            ).RewriteStatement(literal.Body)
        )
        if adapterPrefix.Count > 0 {
            adapterPrefix.AddRange(body.Statements)
            body = BoundBlockStatement(body.Syntax, adapterPrefix.ToImmutable())
        }
        return BoundFunctionLiteralExpression(
            literal.Syntax,
            adapterFunction,
            adapterFunctionType,
            body,
            literal.CapturedVariables
        )
    }

    /// Builds a thunk when a CLR method group's exact parameter types differ
    /// from its structural function target. This commonly occurs when an
    /// imported named delegate is nested in the method signature: direct
    /// `ldftn/newobj` would pair incompatible signatures, while the thunk
    /// lets ordinary conversion emission adapt each slot.
    /// @param group The resolved CLR method group.
    /// @param targetFunctionType The structural target function type.
    /// @returns The original group for an exact signature; otherwise a synthesized adapter literal.
    func CreateClrMethodGroupAdapter(
        group BoundClrMethodGroupExpression,
        targetFunctionType FunctionTypeSymbol
    ) BoundExpression {
        let method = Invariant.Required(
            group.ResolvedMethod,
            "a CLR method-group adapter has a resolved method",
            expression: "group.ResolvedMethod"
        )
        let methodParameters = ImportedFunctionSymbol.GetLogicalParameters(method, out var hasHiddenContext)
        let methodRefKinds = DelegateRefKindUtilities.GetParameterRefKinds(method)
        let logicalParameterCount = methodParameters.Length
        let closesStaticReceiver = method.IsStatic && group.Receiver != nil
        let parameterOffset = if closesStaticReceiver {
            1
        } else {
            0
        }
        if logicalParameterCount != targetFunctionType.ParameterTypes.Length + parameterOffset {
            return group
        }
        if !hasHiddenContext && methodParameters.Any((parameter ParameterInfo) -> parameter.ParameterType.IsByRef) {
            return group
        }
        var invokeParameters[]ParameterInfo
        var exactSignature = false
        if !hasHiddenContext {
            let invoke MethodInfo? = targetFunctionType.ClrType?.GetMethodSafe("Invoke")
            if invoke == nil {
                return group
            }
            invokeParameters = invoke.GetParameters()
            exactSignature = invoke.ReturnType.IsSameAs(method.ReturnType)
            for var i = 0; exactSignature && i < invokeParameters.Length; i++ {
                exactSignature = invokeParameters[i].ParameterType.IsSameAs(
                    methodParameters[i + parameterOffset].ParameterType
                )
            }
        }
        if exactSignature {
            return group
        }
        let adapterParameters = ImmutableArray.CreateBuilder[ParameterSymbol](targetFunctionType.ParameterTypes.Length)
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](logicalParameterCount)
        let argumentRefKinds = ImmutableArray.CreateBuilder[RefKind](logicalParameterCount)
        var receiverTemp LocalVariableSymbol? = nil
        var adapterReceiver BoundExpression? = group.Receiver
        if group.Receiver != nil {
            receiverTemp = LocalVariableSymbol(
                "<method_group_receiver${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: true,
                group.Receiver.Type
            )
            adapterReceiver = BoundVariableExpression(nil, receiverTemp)
        }
        if closesStaticReceiver {
            let receiverRefKind = methodRefKinds[0]
            arguments.Add(
                BoundConversionExpression(
                    nil,
                    ClrNullability.GetParameterTypeSymbol(methodParameters[0]),
                    Invariant.Required(
                        adapterReceiver,
                        "a closed static method-group adapter has a receiver",
                        expression: "adapterReceiver"
                    )
                )
            )
            argumentRefKinds.Add(receiverRefKind)
        }
        for var i = 0; i < targetFunctionType.ParameterTypes.Length; i++ {
            // BoundNode.Syntax is null by design for a synthesized node -- a
            // method group produced by an earlier rewrite has none -- and
            // ParameterSymbol.declaringSyntax is nullable for exactly that
            // reason, so this passes through rather than asserting.
            let methodParameter = methodParameters[i + parameterOffset]
            let refKind = methodRefKinds[i + parameterOffset]
            let parameter = ParameterSymbol(
                "arg$i",
                targetFunctionType.ParameterTypes[i],
                declaringSyntax: group.Syntax,
                refKind: refKind
            )
            adapterParameters.Add(parameter)
            var argument BoundExpression = BoundVariableExpression(nil, parameter)
            if refKind != RefKind.None {
                argument = BoundAddressOfExpression(nil, argument, unmanaged: false, isReadOnly: refKind == RefKind.In)
            }
            arguments.Add(
                if refKind == RefKind.None {
                    cast[BoundExpression](
                        BoundConversionExpression(nil, ClrNullability.GetParameterTypeSymbol(methodParameter), argument)
                    )
                } else {
                    argument
                }
            )
            argumentRefKinds.Add(refKind)
        }
        let methodReturnType = if method.ReturnType.IsSameAs(typeof(Void)) {
            TypeSymbol.Void
        } else {
            ClrNullability.GetReturnTypeSymbol(method)
        }
        let callArguments = arguments.MoveToImmutable()
        let callRefKinds = argumentRefKinds.MoveToImmutable()
        let call BoundExpression = if method.IsStatic {
            cast[BoundExpression](
                BoundClrStaticCallExpression(nil, method, methodReturnType, callArguments, callRefKinds)
            )
        } else {
            cast[BoundExpression](
                BoundImportedInstanceCallExpression(
                    nil,
                    Invariant.Required(
                        adapterReceiver,
                        "an instance method-group adapter has a receiver",
                        expression: "adapterReceiver"
                    ),
                    method,
                    methodReturnType,
                    callArguments,
                    callRefKinds
                )
            )
        }
        let statement BoundStatement = if methodReturnType == TypeSymbol.Void {
            cast[BoundStatement](
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(nil, call),
                        BoundReturnStatement(nil, nil)
                    )
                )
            )
        } else {
            cast[BoundStatement](
                BoundReturnStatement(nil, BoundConversionExpression(nil, targetFunctionType.ReturnType, call))
            )
        }
        let body = statement as BoundBlockStatement ?? BoundBlockStatement(nil, ImmutableArray.Create(statement))
        let function = FunctionSymbol(
            "<method_group_adapter${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            adapterParameters.MoveToImmutable(),
            targetFunctionType.ReturnType,
            $package: getCurrentFunction()?.Package
        ){LexicalEnclosingType = getCurrentFunction()?.LexicalEnclosingType}
        let captured = CollectCapturedVariables(body, function)
        let adapter BoundExpression = BoundFunctionLiteralExpression(
            group.Syntax,
            function,
            targetFunctionType,
            body,
            captured
        )
        return if receiverTemp == nil {
            adapter
        } else {
            cast[BoundExpression](
                BoundBlockExpression(
                    group.Syntax,
                    ImmutableArray.Create[BoundStatement](
                        BoundVariableDeclaration(group.Syntax, receiverTemp, group.Receiver)
                    ),
                    adapter
                )
            )
        }
    }

    /// Wraps a method group in a capturing lambda when its emitted method
    /// signature cannot be used directly as the delegate target. Suspend
    /// methods with an ADR-0174 hidden context parameter need that parameter
    /// supplied, inferred suspend methods need their post-inference return
    /// shape bridged, and value-type extension receivers cannot be closed over
    /// by the CLR delegate constructor.
    /// @param group Resolved user method group.
    /// @returns The original group when direct delegate construction is valid; otherwise a capturing
    /// adapter.
    func CreateUserMethodGroupAdapter(group BoundMethodGroupExpression) BoundExpression {
        let function = Invariant.Required(
            group.Function,
            "a resolved user method group has a function",
            expression: "group.Function"
        )
        let functionType = Invariant.Required(
            group.FunctionType,
            "a resolved user method group has a function type",
            expression: "group.FunctionType"
        )
        let needsValueTypeExtensionAdapter = function.IsExtension &&
            group.Receiver != nil &&
            ReflectionMetadataEmitter.IsValueTypeSymbol(group.Receiver.Type)
        if function.HiddenContextParameter == nil &&
            function.SuspendingKind != SuspendingKind.Inferred &&
            !needsValueTypeExtensionAdapter {
            return group
        }
        var receiverTemp LocalVariableSymbol? = nil
        var adapterReceiver BoundExpression? = group.Receiver
        if group.Receiver != nil {
            receiverTemp = LocalVariableSymbol(
                "<method_group_receiver${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: true,
                group.Receiver.Type
            )
            adapterReceiver = BoundVariableExpression(nil, receiverTemp)
        }
        let adapterParameters = ImmutableArray.CreateBuilder[ParameterSymbol](functionType.ParameterTypes.Length)
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](
            functionType
                .ParameterTypes
                .Length +
                (
                if function.IsExtension && adapterReceiver != nil {
                    1
                } else {
                    0
                }
            )
        )
        if function.IsExtension && adapterReceiver != nil {
            arguments.Add(adapterReceiver)
        }
        for var i = 0; i < functionType.ParameterTypes.Length; i++ {
            let sourceParameterIndex = i +
                (
                if function.IsExtension && adapterReceiver != nil {
                    1
                } else {
                    0
                }
            )
            let parameter = ParameterSymbol(
                function.Parameters[sourceParameterIndex],
                functionType.ParameterTypes[i],
                declaringSyntax: group.Syntax,
                name: "arg$i"
            )
            adapterParameters.Add(parameter)
            var argument BoundExpression = BoundVariableExpression(nil, parameter)
            if parameter.RefKind != RefKind.None {
                argument = BoundAddressOfExpression(
                    nil,
                    argument,
                    unmanaged: false,
                    isReadOnly: parameter.RefKind == RefKind.In
                )
            }
            arguments.Add(argument)
        }
        let callArguments = arguments.MoveToImmutable()
        var call BoundExpression
        if function.IsExtension || adapterReceiver == nil {
            call = BoundCallExpression(nil, function, callArguments, functionType.ReturnType){
                StaticGenericOwnerType = group.StaticOwnerType,
                MethodTypeArguments = group.MethodTypeArguments
            }
        } else if group.ForceNonVirtualDispatch && function.ReceiverType is StructSymbol baseClass {
            call = BoundBaseClassCallExpression(
                nil,
                adapterReceiver,
                baseClass,
                function,
                callArguments,
                functionType.ReturnType
            ){MethodTypeArguments = group.MethodTypeArguments}
        } else {
            call = BoundUserInstanceCallExpression(
                nil,
                adapterReceiver,
                function,
                callArguments,
                functionType.ReturnType
            ){MethodTypeArguments = group.MethodTypeArguments}
        }
        let statement BoundStatement = if functionType.ReturnType == TypeSymbol.Void {
            cast[BoundStatement](
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(nil, call),
                        BoundReturnStatement(nil, nil)
                    )
                )
            )
        } else {
            cast[BoundStatement](BoundReturnStatement(nil, call))
        }
        let body = statement as BoundBlockStatement ?? BoundBlockStatement(nil, ImmutableArray.Create(statement))
        let adapterFunction = FunctionSymbol(
            "<method_group_adapter${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
            adapterParameters.MoveToImmutable(),
            functionType.ReturnType,
            $package: getCurrentFunction()?.Package
        ){
            LexicalEnclosingType = getCurrentFunction()?.LexicalEnclosingType ?? getCurrentFunction()?.ReceiverType ??
                getCurrentFunction()?.StaticOwnerType
        }
        let captured = CollectCapturedVariables(body, adapterFunction)
        let adapter = BoundFunctionLiteralExpression(group.Syntax, adapterFunction, functionType, body, captured)
        return if receiverTemp == nil {
            cast[BoundExpression](adapter)
        } else {
            cast[BoundExpression](
                BoundBlockExpression(
                    group.Syntax,
                    ImmutableArray.Create[BoundStatement](
                        BoundVariableDeclaration(
                            group.Syntax,
                            receiverTemp,
                            Invariant.Required(
                                group.Receiver,
                                "a method-group receiver temp has an initializer",
                                expression: "group.Receiver"
                            )
                        )
                    ),
                    adapter
                )
            )
        }
    }

    /// For an async lambda's declared return type, computes the
    /// observable return type the synthesized
    /// (cref:FunctionTypeSymbol) must present to the delegate
    /// callers: `void` → `Task`, `T` → `Task<T>`,
    /// and erroring / un-mappable inputs pass through. Mirrors the
    /// top-level-async-function widening so async lambdas behave the
    /// same as their named counterparts (issues #290 / #291 / #530).
    /// @param element The element type (the lambda's declared
    /// return type, or for top-level async functions the method's
    /// return type).
    /// @param useValueTask Issue #1918: when `true`,
    /// widen to `ValueTask` / `ValueTask<T>` instead of
    /// `Task` / `Task<T>` — set for an async function whose
    /// declared return-type clause explicitly spelled the `ValueTask`
    /// wrapper ((cref:FunctionSymbol.AsyncReturnsValueTask)).
    /// @returns The Task-widened type, or
    /// [`element`](paramref) when widening is not possible (e.g.
    /// the BCL `Task` reference is unresolved, or the element is
    /// a user-defined GSharp type — Phase 5.1 / ADR-0023).
    func WrapAsTask(element TypeSymbol, useValueTask bool = false) TypeSymbol {
        let wrapperName = if useValueTask {
            "System.Threading.Tasks.ValueTask"
        } else {
            "System.Threading.Tasks.Task"
        }
        let wrapperOpenName = wrapperName + "`1"
        if element == TypeSymbol.Error {
            return TypeSymbol.Error
        }
        if element == TypeSymbol.Void {
            if Scope.References!!.TryResolveType(wrapperName, out var taskType) {
                return ImportedTypeSymbol.GetWithoutNullability(taskType!!, NullabilityFreeReason.TypeLiteral)
            }
            return element
        }
        // Issues #1785/#2026/#2232/#2381/#2713: use the same symbolic-shape
        // predicate as TupleTypeSymbol. This includes type parameters,
        // same-compilation user types, and nullable-reference annotations
        // whose information cannot be recovered from a CLR Type.
        if TypeSymbol.RequiresSymbolicProjection(element) && Scope.References!!.TryResolveType(
            wrapperOpenName,
            out var symbolicTaskOpen
        ) {
            // Issue #502 / #320: a user-defined async result type has no CLR
            // Type yet, so close Task<T> over an object placeholder for
            // reflection/member lookup while preserving the symbolic result
            // type for emit-time metadata encoding.
            let erasedTask = symbolicTaskOpen!!.MakeGenericType(
                Scope.References!!.MapClrTypeToReferences(typeof(object))!!
            )
            return ImportedTypeSymbol.GetConstructed(erasedTask, symbolicTaskOpen, ImmutableArray.Create(element))
        }
        let clr Type? = element.ClrType
        if clr == nil {
            return element
        }
        if Scope.References!!.TryResolveType(wrapperOpenName, out var taskOpen) {
            // Route the element CLR type through the SAME resolver as Task`1.
            // Under the SDK build path the references are loaded via a
            // MetadataLoadContext, and MakeGenericType requires the type
            // argument to originate from that same context (issues #290 and
            // #291: value-returning async funcs and imported-Task<T> awaits).
            // Issue #530: use ResolveClrTypeForGenericArg so that a nullable
            // value type (e.g. `int32?`) correctly wraps as
            // `Task<Nullable<int>>` rather than `Task<int>`.
            let elementClr = resolveClrTypeForGenericArg(element) ?? Scope.References!!.MapClrTypeToReferences(clr)
            let closed = taskOpen!!.MakeGenericType(elementClr!!)
            // Issue #3746 / ADR-0172: tuple element names are metadata over the
            // positional shape, so `ImportedTypeSymbol.Get(closed)` — which
            // rebuilds its type arguments by reflecting over `closed` — erases
            // them: `async func F() Task[(Output string, Count int32)]`
            // normalizes to the awaited named tuple, is re-widened here, and
            // came back as `Task[(string, int32)]`, making every `await F()
            // .Output` / `F().Result.Output` a GS0158. Unlike the symbolic
            // branch above this keeps the EXACT closed CLR type (the awaiter,
            // the async method builder and the emitted signature all depend on
            // it) and only attaches the name-bearing symbolic argument, which
            // AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType and member
            // lookup read in preference to the reflected one.
            return if TypeSymbol.ContainsNamedTupleElement(element) {
                ImportedTypeSymbol.GetConstructed(closed, taskOpen, ImmutableArray.Create(element))
            } else {
                ImportedTypeSymbol.GetWithoutNullability(closed, NullabilityFreeReason.CompilerProduced)
            }
        }
        return element
    }

    private func CheckAllPathsReturn(body BoundBlockStatement, returnType TypeSymbol, location TextLocation) {
        if returnType != TypeSymbol.Void &&
            returnType != TypeSymbol.Error &&
            !isIteratorReturnType(returnType) &&
            !ControlFlowGraph.AllPathsReturn(Lowerer.Lower(body)) {
            Diagnostics.ReportAllPathsMustReturn(location)
        }
    }

    /// Binds and attaches user annotations on a lambda parameter.
    /// @param syntax The source parameter syntax.
    /// @param parameter The parameter symbol receiving the attributes.
    private func AttachParameterAttributes(syntax ParameterSyntax, parameter ParameterSymbol) {
        let attributes = bindParameterAttributes(syntax)
        if !attributes.IsDefaultOrEmpty {
            parameter.SetAttributes(attributes)
            let annotation BoundAttribute? = attributes.FirstOrDefault(KnownAttributes.IsUnscopedRef)
            if annotation == nil {
                return
            }
            parameter.MarkUnscopedRef()
            let reason string? = DeclarationBinder.GetUnscopedRefParameterRejection(parameter)
            if reason != nil {
                Diagnostics.ReportUnscopedRefInvalidTarget(annotation.Syntax.Location, reason)
            }
        }
    }

    /// Issue #2027: snapshots the enclosing frame's `goto`/label state
    /// ((cref:BinderContext.UserLabels), (cref:BinderContext.DefinedUserLabels),
    /// (cref:BinderContext.UnresolvedGotoLabels)) and its
    /// (cref:BinderContext.LoopStack), then resets all four to a
    /// fresh empty state so a nested function-literal body (a lambda OR a
    /// local function — both bind through (cref:BindFunctionLiteralExpression)
    /// / (cref:BindLambdaExpression)) gets its own isolated goto/label
    /// namespace and loop-label stack, matching ADR-0070's "label namespace
    /// is local to the enclosing function" rule and C#'s prohibition on
    /// cross-frame `goto` flow. Pair with (cref:RestoreNestedFrame).
    ///
    /// Issue #4285: also recomputes
    /// (cref:BinderContext.FunctionContainsUserGotoOrLabel) for
    /// [`bodySyntax`](paramref) — the nested body has its own
    /// goto/label namespace, so whether IT contains a goto/label is a
    /// separate question from whether the ENCLOSING function does, and must
    /// be answered fresh for the narrowing-lift guard in
    /// (cref:StatementBinder.ApplyEarlyExitNarrowings) to apply
    /// correctly while the nested body is bound.
    /// @param bodySyntax The nested function-literal or arrow-lambda body being entered.
    private func EnterNestedFrame(bodySyntax SyntaxNode) NestedFrameState {
        let saved = NestedFrameState(binderCtx, isolateExternalCallableAliases())
        binderCtx.UserLabels.Clear()
        binderCtx.DefinedUserLabels.Clear()
        binderCtx.UnresolvedGotoLabels.Clear()
        binderCtx.PendingGotoAssignmentStarts.Clear()
        binderCtx.AssignmentNarrowingGenerations.Clear()
        this.binderCtx.AssignmentNarrowingGeneration = 0
        binderCtx.PendingGotoNarrowingSnapshots.Clear()
        binderCtx.BackwardGotoNarrowingStates.Clear()
        binderCtx.ReachableUserLabels.Clear()
        binderCtx.DeferredUnreachableGotoEdges.Clear()
        this.binderCtx.PotentialReachabilityLabel = nil
        binderCtx.LoopStack.Clear()
        this.binderCtx.CurrentFallthroughTarget = nil
        this.binderCtx.CurrentFallthroughAnchor = nil
        this.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(bodySyntax)
        return saved
    }

    /// Issue #2027: reports GS0469 for any `goto` in the just-bound
    /// nested frame that targets a label never declared inside that SAME
    /// frame — the (cref:StatementBinder.FinalizeUserLabels)
    /// equivalent for a lambda / local-function body. Must run before
    /// (cref:RestoreNestedFrame) restores the outer label state, so a
    /// nested-frame goto is checked only against the nested frame's own
    /// labels (never silently satisfied by an outer label of the same
    /// name).
    private func FinalizeNestedFrameLabels() {
        reportUnsafeBackwardGotoNarrowings()
        for entry in binderCtx.UnresolvedGotoLabels {
            Diagnostics.ReportUndefinedGotoLabel(entry.Value, entry.Key)
        }
        binderCtx.UnresolvedGotoLabels.Clear()
    }

    /// Issue #2027: restores the enclosing frame's goto/label state and
    /// loop stack captured by (cref:EnterNestedFrame), undoing the
    /// isolation so the enclosing function's own goto/label resolution
    /// continues exactly as if the nested body had never been bound.
    private func RestoreNestedFrame(saved NestedFrameState) {
        binderCtx.UserLabels.Clear()
        for kvp in saved.UserLabels {
            binderCtx.UserLabels[kvp.Key] = kvp.Value
        }
        binderCtx.DefinedUserLabels.Clear()
        for name in saved.DefinedUserLabels {
            binderCtx.DefinedUserLabels.Add(name)
        }
        binderCtx.UnresolvedGotoLabels.Clear()
        for kvp in saved.UnresolvedGotoLabels {
            binderCtx.UnresolvedGotoLabels[kvp.Key] = kvp.Value
        }
        binderCtx.PendingGotoAssignmentStarts.Clear()
        for kvp in saved.PendingGotoAssignmentStarts {
            binderCtx.PendingGotoAssignmentStarts[kvp.Key] = kvp.Value
        }
        binderCtx.AssignmentNarrowingGenerations.Clear()
        for kvp in saved.AssignmentNarrowingGenerations {
            binderCtx.AssignmentNarrowingGenerations[kvp.Key] = kvp.Value
        }
        this.binderCtx.AssignmentNarrowingGeneration = saved.AssignmentNarrowingGeneration
        binderCtx.PendingGotoNarrowingSnapshots.Clear()
        for kvp in saved.PendingGotoNarrowingSnapshots {
            binderCtx.PendingGotoNarrowingSnapshots[kvp.Key] = kvp
                .Value
                .Select((snapshot GotoNarrowingSnapshot) -> snapshot.Clone())
                .ToList()
        }
        binderCtx.BackwardGotoNarrowingStates.Clear()
        for kvp in saved.BackwardGotoNarrowingStates {
            binderCtx.BackwardGotoNarrowingStates[kvp.Key] = kvp.Value.Clone()
        }
        binderCtx.ReachableUserLabels.Clear()
        binderCtx.ReachableUserLabels.UnionWith(saved.ReachableUserLabels)
        binderCtx.DeferredUnreachableGotoEdges.Clear()
        binderCtx.DeferredUnreachableGotoEdges.AddRange(saved.DeferredUnreachableGotoEdges)
        this.binderCtx.PotentialReachabilityLabel = saved.PotentialReachabilityLabel
        // BinderContext.LoopStack.ToArray() orders elements top-of-stack
        // first; push back bottom-first so the restored stack's top matches
        // the snapshot exactly.
        binderCtx.LoopStack.Clear()
        for var i = saved.LoopStack.Length - 1; i >= 0; i-- {
            binderCtx.LoopStack.Push(saved.LoopStack[i])
        }
        this.binderCtx.CurrentFallthroughTarget = saved.FallthroughTarget
        this.binderCtx.CurrentFallthroughAnchor = saved.FallthroughAnchor
        restoreExternalCallableAliases(saved.ExternalCallableAliases)
        // Issue #4285: restore the ENCLOSING function's goto/label flag now
        // that the nested body's own bind session (and its own guard checks
        // in ApplyEarlyExitNarrowings) has finished.
        this.binderCtx.FunctionContainsUserGotoOrLabel = saved.FunctionContainsUserGotoOrLabel
    }

    // Issue #893: rewrite a value-returning function-literal block body so a bare
    // trailing expression statement becomes the implicit `return` value. This is
    // the multi-statement-block analogue of the arrow-lambda EmitTrailingExpression
    // path: `func(c T) R { ...; <expr> }` returns `<expr>` converted to `R`.
    //
    // Only applies when the declared return type is a real value type (not void and
    // not the error placeholder) and the last statement is a non-void expression
    // statement that is not already a return. Void function literals are left as-is
    // so the issue #889 statement-body / Action-delegate path keeps emitting a body
    // with no value return.
    private func SynthesizeFunctionLiteralTrailingReturn(
        body BoundBlockStatement,
        syntax FunctionLiteralExpressionSyntax,
        returnType TypeSymbol
    ) BoundBlockStatement {
        if returnType == TypeSymbol.Void || returnType == TypeSymbol.Error {
            return body
        }
        let statements = body.Statements
        if statements.Length == 0 {
            return body
        }
        if statements[^1] is not BoundExpressionStatement trailingStatement {
            return body
        }
        let trailing = trailingStatement.Expression
        if trailing.Type == TypeSymbol.Void || trailing.Type == TypeSymbol.Error {
            return body
        }
        let trailingConverted = if trailing.Type == returnType {
            trailing
        } else {
            conversions.BindConversion(
                Invariant.Required(
                    trailingStatement.Syntax,
                    "a bound trailing expression statement has syntax",
                    expression: "trailingStatement.Syntax"
                )
                    .Location,
                trailing,
                returnType
            )
        }
        let rewritten = statements.ToBuilder()
        rewritten[^1] = BoundReturnStatement(trailingStatement.Syntax, trailingConverted)
        return BoundBlockStatement(body.Syntax, rewritten.ToImmutable())
    }

    // ADR-0076 / issue #716: synthesise the trailing return / expression-
    // statement for an arrow-lambda body. For a void- or error-typed lambda
    // we keep the body as an ExpressionStatement and (for void) follow it
    // with a `return;`; for a value-returning lambda we wrap the trailing
    // expression in a `return` statement after applying a final conversion
    // to the inferred return type.
    private func EmitTrailingExpression(
        bodyStatements ImmutableArray[BoundStatement].Builder,
        syntax LambdaExpressionSyntax,
        trailing BoundExpression,
        returnType TypeSymbol
    ) {
        // Special-case the synthetic void placeholder that BindLambdaBodyExpression
        // injects when a block body lacks a trailing expression: it carries no
        // observable value and the body has already terminated via explicit
        // `return` statements, so emitting (or converting) it is redundant.
        let isVoidPlaceholder = trailing is BoundLiteralExpression{Type: var voidLitType} &&
            voidLitType == TypeSymbol.Void
        if isVoidPlaceholder {
            if returnType == TypeSymbol.Void {
                bodyStatements.Add(BoundReturnStatement(syntax.Body, expression: nil))
            }
            return
        }
        if returnType == TypeSymbol.Void || returnType == TypeSymbol.Error {
            bodyStatements.Add(BoundExpressionStatement(syntax.Body, trailing))
            if returnType == TypeSymbol.Void {
                bodyStatements.Add(BoundReturnStatement(syntax.Body, expression: nil))
            }
            return
        }
        let trailingConverted = if trailing.Type == returnType {
            trailing
        } else {
            conversions.BindConversion(syntax.Body.Location, trailing, returnType)
        }
        bodyStatements.Add(BoundReturnStatement(syntax.Body, trailingConverted))
    }

    /// ADR-0101 / issue #812 — variadic structural validation for lambda
    /// parameter lists. Mirrors
    /// `DeclarationBinder.ValidateVariadicParameterShape`: emits GS0145
    /// for a non-trailing variadic, GS0364 for two-or-more variadic
    /// parameters in the same lambda.
    private func ValidateVariadicParameterShape(
        parameters GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ParameterSyntax]
    ) {
        var firstVariadicSeen = false
        for var i = 0; i < parameters.Count; i++ {
            if !parameters[i].IsVariadic {
                continue
            }
            // ADR-0185: a destructured parameter's IsVariadic is always
            // false (no ellipsis token), so the `continue` above already
            // skipped it — Identifier is non-null on every path reaching here.
            if firstVariadicSeen {
                Diagnostics.ReportMultipleVariadicParameters(
                    parameters[i].Location,
                    parameters[i].Identifier!!.ValueText
                )
            }
            firstVariadicSeen = true
            if i < parameters.Count - 1 {
                Diagnostics.ReportVariadicParameterMustBeLast(
                    parameters[i].Location,
                    parameters[i].Identifier!!.ValueText
                )
            }
        }
    }

    // ADR-0076 / issue #716: rewrites a bound lambda body so each return
    // statement's expression is converted to the inferred return type. The
    // rewrite is a single pass and stops at nested function literals
    // (BoundTreeRewriter's default RewriteFunctionLiteralExpression keeps
    // the nested body opaque).
    /// Issue #5569: binds a speculative literal with its natural type after the target bind failed before its
    /// body bound (a parameter count or an explicit parameter type that the target does not accept). The body
    /// binds once.
    /// @param syntax The function literal.
    /// @param targetDiagnostics The diagnostics of the failed target bind.
    /// @param acceptsNaturalType Whether another candidate accepts the natural function type.
    /// @param discardedTargetDiagnostics Receives the target diagnostics when the natural type is kept.
    /// @param natural The natural literal, on success.
    /// @returns `true` when the literal keeps its natural type.
    private func TryBindNaturalFallback(
        syntax LambdaExpressionSyntax,
        targetDiagnostics ImmutableArray[Diagnostic],
        acceptsNaturalType(TypeSymbol) -> bool,
        discardedTargetDiagnostics List[ImmutableArray[Diagnostic]]?,
        @NotNullWhen(true) out natural BoundExpression?
    ) bool {
        let mark = Diagnostics.Count
        let bound = BindLambdaExpression(syntax)
        if !(bound is BoundErrorExpression) && !Diagnostics.Skip(mark).Any(
            (diagnostic Diagnostic) -> diagnostic.IsError
        ) &&
            acceptsNaturalType(bound.Type) {
            discardedTargetDiagnostics?.Add(targetDiagnostics)
            natural = bound
            return true
        }
        Diagnostics.TruncateTo(mark)
        natural = nil
        return false
    }

    /// Issue #5569: the target-typed return values of a speculative literal body whose target typing failed.
    /// Each such return statement binds its value again with the natural type, so the body can give either
    /// function type after one bind of its statements.
    internal class DeferredReturnState {
        /// Gets or sets a value indicating whether a return value binds its target-typed pass now. A return
        /// nested in it binds with the target type only.
        internal prop InTargetPass bool

        /// Gets or sets a value indicating whether a return value binds its natural pass now. A return nested in it
        /// binds with its natural type only.
        internal prop InNaturalPass bool

        private let operands List[
            (
                Value BoundExpression,
                Diagnostics ImmutableArray[Diagnostic],
                NaturalDiagnostics ImmutableArray[Diagnostic]
            )
        ] = List[
            (
                Value BoundExpression,
                Diagnostics ImmutableArray[Diagnostic],
                NaturalDiagnostics ImmutableArray[Diagnostic]
            )
        ]()

        // The target-typed value of each held return statement, by syntax identity.
        private let targetValues Dictionary[ReturnStatementSyntax, BoundExpression] = Dictionary[
            ReturnStatementSyntax,
            BoundExpression
        ](ReferenceEqualityComparer.Instance)

        /// Records the target-typed value of a return statement and the diagnostics of both passes.
        /// @param syntax The return statement.
        /// @param value The target-typed value.
        /// @param diagnostics The diagnostics of the target pass.
        /// @param naturalDiagnostics The diagnostics of the natural pass.
        internal func Hold(
            syntax ReturnStatementSyntax,
            value BoundExpression,
            diagnostics ImmutableArray[Diagnostic],
            naturalDiagnostics ImmutableArray[Diagnostic]
        ) {
            operands.Add((value, diagnostics, naturalDiagnostics))
            targetValues[syntax] = value
        }

        /// Gets the diagnostics of every held target pass, in source order.
        /// @returns The diagnostics.
        internal func OperandDiagnostics() ImmutableArray[Diagnostic] {
            let builder = ImmutableArray.CreateBuilder[Diagnostic]()
            for operand in operands {
                builder.AddRange(operand.Diagnostics)
            }
            return builder.ToImmutable()
        }

        /// Gets the diagnostics of every held natural pass, in source order.
        /// @returns The diagnostics.
        internal func NaturalDiagnostics() ImmutableArray[Diagnostic] {
            let builder = ImmutableArray.CreateBuilder[Diagnostic]()
            for operand in operands {
                builder.AddRange(operand.NaturalDiagnostics)
            }
            return builder.ToImmutable()
        }

        /// Puts the held target-typed values back into a bound body.
        /// @param body The bound body with the natural values.
        /// @returns The body with the target-typed values.
        internal func WithTargetOperands(body BoundExpression) BoundExpression {
            if operands.Count == 0 {
                return body
            }
            let rewriter = TargetOperandRewriter(targetValues)
            if body is BoundBlockExpression block {
                let statements = ImmutableArray.CreateBuilder[BoundStatement](block.Statements.Length)
                for statement in block.Statements {
                    statements.Add(rewriter.RewriteStatement(statement))
                }
                return BoundBlockExpression(
                    block.Syntax,
                    statements.ToImmutable(),
                    rewriter.RewriteTail(block.Expression)
                )
            }
            return rewriter.RewriteTail(body)
        }

        private class TargetOperandRewriter : BoundTreeRewriter {
            private let targetValues Dictionary[ReturnStatementSyntax, BoundExpression]

            init(targetValues Dictionary[ReturnStatementSyntax, BoundExpression]) {
                this.targetValues = targetValues
            }

            internal func RewriteTail(node BoundExpression) BoundExpression -> RewriteExpression(node)

            protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
                if node.Syntax is ReturnStatementSyntax returnSyntax && targetValues.TryGetValue(
                    returnSyntax,
                    out var value
                ) {
                    return BoundReturnStatement(node.Syntax, value, node.IsRef)
                }
                return base.RewriteReturnStatement(node)
            }
        }
    }

    private func ApplyInferredReturnTypeConversion(
        boundBody BoundExpression,
        syntax LambdaExpressionSyntax,
        returnType TypeSymbol,
        atReturnValue bool = false
    ) BoundExpression {
        if returnType == TypeSymbol.Error {
            return boundBody
        }
        let rewriter = ReturnConversionRewriter(
            conversions,
            syntax,
            returnType,
            if atReturnValue {
                Diagnostics
            } else {
                default(DiagnosticBag?)
            }
        )
        if boundBody is BoundBlockExpression block {
            let newStatements = ImmutableArray.CreateBuilder[BoundStatement](block.Statements.Length)
            for stmt in block.Statements {
                newStatements.Add(rewriter.RewriteStatement(stmt))
            }
            // Issue #4965 (ADR-0202): returns inside the tail (see
            // InferLambdaReturnType) get the same conversion.
            return BoundBlockExpression(
                block.Syntax,
                newStatements.ToImmutable(),
                RewriteTailReturns(rewriter, block.Expression)
            )
        }
        return RewriteTailReturns(rewriter, boundBody)
    }

    // Issue #4965 (ADR-0202): converts the returns inside a lambda body's
    // trailing value, leaving a tail that contains none untouched.
    private func RewriteTailReturns(rewriter ReturnConversionRewriter, tail BoundExpression) BoundExpression {
        let collector = ReturnTypeCollector()
        collector.Visit(tail)
        return if collector.ReturnTypes.Count == 0 {
            tail
        } else {
            rewriter.RewriteTail(tail)
        }
    }

    private func CollectCapturedVariables(body BoundStatement, function FunctionSymbol) ImmutableArray[VariableSymbol] {
        let paramSet = HashSet[VariableSymbol](function.Parameters)
        let seen = HashSet[VariableSymbol]()
        let captured = ImmutableArray.CreateBuilder[VariableSymbol]()
        // Issue #1451: pre-seed the collector's `declared` set with every inline
        // `out var x` local declared *in this body*. Loop lowering (while/for/do)
        // emits the loop body before the controlling condition, so the out-var's
        // reads can be walked before its declaration; a single in-order pass would
        // then misclassify the out-var as an enclosing-scope capture. Gathering the
        // declarations up front removes that order dependency. The pre-pass is a
        // BoundTreeWalker, so it is opaque at nested function literals — out-vars
        // declared by a nested lambda stay in that lambda's scope.
        let outVarCollector = InlineOutVarDeclarationCollector()
        outVarCollector.RewriteStatement(body)
        // Issue #4221: fold in the already-known captures of any local
        // function this body calls directly (see localFunctionCapturedVariables).
        let collector = CapturedVariableCollector(
            paramSet,
            seen,
            captured,
            outVarCollector.Declared,
            localFunctionCapturedVariables
        )
        collector.RewriteStatement(body)
        let result = captured.ToImmutable()
        localFunctionCapturedVariables[function] = result
        return result
    }

    /// Issue #2027: immutable snapshot of the four pieces of
    /// (cref:BinderContext) state that must be per-frame — taken by
    /// (cref:EnterNestedFrame) and consumed by
    /// (cref:RestoreNestedFrame).
    private struct NestedFrameState {
        init(ctx BinderContext, externalCallableAliases HashSet[VariableSymbol]) {
            UserLabels = Dictionary[string, BoundLabel](ctx.UserLabels)
            DefinedUserLabels = HashSet[string](ctx.DefinedUserLabels)
            UnresolvedGotoLabels = Dictionary[string, TextLocation](ctx.UnresolvedGotoLabels)
            PendingGotoAssignmentStarts = Dictionary[string, int32](ctx.PendingGotoAssignmentStarts)
            AssignmentNarrowingGenerations = Dictionary[VariableSymbol, int32](ctx.AssignmentNarrowingGenerations)
            AssignmentNarrowingGeneration = ctx.AssignmentNarrowingGeneration
            PendingGotoNarrowingSnapshots = ctx.PendingGotoNarrowingSnapshots.ToDictionary(
                (entry KeyValuePair[string, List[GotoNarrowingSnapshot]]) -> entry.Key,
                (entry KeyValuePair[string, List[GotoNarrowingSnapshot]]) -> entry
                    .Value
                    .Select((snapshot GotoNarrowingSnapshot) -> snapshot.Clone())
                    .ToList()
            )
            BackwardGotoNarrowingStates = ctx.BackwardGotoNarrowingStates.ToDictionary(
                (entry KeyValuePair[string, BackwardGotoNarrowingState]) -> entry.Key,
                (entry KeyValuePair[string, BackwardGotoNarrowingState]) -> entry.Value.Clone()
            )
            ReachableUserLabels = HashSet[string](ctx.ReachableUserLabels)
            DeferredUnreachableGotoEdges = ctx
                .DeferredUnreachableGotoEdges
                .Select(
                (edge(SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot)) -> (
                    edge.SourceLabel,
                    edge.TargetLabel,
                    edge.Snapshot.Clone()
                )
            )
                .ToList()
            PotentialReachabilityLabel = ctx.PotentialReachabilityLabel
            LoopStack = ctx.LoopStack.ToArray()
            FallthroughTarget = ctx.CurrentFallthroughTarget
            FallthroughAnchor = ctx.CurrentFallthroughAnchor
            ExternalCallableAliases = HashSet[VariableSymbol](externalCallableAliases)
            FunctionContainsUserGotoOrLabel = ctx.FunctionContainsUserGotoOrLabel
        }

        prop UserLabels Dictionary[string, BoundLabel] {
            get;
        }

        prop DefinedUserLabels HashSet[string] {
            get;
        }

        prop UnresolvedGotoLabels Dictionary[string, TextLocation] {
            get;
        }

        prop PendingGotoAssignmentStarts Dictionary[string, int32] {
            get;
        }

        prop AssignmentNarrowingGenerations Dictionary[VariableSymbol, int32] {
            get;
        }

        prop AssignmentNarrowingGeneration int32 {
            get;
        }

        prop PendingGotoNarrowingSnapshots Dictionary[string, List[GotoNarrowingSnapshot]] {
            get;
        }

        prop BackwardGotoNarrowingStates Dictionary[string, BackwardGotoNarrowingState] {
            get;
        }

        prop ReachableUserLabels HashSet[string] {
            get;
        }

        prop DeferredUnreachableGotoEdges List[
            (SourceLabel string?, TargetLabel string, Snapshot GotoNarrowingSnapshot)
        ] {
            get;
        }

        prop PotentialReachabilityLabel string? {
            get;
        }

        prop LoopStack[](LabelName string?, BreakLabel BoundLabel, ContinueLabel BoundLabel?) {
            get;
        }

        // Issue #3501 A3: a lambda body inside a switch arm must not see the
        // enclosing arm's fallthrough context — same isolation as LoopStack.
        prop FallthroughTarget BoundLabel? {
            get;
        }

        prop FallthroughAnchor StatementSyntax? {
            get;
        }

        prop ExternalCallableAliases HashSet[VariableSymbol] {
            get;
        }

        // Issue #4285.
        prop FunctionContainsUserGotoOrLabel bool {
            get;
        }
    }

    // Issue #1451: collects the locals declared by inline `out var`/`out let`
    // arguments (`BoundAddressOfExpression(BoundVariableExpression(local))` where
    // the local's declaring syntax is an inline RefArgumentExpressionSyntax) within
    // a single body. Implemented as a BoundTreeRewriter (not a walker) only so it
    // shares the FunctionLiteral-opaque traversal; it never mutates the tree.
    private class InlineOutVarDeclarationCollector : BoundTreeRewriter {
        init() {
            Declared = HashSet[VariableSymbol]()
        }

        prop Declared HashSet[VariableSymbol] {
            get;
        }

        protected override func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
            if node.Operand is BoundVariableExpression outVarExpr &&
                (outVarExpr.Variable.DeclaringSyntax is RefArgumentExpressionSyntax and {IsInlineDeclaration: true}) {
                this.Declared.Add(outVarExpr.Variable)
            }
            return base.RewriteAddressOfExpression(node)
        }

        // Issue #3501: a `while value is T binding { … }` condition declares
        // its pattern binding with no BoundVariableDeclaration, and the
        // loop's bound shape places the BODY before the controlling
        // condition — the same order dependency as the inline out-var above.
        // A single in-order pass walks the binding's reads first and
        // misclassifies them as enclosing-scope captures (GS9998 "no local
        // slot" at emit), so pattern bindings are pre-seeded here too.
        protected override func RewritePattern(node BoundPattern) BoundPattern {
            switch node {
                case BoundDiscardPattern{Variable: not nil} varPattern {
                    this.Declared.Add(varPattern.Variable!!)
                }
                case BoundTypePattern{Variable: not nil} typePattern {
                    this.Declared.Add(typePattern.Variable)
                }
                case BoundSlicePattern{Variable: not nil} slicePattern {
                    this.Declared.Add(slicePattern.Variable!!)
                }
            }
            return base.RewritePattern(node)
        }
    }

    // ADR-0076 / issue #716: walks a bound block-expression body collecting
    // the types of each `return` statement's expression. Stops at nested
    // function literals (the body is a separate lexical scope) — the
    // BoundTreeWalker base already treats BoundNodeKind.FunctionLiteralExpression
    // as opaque, so nested lambdas' inner returns do not leak into the
    // outer lambda's candidate set.
    private class ReturnTypeCollector : BoundTreeWalker {
        init() {
            ReturnTypes = List[TypeSymbol]()
        }

        prop ReturnTypes List[TypeSymbol] {
            get;
        }

        protected override func VisitReturnStatement(node BoundReturnStatement) {
            if node.Expression != nil {
                ReturnTypes.Add(node.Expression.Type ?? TypeSymbol.Void)
                // Issue #4965 (ADR-0202): the operand can itself hold a
                // `return` (`return if c { return a } else { b }`).
                VisitExpression(node.Expression)
            } else {
                ReturnTypes.Add(TypeSymbol.Void)
            }
        }
    }

    // ADR-0076 / issue #716: a thin BoundTreeRewriter that applies the
    // inferred return-type conversion to every return-statement expression
    // it encounters, without descending into nested function literals.
    private class ReturnConversionRewriter : BoundTreeRewriter {
        private let conversions ConversionClassifier
        private let syntax LambdaExpressionSyntax
        private let returnType TypeSymbol
        // Issue #5569: set for a deferred target conversion, which reports as the return statement does.
        private let deferredDiagnostics DiagnosticBag?

        init(
            conversions ConversionClassifier,
            syntax LambdaExpressionSyntax,
            returnType TypeSymbol,
            deferredDiagnostics DiagnosticBag?
        ) {
            this.conversions = conversions
            this.syntax = syntax
            this.returnType = returnType
            this.deferredDiagnostics = deferredDiagnostics
        }

        /// Rewrites the returns inside a lambda body's trailing value.
        /// @param node The trailing value.
        /// @returns The rewritten value.
        internal func RewriteTail(node BoundExpression) BoundExpression -> RewriteExpression(node)

        protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
            // Read once into a local: `TypeSymbol.Void` below is a static access (ADR-0208, #5520) that ends the
            // narrowing of the member path `node.Expression`.
            let value = node.Expression
            if value == nil {
                let missingValueDiagnostics = deferredDiagnostics
                if missingValueDiagnostics != nil &&
                    returnType != TypeSymbol.Void &&
                    node.Syntax is ReturnStatementSyntax bareReturn {
                    missingValueDiagnostics.ReportMissingReturnExpression(bareReturn.ReturnKeyword.Location, returnType)
                }
                return node
            }
            // Void return type: a `return expr` carrying a value is invalid;
            // the void inference came from a body with no value-bearing
            // returns. Leave the node untouched so cascading shape checks
            // surface elsewhere.
            if returnType == TypeSymbol.Void {
                return node
            }
            // Issue #4965 (ADR-0202): convert any `return` nested inside the
            // operand first (`return if c { return a } else { b }`).
            let operand = RewriteExpression(value)
            if operand.Type == returnType {
                return if object.ReferenceEquals(operand, value) {
                    cast[BoundStatement](node)
                } else {
                    cast[BoundStatement](BoundReturnStatement(node.Syntax, operand, node.IsRef))
                }
            }
            // Issue #5569: a deferred target conversion reports at the return value, as the return statement does.
            let returnValue = if deferredDiagnostics != nil {
                (node.Syntax as ReturnStatementSyntax)?.Expression
            } else {
                default(ExpressionSyntax?)
            }
            let location = returnValue?.Location ?? node.Syntax?.Location ?? syntax.Body.Location
            let converted = conversions.BindConversion(location, operand, returnType)
            return BoundReturnStatement(node.Syntax, converted, node.IsRef)
        }
    }

    /// Issue #2861: collects the variables captured by function literals nested
    /// inside a body. (cref:BoundTreeRewriter) treats a literal as a leaf,
    /// so this walker descends explicitly to reach literals-in-literals.
    private class NestedCaptureCollector : BoundTreeRewriter {
        private let sink HashSet[VariableSymbol]

        init(sink HashSet[VariableSymbol]) {
            this.sink = sink
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            for captured in node.CapturedVariables {
                this.sink.Add(captured)
            }
            this.RewriteStatement(node.Body)
            return node
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            this.RewriteFunctionLiteralExpression(node.Literal)
            return node
        }
    }

    /// Issue #4221 follow-up: collects every (cref:BoundFunctionLiteralExpression)
    /// reachable from a body, including a literal nested inside another
    /// literal at any depth, into a flat list (as opposed to
    /// (cref:NestedCaptureCollector), which flattens their already-
    /// cached `CapturedVariables` instead of the node references
    /// themselves). Used by (cref:ReconcileGenericLocalFunctionGroupCaptures)
    /// to find every literal whose captured-variable set may need
    /// refreshing — not just a generic local-function group's own top-level
    /// members, but a plain or generic local function declared inside one of
    /// their bodies that itself calls a sibling.
    private class NestedFunctionLiteralCollector : BoundTreeRewriter {
        private let sink List[BoundFunctionLiteralExpression]

        init(sink List[BoundFunctionLiteralExpression]) {
            this.sink = sink
        }

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            this.sink.Add(node)
            this.RewriteStatement(node.Body)
            return node
        }

        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            this.RewriteFunctionLiteralExpression(node.Literal)
            return node
        }
    }

    /// Issue #2861: replaces variable references inside a nested function
    /// literal — body reads/writes and the literal's own
    /// (cref:BoundFunctionLiteralExpression.CapturedVariables) list —
    /// when the erased adapter re-homed the captured parameter onto a
    /// converted local declared in the adapter's prologue.
    private class NestedCaptureSubstitutionRewriter : BoundTreeRewriter {
        private let substitution Dictionary[VariableSymbol, VariableSymbol]

        private init(substitution Dictionary[VariableSymbol, VariableSymbol]) {
            this.substitution = substitution
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            let body = cast[BoundBlockStatement](this.RewriteStatement(node.Body))
            let captured = node.CapturedVariables
            var builder ImmutableArray[VariableSymbol].Builder? = nil
            for var i = 0; i < captured.Length; i++ {
                if !this.substitution.TryGetValue(captured[i], out var replacement) {
                    builder?.Add(captured[i])
                    continue
                }
                if builder == nil {
                    builder = ImmutableArray.CreateBuilder[VariableSymbol](captured.Length)
                    for var j = 0; j < i; j++ {
                        builder.Add(captured[j])
                    }
                }
                builder.Add(replacement)
            }
            if builder == nil && object.ReferenceEquals(body, node.Body) {
                return node
            }
            return BoundFunctionLiteralExpression(
                node.Syntax,
                node.Function,
                node.FunctionType,
                body,
                builder?.ToImmutable() ?? captured
            )
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            let rewritten = cast[BoundFunctionLiteralExpression](this.RewriteFunctionLiteralExpression(node.Literal))
            return if object.ReferenceEquals(rewritten, node.Literal) {
                node
            } else {
                BoundLocalFunctionDeclaration(node.Syntax, rewritten)
            }
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            return if this.substitution.TryGetValue(node.Variable, out var replacement) {
                BoundVariableExpression(node.Syntax, replacement)
            } else {
                node
            }
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            let rewritten = cast[BoundAssignmentExpression](base.RewriteAssignmentExpression(node))
            return if this.substitution.TryGetValue(rewritten.Variable, out var replacement) {
                BoundAssignmentExpression(rewritten.Syntax, replacement, rewritten.Expression)
            } else {
                rewritten
            }
        }

        // GSA0005: The rebuild is reached only after `fieldAssignment.Receiver == null`
        // returns, so this is the variable-receiver form: InterfaceType and
        // ReceiverExpression are null on this path and cannot be dropped.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            let rewritten = base.RewriteFieldAssignmentExpression(node)
            if rewritten is not BoundFieldAssignmentExpression fieldAssignment ||
                fieldAssignment.Receiver == nil ||
                !this
                .substitution
                .TryGetValue(fieldAssignment.Receiver, out var replacement) {
                return rewritten
            }
            return BoundFieldAssignmentExpression(
                fieldAssignment.Syntax,
                replacement,
                Invariant.Required(
                    fieldAssignment.StructType,
                    "a variable field assignment has a struct type",
                    expression: "fieldAssignment.StructType"
                ),
                fieldAssignment.Field,
                fieldAssignment.Value,
                fieldAssignment.ResultType
            )
        }

        // GSA0005: The rebuild is reached only after `indexAssignment.Target == null`
        // returns, so this is the variable-target form and TargetExpression is
        // null on this path.
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
            let rewritten = base.RewriteIndexAssignmentExpression(node)
            if rewritten is not BoundIndexAssignmentExpression indexAssignment ||
                indexAssignment.Target == nil ||
                !this
                .substitution
                .TryGetValue(indexAssignment.Target, out var replacement) {
                return rewritten
            }
            return BoundIndexAssignmentExpression(
                indexAssignment.Syntax,
                replacement,
                indexAssignment.Indices,
                indexAssignment.Value,
                indexAssignment.Type
            )
        }

        shared {
            func Rewrite(
                literal BoundFunctionLiteralExpression,
                substitution Dictionary[VariableSymbol, VariableSymbol]
            ) BoundFunctionLiteralExpression {
                return cast[BoundFunctionLiteralExpression](
                    NestedCaptureSubstitutionRewriter(substitution).RewriteFunctionLiteralExpression(literal)
                )
            }
        }
    }

    private class ErasedFunctionLiteralAdapterRewriter : BoundTreeRewriter {
        private let replacementMap Dictionary[VariableSymbol, BoundExpression]
        private let nestedSubstitution Dictionary[VariableSymbol, VariableSymbol]
        private let adapterReturnType TypeSymbol

        init(
            replacementMap Dictionary[VariableSymbol, BoundExpression],
            nestedSubstitution Dictionary[VariableSymbol, VariableSymbol],
            adapterReturnType TypeSymbol
        ) {
            this.replacementMap = replacementMap
            this.nestedSubstitution = nestedSubstitution
            this.adapterReturnType = adapterReturnType
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            return if this.replacementMap.TryGetValue(node.Variable, out var replacement) {
                replacement
            } else {
                cast[BoundExpression](node)
            }
        }

        protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
            if node.TargetExpression != nil {
                return base.RewriteIndexAssignmentExpression(node)
            }
            let rewritten = cast[BoundIndexAssignmentExpression](base.RewriteIndexAssignmentExpression(node))
            // Array stores read their target from a raw symbol, not a variable-expression child.
            if rewritten.Target is {} target && this.replacementMap.TryGetValue(target, out var replacement) {
                return BoundIndexAssignmentExpression.WithExpressionTarget(
                    rewritten.Syntax,
                    replacement,
                    rewritten.Indices,
                    rewritten.Value,
                    rewritten.Type
                )
            }
            return rewritten
        }

        // Issue #2861: BoundTreeRewriter treats a function literal as a leaf,
        // so a nested lambda keeps reading — and keeps listing in its
        // CapturedVariables — the ORIGINAL parameter symbol that the adapter
        // replaced. The adapter method has no slot for that symbol, so emit
        // fails with GS9998 "has no local slot or parameter index in the
        // current method". Rewrite the nested literal against the converted
        // locals the adapter prologue declares for exactly these captures.
        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            return if this.nestedSubstitution.Count == 0 {
                node
            } else {
                NestedCaptureSubstitutionRewriter.Rewrite(node, this.nestedSubstitution)
            }
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteLocalFunctionDeclaration(node BoundLocalFunctionDeclaration) BoundStatement {
            if this.nestedSubstitution.Count == 0 {
                return node
            }
            let rewritten = NestedCaptureSubstitutionRewriter.Rewrite(node.Literal, this.nestedSubstitution)
            return if object.ReferenceEquals(rewritten, node.Literal) {
                node
            } else {
                BoundLocalFunctionDeclaration(node.Syntax, rewritten)
            }
        }

        // GSA0005: IsRef is dropped deliberately: both rebuilds erase the return
        // -- one to a bare `return;` for a void adapter, the other through a
        // conversion to the adapter's return type -- and neither can return by
        // reference.
        @SuppressDiagnostic("GSA0005")
        protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
            let rewritten = cast[BoundReturnStatement](base.RewriteReturnStatement(node))
            if rewritten.Expression == nil {
                return rewritten
            }
            // Issue #889: when the adapter erases a value-returning literal to a
            // void-returning delegate (e.g. a `func`/arrow literal flowing into
            // System.Action), the inner `return <value>;` must drop its value:
            // evaluate the expression for its side effects, then `return;`. A
            // bare `return <value>;` against a void method is invalid IL.
            if this.adapterReturnType == TypeSymbol.Void {
                return BoundBlockStatement(
                    rewritten.Syntax,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(rewritten.Syntax, rewritten.Expression),
                        BoundReturnStatement(rewritten.Syntax, expression: nil)
                    )
                )
            }
            // A bottom-typed return never reaches the target slot.
            if rewritten.Expression!!.Type == this.adapterReturnType ||
                rewritten.Expression!!.Type == TypeSymbol.Never {
                return rewritten
            }
            return BoundReturnStatement(
                nil,
                BoundConversionExpression(nil, this.adapterReturnType, rewritten.Expression!!)
            )
        }
    }

    private class CapturedVariableCollector : BoundTreeRewriter {
        private let parameters HashSet[VariableSymbol]
        private let seen HashSet[VariableSymbol]
        private let declared HashSet[VariableSymbol]
        private let captured ImmutableArray[VariableSymbol].Builder
        private let calleeCapturedVariables IReadOnlyDictionary[FunctionSymbol, ImmutableArray[VariableSymbol]]?

        init(
            parameters HashSet[VariableSymbol],
            seen HashSet[VariableSymbol],
            captured ImmutableArray[VariableSymbol].Builder,
            preDeclared IEnumerable[VariableSymbol]? = nil,
            calleeCapturedVariables IReadOnlyDictionary[FunctionSymbol, ImmutableArray[VariableSymbol]]? = nil
        ) {
            this.parameters = parameters
            this.seen = seen
            this.declared = if preDeclared != nil {
                HashSet[VariableSymbol](){...preDeclared}
            } else {
                HashSet[VariableSymbol]()
            }
            this.captured = captured
            this.calleeCapturedVariables = calleeCapturedVariables
        }

        /// Issue #4221: a call to a local function is a
        /// (cref:BoundCallExpression) against its
        /// (cref:FunctionSymbol) directly — not a reference to its
        /// (cref:BoundFunctionLiteralExpression), which is what
        /// (cref:RewriteFunctionLiteralExpression) relies on for a
        /// physically nested literal. Fold in whatever the callee is already
        /// known to capture (see (cref:localFunctionCapturedVariables))
        /// exactly as that method does for a nested literal, so the caller's
        /// own environment carries every variable a direct call inside its
        /// body will need to rebuild the callee's closure instance at the
        /// call site (`MethodBodyEmitter.EmitGenericLocalClosureInstance`).
        protected override func RewriteCallExpression(node BoundCallExpression) BoundExpression {
            if this.calleeCapturedVariables != nil && this.calleeCapturedVariables.TryGetValue(
                node.Function,
                out var calleeCaptured
            ) {
                for calleeVariable in calleeCaptured {
                    if calleeVariable is GlobalVariableSymbol {
                        continue
                    }
                    if !this.parameters.Contains(calleeVariable) && !this.declared.Contains(calleeVariable) &&
                        this
                        .seen
                        .Add(calleeVariable) {
                        this.captured.Add(calleeVariable)
                    }
                }
            }
            return base.RewriteCallExpression(node)
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            this.declared.Add(node.Variable)
            if node.Variable is LocalVariableSymbol{ManagedReferenceStorage: {} storage} {
                this.declared.Add(storage)
            }
            return base.RewriteVariableDeclaration(node)
        }

        // Issue #1437: a `let`/`var` is not the only construct that introduces a
        // local inside a lambda body. Catch clauses, `select` arms, range/ellipsis
        // loop variables, `fixed` pin/pointer locals and type-pattern bindings all
        // declare variables that are *local* to the body being walked. They must be
        // recorded in `declared` exactly like a BoundVariableDeclaration; otherwise
        // RecordReference misclassifies a later read of one of them as a capture of
        // an enclosing-scope variable. That false capture then flows into
        // BoundFunctionLiteralExpression.CapturedVariables and the CaptureBoxingRewriter
        // hoists the *catch/arm/loop* variable into a heap box — desynchronizing the
        // variable's declaration site (still the original symbol, which the emit
        // local-slot planner allocates a slot for) from its in-body reads (rewritten
        // to `box.Value` against a fresh, slot-less box local), crashing emit with
        // GS9998 "has no local slot or parameter index in the current method."
        // Recording these declarations keeps any genuine capture by a *nested* lambda
        // correct: there the variable is declared in this body's scope, so the nested
        // literal's capture is satisfied here and is not propagated outward.
        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            for clause in node.CatchClauses {
                if clause.Variable != nil {
                    this.declared.Add(clause.Variable)
                }
            }
            return base.RewriteTryStatement(node)
        }

        protected override func RewriteForRangeStatement(node BoundForRangeStatement) BoundStatement {
            if node.KeyVariable != nil {
                this.declared.Add(node.KeyVariable)
            }
            if node.ValueVariable != nil {
                this.declared.Add(node.ValueVariable)
            }
            return base.RewriteForRangeStatement(node)
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        protected override func RewriteAwaitForRangeStatement(node BoundAwaitForRangeStatement) BoundStatement {
            if node.ValueVariable != nil {
                this.declared.Add(node.ValueVariable)
            }
            return base.RewriteAwaitForRangeStatement(node)
        }

        protected override func RewriteForEllipsisStatement(node BoundForEllipsisStatement) BoundStatement {
            if node.Variable != nil {
                this.declared.Add(node.Variable)
            }
            return base.RewriteForEllipsisStatement(node)
        }

        protected override func RewriteFixedStatement(node BoundFixedStatement) BoundStatement {
            if node.PinnedVariable != nil {
                this.declared.Add(node.PinnedVariable)
            }
            if node.PointerVariable != nil {
                this.declared.Add(node.PointerVariable)
            }
            if node.SourceVariable != nil {
                this.declared.Add(node.SourceVariable)
            }
            return base.RewriteFixedStatement(node)
        }

        protected override func RewritePattern(node BoundPattern) BoundPattern {
            if node is BoundDiscardPattern{Variable: not nil} varPattern {
                this.declared.Add(varPattern.Variable!!)
            }
            if node is BoundTypePattern typePattern && typePattern.Variable != nil {
                this.declared.Add(typePattern.Variable)
            }
            // ADR-0166: a slice capture (`[..rest]`) declares its variable in
            // the same way, whether the pattern sits in a switch arm or in a
            // boolean `is` inside the lambda body.
            if node is BoundSlicePattern slicePattern && slicePattern.Variable != nil {
                this.declared.Add(slicePattern.Variable)
            }
            return base.RewritePattern(node)
        }

        protected override func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
            // Issue #1451 (generalization of #1437): an inline `out var x` argument
            // declares a body-local via BoundAddressOfExpression(BoundVariableExpression(local))
            // — NOT a BoundVariableDeclaration. Recording it here keeps the in-order
            // case correct, but loop lowering (while/for/do) emits the body *before*
            // the condition that declares the out-var, so the uses are walked first;
            // a same-pass record is too late (RecordReference already classified the
            // use as a capture). The authoritative seeding therefore happens up front
            // via InlineOutVarDeclarationCollector (see CollectCapturedVariables) — this
            // override is kept for the in-order path and as defense in depth. Without
            // the declared-record, CaptureBoxingRewriter hoists `x` into a heap box,
            // desynchronizing its declaration site (the original local, for which the
            // emit local-slot planner allocates a slot) from its boxed reads, crashing
            // emit with GS9998 "Variable 'x' has no local slot".
            if node.Operand is BoundVariableExpression outVarExpr &&
                (outVarExpr.Variable.DeclaringSyntax is RefArgumentExpressionSyntax and {IsInlineDeclaration: true}) {
                this.declared.Add(outVarExpr.Variable)
            }
            return base.RewriteAddressOfExpression(node)
        }

        protected override func RewriteNullConditionalAccessExpression(
            node BoundNullConditionalAccessExpression
        ) BoundExpression {
            // Issue #1437 (generalization): the `?.` / `?(…)` operators introduce a
            // synthetic `Capture` local (`$ncap_N`) that the receiver value is
            // spilled into, and `WhenNotNull` references that `Capture` as its
            // receiver. Value-typed results also introduce a `$nres_N` ResultSlot.
            // Both are body-local declarations — not BoundVariableDeclarations — so,
            // exactly like a catch/arm/loop variable, without recording them here
            // RecordReference would see the `Capture` read inside `WhenNotNull` as a
            // capture of an enclosing-scope variable, box it, and desynchronize it
            // from the slot the emit planner allocates (crashing with GS9998
            // "Variable '$ncap_N' has no local slot").
            if node.Capture != nil {
                this.declared.Add(node.Capture)
            }
            if node.ResultSlot != nil {
                this.declared.Add(node.ResultSlot)
            }
            return base.RewriteNullConditionalAccessExpression(node)
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            // Issue #523: an assignment LHS is a USE of the variable that
            // must contribute to the capture set, exactly like a
            // BoundVariableExpression. The base rewriter intentionally
            // doesn't visit `node.Variable`, so the binder otherwise
            // silently treats write-only captures (e.g. `func(x) { n = x }`)
            // as having no captures — which crashes the emitter when the
            // body still references the (boxed) target.
            this.RecordReference(node.Variable)
            return base.RewriteAssignmentExpression(node)
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            // Issue #523 (side fix): globals already live in a static field and
            // are addressable from any lambda body via ldsfld/stsfld — capturing
            // them into a closure-class field would re-introduce the snapshot
            // bug. Skip globals so the lambda reads them directly at every use.
            this.RecordReference(node.Variable)
            return node
        }

        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            // Issue #567: BoundFieldAssignmentExpression carries its receiver
            // as a raw VariableSymbol, not as a BoundVariableExpression. Without
            // this override the receiver variable is invisible to capture
            // analysis when the lambda body only does field writes (not reads)
            // on the variable.
            if node.Receiver != nil {
                this.RecordReference(node.Receiver)
            }
            return base.RewriteFieldAssignmentExpression(node)
        }

        protected override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
            // Issue #618: BoundIndexAssignmentExpression carries its target
            // as a raw VariableSymbol. Without this override the target
            // variable is invisible to capture analysis when the lambda body
            // only does index writes (e.g. `arr[i] = v`) on the variable.
            if node.Target != nil {
                this.RecordReference(node.Target)
            }
            return base.RewriteIndexAssignmentExpression(node)
        }

        protected override func RewriteClrIndexAssignmentExpression(
            node BoundClrIndexAssignmentExpression
        ) BoundExpression {
            // Issue #618: same as above for CLR indexer writes (e.g.
            // `dict["key"] = v` on a Dictionary).
            if node.Target != nil {
                this.RecordReference(node.Target)
            }
            return base.RewriteClrIndexAssignmentExpression(node)
        }

        protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
            // Issue #503 follow-up: a nested function literal's captures
            // must transitively contribute to the *outer* literal's capture
            // set whenever they're satisfied by neither outer parameters
            // nor outer-body local declarations. Without this, the outer
            // closure's display class has no field for the inner's free
            // variable, so the inner-literal construction inside the outer
            // Invoke body cannot locate the variable to pass to the inner
            // closure's ctor (the silent-GS9998 failure surfaced by issue
            // #503 closures inside nested lambdas).
            for nestedCapture in node.CapturedVariables {
                // Issue #523 (side fix): see RewriteVariableExpression above.
                if nestedCapture is GlobalVariableSymbol {
                    continue
                }
                if !this.parameters.Contains(nestedCapture) && !this.declared.Contains(nestedCapture) && this.seen.Add(
                    nestedCapture
                ) {
                    this.captured.Add(nestedCapture)
                }
            }
            return node
        }

        private func RecordReference(variable VariableSymbol) {
            // Globals are read live (see RewriteVariableExpression).
            if variable is GlobalVariableSymbol {
                return
            }
            if !this.parameters.Contains(variable) && !this.declared.Contains(variable) && this.seen.Add(variable) {
                this.captured.Add(variable)
            }
        }
    }

    // Issue #1940: walks a generic local function's bound body looking for any reference — an
    // expression's type, a local's declared type, an explicit/inferred method type argument, or a
    // type-pattern's tested type — to a type parameter owned by an enclosing generic method or class.
    // Stops at nested function literals (BoundTreeWalker already treats FunctionLiteralExpression as
    // opaque): a nested generic local function is checked independently, against its own enclosing set,
    // when it is bound.
    private class EnclosingTypeParameterReferenceWalker : BoundTreeWalker {
        private let enclosingTypeParameters ImmutableArray[TypeParameterSymbol]
        private let checkOwners bool

        init(enclosingTypeParameters ImmutableArray[TypeParameterSymbol], checkOwners bool) {
            this.enclosingTypeParameters = enclosingTypeParameters
            this.checkOwners = checkOwners
        }

        prop Found TypeParameterSymbol? {
            get;
            private set;
        }

        prop RequiresLexicalOwner bool {
            get;
            private set;
        }

        func CheckType(type TypeSymbol?) {
            if Found != nil || type == nil {
                return
            }
            if checkOwners {
                let referenced = List[TypeParameterSymbol]()
                TypeSymbol.CollectReferencedTypeParameters(type, referenced)
                for parameter in enclosingTypeParameters {
                    if referenced.Contains(parameter) {
                        Found = parameter
                        break
                    }
                }
                RequiresLexicalOwner |= switch type {
                    case owner is StructSymbol: NeedsAccessDomain(owner.Accessibility)
                    case owner is InterfaceSymbol: NeedsAccessDomain(owner.Accessibility)
                    case owner is EnumSymbol: NeedsAccessDomain(owner.Accessibility)
                    default: false
                }
                return
            }
            TypeSymbol.AnyTypeParameter(
                type,
                (tp TypeParameterSymbol) -> {
                    if Found == nil && enclosingTypeParameters.Contains(tp) {
                        Found = tp
                    }
                    return Found != nil
                }
            )
        }

        override func VisitExpression(node BoundExpression?) {
            if node == nil || Found != nil {
                return
            }
            CheckType(node.Type)
            if checkOwners {
                switch node {
                    case call is BoundCallExpression when !call.IsConditionalElided {
                        CheckType(
                            cast[TypeSymbol?](call.StaticGenericOwnerType) ??
                                call.StaticGenericInterfaceOwnerType ??
                                call
                                .Function
                                .StaticOwnerType
                        )
                        RequiresLexicalOwner |= NeedsAccessDomain(call.Function.Accessibility)
                    }
                    case call is BoundUserInstanceCallExpression {
                        RequiresLexicalOwner |= NeedsAccessDomain(call.Method.Accessibility)
                    }
                    case BoundConstructorCallExpression{SelectedConstructor: {} constructor} {
                        RequiresLexicalOwner |= NeedsAccessDomain(constructor.Function.Accessibility)
                    }
                    case BoundMethodGroupExpression{Function: {} method} group {
                        CheckType(group.StaticOwnerType ?? method.StaticOwnerType)
                        CheckTypeArguments(group.MethodTypeArguments)
                        RequiresLexicalOwner |= NeedsAccessDomain(method.Accessibility)
                    }
                    case pointer is BoundFunctionPointerFromMethodExpression {
                        CheckType(pointer.Method.StaticOwnerType)
                        RequiresLexicalOwner |= NeedsAccessDomain(pointer.Method.Accessibility)
                    }
                    case field is BoundFieldAccessExpression {
                        CheckType(cast[TypeSymbol?](field.StructType) ?? field.InterfaceType)
                        RequiresLexicalOwner |= NeedsAccessDomain(field.Field.Accessibility)
                    }
                    case field is BoundFieldAssignmentExpression {
                        CheckType(cast[TypeSymbol?](field.StructType) ?? field.InterfaceType)
                        RequiresLexicalOwner |= NeedsAccessDomain(field.Field.Accessibility)
                    }
                    case property is BoundPropertyAccessExpression {
                        CheckType(cast[TypeSymbol?](property.StructType) ?? property.InterfaceType)
                        RequiresLexicalOwner |= NeedsAccessDomain(property.Property.GetterAccessibility)
                    }
                    case property is BoundPropertyAssignmentExpression {
                        CheckType(cast[TypeSymbol?](property.StructType) ?? property.InterfaceType)
                        RequiresLexicalOwner |= NeedsAccessDomain(property.Property.SetterAccessibility)
                    }
                    case literal is BoundFunctionLiteralExpression when !literal.Function.IsGeneric {
                        RequiresLexicalOwner |= literal.Function.LexicalEnclosingType != nil
                    }
                }
            }
            switch node {
                case call is BoundCallExpression {
                    CheckTypeArguments(call.MethodTypeArguments)
                }
                case userInstanceCall is BoundUserInstanceCallExpression {
                    CheckTypeArguments(userInstanceCall.MethodTypeArguments)
                }
                case importedCall is BoundImportedCallExpression {
                    CheckNullableTypeArguments(importedCall.TypeArgumentSymbols)
                }
                case importedInstanceCall is BoundImportedInstanceCallExpression {
                    CheckNullableTypeArguments(importedInstanceCall.TypeArgumentSymbols)
                }
                case isExpression is BoundIsExpression {
                    if isExpression.TargetType != nil {
                        CheckType(isExpression.TargetType)
                    }
                }
                case typeOfExpression is BoundTypeOfExpression {
                    CheckType(typeOfExpression.OperandType)
                }
                case sizeOfExpression is BoundSizeOfExpression {
                    CheckType(sizeOfExpression.MeasuredType)
                }
                case constrainedStaticCall is BoundConstrainedStaticCallExpression {
                    CheckType(constrainedStaticCall.TypeParameter)
                }
            }
            base.VisitExpression(node)
        }

        override func VisitPattern(node BoundPattern?) {
            if node == nil || Found != nil {
                return
            }
            CheckType(node.Type)
            if node is BoundTypePattern typePattern {
                CheckType(typePattern.TargetType)
            }
            base.VisitPattern(node)
        }

        protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if Found != nil {
                return
            }
            CheckType(node.Variable.Type)
            base.VisitVariableDeclaration(node)
        }

        private func CheckTypeArguments(typeArguments ImmutableArray[TypeSymbol]) {
            if typeArguments.IsDefaultOrEmpty {
                return
            }
            for typeArgument in typeArguments {
                CheckType(typeArgument)
            }
        }

        private func CheckNullableTypeArguments(typeArguments ImmutableArray[TypeSymbol?]) {
            if typeArguments.IsDefaultOrEmpty {
                return
            }
            for typeArgument in typeArguments {
                CheckType(typeArgument)
            }
        }

        shared {
            private func NeedsAccessDomain(
                accessibility Accessibility
            ) bool -> accessibility == Accessibility.Private ||
                accessibility == Accessibility.Protected
        }
    }

    shared {
        /// Unwraps a bound expression to the underlying
        /// (cref:BoundFunctionLiteralExpression) if any. Handles
        /// both the direct case and the
        /// (cref:BoundConversionExpression)-wrapped case (a
        /// function literal flowing through an implicit conversion to a
        /// delegate-typed target).
        /// @param expression The bound expression to inspect.
        /// @param literal The unwrapped function literal, or
        /// `null` if [`expression`](paramref) is not a function
        /// literal (possibly through a single
        /// (cref:BoundConversionExpression) wrapper).
        /// @returns `true` if a function literal was found.
        func TryGetFunctionLiteral(
            expression BoundExpression,
            @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out literal BoundFunctionLiteralExpression?
        ) bool {
            if expression is BoundFunctionLiteralExpression direct {
                literal = direct
                return true
            }
            if expression is BoundConversionExpression{Expression: BoundFunctionLiteralExpression converted} {
                literal = converted
                return true
            }
            literal = nil
            return false
        }

        /// Issue #4221 follow-up: gathers every (cref:BoundFunctionLiteralExpression)
        /// reachable from [`body`](paramref), including literals nested
        /// inside other literals at any depth, appending them to
        /// [`sink`](paramref). (cref:BoundTreeRewriter) treats a
        /// literal as a leaf by default, so this descends explicitly — mirrors
        /// (cref:NestedCaptureCollector)'s traversal, but collects the
        /// literal nodes themselves rather than their already-cached captures.
        private func CollectNestedFunctionLiterals(body BoundStatement, sink List[BoundFunctionLiteralExpression]) {
            NestedFunctionLiteralCollector(sink).RewriteStatement(body)
        }

        /// ADR-0069 amendment / issue #2442: computes the subset of the enclosing
        /// scope's active narrowing frames that may legally survive into a
        /// captured closure body (a lambda or local function literal).
        /// @remarks A narrowing entry keyed on (cref:AccessPath) `p` survives
        /// into the closure only when `p.Root.IsReadOnly` is
        /// `true` AND `p` is a plain variable path
        /// (`!p.HasMembers`). (cref:VariableSymbol.IsReadOnly) is the
        /// binder's own "can never be reassigned" fact — it is exactly the
        /// signal (cref:ExpressionBinder) already consults to reject
        /// <em>any</em> assignment to the variable (a `let` local, or a
        /// by-value / `in` function parameter), and it is deliberately
        /// `false` for `var` locals, `ref`/`out`
        /// parameters, and `let ref`/`var ref` aliasing locals (which
        /// bind a managed pointer to possibly-external storage — see
        /// `StatementBinder.Narrowing.cs`'s ref-local declaration path,
        /// which passes `isReadOnly: false` unconditionally). Because a
        /// read-only binding can never be written again anywhere in its scope,
        /// the value a nil-guard or `is`-test proved at the guard site can
        /// never change later — no matter when the closure that captured it
        /// eventually runs: immediately and synchronously (`Task.Run(() =>
        /// …)`), after the enclosing function returns (an escaping/stored
        /// delegate), repeatedly (invoked from inside a loop), concurrently on
        /// another thread, or after an `await` suspension point. This is a
        /// strictly stronger guarantee than "not reassigned along this
        /// particular flow path": it holds for every path, so no additional
        /// temporal/flow proof is required.
        ///
        /// Member-access paths (`x.member`) are always dropped even when
        /// the root is read-only: the ADR-0069 addendum (issue #1180) already
        /// treats member reads as fragile because another call or another
        /// receiver's assignment could mutate the member through an alias the
        /// closure's own narrowing analysis never observes — the same reasoning
        /// (cref:StatementBinder.InvalidateNarrowingsForAssignedVariables(SyntaxNode, BoundStatement))
        /// applies at ordinary statement boundaries. Widening that guarantee to
        /// "safe forever, even across a closure capture" would be unsound, so
        /// this method conservatively keeps the pre-existing behaviour (drop) for
        /// every member-bearing key.
        /// @param outerFrames The enclosing scope's narrowing-frame stack at the point the closure
        /// literal is entered (a snapshot copy — not mutated by this method).
        /// @returns A new frame stack, parallel in shape to [`outerFrames`](paramref),
        /// containing only the entries that are sound to keep visible while
        /// binding the closure body.
        private func FilterNarrowingsSurvivingClosureCapture(outerFrames List[NarrowingFrame]) List[
            Dictionary[AccessPath, TypeSymbol]
        ] {
            let result = List[Dictionary[AccessPath, TypeSymbol]](outerFrames.Count)
            for frame in outerFrames {
                let survivors = Dictionary[AccessPath, TypeSymbol]()
                for entry in frame {
                    if !entry.Key.HasMembers && entry.Key.Root.IsReadOnly {
                        survivors[entry.Key] = entry.Value
                    }
                }
                result.Add(survivors)
            }
            return result
        }

        private func ResolveLexicalEnclosingType(
            outerFunction FunctionSymbol?
        ) TypeSymbol? -> outerFunction?.ReceiverType ??
            outerFunction?.StaticOwnerType ??
            outerFunction?.LexicalEnclosingType

        /// ADR-0102 follow-up / issue #818: collects per-parameter variadic
        /// flags from a lambda's bound parameter list into the array shape
        /// (cref:FunctionTypeSymbol.Get(ImmutableArray{TypeSymbol}, ImmutableArray{bool}, TypeSymbol))
        /// consumes. Returns `default` when no parameter is variadic so
        /// the cache lookup stays on the non-variadic key path for the common
        /// case.
        /// @param parameters The bound parameter symbol builder.
        /// @returns The per-parameter variadic flag array, or `default`.
        private func BuildVariadicFlagsIfAny(parameters ImmutableArray[ParameterSymbol].Builder) ImmutableArray[bool] {
            var anyVariadic = false
            for var i = 0; i < parameters.Count; i++ {
                if parameters[i].IsVariadic {
                    anyVariadic = true
                    break
                }
            }
            if !anyVariadic {
                return default(ImmutableArray[bool])
            }
            let builder = ImmutableArray.CreateBuilder[bool](parameters.Count)
            for var i = 0; i < parameters.Count; i++ {
                builder.Add(parameters[i].IsVariadic)
            }
            return builder.MoveToImmutable()
        }

        // ADR-0076 / issue #716: compute the inferred return type from the bound
        // body and any explicit return statements it contains. The rule:
        //   - If the body is a BoundBlockExpression and contains any return
        //     statements, the candidate set is the trailing expression's type
        //     (unless that trailing is the synthetic void marker) UNION the
        //     return statements' expression types.
        //   - Otherwise the candidate set is just the bound body's type.
        // The common type is computed with the same widening rules as a
        // conditional expression (ADR-0062); when there is no common type, the
        // result is TypeSymbol.Error (a downstream conversion will fail and a
        // diagnostic will fire on the offending return). When a target return
        // type is provided AND every candidate is convertible to it, prefer the
        // target.
        private func InferLambdaReturnType(
            boundBody BoundExpression,
            syntax LambdaExpressionSyntax,
            targetFunctionType FunctionTypeSymbol?,
            isAsync bool
        ) TypeSymbol {
            if boundBody is BoundErrorExpression {
                return TypeSymbol.Error
            }
            let trailingType = boundBody.Type ?? TypeSymbol.Void
            // Issue #4965 (ADR-0202): a `return` can also sit inside the
            // trailing value — `(c) -> { if c { return 1 } else { return 2 } }`,
            // whose tail is an if-expression with exiting (`never`) branches —
            // so the collector walks the tail as well as the prefix statements.
            let collector = ReturnTypeCollector()
            if boundBody is BoundBlockExpression block {
                for stmt in block.Statements {
                    collector.Visit(stmt)
                }
                collector.Visit(block.Expression)
            } else {
                collector.Visit(boundBody)
            }
            let returnTypes = collector.ReturnTypes
            let hasExplicitReturn = returnTypes.Count > 0
            let hasExplicitValueReturn = returnTypes.Any((type TypeSymbol) -> type != TypeSymbol.Void)
            // A never-typed tail (every path exits) produces no value, exactly
            // like the void placeholder of a body without a tail.
            let trailingIsVoidPlaceholder = (
                boundBody is BoundBlockExpression{Expression: BoundLiteralExpression{Type: var trailingLit}} &&
                    trailingLit == TypeSymbol.Void
            ) ||
                (hasExplicitReturn && trailingType == TypeSymbol.Never)
            // Issue #2152: in G#'s Kotlin-like semantics an assignment yields
            // Unit/void, so a block-body lambda whose trailing expression is an
            // assignment (simple `=` or a compound `+=`/`-=`/... which the binder
            // represents with the same assignment bound nodes) contributes `void`
            // — not the assigned value's type — to target-less return-type
            // inference. Without this, `(x bool) -> { field = x }` was inferred as
            // `(bool) -> bool` and failed to match an `Action`-style
            // `(bool) -> void` delegate parameter during overload resolution
            // (GS0266/GS0154). This mirrors the target-typed void-discard branch
            // (issue #889) below and the value-discarding statement the emitter
            // produces (see EmitTrailingExpression). It only fires on the
            // target-less path (targetFunctionType == null); the target-typed
            // paths already reconcile the assignment against the delegate's return
            // type and are left untouched.
            let trailingExpression = if boundBody is BoundBlockExpression trailingBlock {
                trailingBlock.Expression
            } else {
                boundBody
            }
            let trailingIsAssignment = IsAssignmentExpression(trailingExpression)
            // Preserve the direct expression-body type before common-type
            // aggregation. This path has one candidate by construction and also
            // remains stable when Core itself is compiled from migrated G#.
            // Issue #4965 (ADR-0202): a BLOCK body whose tail never completes
            // (`() -> { { throw e } }`, `() -> { if c { throw a } else { throw b } }`)
            // produces no value; with no target to adopt it is a void lambda,
            // exactly as `() -> { throw e }` (a throw statement) already is.
            // An expression body `() -> throw e` keeps its `() -> never` type,
            // which adapts to any delegate signature (issue #2716).
            let neverBlockTail = trailingType == TypeSymbol.Never && syntax.Body is BlockExpressionSyntax
            if targetFunctionType == nil && !hasExplicitReturn && !trailingIsAssignment {
                return if neverBlockTail {
                    TypeSymbol.Void
                } else {
                    trailingType
                }
            }
            // Issue #891: a block-body arrow lambda whose body never completes
            // normally — every path throws (or otherwise terminates) without a
            // value-producing `return` — has no natural return value. C# treats
            // such a lambda as convertible to ANY delegate return type (e.g.
            // `() -> { throw ... }` converts to both `Action` and `Func<string>`).
            // When a target delegate return type is supplied we therefore adopt it
            // directly, exactly as the equivalent `func() T { throw ... }` literal
            // (whose explicit return type a throwing body satisfies) already does.
            // ADR-0128 / issue #1172: the body may now contain un-lowered control-
            // flow statements (e.g. an `if`-without-`else` void statement), so lower
            // it before running the CFG analysis — `ControlFlowGraph.AllPathsReturn`
            // expects the goto/label form produced by the lowerer (mirrors the
            // function-literal path in Binder).
            let bodyNeverCompletesNormally = !hasExplicitReturn &&
                trailingIsVoidPlaceholder &&
                boundBody is BoundBlockExpression neverBlock &&
                neverBlock
                .Statements
                .Length > 0 &&
                ControlFlowGraph.AllPathsReturn(Lowerer.Lower(BoundBlockStatement(syntax.Body, neverBlock.Statements)))
            // ADR-0076 §3: the candidate set.
            let candidates = List[TypeSymbol]()
            if !(hasExplicitReturn && trailingIsVoidPlaceholder) {
                // Issue #2152: a trailing assignment contributes void on the
                // target-less inference path (see the note above).
                let trailingCandidate = if trailingIsAssignment && targetFunctionType == nil {
                    TypeSymbol.Void
                } else {
                    trailingType
                }
                candidates.Add(trailingCandidate)
            }
            candidates.AddRange(returnTypes)
            // If a target return type was supplied by the caller, prefer it when
            // every candidate is convertible to it — this handles the case where
            // the lambda value flows into a variable whose explicit type pins the
            // return type up-front.
            var targetReturn TypeSymbol? = nil
            if targetFunctionType != nil {
                targetReturn = targetFunctionType.ReturnType
                if isAsync {
                    // Strip the Task / Task<T> wrap so we compare against the
                    // awaited type the lambda body actually produces.
                    targetReturn = UnwrapTaskReturnType(targetReturn)
                }
                // Issue #891: a throwing/never-returning body adopts the target's
                // return type directly — there is no value to reconcile, so the
                // synthesized method's signature simply matches the delegate.
                if bodyNeverCompletesNormally && targetReturn != nil && targetReturn != TypeSymbol.Error {
                    return targetReturn
                }
                // Issue #889: when the target delegate returns void (e.g.
                // System.Action), an arrow lambda whose body is an expression
                // (assignment, call, increment, ...) discards that value — exactly
                // like the equivalent `func() { ... }` literal whose statement body
                // yields void. Pin the return type to void so the synthesized
                // method's signature matches the Action/void-delegate target and
                // the trailing expression is emitted as a value-discarding
                // statement (see EmitTrailingExpression).
                if targetReturn == TypeSymbol.Void && !hasExplicitValueReturn {
                    return TypeSymbol.Void
                }
                var allCandidatesConvert = targetReturn != nil
                if targetReturn != nil {
                    for candidate in candidates {
                        if candidate != TypeSymbol.Error && !Conversion.Classify(candidate, targetReturn)
                            .IsImplicit &&
                            !ConversionClassifier.HasUserDefinedImplicitConversionForTypes(candidate, targetReturn) {
                            allCandidatesConvert = false
                            break
                        }
                    }
                }
                if allCandidatesConvert {
                    return targetReturn!!
                }
            }
            if candidates.Count == 0 {
                return TypeSymbol.Void
            }
            var result TypeSymbol? = candidates[0]
            for var i = 1; i < candidates.Count; i++ {
                result = ComputeLambdaCommonType(result, candidates[i])
                if result == TypeSymbol.Error {
                    return TypeSymbol.Error
                }
            }
            // Issue #4965 (ADR-0202): a block body every return of which never
            // completes (`() -> { return { throw e } }`) has no value type
            // either; see `neverBlockTail` above.
            if result == TypeSymbol.Never && syntax.Body is BlockExpressionSyntax {
                return TypeSymbol.Void
            }
            return result ?? TypeSymbol.Error
        }

        // Issue #2152: recognizes every bound-node shape the binder uses to
        // represent an assignment — the simple `=` variants across the different
        // assignment targets (locals, fields, properties, indexers, CLR members,
        // pointers) as well as compound `+=`/`-=`/... forms, which the binder
        // lowers into these same nodes. Used by InferLambdaReturnType to treat a
        // trailing assignment as contributing `void` (G#'s Kotlin-like Unit
        // semantics) on the target-less inference path.
        private func IsAssignmentExpression(expression BoundExpression) bool {
            // Issue #4967: `??=` is an assignment too. Its value lowering is a
            // block or `??` expression, so it is recognized by the syntax every
            // such lowering is anchored to.
            if expression.Syntax is NullCoalescingAssignmentExpressionSyntax {
                return true
            }
            let kind = expression.Kind
            return kind == BoundNodeKind.AssignmentExpression ||
                kind == BoundNodeKind.FieldAssignmentExpression ||
                kind == BoundNodeKind.PropertyAssignmentExpression ||
                kind == BoundNodeKind.IndexAssignmentExpression ||
                kind == BoundNodeKind.ClrPropertyAssignmentExpression ||
                kind == BoundNodeKind.ClrIndexAssignmentExpression ||
                kind == BoundNodeKind.IndirectAssignmentExpression
        }

        // ADR-0076 / issue #716: a trimmed copy of ExpressionBinder's common-
        // type rule (ADR-0062). Kept here to avoid widening the binder API
        // surface; the rule is intentionally identical so a lambda's return-
        // type inference picks the same shape as a ternary expression mixing
        // the same operand types.
        private func ComputeLambdaCommonType(left TypeSymbol?, right TypeSymbol?) TypeSymbol? {
            if left == nil || right == nil {
                return nil
            }
            if left == TypeSymbol.Error || right == TypeSymbol.Error {
                return TypeSymbol.Error
            }
            if object.ReferenceEquals(left, right) {
                return left
            }
            if left == TypeSymbol.Null {
                return if right is NullableTypeSymbol {
                    right
                } else {
                    cast[TypeSymbol](NullableTypeSymbol.Get(right))
                }
            }
            if right == TypeSymbol.Null {
                return if left is NullableTypeSymbol {
                    left
                } else {
                    cast[TypeSymbol](NullableTypeSymbol.Get(left))
                }
            }
            let leftToRight = Conversion.Classify(left, right)
            let rightToLeft = Conversion.Classify(right, left)
            if leftToRight.IsImplicit && !rightToLeft.IsImplicit {
                return right
            }
            if rightToLeft.IsImplicit && !leftToRight.IsImplicit {
                return left
            }
            if leftToRight.IsImplicit && rightToLeft.IsImplicit {
                // Issue #2498: mutually convertible nullable/non-nullable
                // references must union their annotations independent of return
                // statement order.
                return MemberLookup.MergeInferredTypeArgument(left, right)
            }
            return nil
        }

        // ADR-0076 / issue #716: strips a Task / Task<T> wrap from a target
        // function-type return slot so an async lambda's awaited type can be
        // compared against the candidates the body produces. Returns the
        // unwrapped type when the input is recognisably a Task shape;
        // otherwise returns the input unchanged.
        private func UnwrapTaskReturnType(returnType TypeSymbol?) TypeSymbol? {
            if returnType == nil {
                return nil
            }
            return if AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(returnType, out var awaited) {
                awaited
            } else {
                returnType
            }
        }

        private func GetErasedDelegateSlotType(type TypeSymbol) TypeSymbol {
            return if TypeSymbol.ContainsTypeParameter(type) {
                TypeSymbol.Object
            } else {
                type
            }
        }

        // Issue #1457: chooses the adapter slot type for one delegate
        // parameter/return position. The erased adapter exists to widen
        // type-parameter slots to System.Object so the lambda MethodDef matches
        // the runtime delegate's Invoke shape. But when the literal's own slot is
        // a same-compilation user type (a `data struct`, user class, enum, …) the
        // host-reflection target slot has already been erased to `object` (the
        // user type has no host CLR Type yet). Erasing to that `object` would
        // realise the delegate as `Func<object, …>` and force an unverifiable
        // `object -> UserType` unbox in the body. Preserve the literal's concrete
        // slot instead so the delegate reifies as `Func<UserType, …>` through the
        // TypeSpec path (ADR-0087 §3 R6), matching the reified generic call site.
        private func GetAdapterSlotType(literalSlot TypeSymbol?, targetSlot TypeSymbol) TypeSymbol {
            if literalSlot != nil && TypeSymbol.ContainsSameCompilationUserType(literalSlot) {
                return literalSlot
            }
            return GetErasedDelegateSlotType(targetSlot)
        }

        // ADR-0087 §3 R6: returns true when the literal's signature already
        // matches the (possibly substituted) target — so wrapping it in the
        // erased adapter would be pure waste. The adapter only widens
        // type-parameter-containing slots to System.Object; once R6 retires
        // that erasure, the only remaining role is shaping a mismatched
        // literal to the target signature. When the shapes already line up
        // the literal can flow through unchanged, which is the path needed
        // for the reified Func/Action TypeSpec dispatch to bind correctly
        // at runtime.
        private func IsIdentityAdapter(literal BoundFunctionLiteralExpression, target FunctionTypeSymbol?) bool {
            if target == nil {
                return false
            }
            if literal.Function.Parameters.Length != target.ParameterTypes.Length {
                return false
            }
            for var i = 0; i < literal.Function.Parameters.Length; i++ {
                if !object.ReferenceEquals(literal.Function.Parameters[i].Type, target.ParameterTypes[i]) {
                    return false
                }
            }
            let literalReturn = literal.Function.Type ?? TypeSymbol.Void
            let targetReturn = target.ReturnType ?? TypeSymbol.Void
            return object.ReferenceEquals(literalReturn, targetReturn)
        }

        /// Issue #2861: gathers every variable captured by a function literal (or
        /// local function) nested inside [`body`](paramref), transitively.
        /// The erased-adapter rewriter must know these up front because a captured
        /// variable can only be replaced by another <em>variable</em>, never by the
        /// inline conversion expression the adapter otherwise substitutes.
        /// @param body The literal body to scan.
        /// @returns The set of variables captured by nested literals.
        private func CollectNestedCapturedVariables(body BoundStatement?) HashSet[VariableSymbol] {
            let sink = HashSet[VariableSymbol]()
            if body != nil {
                NestedCaptureCollector(sink).RewriteStatement(body)
            }
            return sink
        }

        /// Issue #1940: scans a generic local function's parameter types, return type, and body for any
        /// reference to a [`enclosingTypeParameters`](paramref) member — a type parameter owned by an
        /// enclosing generic method or class rather than the local function's own `[T, U, …]` list.
        /// @param function The generic local function's symbol (already carrying its own type parameters).
        /// @param body The bound body to scan.
        /// @param enclosingTypeParameters The in-scope type parameters owned by an enclosing method or class.
        /// @param requiresLexicalOwner Whether a direct generic local needs its lexical access domain.
        /// @returns The first offending enclosing type parameter found, or `null` if none.
        private func FindEnclosingTypeParameterReference(
            function FunctionSymbol,
            body BoundStatement,
            enclosingTypeParameters ImmutableArray[TypeParameterSymbol],
            out requiresLexicalOwner bool
        ) TypeParameterSymbol? {
            let walker = EnclosingTypeParameterReferenceWalker(enclosingTypeParameters, function.IsGeneric)
            for parameter in function.Parameters {
                walker.CheckType(parameter.Type)
            }
            walker.CheckType(function.Type)
            for typeParameter in function.TypeParameters {
                walker.CheckType(typeParameter.ConstraintReferenceType)
            }
            walker.Visit(body)
            requiresLexicalOwner = walker.RequiresLexicalOwner
            return walker.Found
        }
    }
}
