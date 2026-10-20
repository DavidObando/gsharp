// <copyright file="SuspendingCallRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.Suspension

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// The rewrite half of (cref:SuspensionInference). Inside one body it
/// (1) retypes every call to a function the pass just marked suspending from
/// `R` to `ValueTask[R]` and completes it — an implicit await when
/// the containing function suspends or is `async`, the blocking root
/// bridge otherwise; (2) turns a bridge the binder emitted into an await when
/// the containing function turned out to suspend; and (3) reports GS0558 for
/// every bridge that remains outside the synthesized entry point and outside
/// `go` operands. Function-literal bodies are rewritten with the
/// literal's own function as the container.
internal class SuspendingCallRewriter : BoundTreeRewriter {
    private let container FunctionSymbol
    private let containerIsRoot bool
    private let newlySuspending ImmutableHashSet[FunctionSymbol]
    private let runtime ChannelRuntimeBinder
    private let diagnostics DiagnosticBag
    private let createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
    private var goDepth int32
    private var resultGoDepth int32
    private var lockDepth int32
    private var lexicalContext BoundExpression?

    private init(
        container FunctionSymbol,
        containerIsRoot bool,
        newlySuspending ImmutableHashSet[FunctionSymbol],
        runtime ChannelRuntimeBinder,
        diagnostics DiagnosticBag,
        createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
    ) {
        this.container = container
        this.containerIsRoot = containerIsRoot || container.IsTopLevelEntryPoint
        this.newlySuspending = newlySuspending
        this.runtime = runtime
        this.diagnostics = diagnostics
        this.createMethodGroupAdapter = createMethodGroupAdapter
    }

    private prop ContainerSuspends bool -> container.IsAsyncOrSuspending

