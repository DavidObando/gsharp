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

    private SuspendingCallRewriter(FunctionSymbol container, bool containerIsRoot, ImmutableHashSet<FunctionSymbol> newlySuspending, ChannelRuntimeBinder runtime, DiagnosticBag diagnostics)
    {
        this.container = container;
        this.containerIsRoot = containerIsRoot || container.IsTopLevelEntryPoint;
        this.newlySuspending = newlySuspending;
        this.runtime = runtime;
        this.diagnostics = diagnostics;
    }

    private bool ContainerSuspends => container.IsAsyncOrSuspending;

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
            return rewritten;
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
        if (rewritten is not BoundCallExpression call || !newlySuspending.Contains(call.Function))
        {
            return rewritten;
        }

        // The bind-time ReturnType is the (possibly substituted) logical R; the
        // retyped call carries ValueTask[R] in its place.
        var logicalType = call.ReturnType ?? call.Function.Type;
        var retyped = new BoundCallExpression(call.Syntax, call.Function, call.Arguments, runtime.ValueTaskOf(logicalType), call.IsConditionalElided)
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
        if (rewritten is not BoundUserInstanceCallExpression call || !newlySuspending.Contains(call.Method))
        {
            return rewritten;
        }

        var logicalType = call.Type;
        var retyped = new BoundUserInstanceCallExpression(
            call.Syntax,
            call.Receiver,
            call.Method,
            call.Arguments,
            runtime.ValueTaskOf(logicalType),
            call.ConstrainedReceiverTypeParameter,
            call.ConstrainedInterfaceType)
        {
            MethodTypeArguments = call.MethodTypeArguments,
        };
        return Complete(retyped, logicalType, call.Method.Name);
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
