// <copyright file="LambdaBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

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
        Func<ExpressionSyntax, BoundExpression> bindLambdaBodyExpression = null)
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
    /// <returns>The bound function-literal expression.</returns>
    public BoundExpression BindFunctionLiteralExpression(FunctionLiteralExpressionSyntax syntax)
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

            if (!seen.Add(pname))
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
            $"<lambda{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>",
            parameterSymbols.ToImmutable(),
            returnType);
        synthetic.IsAsync = syntax.IsAsync;

        // Snapshot current binder state, then push a child scope and bind
        // the body as if we were inside this synthetic function.
        var outerScope = Scope;
        var outerFunction = getCurrentFunction();
        Scope = new BoundScope(outerScope);
        setCurrentFunction(synthetic);
        foreach (var ps in synthetic.Parameters)
        {
            Scope.TryDeclareVariable(ps);
        }

        // ADR-0069 / issue #700: smart-cast narrowings do not survive into a
        // closure body — the narrowed variable could be reassigned by the
        // enclosing scope between when the closure is created and when it
        // runs. Save and restore the outer narrowing-frame stack so the
        // lambda body binds at the captured variables' declared types.
        var savedNarrowed = binderCtx.NarrowedVariables.ToList();
        binderCtx.NarrowedVariables.Clear();

        BoundStatement body;
        try
        {
            body = bindBlockStatement(syntax.Body);
        }
        finally
        {
            binderCtx.NarrowedVariables.Clear();
            binderCtx.NarrowedVariables.AddRange(savedNarrowed);
        }

        Scope = outerScope;
        setCurrentFunction(outerFunction);

        var captured = CollectCapturedVariables(body, synthetic.Parameters);

        // Issue #367: a by-ref-like (`ref struct`) local cannot be captured by a
        // closure; the capture would hoist it into a heap-allocated display
        // class, which the CLR forbids.
        // ADR-0058 / issue #376: a managed-pointer (*T / ByRefTypeSymbol) local also
        // cannot be captured — the closure may outlive the pointed-to variable.
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
        }

        return new BoundFunctionLiteralExpression(null, synthetic, fnType, (BoundBlockStatement)body, captured);
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
    /// <returns>The bound lambda as a <see cref="BoundFunctionLiteralExpression"/>.</returns>
    public BoundExpression BindLambdaExpression(LambdaExpressionSyntax syntax, FunctionTypeSymbol targetFunctionType = null)
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

            if (!seen.Add(pname))
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
        foreach (var ps in placeholder.Parameters)
        {
            Scope.TryDeclareVariable(ps);
        }

        var savedNarrowed = binderCtx.NarrowedVariables.ToList();
        binderCtx.NarrowedVariables.Clear();

        BoundExpression boundBody;
        try
        {
            boundBody = bindLambdaBodyExpression(syntax.Body);
        }
        finally
        {
            binderCtx.NarrowedVariables.Clear();
            binderCtx.NarrowedVariables.AddRange(savedNarrowed);
        }

        Scope = outerScope;
        setCurrentFunction(outerFunction);

        // ADR-0076 / issue #716: infer the lambda's return type from
        // (a) the bound body's trailing-expression type, combined with
        // (b) the types of any `return` statements in the body. For a block-
        // body lambda with explicit `return` statements, the void trailing
        // produced by the body-binding pipeline is replaced by the common
        // type of all return-statement expressions.
        var returnType = InferLambdaReturnType(boundBody, syntax, targetFunctionType, isAsync);

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
            var adapterParameterType = i < targetFunctionType.ParameterTypes.Length
                ? GetErasedDelegateSlotType(targetFunctionType.ParameterTypes[i])
                : TypeSymbol.Object;
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
            : GetErasedDelegateSlotType(targetFunctionType.ReturnType);

        // ADR-0102 follow-up / issue #818: preserve the target's variadic
        // flag shape through the erased adapter so call-site dispatch keeps
        // its pack / pass-through semantics.
        var adapterFunctionType = FunctionTypeSymbol.Get(
            adapterParameters.Select(p => p.Type).ToImmutableArray(),
            targetFunctionType.IsVariadic,
            adapterReturnType);
        var adapterFunction = new FunctionSymbol(
            $"<lambda_erased{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>",
            adapterParameters.ToImmutable(),
            adapterReturnType,
            package: literal.Function.Package);
        adapterFunction.IsAsync = literal.Function.IsAsync;

        var body = (BoundBlockStatement)new ErasedFunctionLiteralAdapterRewriter(replacementMap, adapterReturnType)
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
    /// <returns>The Task-widened type, or
    /// <paramref name="element"/> when widening is not possible (e.g.
    /// the BCL <c>Task</c> reference is unresolved, or the element is
    /// a user-defined GSharp type — Phase 5.1 / ADR-0023).</returns>
    public TypeSymbol WrapAsTask(TypeSymbol element)
    {
        if (element == TypeSymbol.Error)
        {
            return TypeSymbol.Error;
        }

        if (element == TypeSymbol.Void)
        {
            if (Scope.References.TryResolveType("System.Threading.Tasks.Task", out var taskType))
            {
                return ImportedTypeSymbol.Get(taskType);
            }

            return element;
        }

        var clr = element.ClrType;
        if (clr == null)
        {
            if (element is StructSymbol or InterfaceSymbol or EnumSymbol
                && Scope.References.TryResolveType("System.Threading.Tasks.Task`1", out var symbolicTaskOpen))
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

            return element;
        }

        if (Scope.References.TryResolveType("System.Threading.Tasks.Task`1", out var taskOpen))
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

        // ADR-0076 §3: the candidate set.
        var candidates = new List<TypeSymbol>();
        if (!(hasExplicitReturn && trailingIsVoidPlaceholder))
        {
            candidates.Add(trailingType);
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
            return right;
        }

        if (right == TypeSymbol.Null)
        {
            return left;
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
            // Pick the left arm deterministically when both sides convert.
            return left;
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

    private static ImmutableArray<VariableSymbol> CollectCapturedVariables(BoundStatement body, ImmutableArray<ParameterSymbol> parameters)
    {
        var paramSet = new HashSet<VariableSymbol>(parameters);
        var seen = new HashSet<VariableSymbol>();
        var captured = ImmutableArray.CreateBuilder<VariableSymbol>();
        var collector = new CapturedVariableCollector(paramSet, seen, captured);
        collector.RewriteStatement(body);
        return captured.ToImmutable();
    }

    // ADR-0076 / issue #716: walks a bound block-expression body collecting
    // the types of each `return` statement's expression. Stops at nested
    // function literals (the body is a separate lexical scope) — the
    // BoundTreeWalker base already treats BoundNodeKind.FunctionLiteralExpression
    // as opaque, so nested lambdas' inner returns do not leak into the
    // outer lambda's candidate set.
    private sealed class ReturnTypeCollector : BoundTreeWalker
    {
        public List<TypeSymbol> ReturnTypes { get; } = new List<TypeSymbol>();

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
            ImmutableArray<VariableSymbol>.Builder captured)
        {
            this.parameters = parameters;
            this.seen = seen;
            this.declared = new HashSet<VariableSymbol>();
            this.captured = captured;
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            this.declared.Add(node.Variable);
            return base.RewriteVariableDeclaration(node);
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
}