    /// Gets the context an operation or call at this position observes (ADR-0174 D7):
    /// the innermost enclosing `scope`'s `ctx`, else this function's
    /// hidden context parameter, else nothing (the call site supplies
    /// `Context.None`).
    private prop Ambient BoundExpression? -> lexicalContext ??
        (
        if container.AmbientContextParameter is {} ambient {
            BoundVariableExpression(nil, ambient)
        } else {
            default(BoundVariableExpression?)
        }
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteBlockStatement(node BoundBlockStatement) BoundStatement {
        // The scope lowering declares the block's `ctx` local before the try it
        // guards, so every statement after that declaration is under it.
        let outer = lexicalContext
        try {
            let builder = ImmutableArray.CreateBuilder[BoundStatement](node.Statements.Length)
            var changed = false
            for statement in node.Statements {
                let rewritten = RewriteStatement(statement)
                changed |= !object.ReferenceEquals(rewritten, statement)
                builder.Add(rewritten)
                if rewritten is BoundVariableDeclaration declaration && IsContextLocal(declaration.Variable) {
                    lexicalContext = BoundVariableExpression(nil, declaration.Variable)
                }
            }
            return if changed {
                BoundBlockStatement(node.Syntax, builder.MoveToImmutable())
            } else {
                node
            }
        } finally {
            lexicalContext = outer
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteGoStatement(node BoundGoStatement) BoundStatement {
        goDepth++
        let savedContext = lexicalContext
        if node.ResultCell is {} spawning {
            resultGoDepth++
            // ADR-0174 D15: the child runs under its cell's context, not the
            // spawning block's. The cell's is linked to the scope's, so the
            // scope still collapses the child; cancelling one unread binding
            // at scope exit leaves its siblings alone.
            lexicalContext = runtime.BindAsyncLetContext(spawning)
        }
        try {
            let rewritten = cast[BoundGoStatement](base.RewriteGoStatement(node))
            if rewritten.ResultCell is not{} cell {
                return rewritten
            }
            // ADR-0174 D15: the child deposits its value into the cell. The
            // wrap happens here, not in the binder, because an inferred callee
            // is typed `R` when the binder sees the call and `ValueTask[R]`
            // once the fixed point has coloured it — a bind-time overload
            // choice would be wrong for half the programs.
            let resultType = rewritten.ResultType ?? TypeSymbol.Error
            let body = runtime.BindAsyncLetRun(cell, rewritten.Expression, resultType)
            return BoundGoStatement(
                rewritten.Syntax,
                body,
                rewritten.Sink,
                rewritten.ResultCell,
                resultType,
                rewritten.LexicalEnclosingType
            )
        } finally {
            if node.ResultCell != nil {
                resultGoDepth--
            }
            lexicalContext = savedContext
            goDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
        if !LockRegions.IsLockRegion(node) {
            return base.RewriteTryStatement(node)
        }
        lockDepth++
        try {
            return base.RewriteTryStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteFixedStatement(node BoundFixedStatement) BoundStatement {
        lockDepth++
        try {
            return base.RewriteFixedStatement(node)
        } finally {
            lockDepth--
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteFunctionLiteralExpression(node BoundFunctionLiteralExpression) BoundExpression {
        let inner = SuspendingCallRewriter(
            node.Function,
            containerIsRoot: false,
            newlySuspending,
            runtime,
            diagnostics,
            createMethodGroupAdapter
        )
        // ADR-0174 D7: a suspending delegate carries the context active when
        // the delegate is created, not the context active when it is invoked.
        let capturedContext = Ambient ?? runtime.BindContextNone()
        inner.lexicalContext = capturedContext
        let body = cast[BoundBlockStatement](inner.RewriteStatement(node.Body))
        if object.ReferenceEquals(body, node.Body) {
            return node
        }
        var capturedVariables = node.CapturedVariables
        for variable in GoCapturedVariableCollector.CollectCapturedVariables(capturedContext) {
            if !capturedVariables.Contains(variable) {
                capturedVariables = capturedVariables.Add(variable)
            }
        }
        return BoundFunctionLiteralExpression(node.Syntax, node.Function, node.FunctionType, body, capturedVariables)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteMethodGroupExpression(node BoundMethodGroupExpression) BoundExpression {
        if node.Function?.IsSuspending == true && node.FunctionType != nil {
            let adapter = createMethodGroupAdapter(container, node)
            if !object.ReferenceEquals(adapter, node) {
                return RewriteExpression(adapter)
            }
        }
        return base.RewriteMethodGroupExpression(node)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteClrStaticCallExpression(node BoundClrStaticCallExpression) BoundExpression {
        let rewritten = cast[BoundClrStaticCallExpression](base.RewriteClrStaticCallExpression(node))
        return if Ambient is {} ambient {
            ChannelRuntimeBinder.SupplyImportedContext(rewritten, ambient)
        } else {
            cast[BoundExpression](rewritten)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteImportedInstanceCallExpression(
        node BoundImportedInstanceCallExpression
    ) BoundExpression {
        let rewritten = cast[BoundImportedInstanceCallExpression](base.RewriteImportedInstanceCallExpression(node))
        // ADR-0174 D8: `case cancelled` observes the ambient context. Whether
        // there is one is only known here, after the fixed point has decided
        // which functions carry a context; in a boundary or a root without a
        // `scope` the arm would silently never be taken.
        if Ambient == nil && ChannelRuntimeBinder.IsSelectAddCancelled(rewritten) &&
            rewritten.Syntax is SelectCaseSyntax syntax {
            diagnostics.ReportSelectCancelledArmNeedsContext(syntax.Keyword.Location)
        }
        // A suspending instance method imported from another assembly takes
        // the context as a trailing optional parameter this compilation never
        // bound; supply it so cancellation crosses the assembly boundary, on
        // an ordinary call and on `base.M()` alike (issue #4392).
        return if Ambient is {} ambient {
            ChannelRuntimeBinder.SupplyImportedContext(rewritten, ambient)
        } else {
            cast[BoundExpression](rewritten)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteImportedCallExpression(node BoundImportedCallExpression) BoundExpression {
        let rewritten = cast[BoundImportedCallExpression](base.RewriteImportedCallExpression(node))
        if !LockRegions.IsBlockingBridge(rewritten) {
            // A channel operation that no lexical scope encloses parks on this
            // function's hidden context, so the caller's scope cancels it
            // (ADR-0174 D7); one bound at a root keeps the default token.
            if Ambient is not{} ambient {
                return rewritten
            }
            let retargeted = runtime.RetargetFacadeCancellation(rewritten, ambient)
            if !object.ReferenceEquals(retargeted, rewritten) {
                return retargeted
            }
            // A scope opened here inherits the caller's context, so cancelling
            // the caller collapses this block too (ADR-0174 D6/D7).
            let scopeRetargeted = runtime.RetargetScopeEnter(rewritten, ambient)
            if !object.ReferenceEquals(scopeRetargeted, rewritten) {
                return scopeRetargeted
            }
            // A select bound outside any lexical `scope` parks under the
            // container's context, so cancelling the caller unwinds it and a
            // `case cancelled` arm is reachable (ADR-0174 D7/D8).
            let rentRetargeted = runtime.RetargetSelectRent(rewritten, ambient)
            if !object.ReferenceEquals(rentRetargeted, rewritten) {
                return rentRetargeted
            }
            // A suspending function imported from another assembly takes the
            // context as a trailing optional parameter this compilation never
            // bound; supply it so cancellation crosses the assembly boundary.
            return ChannelRuntimeBinder.SupplyImportedContext(rewritten, ambient)
        }
        let inner = rewritten.Arguments[0]
        if goDepth > 0 {
            // The goroutine consumes the ValueTask itself. An `async let` keeps
            // the result, so it must not be discarded on the way (ADR-0174 D15).
            return if resultGoDepth > 0 {
                inner
            } else {
                runtime.ShapeGoOperand(inner)
            }
        }
        if ContainerSuspends && lockDepth == 0 && inner.Type != nil {
            return CompleteAwait(rewritten.Syntax, inner, rewritten.Type)
        }
        ReportResidualBridge(rewritten.Syntax, inner)
        return rewritten
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteAwaitExpression(node BoundAwaitExpression) BoundExpression {
        let rewritten = base.RewriteAwaitExpression(node)
        if node.Syntax == nil {
            return rewritten
        }
        // ADR-0174 D4 / errata 10: a `lock` body's monitor is thread-affine and
        // reentrant, which is why a channel operation there compiles to the
        // BLOCKING form rather than parking. An explicit await has no blocking
        // form to fall back to — it would resume on another thread and exit a
        // monitor it does not hold — so it is rejected wherever it appears,
        // including in a body that is already `async` or suspending. C# spells
        // the same rule CS1996.
        if lockDepth > 0 {
            diagnostics.ReportAwaitInsideLockBody(node.Syntax!!.Location)
            return rewritten
        }
        // ADR-0174 D5: `BindGoStatement` strips the operand's OWN await — the
        // goroutine consumes that task — so an await still here is nested in
        // the operand's arguments, and no function kind can lower it: the
        // spiller does not hoist out of a `go`, so before this check the shape
        // reached the emitter as GS9998 even from an `async func`.
        if goDepth > 0 {
            diagnostics.ReportAwaitInsideGoOperand(node.Syntax!!.Location)
            return rewritten
        }
        // ADR-0174 D4, the `await g()` row: the binder lets an await stand in a
        // plain `func` and leaves the coloring to inference, which has now run.
        // A container that still does not suspend is a boundary — inference may
        // not change its signature — and an await there has nowhere to suspend,
        // so the author must choose the coloring. This holds inside a `go`
        // operand too: the operand's own await was stripped at bind time, so a
        // surviving one is nested, and the spiller hoists it into THIS body.
        if !ContainerSuspends {
            diagnostics.ReportAwaitAtSuspensionBoundary(node.Syntax!!.Location, container.Name)
        }
        return rewritten
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteCallExpression(node BoundCallExpression) BoundExpression {
        let rewritten = base.RewriteCallExpression(node)
        if rewritten is not BoundCallExpression call {
            return rewritten
        }
        // Every suspending callee — declared or inferred — takes the hidden
        // context first (ADR-0174 D7). A declared one was already completed at
        // bind time, so this is the only place its call site learns about it.
        let arguments = WithContextArgument(call.Function, call.Arguments)
        if !newlySuspending.Contains(call.Function) {
            return if arguments.Length == call.Arguments.Length {
                rewritten
            } else {
                CopySelectedCall(call, arguments, call.ReturnType)
            }
        }
        // The bind-time ReturnType is the (possibly substituted) logical R; the
        // retyped call carries ValueTask[R] in its place.
        let logicalType = call.ReturnType ?? call.Function.Type
        let retyped = CopySelectedCall(call, arguments, runtime.ValueTaskOf(logicalType))
        return Complete(retyped, logicalType, call.Function.Name)
    }

    private func CopySelectedCall(
        call BoundCallExpression,
        arguments ImmutableArray[BoundExpression],
        returnType TypeSymbol?
    ) BoundCallExpression {
        let copy = BoundCallExpression(call.Syntax, call.Function, arguments, returnType, call.IsConditionalElided){
            StaticGenericOwnerType = call.StaticGenericOwnerType,
            StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
            MethodTypeArguments = call.MethodTypeArguments
        }
        call.CopyStaticQualifierTo(copy)
        return copy
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteUserInstanceCallExpression(node BoundUserInstanceCallExpression) BoundExpression {
        let rewritten = base.RewriteUserInstanceCallExpression(node)
        if rewritten is not BoundUserInstanceCallExpression call {
            return rewritten
        }
        let arguments = WithContextArgument(call.Method, call.Arguments)
        if !newlySuspending.Contains(call.Method) {
            return if arguments.Length == call.Arguments.Length {
                rewritten
            } else {
                cast[BoundExpression](
                    BoundUserInstanceCallExpression(
                        call.Syntax,
                        call.Receiver,
                        call.Method,
                        arguments,
                        call.Type,
                        call.ConstrainedReceiverTypeParameter,
                        call.ConstrainedInterfaceType
                    ){MethodTypeArguments = call.MethodTypeArguments}
                )
            }
        }
        let logicalType = call.Type
        let retyped = BoundUserInstanceCallExpression(
            call.Syntax,
            call.Receiver,
            call.Method,
            arguments,
            runtime.ValueTaskOf(logicalType),
            call.ConstrainedReceiverTypeParameter,
            call.ConstrainedInterfaceType
        ){MethodTypeArguments = call.MethodTypeArguments}
        return Complete(retyped, logicalType, call.Method.Name)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    protected override func RewriteBaseClassCallExpression(node BoundBaseClassCallExpression) BoundExpression {
        // Issue #4392: `base.M()` is a non-virtual instance call, and a
        // suspending base method owes it the hidden context exactly like an
        // ordinary instance call. A base auto-property accessor has no method.
        let rewritten = base.RewriteBaseClassCallExpression(node)
        if !(rewritten is BoundBaseClassCallExpression{Method: {} method} call) {
            return rewritten
        }
        let arguments = WithContextArgument(method, call.Arguments)
        let retype = newlySuspending.Contains(method)
        if !retype && arguments.Length == call.Arguments.Length {
            return rewritten
        }
        let logicalType = call.Type
        let result = BoundBaseClassCallExpression(
            call.Syntax ?? node.Syntax,
            call.Receiver,
            call.BaseClass,
            method,
            arguments,
            if retype {
                runtime.ValueTaskOf(logicalType)
            } else {
                call.Type
            },
            call.Property,
            call.IsSetterAccessor
        ){MethodTypeArguments = call.MethodTypeArguments}
        return if retype {
            Complete(result, logicalType, method.Name)
        } else {
            cast[BoundExpression](result)
        }
    }

    /// Supplies the hidden trailing `Context` argument of ADR-0174 D7 when
    /// the callee carries the parameter and this call site has not been given
    /// it yet. Idempotent: a call whose arity already matches is left alone.
    /// @param callee The callee.
    /// @param arguments The bound arguments.
    /// @returns The arguments, with the ambient context appended when one is owed.
    private func WithContextArgument(callee FunctionSymbol, arguments ImmutableArray[BoundExpression]) ImmutableArray[
        BoundExpression
    ] {
        if callee.HiddenContextParameter == nil || arguments.Length == callee.EmittedParameters.Length {
            return arguments
        }
        return arguments.Add(Ambient ?? runtime.BindContextNone())
    }

    private func Complete(retyped BoundExpression, logicalType TypeSymbol, calleeName string) BoundExpression {
        // A `go` operand runs on the goroutine, which consumes the ValueTask
        // itself (ADR-0174 D5); it is never awaited or bridged here. An
        // `async let` keeps the result, so it must not be discarded on the way
        // (ADR-0174 D15).
        if goDepth > 0 {
            return if resultGoDepth > 0 {
                retyped
            } else {
                runtime.ShapeGoOperand(retyped)
            }
        }
        if ContainerSuspends && lockDepth == 0 {
            return CompleteAwait(retyped.Syntax, retyped, logicalType)
        }
        let bridge = runtime.BindBlockingWait(retyped, logicalType)
        ReportResidualBridge(retyped.Syntax, retyped, calleeName)
        return bridge
    }

    private func CompleteAwait(
        syntax SyntaxNode?,
        operand BoundExpression,
        logicalType TypeSymbol
    ) BoundAwaitExpression {
        let completed = BoundAwaitExpression(
            syntax,
            operand,
            logicalType,
            ExpressionBinder.TryGetAwaiterTypeSymbol(operand.Type)
        )
        completed.RecordImplicitCompletion(operand)
        return completed
    }

    private func ReportResidualBridge(syntax SyntaxNode?, inner BoundExpression, calleeName string? = nil) {
        if containerIsRoot || goDepth > 0 || syntax == nil {
            return
        }
        let name = calleeName ?? switch inner {
            case c is BoundCallExpression: c.Function.Name
            case u is BoundUserInstanceCallExpression: u.Method.Name
            case i is BoundImportedCallExpression: i.Function.Name
            case ii is BoundImportedInstanceCallExpression: ii.Method.Name
            case BoundBaseClassCallExpression{Method: {} baseMethod}: baseMethod.Name
            default: "call"
        }
        diagnostics.ReportSuspendingCallBlocks(syntax.Location, name)
    }

    shared {
        /// Rewrites [`body`](paramref) for [`container`](paramref).
        /// @param body The bound body.
        /// @param container The function the body belongs to.
        /// @param containerIsRoot Whether [`container`](paramref) is the program's entry point (the root that
        /// blocks silently).
        /// @param newlySuspending The functions inference marked in this pass.
        /// @param runtime The channel runtime binder.
        /// @param diagnostics Receives GS0558.
        /// @param createMethodGroupAdapter Creates a verifier-safe adapter after suspension inference has
        /// finalized a method's emitted shape.
        /// @returns The rewritten body, or [`body`](paramref) when nothing changed.
        func Rewrite(
            body BoundBlockStatement,
            container FunctionSymbol,
            containerIsRoot bool,
            newlySuspending ImmutableHashSet[FunctionSymbol],
            runtime ChannelRuntimeBinder,
            diagnostics DiagnosticBag,
            createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
        ) BoundBlockStatement {
            let rewriter = SuspendingCallRewriter(
                container,
                containerIsRoot,
                newlySuspending,
                runtime,
                diagnostics,
                createMethodGroupAdapter
            )
            return cast[BoundBlockStatement](rewriter.RewriteStatement(body))
        }

        /// Rewrites a field initializer after suspension inference.
        /// @param expression The initializer expression.
        /// @param container A synthetic container carrying the field owner's lexical context.
        /// @param newlySuspending The functions inference marked in this pass.
        /// @param runtime The channel runtime binder.
        /// @param diagnostics Receives suspension diagnostics.
        /// @param createMethodGroupAdapter Creates a verifier-safe inferred-suspension adapter.
        /// @returns The rewritten initializer.
        func RewriteInitializer(
            expression BoundExpression,
            container FunctionSymbol,
            newlySuspending ImmutableHashSet[FunctionSymbol],
            runtime ChannelRuntimeBinder,
            diagnostics DiagnosticBag,
            createMethodGroupAdapter(FunctionSymbol, BoundMethodGroupExpression) -> BoundExpression
        ) BoundExpression {
            let rewriter = SuspendingCallRewriter(
                container,
                containerIsRoot: false,
                newlySuspending,
                runtime,
                diagnostics,
                createMethodGroupAdapter
            )
            return rewriter.RewriteExpression(expression)
        }

        private func IsContextLocal(variable VariableSymbol) bool -> variable
            .Type
            .ClrType
            ?.FullName == "Gsharp.Concurrency.Context"
    }
}
