// <copyright file="LambdaBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// PR-B-6: the binder-side facade that owns all function-literal
/// (lambda) binding. Wraps <see cref="BindFunctionLiteralExpression"/>,
/// the erased-adapter rewriter / synthesizer
/// (<see cref="CreateErasedFunctionLiteralAdapter"/> and its nested
/// <see cref="ErasedFunctionLiteralAdapterRewriter"/>), the captured-
/// variable analysis (<see cref="CapturedVariableCollector"/>), the
/// async-return-type widening helper (<see cref="WrapAsTask"/>), and
/// the <see cref="TryGetFunctionLiteral"/> unwrap helper that
/// previously lived directly on <see cref="Binder"/>.
/// </summary>
/// <remarks>
/// <para>
/// This type is the binder-side wrapper: it consumes
/// <see cref="BinderContext"/> for the diagnostics bag, the (mutable)
/// scope, and the synthetic-local counter, and
/// <see cref="ConversionClassifier"/> for the lambda-parameter default-
/// value binding (<see cref="ConversionClassifier.BindAndAttachParameterDefaultValue"/>).
/// It never back-references <see cref="Binder"/>; the callbacks it
/// needs (binding the lambda body, binding type / return-type clauses,
/// detecting async-iterator return types, mapping a CLR generic-argument
/// type to the reference resolver's load-context, and reading / writing
/// the current <see cref="FunctionSymbol"/> while a lambda body is being
/// bound) are injected through narrow <see cref="Func{T, TResult}"/> /
/// <see cref="Action{T}"/> seams in the constructor — the same pattern
/// established by <see cref="ConversionClassifier"/> in PR-B-3,
/// <see cref="OverloadResolver"/> in PR-B-4, and
/// <see cref="PatternBinder"/> in PR-B-5.
/// </para>
/// <para>
/// This PR is structural only; the underlying open bug #567 (closure
/// reads a field on a captured ref-type local → GS9998) is left alone
/// here. Consolidating function-literal binding into a single owner is
/// the setup the eventual <c>ClosureEmitter</c> extraction (PR-E-9)
/// needs so the emit-side fix can assume a clean
/// <see cref="BoundFunctionLiteralExpression"/> contract.
/// </para>
/// <para>
/// <see cref="TryGetFunctionLiteral"/> is exposed as <c>public
/// static</c> so <see cref="Binder"/> can keep forwarding it as the
/// <see cref="OverloadResolver.TryGetFunctionLiteralDelegate"/> wired
/// into <see cref="OverloadResolver"/>'s constructor (the resolver
/// uses it from three argument-shaping paths and never gains a
/// <see cref="LambdaBinder"/> reference). Likewise
/// <see cref="CreateErasedFunctionLiteralAdapter"/> and
/// <see cref="WrapAsTask"/> are exposed as <c>public</c> instance
/// methods so the remaining call sites in <see cref="Binder"/> can
/// route through the <c>lambdas</c> field without widening any other
/// helper's visibility.
/// </para>
/// </remarks>
internal sealed class LambdaBinder
{
    private readonly BinderContext binderCtx;
    private readonly ConversionClassifier conversions;
    private readonly Func<BlockStatementSyntax, BoundStatement> bindBlockStatement;
    private readonly Func<TypeClauseSyntax, TypeSymbol> bindTypeClause;
    private readonly Func<TypeClauseSyntax, bool, TypeSymbol> bindReturnTypeClause;
    private readonly Func<TypeSymbol, bool> isAsyncIteratorReturnType;
    private readonly Func<TypeSymbol, Type> resolveClrTypeForGenericArg;
    private readonly Func<FunctionSymbol> getCurrentFunction;
    private readonly Action<FunctionSymbol> setCurrentFunction;
    private readonly Func<ExpressionSyntax, BoundExpression> bindLambdaBodyExpression;
    private readonly Func<TypeParameterListSyntax, ImmutableArray<TypeParameterSymbol>> bindTypeParameterList;

