// <copyright file="SuspendingCallRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding.Suspension;

/// <summary>
/// The rewrite half of <see cref="SuspensionInference"/>. Inside one body it
/// (1) retypes every call to a function the pass just marked suspending from
/// <c>R</c> to <c>ValueTask[R]</c> and completes it — an implicit await when
/// the containing function suspends or is <c>async</c>, the blocking root
/// bridge otherwise; (2) turns a bridge the binder emitted into an await when
/// the containing function turned out to suspend; and (3) reports GS0558 for
/// every bridge that remains outside the synthesized entry point and outside
/// <c>go</c> operands. Function-literal bodies are rewritten with the
/// literal's own function as the container.
/// </summary>
internal sealed class SuspendingCallRewriter : BoundTreeRewriter
{
    private readonly FunctionSymbol container;
    private readonly bool containerIsRoot;
    private readonly ImmutableHashSet<FunctionSymbol> newlySuspending;
    private readonly ChannelRuntimeBinder runtime;
    private readonly DiagnosticBag diagnostics;
    private int goDepth;
    private int lockDepth;
    private BoundExpression? lexicalContext;

    private SuspendingCallRewriter(FunctionSymbol container, bool containerIsRoot, ImmutableHashSet<FunctionSymbol> newlySuspending, ChannelRuntimeBinder runtime, DiagnosticBag diagnostics)
    {
        this.container = container;
        this.containerIsRoot = containerIsRoot || container.IsTopLevelEntryPoint;
        this.newlySuspending = newlySuspending;
        this.runtime = runtime;
        this.diagnostics = diagnostics;
    }

    private bool ContainerSuspends => container.IsAsyncOrSuspending;

    /// <summary>
    /// Gets the context an operation or call at this position observes (ADR-0174 D7):
    /// the innermost enclosing <c>scope</c>'s <c>ctx</c>, else this function's
    /// hidden context parameter, else nothing (the call site supplies
    /// <c>Context.None</c>).
    /// </summary>
    private BoundExpression? Ambient
        => lexicalContext
            ?? (container.AmbientContextParameter is { } ambient ? new BoundVariableExpression(null, ambient) : null);

