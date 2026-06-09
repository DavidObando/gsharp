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
    public LambdaBinder(
        BinderContext binderCtx,
        ConversionClassifier conversions,
        Func<BlockStatementSyntax, BoundStatement> bindBlockStatement,
        Func<TypeClauseSyntax, TypeSymbol> bindTypeClause,
        Func<TypeClauseSyntax, bool, TypeSymbol> bindReturnTypeClause,
        Func<TypeSymbol, bool> isAsyncIteratorReturnType,
        Func<TypeSymbol, Type> resolveClrTypeForGenericArg,
        Func<FunctionSymbol> getCurrentFunction,
        Action<FunctionSymbol> setCurrentFunction)
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
            if (p.IsVariadic)
            {
                Diagnostics.ReportVariadicParameterNotSupportedHere(p.Location, pname);
            }

            if (!seen.Add(pname))
            {
                Diagnostics.ReportParameterAlreadyDeclared(p.Location, pname);
            }

            var lambdaParam = new ParameterSymbol(pname, ptype, declaringSyntax: p.Identifier, isScoped: p.IsScoped);

            // ADR-0063 §5: function-literal (lambda) parameters can declare a
            // default value; lambdas can be invoked through their delegate type
            // which honors the default at the call site.
            conversions.BindAndAttachParameterDefaultValue(p, lambdaParam);
            parameterSymbols.Add(lambdaParam);
            parameterTypes.Add(ptype);
        }

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

        var fnType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), observableReturnType);
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

        var body = bindBlockStatement(syntax.Body);

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
        var adapterFunctionType = FunctionTypeSymbol.Get(
            adapterParameters.Select(p => p.Type).ToImmutableArray(),
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
            // Phase 5.1 limitation (see ADR-0023): wrapping a user-defined
            // GSharp type as Task[T] requires interop work that is deferred.
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

    private static TypeSymbol GetErasedDelegateSlotType(TypeSymbol type)
    {
        return TypeSymbol.ContainsTypeParameter(type) ? TypeSymbol.Object : type;
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
            if (this.adapterReturnType == TypeSymbol.Void || rewritten.Expression == null)
            {
                return rewritten;
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