    /// <summary>
    /// Initializes a new instance of the <see cref="LambdaBinder"/>
    /// class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes
    /// the diagnostics bag, the (mutable) root scope, and the synthetic-
    /// local counter used to name <c>&lt;lambdaN&gt;</c> /
    /// <c>&lt;lambda_erasedN&gt;</c> synthetic function symbols.</param>
    /// <param name="conversions">The binder-side conversion classifier
    /// used by <see cref="BindFunctionLiteralExpression"/> to bind and
    /// attach each lambda parameter's default value
    /// (ADR-0063 §5).</param>
    /// <param name="bindBlockStatement">Callback to bind the lambda
    /// body against the synthetic function symbol that
    /// <see cref="BindFunctionLiteralExpression"/> pushes onto the
    /// binder state.</param>
    /// <param name="bindTypeClause">Callback to bind each lambda
    /// parameter's type clause to a <see cref="TypeSymbol"/>.</param>
    /// <param name="bindReturnTypeClause">Callback to bind a lambda's
    /// declared return-type clause, with the <c>isAsync</c> flag so
    /// the still-on-Binder helper can apply the async-specific
    /// validation it already performs.</param>
    /// <param name="isAsyncIteratorReturnType">Callback that returns
    /// <c>true</c> when the supplied return type is an async-iterator
    /// shape (ADR-0041) and therefore does NOT participate in the
    /// <c>Task</c> / <c>Task&lt;T&gt;</c> widening that
    /// <see cref="WrapAsTask"/> performs.</param>
    /// <param name="resolveClrTypeForGenericArg">Callback that maps a
    /// <see cref="TypeSymbol"/> to the CLR <see cref="Type"/> the
    /// reference resolver's load context expects when it is used as a
    /// generic type-argument (issue #530). Used by
    /// <see cref="WrapAsTask"/> when constructing
    /// <c>Task&lt;T&gt;</c>.</param>
    /// <param name="getCurrentFunction">Callback that returns the
    /// <see cref="FunctionSymbol"/> currently being bound on the
    /// owning <see cref="Binder"/>.
    /// <see cref="BindFunctionLiteralExpression"/> snapshots it,
    /// replaces it with the synthetic lambda function while binding
    /// the body, then restores it.</param>
    /// <param name="setCurrentFunction">Callback that writes the
    /// owning <see cref="Binder"/>'s current
    /// <see cref="FunctionSymbol"/>. Used by
    /// <see cref="BindFunctionLiteralExpression"/> to push the
    /// synthetic lambda function for the duration of the body bind
    /// and to restore the outer function on exit.</param>
    /// <param name="bindLambdaBodyExpression">ADR-0074 / issue #714:
    /// optional callback that binds an arrow-lambda body expression.
    /// Required only when <see cref="BindLambdaExpression"/> is
    /// invoked; the function-literal pipeline does not need it.</param>
    /// <param name="bindTypeParameterList">Issue #1886: callback that
    /// binds a <c>[T, U, ...]</c> type-parameter list to
    /// <see cref="TypeParameterSymbol"/>s, reusing
    /// <see cref="DeclarationBinder.BindTypeParameterList(TypeParameterListSyntax)"/>.
    /// Required only when <see cref="BindGenericLocalFunctionDeclaration"/>
    /// is invoked.</param>
    public LambdaBinder(
        BinderContext binderCtx,
        ConversionClassifier conversions,
        Func<BlockStatementSyntax, BoundStatement> bindBlockStatement,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        Func<TypeClauseSyntax, bool, TypeSymbol> bindReturnTypeClause,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        Func<TypeSymbol, Type> resolveClrTypeForGenericArg,
        Func<FunctionSymbol> getCurrentFunction,
        Action<FunctionSymbol> setCurrentFunction,
        Func<ExpressionSyntax, BoundExpression> bindLambdaBodyExpression = null,
        Func<TypeParameterListSyntax, ImmutableArray<TypeParameterSymbol>> bindTypeParameterList = null)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
        this.conversions = conversions ?? throw new ArgumentNullException(nameof(conversions));
        this.bindBlockStatement = bindBlockStatement ?? throw new ArgumentNullException(nameof(bindBlockStatement));
        this.bindTypeClause = bindTypeClause ?? throw new ArgumentNullException(nameof(bindTypeClause));
        this.bindReturnTypeClause = bindReturnTypeClause ?? throw new ArgumentNullException(nameof(bindReturnTypeClause));
        this.isAsyncIteratorReturnType = isAsyncIteratorReturnType ?? throw new ArgumentNullException(nameof(isAsyncIteratorReturnType));
        this.resolveClrTypeForGenericArg = resolveClrTypeForGenericArg ?? throw new ArgumentNullException(nameof(resolveClrTypeForGenericArg));
        this.getCurrentFunction = getCurrentFunction ?? throw new ArgumentNullException(nameof(getCurrentFunction));
        this.setCurrentFunction = setCurrentFunction ?? throw new ArgumentNullException(nameof(setCurrentFunction));
        this.bindLambdaBodyExpression = bindLambdaBodyExpression;
        this.bindTypeParameterList = bindTypeParameterList;
    }

    private DiagnosticBag Diagnostics => binderCtx.Diagnostics;

    private BoundScope Scope
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

    /// <summary>
    /// Unwraps a bound expression to the underlying
    /// <see cref="BoundFunctionLiteralExpression"/> if any. Handles
    /// both the direct case and the
    /// <see cref="BoundConversionExpression"/>-wrapped case (a
    /// function literal flowing through an implicit conversion to a
    /// delegate-typed target).
    /// </summary>
    /// <param name="expression">The bound expression to inspect.</param>
    /// <param name="literal">The unwrapped function literal, or
    /// <c>null</c> if <paramref name="expression"/> is not a function
    /// literal (possibly through a single
    /// <see cref="BoundConversionExpression"/> wrapper).</param>
    /// <returns><c>true</c> if a function literal was found.</returns>
    public static bool TryGetFunctionLiteral(BoundExpression expression, out BoundFunctionLiteralExpression literal)
    {
        if (expression is BoundFunctionLiteralExpression direct)
        {
            literal = direct;
            return true;
        }

        if (expression is BoundConversionExpression { Expression: BoundFunctionLiteralExpression converted })
        {
            literal = converted;
            return true;
        }

        literal = null;
        return false;
    }

    /// <summary>
    /// Binds a <see cref="FunctionLiteralExpressionSyntax"/>
    /// (<c>[async] func(p1 T1, p2 T2) R { body }</c>) to a
    /// <see cref="BoundFunctionLiteralExpression"/>. Binds the
    /// parameters (including their ADR-0063 default values), pushes a
    /// new scope so outer locals are visible by lexical lookup
    /// (closure capture), binds the body against a synthetic
    /// <see cref="FunctionSymbol"/> whose return type is the declared
    /// return clause (or <see cref="TypeSymbol.Void"/>), then collects
    /// the captured outer variables by inspecting the bound body.
    /// </summary>
    /// <param name="syntax">The function-literal syntax node.</param>
    /// <param name="explicitName">Issue #1886: when non-null, names the
    /// synthetic <see cref="FunctionSymbol"/> after this value (e.g. the
    /// identifier of a <c>let Name[T] = func (...) ... { ... }</c> generic
    /// local-function declaration) instead of the default
    /// <c>&lt;lambdaN&gt;</c> synthetic name, so scope-based name lookup
    /// (<see cref="BoundScope.TryDeclareFunction"/>) can find it.</param>
    /// <returns>The bound function-literal expression.</returns>
    public BoundExpression BindFunctionLiteralExpression(FunctionLiteralExpressionSyntax syntax, string explicitName = null)
    {
        // Phase 4.7: function literal `[async] func(p1 T1, p2 T2) R { body }`.
        // Bind parameters, push a new scope chained to the current scope so
        // outer locals are visible by lexical lookup (closure capture), bind
        // the body against a synthetic FunctionSymbol whose return type is
        // the declared return clause (or void), then collect the captured
        // outer variables by inspecting the bound body.
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.Parameters.Count);
        var parameterSymbols = ImmutableArray.CreateBuilder<ParameterSymbol>(syntax.Parameters.Count);
        var seen = new HashSet<string>();
        foreach (var p in syntax.Parameters)
        {
            var pname = p.Identifier.Text;
            var ptype = bindTypeClause(p.Type) ?? TypeSymbol.Error;

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on function-literal lambdas. The body sees the
            // parameter as a `[]T` slice; when the lambda is invoked through
            // a typed delegate (the common case), pack/pass-through happens
            // on the indirect-call path inside OverloadResolver.
            var isVariadic = p.IsVariadic;
            if (isVariadic && ptype != null && ptype != TypeSymbol.Error)
            {
                ptype = SliceTypeSymbol.Get(ptype);
            }

            // Issue #1262: the discard identifier `_` is not a real binding —
            // C# allows repeated `_` discard parameters (e.g. `(_, _) => ...`).
            // Skip the uniqueness check for `_` so a second discard is not a
            // duplicate; each `_` still occupies its positional slot below.
            if (pname != "_" && !seen.Add(pname))
            {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname);
            }

            var lambdaParam = new ParameterSymbol(pname, ptype, isVariadic, declaringSyntax: p.Identifier, isScoped: p.IsScoped);

            // ADR-0063 §5: function-literal (lambda) parameters can declare a
            // default value; lambdas can be invoked through their delegate type
            // which honors the default at the call site.
            conversions.BindAndAttachParameterDefaultValue(p, lambdaParam);
            parameterSymbols.Add(lambdaParam);
            parameterTypes.Add(ptype);
        }

        // ADR-0101 follow-up / issue #812: enforce variadic structural rules.
        ValidateVariadicParameterShape(syntax.Parameters);

        var returnType = syntax.ReturnTypeClause != null ? bindReturnTypeClause(syntax.ReturnTypeClause, syntax.IsAsync) : TypeSymbol.Void;
        returnType ??= TypeSymbol.Void;

        // ADR-0058: a managed-pointer (*T) cannot be used as a lambda return type
        // because CLR Func<> delegates cannot carry by-ref type arguments.
        if (returnType is ByRefTypeSymbol && syntax.ReturnTypeClause != null)
        {
            Diagnostics.ReportByRefCannotEscape(
                syntax.ReturnTypeClause.Location,
                "a managed pointer (*T) cannot be the return type of a function literal");
            returnType = TypeSymbol.Error;
        }

        // For async lambdas, the observable return type (from the caller's
        // perspective) is Task or Task<T>, matching top-level async functions —
        // with the iterator carve-out (ADR-0041): an async iterator lambda
        // returning IAsyncEnumerable[T] does not get a Task wrap.
        var observableReturnType = returnType;
        if (syntax.IsAsync && !isAsyncIteratorReturnType(returnType))
        {
            observableReturnType = WrapAsTask(returnType);
        }

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), BuildVariadicFlagsIfAny(parameterSymbols), observableReturnType);
        var synthetic = new FunctionSymbol(
            explicitName ?? $"<lambda{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>",
            parameterSymbols.ToImmutable(),
            returnType);
        synthetic.IsAsync = syntax.IsAsync;

        // Snapshot current binder state, then push a child scope and bind
        // the body as if we were inside this synthetic function.
        var outerScope = Scope;
        var outerFunction = getCurrentFunction();
        Scope = new BoundScope(outerScope);
        setCurrentFunction(synthetic);
        synthetic.LexicalEnclosingType = ResolveLexicalEnclosingType(outerFunction);
        foreach (var ps in synthetic.Parameters)
        {
            // Issue #1262: discard parameters (`_`) are non-referenceable —
            // do not add them to the lookup scope so `_` in the body does not
            // resolve to a parameter (and repeated `_` slots never collide).
            if (ps.Name == "_")
            {
                continue;
            }

            Scope.TryDeclareVariable(ps);
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
        var savedNarrowed = binderCtx.NarrowedVariables.ToList();
        var survivingNarrowed = FilterNarrowingsSurvivingClosureCapture(savedNarrowed);
        binderCtx.NarrowedVariables.Clear();
        binderCtx.NarrowedVariables.AddRange(survivingNarrowed);

        // Issue #2027: a function literal (lambda OR local function — this
        // method binds both) is its own goto/label frame; isolate it from
        // the enclosing function's labels and loop stack.
        var savedFrame = EnterNestedFrame();

        BoundStatement body;
        try
        {
            body = bindBlockStatement(syntax.Body);
            FinalizeNestedFrameLabels();
        }
        finally
        {
            binderCtx.NarrowedVariables.Clear();
            binderCtx.NarrowedVariables.AddRange(savedNarrowed);
            RestoreNestedFrame(savedFrame);
        }

        Scope = outerScope;
        setCurrentFunction(outerFunction);

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
        body = SynthesizeFunctionLiteralTrailingReturn((BoundBlockStatement)body, syntax, returnType);

        var captured = CollectCapturedVariables(body, synthetic.Parameters);

        // Issue #367: a by-ref-like (`ref struct`) local cannot be captured by a
        // closure; the capture would hoist it into a heap-allocated display
        // class, which the CLR forbids.
        // ADR-0058 / issue #376: a managed-pointer (*T / ByRefTypeSymbol) local also
        // cannot be captured — the closure may outlive the pointed-to variable.
        // Issue #2330: an unmanaged pointer (PointerTypeSymbol) bound by a
        // `fixed` statement is likewise rejected — see ReportFixedPointerCannotEscape.
        foreach (var capturedVariable in captured)
        {
            if (TypeSymbol.IsByRefLike(capturedVariable.Type))
            {
                Diagnostics.ReportByRefLikeEscape(syntax.Location, capturedVariable.Type, $"be captured by a closure (variable '{capturedVariable.Name}')");
            }
            else if (capturedVariable.Type is ByRefTypeSymbol)
            {
                Diagnostics.ReportByRefCannotEscape(
                    syntax.Location,
                    $"managed pointer '{capturedVariable.Name}' cannot be captured by a closure; the closure may outlive the pointed-to variable");
            }
            else if (capturedVariable.Type is PointerTypeSymbol)
            {
                Diagnostics.ReportFixedPointerCannotEscape(syntax.Location, capturedVariable.Name);
            }
        }

        return new BoundFunctionLiteralExpression(null, synthetic, fnType, (BoundBlockStatement)body, captured);
    }

    /// <summary>
    /// Issue #2016: checks a NON-generic named local function (<c>let Name = func (...)
    /// ... {...}</c>, no <c>[T, ...]</c> of its own — the sibling case of #1940's generic
    /// local function) for a direct reference to a type parameter owned by an enclosing
    /// generic method or class in its own parameter type, return type, or body, and reports
    /// GS0468 if found. Such a local function that captures no outer variables is hoisted to
    /// a top-level static method (issue #1469's zero-capture fast path) UNLESS it is nested
    /// inside a non-generic user type purely for accessibility (see
    /// <c>ClosureEmitter.SynthesizeClosures</c>). When there is no such non-generic-struct
    /// nesting available — because the local function is declared at top level (inside a
    /// plain/generic top-level function) or because its enclosing user type is itself
    /// generic — that hoisted method carries none of the enclosing type parameters, so the
    /// reference has no corresponding CLR slot: invalid IL that silently crashes at run time
    /// with <see cref="System.BadImageFormatException"/> instead of failing to compile —
    /// the same invalid-IL family as the generic-local-function case, but without that fix's
    /// own-type-parameter list to hide behind.
    ///
    /// Follow-up review of #2024: an earlier revision of this method
    /// short-circuited on <c>literal.Function.IsAsync</c>, on the assumption
    /// that async local functions are owned by the async state-machine
    /// synthesis (<c>StateMachineEmitter.SynthesizeAsyncLambdaStateMachines</c>)
    /// rather than the plain zero-capture static-method hoisting path, and
    /// might therefore reify the enclosing type parameter safely. That
    /// assumption was verified FALSE: a zero-capture async local function's
    /// kickoff method is still <c>literal.Function</c> itself — the exact
    /// same un-parameterized top-level static method used by the sync path
    /// — and the synthesized state-machine struct
    /// (<see cref="GSharp.Core.CodeAnalysis.Lowering.Async.SynthesizedStateMachineType.MaterializeAsStructSymbol"/>)
    /// never re-declares the kickoff's enclosing type parameters either. A
    /// hoisted field of the enclosing type parameter's type therefore has the
    /// identical dangling-MVAR shape as the sync case, confirmed by direct
    /// repro: an UNCALLED `let Local = async func (x U) U { return x }` inside
    /// `func Outer[U](seed U) U` compiled clean before this fix and crashed at
    /// run time with <see cref="System.BadImageFormatException"/> the moment
    /// `Outer` executed (the state machine's field layout is invalid
    /// regardless of whether the local function is ever called). The
    /// short-circuit is removed so this check also covers async local
    /// functions.
    /// </summary>
    /// <param name="location">The text location of the declaring <c>let</c> identifier.</param>
    /// <param name="name">The local function's declared name (the <c>let</c> variable name).</param>
    /// <param name="literal">The already-bound function-literal expression.</param>
    public void CheckNonGenericLocalFunctionEnclosingTypeParameterReference(TextLocation location, string name, BoundFunctionLiteralExpression literal)
    {
        if (literal?.Function == null
            || literal.CapturedVariables.Length > 0
            || binderCtx.CurrentTypeParameters is not { Count: > 0 } enclosingTypeParametersInScope
            || (literal.Function.LexicalEnclosingType is StructSymbol enclosingStruct
                && enclosingStruct.TypeParameters.IsDefaultOrEmpty))
        {
            return;
        }

        var offender = FindEnclosingTypeParameterReference(literal.Function, literal.Body, enclosingTypeParametersInScope.Values.ToImmutableArray());
        if (offender != null)
        {
            Diagnostics.ReportLocalFunctionCannotReferenceEnclosingTypeParameter(location, name, offender.Name);
        }
    }

    /// <summary>
    /// Issue #1886: binds a generic local-function declaration
    /// <c>let Name[T, U, ...] = func (a T, b U) ... { ... }</c>. A CLR
    /// delegate cannot close over an unbound generic method, so this does
    /// NOT produce a runtime variable/closure value — it binds the
    /// <c>[T, U, ...]</c> list, binds the function literal against those
    /// type parameters (so <c>T</c>/<c>U</c> resolve in the parameter,
    /// return-type, and body clauses), marks the resulting
    /// <see cref="FunctionSymbol"/> as generic, and declares it directly
    /// into the enclosing scope so calls resolve through the ordinary
    /// generic overload-resolution / type-inference call path — the exact
    /// mechanism already used for top-level generic functions — instead of
    /// through an indirect delegate call.
    /// </summary>
    /// <param name="syntax">The <c>let Name[T, ...] = ...</c> variable declaration syntax.</param>
    /// <returns>The bound statement (a no-op declaration; the underlying method is emitted independently).</returns>
    public BoundStatement BindGenericLocalFunctionDeclaration(VariableDeclarationSyntax syntax)
    {
        var name = syntax.Identifier.Text;
        if (syntax.Keyword.Kind != SyntaxKind.LetKeyword || syntax.Initializer is not FunctionLiteralExpressionSyntax literalSyntax)
        {
            Diagnostics.ReportGenericLocalFunctionMustBeLetBoundLiteral(syntax.Identifier.Location, name);
            return new BoundBlockStatement(syntax, ImmutableArray<BoundStatement>.Empty);
        }

        var previousTypeParameters = binderCtx.CurrentTypeParameters;
        binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
        ImmutableArray<TypeParameterSymbol> typeParameters;
        try
        {
            typeParameters = bindTypeParameterList(syntax.TypeParameterList);

            // Re-establish the type-parameter scope merged with any enclosing
            // ones (mirrors DeclarationBinder.BindDelegateDeclaration) so the
            // literal's parameter/return/body clauses resolve T, U, ….
            binderCtx.CurrentTypeParameters = previousTypeParameters == null
                ? new Dictionary<string, TypeParameterSymbol>()
                : new Dictionary<string, TypeParameterSymbol>(previousTypeParameters);
            foreach (var tp in typeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }

            var literal = (BoundFunctionLiteralExpression)BindFunctionLiteralExpression(literalSyntax, explicitName: name);
            literal.Function.TypeParameters = typeParameters;

            if (literal.CapturedVariables.Length > 0)
            {
                Diagnostics.ReportGenericLocalFunctionCannotCapture(syntax.Identifier.Location, name);
            }

            // Issue #1940: a generic local function is hoisted to its own
            // top-level static method carrying only ITS OWN type parameters
            // as CLR MVAR slots. Referencing a type parameter owned by an
            // enclosing generic method or class (available here only because
            // BindFunctionLiteralExpression's body bind saw the merged
            // enclosing + own CurrentTypeParameters dictionary above) has no
            // corresponding slot on that hoisted method and would silently
            // emit invalid IL. Detect any such reference — in a parameter
            // type, the return type, or anywhere in the body — and report a
            // diagnostic instead of letting it reach the emitter.
            var enclosingTypeParameters = previousTypeParameters == null
                ? ImmutableArray<TypeParameterSymbol>.Empty
                : previousTypeParameters.Values.ToImmutableArray();
            if (enclosingTypeParameters.Length > 0)
            {
                var offender = FindEnclosingTypeParameterReference(literal.Function, literal.Body, enclosingTypeParameters);
                if (offender != null)
                {
                    Diagnostics.ReportLocalFunctionCannotReferenceEnclosingTypeParameter(syntax.Identifier.Location, name, offender.Name);
                }
            }

            if (!Scope.TryDeclareFunction(literal.Function))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            }

            return new BoundLocalFunctionDeclaration(syntax, literal);
        }
        finally
        {
            binderCtx.CurrentTypeParameters = previousTypeParameters;
        }
    }

    /// <summary>
    /// ADR-0074 / issue #714: binds an arrow-lambda expression
    /// <c>[async] (p1 T1, p2 T2) -&gt; body</c> to a
    /// <see cref="BoundFunctionLiteralExpression"/>. Reuses every piece
    /// of <see cref="BindFunctionLiteralExpression"/>'s plumbing — scope,
    /// synthetic function, captured-variable analysis, smart-cast
    /// narrowing snapshot — but the body is an expression (or a
    /// <see cref="BlockExpressionSyntax"/>) rather than a
    /// <see cref="BlockStatementSyntax"/>. The return type is inferred
    /// from the bound body's type; a <see cref="TypeSymbol.Void"/> body
    /// yields a void return.
    /// <para>
    /// ADR-0076 / issue #716 extends this in three ways:
    /// </para>
    /// <list type="bullet">
    ///   <item><description><b>Optional async modifier</b> — when
    ///   <see cref="LambdaExpressionSyntax.IsAsync"/> is set, the body
    ///   is bound under an async synthetic function and the function-
    ///   type's return slot is widened to <c>Task</c> / <c>Task[T]</c>
    ///   exactly as a function-literal would.</description></item>
    ///   <item><description><b>Block-body return-type inference</b> —
    ///   the placeholder synthetic function is marked
    ///   <see cref="FunctionSymbol.IsReturnTypeInferred"/>, the return
    ///   statements inside the block bind without a void or declared-
    ///   return-type check, and a post-bind pass computes the common
    ///   type and applies a single conversion to each return
    ///   expression.</description></item>
    ///   <item><description><b>Target-typed parameter inference</b> —
    ///   when <paramref name="targetFunctionType"/> is non-null, an
    ///   omitted parameter type clause is filled in from the
    ///   corresponding slot of the target. With no target type, a
    ///   missing parameter type is reported as GS0304.</description></item>
    /// </list>
    /// </summary>
    /// <param name="syntax">The lambda-expression syntax node.</param>
    /// <param name="targetFunctionType">Optional target function type
    /// supplied by the caller (e.g. an explicit variable type clause)
    /// when the parameter types should be inferred from a target. When
    /// non-null and arity matches, omitted parameter type clauses are
    /// filled in from this target.</param>
    /// <param name="inferReturnTypeFromBody">Follow-up to issue #891: when <see langword="true"/>,
    /// the target's return slot is ignored for return-type inference — the
    /// lambda's return type is computed purely from its body. Used by the
    /// deferred-lambda partial-inference path, where the target carries only
    /// closed parameter types (the delegate's return type is an un-inferred
    /// method type parameter and a placeholder occupies the target's return
    /// slot).</param>
    /// <returns>The bound lambda as a <see cref="BoundFunctionLiteralExpression"/>.</returns>
    public BoundExpression BindLambdaExpression(LambdaExpressionSyntax syntax, FunctionTypeSymbol targetFunctionType = null, bool inferReturnTypeFromBody = false)
    {
        if (bindLambdaBodyExpression == null)
        {
            throw new InvalidOperationException("LambdaBinder was constructed without a bindLambdaBodyExpression callback; arrow-lambda binding is unavailable.");
        }

        var isAsync = syntax.IsAsync;
        var arityMatchesTarget = targetFunctionType != null && targetFunctionType.Arity == syntax.Parameters.Count;
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.Parameters.Count);
        var parameterSymbols = ImmutableArray.CreateBuilder<ParameterSymbol>(syntax.Parameters.Count);
        var seen = new HashSet<string>();
        for (var i = 0; i < syntax.Parameters.Count; i++)
        {
            var p = syntax.Parameters[i];
            var pname = p.Identifier.Text;
            TypeSymbol ptype;
            if (p.Type != null)
            {
                ptype = bindTypeClause(p.Type) ?? TypeSymbol.Error;
            }
            else if (arityMatchesTarget)
            {
                // ADR-0076 / issue #716: target-typed parameter inference —
                // an omitted parameter type is filled in from the target's
                // corresponding slot.
                ptype = targetFunctionType.ParameterTypes[i] ?? TypeSymbol.Error;
            }
            else
            {
                // ADR-0076 / issue #716: no parameter type and no target to
                // infer it from — GS0304.
                Diagnostics.ReportLambdaBindingTypeCannotBeInferred(p.Location, pname);
                ptype = TypeSymbol.Error;
            }

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on arrow lambdas. The body sees the parameter as a
            // `[]T` slice; when the lambda is invoked through its inferred
            // delegate type, the indirect-call path packs / passes through
            // trailing arguments.
            //
            // Target-typed inference: when the slot type already comes from
            // a `(T1, ..., Tn) -> R` target whose Nth slot is itself a
            // slice, treat the `...T` form as element-type `T` and wrap to
            // `[]T` here. If the inferred slot is already a slice and the
            // user wrote `xs ...T`, the wrap below is a no-op only when the
            // user spelled `xs ...[]T`; the binder doesn't second-guess.
            var isVariadic = p.IsVariadic;
            if (isVariadic && ptype != null && ptype != TypeSymbol.Error && p.Type != null)
            {
                ptype = SliceTypeSymbol.Get(ptype);
            }

            // Issue #1262: skip the uniqueness check for the discard `_` so a
            // second discard parameter is permitted (C# `(_, _) => ...`). Each
            // `_` still occupies its positional slot.
            if (pname != "_" && !seen.Add(pname))
            {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname);
            }

            var lambdaParam = new ParameterSymbol(pname, ptype, isVariadic, declaringSyntax: p.Identifier, isScoped: p.IsScoped);

            // ADR-0063 §5: arrow-lambda parameters can also declare a default
            // value; the conversion classifier validates the constant-folded
            // default at bind time the same way it does for function-literal
            // parameters.
            conversions.BindAndAttachParameterDefaultValue(p, lambdaParam);
            parameterSymbols.Add(lambdaParam);
            parameterTypes.Add(ptype);
        }

        // ADR-0101 follow-up / issue #812: enforce variadic structural rules.
        ValidateVariadicParameterShape(syntax.Parameters);

        // Construct a placeholder synthetic FunctionSymbol whose return type
        // is being inferred. The placeholder type itself is set to
        // TypeSymbol.Error so an accidental consumer that ignores
        // `IsReturnTypeInferred` still sees a poisoned type that suppresses
        // cascading conversion diagnostics rather than a load-bearing void.
        var syntheticName = $"<lambda{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var placeholder = new FunctionSymbol(syntheticName, parameterSymbols.ToImmutable(), TypeSymbol.Error);
        placeholder.IsAsync = isAsync;
        placeholder.IsReturnTypeInferred = true;

        var outerScope = Scope;
        var outerFunction = getCurrentFunction();
        Scope = new BoundScope(outerScope);
        setCurrentFunction(placeholder);
        placeholder.LexicalEnclosingType = ResolveLexicalEnclosingType(outerFunction);
        foreach (var ps in placeholder.Parameters)
        {
            // Issue #1262: discard parameters (`_`) are non-referenceable —
            // do not add them to the lookup scope so `_` in the body does not
            // resolve to a parameter (and repeated `_` slots never collide).
            if (ps.Name == "_")
            {
                continue;
            }

            Scope.TryDeclareVariable(ps);
        }

        // ADR-0069 / issue #700, amended by issue #2442: see the matching
        // comment in BindFunctionLiteralExpression — a read-only
        // plain-variable narrowing survives into the arrow-lambda body
        // unconditionally; every other narrowing (mutable `var` locals,
        // ref/out parameters, member-access paths) is dropped exactly as
        // before.
        var savedNarrowed = binderCtx.NarrowedVariables.ToList();
        var survivingNarrowed = FilterNarrowingsSurvivingClosureCapture(savedNarrowed);
        binderCtx.NarrowedVariables.Clear();
        binderCtx.NarrowedVariables.AddRange(survivingNarrowed);

        // Issue #2027: an arrow lambda is its own goto/label frame — a
        // block-bodied arrow lambda (`x => { ...; goto foo; foo: ...; }`)
        // can contain loops and labels of its own, so isolate it from the
        // enclosing function's labels and loop stack exactly like the
        // function-literal path above.
        var savedFrame = EnterNestedFrame();

        BoundExpression boundBody;
        try
        {
            boundBody = bindLambdaBodyExpression(syntax.Body);
            FinalizeNestedFrameLabels();
        }
        finally
        {
            binderCtx.NarrowedVariables.Clear();
            binderCtx.NarrowedVariables.AddRange(savedNarrowed);
            RestoreNestedFrame(savedFrame);
        }

        Scope = outerScope;
        setCurrentFunction(outerFunction);

        // ADR-0076 / issue #716: infer the lambda's return type from
        // (a) the bound body's trailing-expression type, combined with
        // (b) the types of any `return` statements in the body. For a block-
        // body lambda with explicit `return` statements, the void trailing
        // produced by the body-binding pipeline is replaced by the common
        // type of all return-statement expressions.
        var returnType = InferLambdaReturnType(boundBody, syntax, inferReturnTypeFromBody ? null : targetFunctionType, isAsync);

        // ADR-0058: a managed-pointer (*T) cannot be used as a lambda return
        // type because CLR Func<> delegates cannot carry by-ref type arguments.
        if (returnType is ByRefTypeSymbol)
        {
            Diagnostics.ReportByRefCannotEscape(
                syntax.Body.Location,
                "a managed pointer (*T) cannot be the return type of a lambda expression");
            returnType = TypeSymbol.Error;
        }

        // For async lambdas, the observable function-type (from the caller's
        // perspective) is Task / Task<T>, matching async function literals.
        var observableReturnType = returnType;
        if (isAsync && !isAsyncIteratorReturnType(returnType) && returnType != TypeSymbol.Error)
        {
            observableReturnType = WrapAsTask(returnType);
        }

        var synthetic = new FunctionSymbol(syntheticName, placeholder.Parameters, returnType);
        synthetic.IsAsync = isAsync;
        synthetic.LexicalEnclosingType = placeholder.LexicalEnclosingType;

        // ADR-0076 / issue #716: rewrite the bound body so every return
        // statement's expression is converted to the inferred return type.
        // We deferred the conversion in BindReturnStatement; apply it now.
        boundBody = ApplyInferredReturnTypeConversion(boundBody, syntax, returnType);

        // Synthesize the lambda's BoundBlockStatement body: for void bodies, an
        // ExpressionStatement; for value bodies, a ReturnStatement.
        var bodyStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (boundBody is BoundBlockExpression blockExpr)
        {
            // Block body — emit the prefix statements, then either a return-
            // statement on the trailing expression (when the lambda returns a
            // value) or an expression-statement + void return (when it doesn't).
            foreach (var stmt in blockExpr.Statements)
            {
                bodyStatements.Add(stmt);
            }

            EmitTrailingExpression(bodyStatements, syntax, blockExpr.Expression, returnType);
        }
        else
        {
            EmitTrailingExpression(bodyStatements, syntax, boundBody, returnType);
        }

        var bodyBlock = new BoundBlockStatement(syntax.Body, bodyStatements.ToImmutable());
        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), BuildVariadicFlagsIfAny(parameterSymbols), observableReturnType);
        var captured = CollectCapturedVariables(bodyBlock, synthetic.Parameters);

        // Issue #367 / ADR-0058: by-ref-like or managed-pointer locals cannot
        // be captured by a closure; mirror the function-literal checks.
        // Issue #2330: same for an unmanaged `fixed` pointer.
        foreach (var capturedVariable in captured)
        {
            if (TypeSymbol.IsByRefLike(capturedVariable.Type))
            {
                Diagnostics.ReportByRefLikeEscape(syntax.Location, capturedVariable.Type, $"be captured by a closure (variable '{capturedVariable.Name}')");
            }
            else if (capturedVariable.Type is ByRefTypeSymbol)
            {
                Diagnostics.ReportByRefCannotEscape(
                    syntax.Location,
                    $"managed pointer '{capturedVariable.Name}' cannot be captured by a closure; the closure may outlive the pointed-to variable");
            }
            else if (capturedVariable.Type is PointerTypeSymbol)
            {
                Diagnostics.ReportFixedPointerCannotEscape(syntax.Location, capturedVariable.Name);
            }
        }

        return new BoundFunctionLiteralExpression(syntax, synthetic, fnType, bodyBlock, captured);
    }

    /// <summary>
    /// Synthesizes an "erased" function-literal adapter: a wrapper
    /// <see cref="BoundFunctionLiteralExpression"/> whose parameter
    /// types and return type are the erased-delegate slot shapes of
    /// the supplied <paramref name="targetFunctionType"/>, and whose
    /// body forwards into the original literal through value-converting
    /// <see cref="BoundConversionExpression"/>s on each parameter
    /// reference and (for non-<c>void</c> returns) on the return
    /// value. Generic <see cref="TypeParameterSymbol"/> slots widen
    /// to <see cref="TypeSymbol.Object"/> via
    /// <see cref="GetErasedDelegateSlotType"/>.
    /// </summary>
    /// <param name="literal">The original bound function literal whose
    /// signature needs to widen to a delegate-typed target.</param>
    /// <param name="targetFunctionType">The function-type shape the
    /// adapter must present to the delegate-typed parameter.</param>
    /// <returns>The adapter literal; its
    /// <see cref="BoundFunctionLiteralExpression.CapturedVariables"/>
    /// match the original literal's captures.</returns>
    public BoundFunctionLiteralExpression CreateErasedFunctionLiteralAdapter(
        BoundFunctionLiteralExpression literal,
        FunctionTypeSymbol targetFunctionType)
    {
        // ADR-0087 §3 R6: if the literal's declared signature already
        // matches the (possibly substituted) target, the adapter would
        // be an identity wrapper that erased type-parameter slots to
        // System.Object without need. Skip it — the literal flows
        // through with its concrete signature so the emitted lambda
        // MethodDef matches the runtime delegate's Invoke shape.
        if (IsIdentityAdapter(literal, targetFunctionType))
        {
            return literal;
        }

        var adapterParameters = ImmutableArray.CreateBuilder<ParameterSymbol>(literal.Function.Parameters.Length);
        var replacementMap = new Dictionary<VariableSymbol, BoundExpression>();
        for (var i = 0; i < literal.Function.Parameters.Length; i++)
        {
            var original = literal.Function.Parameters[i];
            var targetSlot = i < targetFunctionType.ParameterTypes.Length
                ? targetFunctionType.ParameterTypes[i]
                : TypeSymbol.Object;
            var adapterParameterType = GetAdapterSlotType(original.Type, targetSlot);
            var adapterParameter = new ParameterSymbol(
                original.Name,
                adapterParameterType,
                declaringSyntax: original.DeclaringSyntax,
                isScoped: original.IsScoped);
            adapterParameters.Add(adapterParameter);
            replacementMap[original] = new BoundConversionExpression(
                null,
                original.Type,
                new BoundVariableExpression(null, adapterParameter));
        }

        var adapterReturnType = targetFunctionType.ReturnType == TypeSymbol.Void
            ? TypeSymbol.Void
            : GetAdapterSlotType(literal.Function.Type, targetFunctionType.ReturnType);

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
        var adapterResultType = adapterReturnType;
        var adapterDelegateReturnType = adapterReturnType;
        if (literal.Function.IsAsync
            && targetFunctionType.ReturnType != TypeSymbol.Void
            && literal.Function.Type != null)
        {
            adapterResultType = literal.Function.Type;
            adapterDelegateReturnType = targetFunctionType.ReturnType;
        }

        // ADR-0102 follow-up / issue #818: preserve the target's variadic
        // flag shape through the erased adapter so call-site dispatch keeps
        // its pack / pass-through semantics.
        var adapterFunctionType = FunctionTypeSymbol.Get(
            adapterParameters.Select(p => p.Type).ToImmutableArray(),
            targetFunctionType.IsVariadic,
            adapterDelegateReturnType);
        var adapterFunction = new FunctionSymbol(
            $"<lambda_erased{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>",
            adapterParameters.ToImmutable(),
            adapterResultType,
            package: literal.Function.Package);
        adapterFunction.IsAsync = literal.Function.IsAsync;

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
        adapterFunction.LexicalEnclosingType = literal.Function.LexicalEnclosingType;

        var body = (BoundBlockStatement)new ErasedFunctionLiteralAdapterRewriter(replacementMap, adapterResultType)
            .RewriteStatement(literal.Body);

        return new BoundFunctionLiteralExpression(
            literal.Syntax,
            adapterFunction,
            adapterFunctionType,
            body,
            literal.CapturedVariables);
    }

    /// <summary>
    /// For an async lambda's declared return type, computes the
    /// observable return type the synthesized
    /// <see cref="FunctionTypeSymbol"/> must present to the delegate
    /// callers: <c>void</c> → <c>Task</c>, <c>T</c> → <c>Task&lt;T&gt;</c>,
    /// and erroring / un-mappable inputs pass through. Mirrors the
    /// top-level-async-function widening so async lambdas behave the
    /// same as their named counterparts (issues #290 / #291 / #530).
    /// </summary>
    /// <param name="element">The element type (the lambda's declared
    /// return type, or for top-level async functions the method's
    /// return type).</param>
    /// <param name="useValueTask">Issue #1918: when <see langword="true"/>,
    /// widen to <c>ValueTask</c> / <c>ValueTask&lt;T&gt;</c> instead of
    /// <c>Task</c> / <c>Task&lt;T&gt;</c> — set for an async function whose
    /// declared return-type clause explicitly spelled the <c>ValueTask</c>
    /// wrapper (<see cref="FunctionSymbol.AsyncReturnsValueTask"/>).</param>
    /// <returns>The Task-widened type, or
    /// <paramref name="element"/> when widening is not possible (e.g.
    /// the BCL <c>Task</c> reference is unresolved, or the element is
    /// a user-defined GSharp type — Phase 5.1 / ADR-0023).</returns>
    public TypeSymbol WrapAsTask(TypeSymbol element, bool useValueTask = false)
    {
        var wrapperName = useValueTask ? "System.Threading.Tasks.ValueTask" : "System.Threading.Tasks.Task";
        var wrapperOpenName = wrapperName + "`1";

        if (element == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        if (element == TypeSymbol.Void)
        {
            if (Scope.References.TryResolveType(wrapperName, out var taskType))
            {
                return ImportedTypeSymbol.Get(taskType);
            }

            return element;
        }

        // Issue #1785 / #2026 / #2232 / #2381: a same-compilation user type
        // anywhere in the element's structure — a bare struct/enum/interface/
        // delegate, a nullable wrapping one, a tuple element, an array/slice
        // element (`[]DiagnosticCheck`, `[N]DiagnosticCheck`), or an imported
        // generic type argument (`List[DiagnosticCheck]`,
        // `Dictionary[string,DiagnosticCheck]`, arbitrarily nested) — must
        // route through the symbolic Task<T> construction below rather than
        // the ordinary reflection-based `taskOpen.MakeGenericType(element.
        // ClrType)` path further down. Two distinct CLR-type shapes trigger
        // this, both signalling "not really closed yet":
        //   - a genuinely null ClrType (bare struct/enum/interface/tuple/
        //     array/slice — `SliceTypeSymbol`/`ArrayTypeSymbol`'s CLR shape is
        //     computed ONCE, at construction, as `elementType.ClrType?.
        //     MakeArrayType()`, so it stays null forever once captured before
        //     the element's TypeBuilder closes);
        //   - a NON-null but OBJECT-ERASED ClrType (an imported generic like
        //     `List<>` closed over a still-building same-compilation argument
        //     resolves via reflection to `List<object>`, since imported
        //     generics do not report a null ClrType the way same-compilation
        //     types do).
        // `ContainsSameCompilationUserType` (recursing through nullable/
        // array/slice/tuple/imported-generic wrappers via `GetWrappedTypes`)
        // and the emitter's `ArgIsSymbolicUserDefined` (the same recursive
        // shape, reused so the async function's OBSERVABLE return type used
        // for lambda/delegate target typing — e.g. `Task.Run(() ->
        // RunAsync())`'s `TResult` inference — matches the REAL closed
        // generic the kickoff method's CLR signature carries after emission)
        // together detect both shapes regardless of which one `element.
        // ClrType` happens to report. A still-OPEN generic type parameter
        // (e.g. the caller's own `U` substituted in for a generic async
        // callee's declared return type, or a constructed generic like
        // `Box[U]`) is handled by the sibling `ContainsTypeParameter` check.
        if ((TypeSymbol.ContainsSameCompilationUserType(element)
            || GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.ArgIsSymbolicUserDefined(element)
            || TypeSymbol.ContainsTypeParameter(element))
            && Scope.References.TryResolveType(wrapperOpenName, out var symbolicTaskOpen))
        {
            // Issue #502 / #320: a user-defined async result type has no CLR
            // Type yet, so close Task<T> over an object placeholder for
            // reflection/member lookup while preserving the symbolic result
            // type for emit-time metadata encoding.
            var erasedTask = symbolicTaskOpen.MakeGenericType(Scope.References.MapClrTypeToReferences(typeof(object)));
            return ImportedTypeSymbol.GetConstructed(
                erasedTask,
                symbolicTaskOpen,
                ImmutableArray.Create(element));
        }

        var clr = element.ClrType;
        if (clr == null)
        {
            return element;
        }

        if (Scope.References.TryResolveType(wrapperOpenName, out var taskOpen))
        {
            // Route the element CLR type through the SAME resolver as Task`1.
            // Under the SDK build path the references are loaded via a
            // MetadataLoadContext, and MakeGenericType requires the type
            // argument to originate from that same context (issues #290 and
            // #291: value-returning async funcs and imported-Task<T> awaits).
            // Issue #530: use ResolveClrTypeForGenericArg so that a nullable
            // value type (e.g. `int32?`) correctly wraps as
            // `Task<Nullable<int>>` rather than `Task<int>`.
            var elementClr = resolveClrTypeForGenericArg(element) ?? Scope.References.MapClrTypeToReferences(clr);
            var closed = taskOpen.MakeGenericType(elementClr);
            return ImportedTypeSymbol.Get(closed);
        }

        return element;
    }

    /// <summary>
    /// ADR-0069 amendment / issue #2442: computes the subset of the enclosing
    /// scope's active narrowing frames that may legally survive into a
    /// captured closure body (a lambda or local function literal).
    /// </summary>
    /// <remarks>
    /// <para>
    /// A narrowing entry keyed on <see cref="AccessPath"/> <c>p</c> survives
    /// into the closure only when <c>p.Root.IsReadOnly</c> is
    /// <see langword="true"/> AND <c>p</c> is a plain variable path
    /// (<c>!p.HasMembers</c>). <see cref="VariableSymbol.IsReadOnly"/> is the
    /// binder's own "can never be reassigned" fact — it is exactly the
    /// signal <see cref="ExpressionBinder"/> already consults to reject
    /// <em>any</em> assignment to the variable (a <c>let</c> local, or a
    /// by-value / <c>in</c> function parameter), and it is deliberately
    /// <see langword="false"/> for <c>var</c> locals, <c>ref</c>/<c>out</c>
    /// parameters, and <c>let ref</c>/<c>var ref</c> aliasing locals (which
    /// bind a managed pointer to possibly-external storage — see
    /// <c>StatementBinder.Narrowing.cs</c>'s ref-local declaration path,
    /// which passes <c>isReadOnly: false</c> unconditionally). Because a
    /// read-only binding can never be written again anywhere in its scope,
    /// the value a nil-guard or <c>is</c>-test proved at the guard site can
    /// never change later — no matter when the closure that captured it
    /// eventually runs: immediately and synchronously (<c>Task.Run(() =>
    /// …)</c>), after the enclosing function returns (an escaping/stored
    /// delegate), repeatedly (invoked from inside a loop), concurrently on
    /// another thread, or after an <c>await</c> suspension point. This is a
    /// strictly stronger guarantee than "not reassigned along this
    /// particular flow path": it holds for every path, so no additional
    /// temporal/flow proof is required.
    /// </para>
    /// <para>
    /// Member-access paths (<c>x.member</c>) are always dropped even when
    /// the root is read-only: the ADR-0069 addendum (issue #1180) already
    /// treats member reads as fragile because another call or another
    /// receiver's assignment could mutate the member through an alias the
    /// closure's own narrowing analysis never observes — the same reasoning
    /// <see cref="StatementBinder.InvalidateNarrowingsForAssignedVariables(SyntaxNode)"/>
    /// applies at ordinary statement boundaries. Widening that guarantee to
    /// "safe forever, even across a closure capture" would be unsound, so
    /// this method conservatively keeps the pre-existing behaviour (drop) for
    /// every member-bearing key.
    /// </para>
    /// </remarks>
    /// <param name="outerFrames">
    /// The enclosing scope's narrowing-frame stack at the point the closure
    /// literal is entered (a snapshot copy — not mutated by this method).
    /// </param>
    /// <returns>
    /// A new frame stack, parallel in shape to <paramref name="outerFrames"/>,
    /// containing only the entries that are sound to keep visible while
    /// binding the closure body.
    /// </returns>
    private static List<Dictionary<AccessPath, TypeSymbol>> FilterNarrowingsSurvivingClosureCapture(
        List<Dictionary<AccessPath, TypeSymbol>> outerFrames)
    {
        var result = new List<Dictionary<AccessPath, TypeSymbol>>(outerFrames.Count);
        foreach (var frame in outerFrames)
        {
            var survivors = new Dictionary<AccessPath, TypeSymbol>();
            foreach (var entry in frame)
            {
                if (!entry.Key.HasMembers && entry.Key.Root.IsReadOnly)
                {
                    survivors[entry.Key] = entry.Value;
                }
            }

            result.Add(survivors);
        }

        return result;
    }

    /// <summary>
    /// Issue #2027: snapshots the enclosing frame's <c>goto</c>/label state
    /// (<see cref="BinderContext.UserLabels"/>, <see cref="BinderContext.DefinedUserLabels"/>,
    /// <see cref="BinderContext.UnresolvedGotoLabels"/>) and its
    /// <see cref="BinderContext.LoopStack"/>, then resets all four to a
    /// fresh empty state so a nested function-literal body (a lambda OR a
    /// local function — both bind through <see cref="BindFunctionLiteralExpression"/>
    /// / <see cref="BindLambdaExpression"/>) gets its own isolated goto/label
    /// namespace and loop-label stack, matching ADR-0070's "label namespace
    /// is local to the enclosing function" rule and C#'s prohibition on
    /// cross-frame <c>goto</c> flow. Pair with <see cref="RestoreNestedFrame"/>.
    /// </summary>
    private NestedFrameState EnterNestedFrame()
    {
        var saved = new NestedFrameState(binderCtx);
        binderCtx.UserLabels.Clear();
        binderCtx.DefinedUserLabels.Clear();
        binderCtx.UnresolvedGotoLabels.Clear();
        binderCtx.LoopStack.Clear();
        return saved;
    }

    /// <summary>
    /// Issue #2027: reports GS0469 for any <c>goto</c> in the just-bound
    /// nested frame that targets a label never declared inside that SAME
    /// frame — the <see cref="StatementBinder.FinalizeUserLabels"/>
    /// equivalent for a lambda / local-function body. Must run before
    /// <see cref="RestoreNestedFrame"/> restores the outer label state, so a
    /// nested-frame goto is checked only against the nested frame's own
    /// labels (never silently satisfied by an outer label of the same
    /// name).
    /// </summary>
    private void FinalizeNestedFrameLabels()
    {
        foreach (var entry in binderCtx.UnresolvedGotoLabels)
        {
            Diagnostics.ReportUndefinedGotoLabel(entry.Value, entry.Key);
        }

        binderCtx.UnresolvedGotoLabels.Clear();
    }

    /// <summary>
    /// Issue #2027: restores the enclosing frame's goto/label state and
    /// loop stack captured by <see cref="EnterNestedFrame"/>, undoing the
    /// isolation so the enclosing function's own goto/label resolution
    /// continues exactly as if the nested body had never been bound.
    /// </summary>
    private void RestoreNestedFrame(NestedFrameState saved)
    {
        binderCtx.UserLabels.Clear();
        foreach (var kvp in saved.UserLabels)
        {
            binderCtx.UserLabels[kvp.Key] = kvp.Value;
        }

        binderCtx.DefinedUserLabels.Clear();
        foreach (var name in saved.DefinedUserLabels)
        {
            binderCtx.DefinedUserLabels.Add(name);
        }

        binderCtx.UnresolvedGotoLabels.Clear();
        foreach (var kvp in saved.UnresolvedGotoLabels)
        {
            binderCtx.UnresolvedGotoLabels[kvp.Key] = kvp.Value;
        }

        // BinderContext.LoopStack.ToArray() orders elements top-of-stack
        // first; push back bottom-first so the restored stack's top matches
        // the snapshot exactly.
        binderCtx.LoopStack.Clear();
        for (var i = saved.LoopStack.Length - 1; i >= 0; i--)
        {
            binderCtx.LoopStack.Push(saved.LoopStack[i]);
        }
    }

    private static TypeSymbol ResolveLexicalEnclosingType(FunctionSymbol outerFunction)
        => outerFunction?.ReceiverType
            ?? outerFunction?.StaticOwnerType
            ?? outerFunction?.LexicalEnclosingType;

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
    private BoundBlockStatement SynthesizeFunctionLiteralTrailingReturn(
        BoundBlockStatement body,
        FunctionLiteralExpressionSyntax syntax,
        TypeSymbol returnType)
    {
        if (returnType == TypeSymbol.Void || returnType == TypeSymbol.Error)
        {
            return body;
        }

        var statements = body.Statements;
        if (statements.Length == 0)
        {
            return body;
        }

        if (statements[^1] is not BoundExpressionStatement trailingStatement)
        {
            return body;
        }

        var trailing = trailingStatement.Expression;
        if (trailing.Type == TypeSymbol.Void || trailing.Type == TypeSymbol.Error)
        {
            return body;
        }

        var trailingConverted = trailing.Type == returnType
            ? trailing
            : conversions.BindConversion(trailingStatement.Syntax.Location, trailing, returnType);

        var rewritten = statements.ToBuilder();
        rewritten[^1] = new BoundReturnStatement(trailingStatement.Syntax, trailingConverted);
        return new BoundBlockStatement(body.Syntax, rewritten.ToImmutable());
    }

    // ADR-0076 / issue #716: synthesise the trailing return / expression-
    // statement for an arrow-lambda body. For a void- or error-typed lambda
    // we keep the body as an ExpressionStatement and (for void) follow it
    // with a `return;`; for a value-returning lambda we wrap the trailing
    // expression in a `return` statement after applying a final conversion
    // to the inferred return type.
    private void EmitTrailingExpression(
        ImmutableArray<BoundStatement>.Builder bodyStatements,
        LambdaExpressionSyntax syntax,
        BoundExpression trailing,
        TypeSymbol returnType)
    {
        // Special-case the synthetic void placeholder that BindLambdaBodyExpression
        // injects when a block body lacks a trailing expression: it carries no
        // observable value and the body has already terminated via explicit
        // `return` statements, so emitting (or converting) it is redundant.
        var isVoidPlaceholder = trailing is BoundLiteralExpression { Type: var voidLitType } && voidLitType == TypeSymbol.Void;
        if (isVoidPlaceholder)
        {
            if (returnType == TypeSymbol.Void)
            {
                bodyStatements.Add(new BoundReturnStatement(syntax.Body, expression: null));
            }

            return;
        }

        if (returnType == TypeSymbol.Void || returnType == TypeSymbol.Error)
        {
            bodyStatements.Add(new BoundExpressionStatement(syntax.Body, trailing));

            if (returnType == TypeSymbol.Void)
            {
                bodyStatements.Add(new BoundReturnStatement(syntax.Body, expression: null));
            }

            return;
        }

        var trailingConverted = trailing.Type == returnType
            ? trailing
            : conversions.BindConversion(syntax.Body.Location, trailing, returnType);
        bodyStatements.Add(new BoundReturnStatement(syntax.Body, trailingConverted));
    }

    /// <summary>
    /// ADR-0102 follow-up / issue #818: collects per-parameter variadic
    /// flags from a lambda's bound parameter list into the array shape
    /// <see cref="FunctionTypeSymbol.Get(ImmutableArray{TypeSymbol}, ImmutableArray{bool}, TypeSymbol)"/>
    /// consumes. Returns <c>default</c> when no parameter is variadic so
    /// the cache lookup stays on the non-variadic key path for the common
    /// case.
    /// </summary>
    /// <param name="parameters">The bound parameter symbol builder.</param>
    /// <returns>The per-parameter variadic flag array, or <c>default</c>.</returns>
    private static ImmutableArray<bool> BuildVariadicFlagsIfAny(ImmutableArray<ParameterSymbol>.Builder parameters)
    {
        var anyVariadic = false;
        for (var i = 0; i < parameters.Count; i++)
        {
            if (parameters[i].IsVariadic)
            {
                anyVariadic = true;
                break;
            }
        }

        if (!anyVariadic)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<bool>(parameters.Count);
        for (var i = 0; i < parameters.Count; i++)
        {
            builder.Add(parameters[i].IsVariadic);
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// ADR-0101 / issue #812 — variadic structural validation for lambda
    /// parameter lists. Mirrors
    /// <c>DeclarationBinder.ValidateVariadicParameterShape</c>: emits GS0145
    /// for a non-trailing variadic, GS0364 for two-or-more variadic
    /// parameters in the same lambda.
    /// </summary>
    private void ValidateVariadicParameterShape(SeparatedSyntaxList<ParameterSyntax> parameters)
    {
        var firstVariadicSeen = false;
        for (var i = 0; i < parameters.Count; i++)
        {
            if (!parameters[i].IsVariadic)
            {
                continue;
            }

            if (firstVariadicSeen)
            {
                Diagnostics.ReportMultipleVariadicParameters(parameters[i].Location, parameters[i].Identifier.Text);
            }

            firstVariadicSeen = true;
            if (i < parameters.Count - 1)
            {
                Diagnostics.ReportVariadicParameterMustBeLast(parameters[i].Location, parameters[i].Identifier.Text);
            }
        }
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
    private static TypeSymbol InferLambdaReturnType(
        BoundExpression boundBody,
        LambdaExpressionSyntax syntax,
        FunctionTypeSymbol targetFunctionType,
        bool isAsync)
    {
        if (boundBody is BoundErrorExpression)
        {
            return TypeSymbol.Error;
        }

        var trailingType = boundBody.Type ?? TypeSymbol.Void;
        var collector = new ReturnTypeCollector();
        if (boundBody is BoundBlockExpression block)
        {
            foreach (var stmt in block.Statements)
            {
                collector.Visit(stmt);
            }
        }

        var returnTypes = collector.ReturnTypes;
        var hasExplicitReturn = returnTypes.Count > 0;
        var trailingIsVoidPlaceholder = boundBody is BoundBlockExpression { Expression: BoundLiteralExpression { Type: var trailingLit } }
            && trailingLit == TypeSymbol.Void;

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
        var trailingExpression = boundBody is BoundBlockExpression trailingBlock
            ? trailingBlock.Expression
            : boundBody;
        var trailingIsAssignment = IsAssignmentExpression(trailingExpression);

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
        var bodyNeverCompletesNormally = !hasExplicitReturn
            && trailingIsVoidPlaceholder
            && boundBody is BoundBlockExpression neverBlock
            && neverBlock.Statements.Length > 0
            && ControlFlowGraph.AllPathsReturn(
                Lowerer.Lower(new BoundBlockStatement(syntax.Body, neverBlock.Statements)));

        // ADR-0076 §3: the candidate set.
        var candidates = new List<TypeSymbol>();
        if (!(hasExplicitReturn && trailingIsVoidPlaceholder))
        {
            // Issue #2152: a trailing assignment contributes void on the
            // target-less inference path (see the note above).
            var trailingCandidate = trailingIsAssignment && targetFunctionType == null
                ? TypeSymbol.Void
                : trailingType;
            candidates.Add(trailingCandidate);
        }

        candidates.AddRange(returnTypes);

        // If a target return type was supplied by the caller, prefer it when
        // every candidate is convertible to it — this handles the case where
        // the lambda value flows into a variable whose explicit type pins the
        // return type up-front.
        TypeSymbol targetReturn = null;
        if (targetFunctionType != null)
        {
            targetReturn = targetFunctionType.ReturnType;
            if (isAsync)
            {
                // Strip the Task / Task<T> wrap so we compare against the
                // awaited type the lambda body actually produces.
                targetReturn = UnwrapTaskReturnType(targetReturn);
            }

            // Issue #891: a throwing/never-returning body adopts the target's
            // return type directly — there is no value to reconcile, so the
            // synthesized method's signature simply matches the delegate.
            if (bodyNeverCompletesNormally && targetReturn != null && targetReturn != TypeSymbol.Error)
            {
                return targetReturn;
            }

            // Issue #889: when the target delegate returns void (e.g.
            // System.Action), an arrow lambda whose body is an expression
            // (assignment, call, increment, ...) discards that value — exactly
            // like the equivalent `func() { ... }` literal whose statement body
            // yields void. Pin the return type to void so the synthesized
            // method's signature matches the Action/void-delegate target and
            // the trailing expression is emitted as a value-discarding
            // statement (see EmitTrailingExpression).
            if (targetReturn == TypeSymbol.Void)
            {
                return TypeSymbol.Void;
            }

            if (targetReturn != null && candidates.All(c => c == TypeSymbol.Error || Conversion.Classify(c, targetReturn).IsImplicit))
            {
                return targetReturn;
            }
        }

        if (candidates.Count == 0)
        {
            return TypeSymbol.Void;
        }

        var result = candidates[0];
        for (var i = 1; i < candidates.Count; i++)
        {
            result = ComputeLambdaCommonType(result, candidates[i]);
            if (result == TypeSymbol.Error)
            {
                return TypeSymbol.Error;
            }
        }

        return result ?? TypeSymbol.Error;
    }

    // Issue #2152: recognizes every bound-node shape the binder uses to
    // represent an assignment — the simple `=` variants across the different
    // assignment targets (locals, fields, properties, indexers, CLR members,
    // pointers) as well as compound `+=`/`-=`/... forms, which the binder
    // lowers into these same nodes. Used by InferLambdaReturnType to treat a
    // trailing assignment as contributing `void` (G#'s Kotlin-like Unit
    // semantics) on the target-less inference path.
    private static bool IsAssignmentExpression(BoundExpression expression)
        => expression?.Kind is BoundNodeKind.AssignmentExpression
            or BoundNodeKind.FieldAssignmentExpression
            or BoundNodeKind.PropertyAssignmentExpression
            or BoundNodeKind.IndexAssignmentExpression
            or BoundNodeKind.ClrPropertyAssignmentExpression
            or BoundNodeKind.ClrIndexAssignmentExpression
            or BoundNodeKind.IndirectAssignmentExpression;

    // ADR-0076 / issue #716: a trimmed copy of ExpressionBinder's common-
    // type rule (ADR-0062). Kept here to avoid widening the binder API
    // surface; the rule is intentionally identical so a lambda's return-
    // type inference picks the same shape as a ternary expression mixing
    // the same operand types.
    private static TypeSymbol ComputeLambdaCommonType(TypeSymbol left, TypeSymbol right)
    {
        if (left == null || right == null)
        {
            return null;
        }

        if (left == TypeSymbol.Error || right == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        if (ReferenceEquals(left, right))
        {
            return left;
        }

        if (left == TypeSymbol.Null)
        {
            return right is NullableTypeSymbol ? right : NullableTypeSymbol.Get(right);
        }

        if (right == TypeSymbol.Null)
        {
            return left is NullableTypeSymbol ? left : NullableTypeSymbol.Get(left);
        }

        var leftToRight = Conversion.Classify(left, right);
        var rightToLeft = Conversion.Classify(right, left);

        if (leftToRight.IsImplicit && !rightToLeft.IsImplicit)
        {
            return right;
        }

        if (rightToLeft.IsImplicit && !leftToRight.IsImplicit)
        {
            return left;
        }

        if (leftToRight.IsImplicit && rightToLeft.IsImplicit)
        {
            // Issue #2498: mutually convertible nullable/non-nullable
            // references must union their annotations independent of return
            // statement order.
            return MemberLookup.MergeInferredTypeArgument(left, right);
        }

        return null;
    }

    // ADR-0076 / issue #716: strips a Task / Task<T> wrap from a target
    // function-type return slot so an async lambda's awaited type can be
    // compared against the candidates the body produces. Returns the
    // unwrapped type when the input is recognisably a Task shape;
    // otherwise returns the input unchanged.
    private static TypeSymbol UnwrapTaskReturnType(TypeSymbol returnType)
    {
        if (returnType?.ClrType == null)
        {
            return returnType;
        }

        var clr = returnType.ClrType;
        if (clr.IsSameAs(typeof(System.Threading.Tasks.Task)))
        {
            return TypeSymbol.Void;
        }

        if (clr.IsGenericType && clr.GetGenericTypeDefinition().IsSameAs(typeof(System.Threading.Tasks.Task<>)))
        {
            // The unwrapped awaited type lives in the generic argument slot.
            return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
        }

        return returnType;
    }

    // ADR-0076 / issue #716: rewrites a bound lambda body so each return
    // statement's expression is converted to the inferred return type. The
    // rewrite is a single pass and stops at nested function literals
    // (BoundTreeRewriter's default RewriteFunctionLiteralExpression keeps
    // the nested body opaque).
    private BoundExpression ApplyInferredReturnTypeConversion(
        BoundExpression boundBody,
        LambdaExpressionSyntax syntax,
        TypeSymbol returnType)
    {
        if (returnType == TypeSymbol.Error)
        {
            return boundBody;
        }

        if (boundBody is BoundBlockExpression block)
        {
            var rewriter = new ReturnConversionRewriter(conversions, syntax, returnType);
            var newStatements = ImmutableArray.CreateBuilder<BoundStatement>(block.Statements.Length);
            foreach (var stmt in block.Statements)
            {
                newStatements.Add(rewriter.RewriteStatement(stmt));
            }

            return new BoundBlockExpression(block.Syntax, newStatements.ToImmutable(), block.Expression);
        }

        return boundBody;
    }

    private static TypeSymbol GetErasedDelegateSlotType(TypeSymbol type)
    {
        return TypeSymbol.ContainsTypeParameter(type) ? TypeSymbol.Object : type;
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
    private static TypeSymbol GetAdapterSlotType(TypeSymbol literalSlot, TypeSymbol targetSlot)
    {
        if (literalSlot != null && TypeSymbol.ContainsSameCompilationUserType(literalSlot))
        {
            return literalSlot;
        }

        return GetErasedDelegateSlotType(targetSlot);
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
    private static bool IsIdentityAdapter(BoundFunctionLiteralExpression literal, FunctionTypeSymbol target)
    {
        if (target == null)
        {
            return false;
        }

        if (literal.Function.Parameters.Length != target.ParameterTypes.Length)
        {
            return false;
        }

        for (var i = 0; i < literal.Function.Parameters.Length; i++)
        {
            if (!ReferenceEquals(literal.Function.Parameters[i].Type, target.ParameterTypes[i]))
            {
                return false;
            }
        }

        var literalReturn = literal.Function.Type ?? TypeSymbol.Void;
        var targetReturn = target.ReturnType ?? TypeSymbol.Void;
        return ReferenceEquals(literalReturn, targetReturn);
    }

    /// <summary>
    /// Issue #1940: scans a generic local function's parameter types, return type, and body for any
    /// reference to a <paramref name="enclosingTypeParameters"/> member — a type parameter owned by an
    /// enclosing generic method or class rather than the local function's own <c>[T, U, …]</c> list.
    /// </summary>
    /// <param name="function">The generic local function's symbol (already carrying its own type parameters).</param>
    /// <param name="body">The bound body to scan.</param>
    /// <param name="enclosingTypeParameters">The in-scope type parameters owned by an enclosing method or class.</param>
    /// <returns>The first offending enclosing type parameter found, or <see langword="null"/> if none.</returns>
    private static TypeParameterSymbol FindEnclosingTypeParameterReference(
        FunctionSymbol function,
        BoundStatement body,
        ImmutableArray<TypeParameterSymbol> enclosingTypeParameters)
    {
        var walker = new EnclosingTypeParameterReferenceWalker(enclosingTypeParameters);
        foreach (var parameter in function.Parameters)
        {
            walker.CheckType(parameter.Type);
        }

        walker.CheckType(function.Type);
        walker.Visit(body);
        return walker.Found;
    }

    private static ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundStatement body, ImmutableArray<ParameterSymbol> parameters)
    {
        var paramSet = new HashSet<VariableSymbol>(parameters);
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();

        // Issue #1451: pre-seed the collector's `declared` set with every inline
        // `out var x` local declared *in this body*. Loop lowering (while/for/do)
        // emits the loop body before the controlling condition, so the out-var's
        // reads can be walked before its declaration; a single in-order pass would
        // then misclassify the out-var as an enclosing-scope capture. Gathering the
        // declarations up front removes that order dependency. The pre-pass is a
        // BoundTreeWalker, so it is opaque at nested function literals — out-vars
        // declared by a nested lambda stay in that lambda's scope.
        var outVarCollector = new InlineOutVarDeclarationCollector();
        outVarCollector.RewriteStatement(body);

        var collector = new CapturedVariableCollector(paramSet, seen, captured, outVarCollector.Declared);
        collector.RewriteStatement(body);
        return captured.ToImmutable();
    }

    /// <summary>
    /// Issue #2027: immutable snapshot of the four pieces of
    /// <see cref="BinderContext"/> state that must be per-frame — taken by
    /// <see cref="EnterNestedFrame"/> and consumed by
    /// <see cref="RestoreNestedFrame"/>.
    /// </summary>
    private readonly struct NestedFrameState
    {
        public NestedFrameState(BinderContext ctx)
        {
            UserLabels = new Dictionary<string, BoundLabel>(ctx.UserLabels);
            DefinedUserLabels = new HashSet<string>(ctx.DefinedUserLabels);
            UnresolvedGotoLabels = new Dictionary<string, TextLocation>(ctx.UnresolvedGotoLabels);
            LoopStack = ctx.LoopStack.ToArray();
        }

        public Dictionary<string, BoundLabel> UserLabels { get; }

        public HashSet<string> DefinedUserLabels { get; }

        public Dictionary<string, TextLocation> UnresolvedGotoLabels { get; }

        public (string LabelName, BoundLabel BreakLabel, BoundLabel ContinueLabel)[] LoopStack { get; }
    }

    // Issue #1451: collects the locals declared by inline `out var`/`out let`
    // arguments (`BoundAddressOfExpression(BoundVariableExpression(local))` where
    // the local's declaring syntax is an inline RefArgumentExpressionSyntax) within
    // a single body. Implemented as a BoundTreeRewriter (not a walker) only so it
    // shares the FunctionLiteral-opaque traversal; it never mutates the tree.
    private sealed class InlineOutVarDeclarationCollector : BoundTreeRewriter
    {
        public HashSet<VariableSymbol> Declared { get; } = [];

        protected override BoundExpression RewriteAddressOfExpression(BoundAddressOfExpression node)
        {
            if (node.Operand is BoundVariableExpression outVarExpr
                && outVarExpr.Variable.DeclaringSyntax is RefArgumentExpressionSyntax { IsInlineDeclaration: true })
            {
                this.Declared.Add(outVarExpr.Variable);
            }

            return base.RewriteAddressOfExpression(node);
        }
    }

    // ADR-0076 / issue #716: walks a bound block-expression body collecting
    // the types of each `return` statement's expression. Stops at nested
    // function literals (the body is a separate lexical scope) — the
    // BoundTreeWalker base already treats BoundNodeKind.FunctionLiteralExpression
    // as opaque, so nested lambdas' inner returns do not leak into the
    // outer lambda's candidate set.
    private sealed class ReturnTypeCollector : BoundTreeWalker
    {
        public List<TypeSymbol> ReturnTypes { get; } = [];

        protected override void VisitReturnStatement(BoundReturnStatement node)
        {
            if (node.Expression != null)
            {
                ReturnTypes.Add(node.Expression.Type ?? TypeSymbol.Void);
            }
            else
            {
                ReturnTypes.Add(TypeSymbol.Void);
            }
        }
    }

    // ADR-0076 / issue #716: a thin BoundTreeRewriter that applies the
    // inferred return-type conversion to every return-statement expression
    // it encounters, without descending into nested function literals.
    private sealed class ReturnConversionRewriter : BoundTreeRewriter
    {
        private readonly ConversionClassifier conversions;
        private readonly LambdaExpressionSyntax syntax;
        private readonly TypeSymbol returnType;

        public ReturnConversionRewriter(ConversionClassifier conversions, LambdaExpressionSyntax syntax, TypeSymbol returnType)
        {
            this.conversions = conversions;
            this.syntax = syntax;
            this.returnType = returnType;
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            if (node.Expression == null)
            {
                return node;
            }

            // Void return type: a `return expr` carrying a value is invalid;
            // the void inference came from a body with no value-bearing
            // returns. Leave the node untouched so cascading shape checks
            // surface elsewhere.
            if (returnType == TypeSymbol.Void)
            {
                return node;
            }

            if (node.Expression.Type == returnType)
            {
                return node;
            }

            var location = node.Syntax?.Location ?? syntax.Body.Location;
            var converted = conversions.BindConversion(location, node.Expression, returnType);
            return new BoundReturnStatement(node.Syntax, converted, node.IsRef);
        }
    }

    private sealed class ErasedFunctionLiteralAdapterRewriter : BoundTreeRewriter
    {
        private readonly Dictionary<VariableSymbol, BoundExpression> replacementMap;
        private readonly TypeSymbol adapterReturnType;

        public ErasedFunctionLiteralAdapterRewriter(
            Dictionary<VariableSymbol, BoundExpression> replacementMap,
            TypeSymbol adapterReturnType)
        {
            this.replacementMap = replacementMap;
            this.adapterReturnType = adapterReturnType;
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            return this.replacementMap.TryGetValue(node.Variable, out var replacement)
                ? replacement
                : node;
        }

        protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
        {
            var rewritten = (BoundReturnStatement)base.RewriteReturnStatement(node);
            if (rewritten.Expression == null)
            {
                return rewritten;
            }

            // Issue #889: when the adapter erases a value-returning literal to a
            // void-returning delegate (e.g. a `func`/arrow literal flowing into
            // System.Action), the inner `return <value>;` must drop its value:
            // evaluate the expression for its side effects, then `return;`. A
            // bare `return <value>;` against a void method is invalid IL.
            if (this.adapterReturnType == TypeSymbol.Void)
            {
                return new BoundBlockStatement(
                    rewritten.Syntax,
                    ImmutableArray.Create<BoundStatement>(
                        new BoundExpressionStatement(rewritten.Syntax, rewritten.Expression),
                        new BoundReturnStatement(rewritten.Syntax, expression: null)));
            }

            if (rewritten.Expression.Type == this.adapterReturnType)
            {
                return rewritten;
            }

            return new BoundReturnStatement(
                null,
                new BoundConversionExpression(null, this.adapterReturnType, rewritten.Expression));
        }
    }

    private sealed class CapturedVariableCollector : BoundTreeRewriter
    {
        private readonly HashSet<VariableSymbol> parameters;
        private readonly HashSet<VariableSymbol> seen;
        private readonly HashSet<VariableSymbol> declared;
        private readonly ImmutableArray<VariableSymbol>.Builder captured;

        public CapturedVariableCollector(
            HashSet<VariableSymbol> parameters,
            HashSet<VariableSymbol> seen,
            ImmutableArray<VariableSymbol>.Builder captured,
            IEnumerable<VariableSymbol> preDeclared = null)
        {
            this.parameters = parameters;
            this.seen = seen;
            this.declared = preDeclared != null ? [.. preDeclared] : [];
            this.captured = captured;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            this.declared.Add(node.Variable);
            return base.RewriteVariableDeclaration(node);
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
        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            foreach (var clause in node.CatchClauses)
            {
                if (clause.Variable != null)
                {
                    this.declared.Add(clause.Variable);
                }
            }

            return base.RewriteTryStatement(node);
        }

        protected override BoundStatement RewriteSelectStatement(BoundSelectStatement node)
        {
            foreach (var arm in node.Cases)
            {
                if (arm.Variable != null)
                {
                    this.declared.Add(arm.Variable);
                }
            }

            return base.RewriteSelectStatement(node);
        }

        protected override BoundStatement RewriteForRangeStatement(BoundForRangeStatement node)
        {
            if (node.KeyVariable != null)
            {
                this.declared.Add(node.KeyVariable);
            }

            if (node.ValueVariable != null)
            {
                this.declared.Add(node.ValueVariable);
            }

            return base.RewriteForRangeStatement(node);
        }

        /// <inheritdoc/>
        protected override BoundStatement RewriteAwaitForRangeStatement(BoundAwaitForRangeStatement node)
        {
            if (node.ValueVariable != null)
            {
                this.declared.Add(node.ValueVariable);
            }

            return base.RewriteAwaitForRangeStatement(node);
        }

        protected override BoundStatement RewriteForEllipsisStatement(BoundForEllipsisStatement node)
        {
            if (node.Variable != null)
            {
                this.declared.Add(node.Variable);
            }

            return base.RewriteForEllipsisStatement(node);
        }

        protected override BoundStatement RewriteFixedStatement(BoundFixedStatement node)
        {
            if (node.PinnedVariable != null)
            {
                this.declared.Add(node.PinnedVariable);
            }

            if (node.PointerVariable != null)
            {
                this.declared.Add(node.PointerVariable);
            }

            if (node.SourceVariable != null)
            {
                this.declared.Add(node.SourceVariable);
            }

            return base.RewriteFixedStatement(node);
        }

        protected override BoundPattern RewritePattern(BoundPattern node)
        {
            if (node is BoundTypePattern typePattern && typePattern.Variable != null)
            {
                this.declared.Add(typePattern.Variable);
            }

            return base.RewritePattern(node);
        }

        protected override BoundExpression RewriteAddressOfExpression(BoundAddressOfExpression node)
        {
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
            if (node.Operand is BoundVariableExpression outVarExpr
                && outVarExpr.Variable.DeclaringSyntax is RefArgumentExpressionSyntax { IsInlineDeclaration: true })
            {
                this.declared.Add(outVarExpr.Variable);
            }

            return base.RewriteAddressOfExpression(node);
        }

        protected override BoundExpression RewriteNullConditionalAccessExpression(BoundNullConditionalAccessExpression node)
        {
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
            if (node.Capture != null)
            {
                this.declared.Add(node.Capture);
            }

            if (node.ResultSlot != null)
            {
                this.declared.Add(node.ResultSlot);
            }

            return base.RewriteNullConditionalAccessExpression(node);
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            // Issue #523: an assignment LHS is a USE of the variable that
            // must contribute to the capture set, exactly like a
            // BoundVariableExpression. The base rewriter intentionally
            // doesn't visit `node.Variable`, so the binder otherwise
            // silently treats write-only captures (e.g. `func(x) { n = x }`)
            // as having no captures — which crashes the emitter when the
            // body still references the (boxed) target.
            this.RecordReference(node.Variable);
            return base.RewriteAssignmentExpression(node);
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            // Issue #523 (side fix): globals already live in a static field and
            // are addressable from any lambda body via ldsfld/stsfld — capturing
            // them into a closure-class field would re-introduce the snapshot
            // bug. Skip globals so the lambda reads them directly at every use.
            this.RecordReference(node.Variable);
            return node;
        }

        protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
        {
            // Issue #567: BoundFieldAssignmentExpression carries its receiver
            // as a raw VariableSymbol, not as a BoundVariableExpression. Without
            // this override the receiver variable is invisible to capture
            // analysis when the lambda body only does field writes (not reads)
            // on the variable.
            if (node.Receiver != null)
            {
                this.RecordReference(node.Receiver);
            }

            return base.RewriteFieldAssignmentExpression(node);
        }

        protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
        {
            // Issue #618: BoundIndexAssignmentExpression carries its target
            // as a raw VariableSymbol. Without this override the target
            // variable is invisible to capture analysis when the lambda body
            // only does index writes (e.g. `arr[i] = v`) on the variable.
            if (node.Target != null)
            {
                this.RecordReference(node.Target);
            }

            return base.RewriteIndexAssignmentExpression(node);
        }

        protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
        {
            // Issue #618: same as above for CLR indexer writes (e.g.
            // `dict["key"] = v` on a Dictionary).
            if (node.Target != null)
            {
                this.RecordReference(node.Target);
            }

            return base.RewriteClrIndexAssignmentExpression(node);
        }

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            // Issue #503 follow-up: a nested function literal's captures
            // must transitively contribute to the *outer* literal's capture
            // set whenever they're satisfied by neither outer parameters
            // nor outer-body local declarations. Without this, the outer
            // closure's display class has no field for the inner's free
            // variable, so the inner-literal construction inside the outer
            // Invoke body cannot locate the variable to pass to the inner
            // closure's ctor (the silent-GS9998 failure surfaced by issue
            // #503 closures inside nested lambdas).
            foreach (var nestedCapture in node.CapturedVariables)
            {
                // Issue #523 (side fix): see RewriteVariableExpression above.
                if (nestedCapture is GlobalVariableSymbol)
                {
                    continue;
                }

                if (!this.parameters.Contains(nestedCapture)
                    && !this.declared.Contains(nestedCapture)
                    && this.seen.Add(nestedCapture))
                {
                    this.captured.Add(nestedCapture);
                }
            }

            return node;
        }

        private void RecordReference(VariableSymbol variable)
        {
            // Globals are read live (see RewriteVariableExpression).
            if (variable is GlobalVariableSymbol)
            {
                return;
            }

            if (!this.parameters.Contains(variable)
                && !this.declared.Contains(variable)
                && this.seen.Add(variable))
            {
                this.captured.Add(variable);
            }
        }
    }

    // Issue #1940: walks a generic local function's bound body looking for any reference — an
    // expression's type, a local's declared type, an explicit/inferred method type argument, or a
    // type-pattern's tested type — to a type parameter owned by an enclosing generic method or class.
    // Stops at nested function literals (BoundTreeWalker already treats FunctionLiteralExpression as
    // opaque): a nested generic local function is checked independently, against its own enclosing set,
    // when it is bound.
    private sealed class EnclosingTypeParameterReferenceWalker : BoundTreeWalker
    {
        private readonly ImmutableArray<TypeParameterSymbol> enclosingTypeParameters;

        public EnclosingTypeParameterReferenceWalker(ImmutableArray<TypeParameterSymbol> enclosingTypeParameters)
        {
            this.enclosingTypeParameters = enclosingTypeParameters;
        }

        public TypeParameterSymbol Found { get; private set; }

        public void CheckType(TypeSymbol type)
        {
            if (Found != null || type == null)
            {
                return;
            }

            TypeSymbol.AnyTypeParameter(type, tp =>
            {
                if (Found == null && enclosingTypeParameters.Contains(tp))
                {
                    Found = tp;
                }

                return Found != null;
            });
        }

        public override void VisitExpression(BoundExpression node)
        {
            if (node == null || Found != null)
            {
                return;
            }

            CheckType(node.Type);
            switch (node)
            {
                case BoundCallExpression call:
                    CheckTypeArguments(call.MethodTypeArguments);
                    break;
                case BoundUserInstanceCallExpression userInstanceCall:
                    CheckTypeArguments(userInstanceCall.MethodTypeArguments);
                    break;
                case BoundImportedCallExpression importedCall:
                    CheckTypeArguments(importedCall.TypeArgumentSymbols);
                    break;
                case BoundImportedInstanceCallExpression importedInstanceCall:
                    CheckTypeArguments(importedInstanceCall.TypeArgumentSymbols);
                    break;
                case BoundIsExpression isExpression:
                    CheckType(isExpression.TargetType);
                    break;

                // Issue #1940: TypeOf/SizeOf are opaque leaves in BoundTreeWalker
                // (no VisitXxx dispatch), so their referenced type must be checked
                // here — base.VisitExpression never reaches it otherwise.
                case BoundTypeOfExpression typeOfExpression:
                    CheckType(typeOfExpression.OperandType);
                    break;
                case BoundSizeOfExpression sizeOfExpression:
                    CheckType(sizeOfExpression.MeasuredType);
                    break;

                // Issue #1940 (NB1): a constrained static-abstract call `U.M()` with
                // void return has node.Type == void, so the enclosing type parameter
                // in the constrained receiver is otherwise missed -> silent invalid IL.
                case BoundConstrainedStaticCallExpression constrainedStaticCall:
                    CheckType(constrainedStaticCall.TypeParameter);
                    break;
            }

            base.VisitExpression(node);
        }

        public override void VisitPattern(BoundPattern node)
        {
            if (node == null || Found != null)
            {
                return;
            }

            CheckType(node.Type);
            if (node is BoundTypePattern typePattern)
            {
                CheckType(typePattern.TargetType);
            }

            base.VisitPattern(node);
        }

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            if (Found != null)
            {
                return;
            }

            CheckType(node.Variable.Type);
            base.VisitVariableDeclaration(node);
        }

        private void CheckTypeArguments(ImmutableArray<TypeSymbol> typeArguments)
        {
            if (typeArguments.IsDefaultOrEmpty)
            {
                return;
            }

            foreach (var typeArgument in typeArguments)
            {
                CheckType(typeArgument);
            }
        }
    }
}