    /// <summary>Rewrites <paramref name="body"/> for <paramref name="container"/>.</summary>
    /// <param name="body">The bound body.</param>
    /// <param name="container">The function the body belongs to.</param>
    /// <param name="containerIsRoot">Whether <paramref name="container"/> is the program's entry point (the root that blocks silently).</param>
    /// <param name="newlySuspending">The functions inference marked in this pass.</param>
    /// <param name="runtime">The channel runtime binder.</param>
    /// <param name="diagnostics">Receives GS0558.</param>
    /// <returns>The rewritten body, or <paramref name="body"/> when nothing changed.</returns>
    public static BoundBlockStatement Rewrite(
        BoundBlockStatement body,
        FunctionSymbol container,
        bool containerIsRoot,
        ImmutableHashSet<FunctionSymbol> newlySuspending,
        ChannelRuntimeBinder runtime,
        DiagnosticBag diagnostics)
    {
        var rewriter = new SuspendingCallRewriter(container, containerIsRoot, newlySuspending, runtime, diagnostics);
        return (BoundBlockStatement)rewriter.RewriteStatement(body);
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteBlockStatement(BoundBlockStatement node)
    {
        // The scope lowering declares the block's `ctx` local before the try it
        // guards, so every statement after that declaration is under it.
        var outer = lexicalContext;
        try
        {
            var builder = ImmutableArray.CreateBuilder<BoundStatement>(node.Statements.Length);
            var changed = false;
            foreach (var statement in node.Statements)
            {
                var rewritten = RewriteStatement(statement);
                changed |= !ReferenceEquals(rewritten, statement);
                builder.Add(rewritten);
                if (rewritten is BoundVariableDeclaration declaration && IsContextLocal(declaration.Variable))
                {
                    lexicalContext = new BoundVariableExpression(null, declaration.Variable);
                }
            }

            return changed ? new BoundBlockStatement(node.Syntax, builder.MoveToImmutable()) : node;
        }
        finally
        {
            lexicalContext = outer;
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteGoStatement(BoundGoStatement node)
    {
        goDepth++;
        try
        {
            return base.RewriteGoStatement(node);
        }
        finally
        {
            goDepth--;
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
    {
        if (!LockRegions.IsLockRegion(node))
        {
            return base.RewriteTryStatement(node);
        }

        lockDepth++;
        try
        {
            return base.RewriteTryStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override BoundStatement RewriteFixedStatement(BoundFixedStatement node)
    {
        lockDepth++;
        try
        {
            return base.RewriteFixedStatement(node);
        }
        finally
        {
            lockDepth--;
        }
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
    {
        var inner = new SuspendingCallRewriter(node.Function, containerIsRoot: false, newlySuspending, runtime, diagnostics);
        var body = (BoundBlockStatement)inner.RewriteStatement(node.Body);
        return ReferenceEquals(body, node.Body)
            ? node
            : new BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, node.CapturedVariables);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteImportedCallExpression(BoundImportedCallExpression node)
    {
        var rewritten = (BoundImportedCallExpression)base.RewriteImportedCallExpression(node);
        if (!LockRegions.IsBlockingBridge(rewritten))
        {
            // A channel operation that no lexical scope encloses parks on this
            // function's hidden context, so the caller's scope cancels it
            // (ADR-0174 D7); one bound at a root keeps the default token.
            if (Ambient is not { } ambient)
            {
                return rewritten;
            }

            var retargeted = runtime.RetargetFacadeCancellation(rewritten, ambient);
            if (!ReferenceEquals(retargeted, rewritten))
            {
                return retargeted;
            }

            // A scope opened here inherits the caller's context, so cancelling
            // the caller collapses this block too (ADR-0174 D6/D7).
            var scopeRetargeted = runtime.RetargetScopeEnter(rewritten, ambient);
            if (!ReferenceEquals(scopeRetargeted, rewritten))
            {
                return scopeRetargeted;
            }

            // A suspending function imported from another assembly takes the
            // context as a trailing optional parameter this compilation never
            // bound; supply it so cancellation crosses the assembly boundary.
            return ChannelRuntimeBinder.SupplyImportedContext(rewritten, ambient);
        }

        var inner = rewritten.Arguments[0];
        if (goDepth > 0)
        {
            // The goroutine consumes the ValueTask itself.
            return runtime.ShapeGoOperand(inner);
        }

        if (ContainerSuspends && lockDepth == 0 && inner.Type != null)
        {
            return new BoundAwaitExpression(rewritten.Syntax, inner, rewritten.Type, ExpressionBinder.TryGetAwaiterTypeSymbol(inner.Type));
        }

        ReportResidualBridge(rewritten.Syntax, inner);
        return rewritten;
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteCallExpression(BoundCallExpression node)
    {
        var rewritten = base.RewriteCallExpression(node);
        if (rewritten is not BoundCallExpression call)
        {
            return rewritten;
        }

        // Every suspending callee — declared or inferred — takes the hidden
        // context first (ADR-0174 D7). A declared one was already completed at
        // bind time, so this is the only place its call site learns about it.
        var arguments = WithContextArgument(call.Function, call.Arguments);
        if (!newlySuspending.Contains(call.Function))
        {
            return arguments.Length == call.Arguments.Length
                ? rewritten
                : new BoundCallExpression(call.Syntax, call.Function, arguments, call.ReturnType, call.IsConditionalElided)
                {
                    StaticGenericOwnerType = call.StaticGenericOwnerType,
                    StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                    MethodTypeArguments = call.MethodTypeArguments,
                };
        }

        // The bind-time ReturnType is the (possibly substituted) logical R; the
        // retyped call carries ValueTask[R] in its place.
        var logicalType = call.ReturnType ?? call.Function.Type;
        var retyped = new BoundCallExpression(call.Syntax, call.Function, arguments, runtime.ValueTaskOf(logicalType), call.IsConditionalElided)
        {
            StaticGenericOwnerType = call.StaticGenericOwnerType,
            StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
            MethodTypeArguments = call.MethodTypeArguments,
        };
        return Complete(retyped, logicalType, call.Function.Name);
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteUserInstanceCallExpression(BoundUserInstanceCallExpression node)
    {
        var rewritten = base.RewriteUserInstanceCallExpression(node);
        if (rewritten is not BoundUserInstanceCallExpression call)
        {
            return rewritten;
        }

        var arguments = WithContextArgument(call.Method, call.Arguments);
        if (!newlySuspending.Contains(call.Method))
        {
            return arguments.Length == call.Arguments.Length
                ? rewritten
                : new BoundUserInstanceCallExpression(
                    call.Syntax,
                    call.Receiver,
                    call.Method,
                    arguments,
                    call.Type,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType)
                {
                    MethodTypeArguments = call.MethodTypeArguments,
                };
        }

        var logicalType = call.Type;
        var retyped = new BoundUserInstanceCallExpression(
            call.Syntax,
            call.Receiver,
            call.Method,
            arguments,
            runtime.ValueTaskOf(logicalType),
            call.ConstrainedReceiverTypeParameter,
            call.ConstrainedInterfaceType)
        {
            MethodTypeArguments = call.MethodTypeArguments,
        };
        return Complete(retyped, logicalType, call.Method.Name);
    }

    private static bool IsContextLocal(VariableSymbol variable)
        => variable.Type.ClrType?.FullName == "Gsharp.Concurrency.Context";

    /// <summary>
    /// Supplies the hidden trailing <c>Context</c> argument of ADR-0174 D7 when
    /// the callee carries the parameter and this call site has not been given
    /// it yet. Idempotent: a call whose arity already matches is left alone.
    /// </summary>
    /// <param name="callee">The callee.</param>
    /// <param name="arguments">The bound arguments.</param>
    /// <returns>The arguments, with the ambient context appended when one is owed.</returns>
    private ImmutableArray<BoundExpression> WithContextArgument(FunctionSymbol callee, ImmutableArray<BoundExpression> arguments)
    {
        if (callee.HiddenContextParameter == null || arguments.Length == callee.EmittedParameters.Length)
        {
            return arguments;
        }

        return arguments.Add(Ambient ?? runtime.BindContextNone());
    }

    private BoundExpression Complete(BoundExpression retyped, TypeSymbol logicalType, string calleeName)
    {
        // A `go` operand runs on the goroutine, which consumes the ValueTask
        // itself (ADR-0174 D5); it is never awaited or bridged here.
        if (goDepth > 0)
        {
            return runtime.ShapeGoOperand(retyped);
        }

        if (ContainerSuspends && lockDepth == 0)
        {
            return new BoundAwaitExpression(retyped.Syntax, retyped, logicalType, ExpressionBinder.TryGetAwaiterTypeSymbol(retyped.Type!));
        }

        var bridge = runtime.BindBlockingWait(retyped, logicalType);
        ReportResidualBridge(retyped.Syntax, retyped, calleeName);
        return bridge;
    }

    private void ReportResidualBridge(SyntaxNode? syntax, BoundExpression inner, string? calleeName = null)
    {
        if (containerIsRoot || goDepth > 0 || syntax == null)
        {
            return;
        }

        var name = calleeName ?? inner switch
        {
            BoundCallExpression c => c.Function.Name,
            BoundUserInstanceCallExpression u => u.Method.Name,
            BoundImportedCallExpression i => i.Function.Name,
            BoundImportedInstanceCallExpression ii => ii.Method.Name,
            _ => "call",
        };
        diagnostics.ReportSuspendingCallBlocks(syntax.Location, name);
    }
}
