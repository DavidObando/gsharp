// <copyright file="ChannelRuntimeBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Lowers channel operations onto the <c>Gsharp.Runtime.Channels</c> runtime
/// (ADR-0174 D1/D2/D12) as ordinary imported calls and constructions, so the
/// proven imported-member emit path handles metadata, symbolic type arguments,
/// and load contexts, and no channel IL is hand-rolled.
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item><c>chan[T](n)</c> → <c>new Gsharp.Concurrency.Chan&lt;T&gt;(n)</c>, typed as the
/// runtime class so <c>Length()</c>/<c>Capacity</c>/<c>Close()</c> bind as ordinary members;</item>
/// <item><c>&lt;-ch</c> → <c>ChannelOps.Receive&lt;T&gt;(ch, default)</c> (zero on closed, no exception);</item>
/// <item><c>let v, ok = &lt;-ch</c> → <c>ChannelOps.Receive2&lt;T&gt;(ch, default)</c>, a <c>(T, bool)</c> tuple;</item>
/// <item><c>ch &lt;- v</c> → <c>ChannelOps.Send&lt;T&gt;(ch, v, default)</c>;</item>
/// <item><c>close</c> (member <c>Close()</c> on a <c>chan[T]</c>) → <c>ChannelOps.Close&lt;T&gt;(ch)</c>.</item>
/// </list>
/// <para>The overload is chosen by the handle's direction: a <c>chan[T]</c> or a
/// constructed <c>Chan&lt;T&gt;</c> uses the <c>Channel&lt;T&gt;</c> overloads, an
/// <c>in chan[T]</c> the <c>ChannelReader&lt;T&gt;</c> ones, an <c>out chan[T]</c> the
/// <c>ChannelWriter&lt;T&gt;</c> ones. The runtime dispatches the fast path versus the
/// documented foreign-channel fallback (D2's matrix).</para>
/// <para>The blocking <c>Receive</c>/<c>Send</c> forms are the Phase 2 target;
/// Phase 3's suspension rewriter swaps them for the <c>…Async</c> forms and awaits.</para>
/// <para>Element types are projected onto the reference set exactly as an
/// explicit generic type argument is (issue #320): a CLR-backed element is
/// mapped into the resolver's load context; a same-compilation or
/// type-parameter element closes the generic over an <c>object</c> placeholder
/// and travels as a symbolic type argument the emitter re-encodes.</para>
/// </remarks>
internal sealed class ChannelRuntimeBinder
{
    /// <summary>The runtime's constructed channel class.</summary>
    public const string ChanTypeName = ChannelTypeSymbol.ConstructedChannelFullName;

    /// <summary>The runtime's static operation facade.</summary>
    public const string ChannelOpsTypeName = "Gsharp.Concurrency.ChannelOps";

    private const string CancellationTokenTypeName = "System.Threading.CancellationToken";

    private readonly ReferenceResolver references;
    private readonly Type? chanOpen;
    private readonly Type? channelOps;
    private readonly Type? cancellationToken;
    private readonly Type? valueTaskOpen;
    private readonly Type? valueTask;
    private readonly Type? blockingType;
    private readonly Type? scopeFrameType;
    private readonly Type? contextType;
    private readonly Type? goroutineRuntimeType;
    private ImportedClassSymbol? channelOpsClass;
    private ImportedClassSymbol? blockingClass;
    private ImportedClassSymbol? scopeFrameClass;
    private ImportedClassSymbol? goroutineRuntimeClass;

    /// <summary>Initializes a new instance of the <see cref="ChannelRuntimeBinder"/> class.</summary>
    /// <param name="references">The compilation's reference resolver.</param>
    public ChannelRuntimeBinder(ReferenceResolver references)
    {
        this.references = references;
        references.TryResolveType(ChanTypeName, out chanOpen);
        references.TryResolveType(ChannelOpsTypeName, out channelOps);
        references.TryResolveType(CancellationTokenTypeName, out cancellationToken);
        references.TryResolveType("System.Threading.Tasks.ValueTask`1", out valueTaskOpen);
        references.TryResolveType("System.Threading.Tasks.ValueTask", out valueTask);
        references.TryResolveType("Gsharp.Concurrency.Blocking", out blockingType);
        references.TryResolveType("Gsharp.Concurrency.ScopeFrame", out scopeFrameType);
        references.TryResolveType("Gsharp.Concurrency.Context", out contextType);
        references.TryResolveType("Gsharp.Concurrency.GoroutineRuntime", out goroutineRuntimeType);
    }

    /// <summary>Gets a value indicating whether the runtime assembly is in the reference set.</summary>
    public bool IsAvailable => chanOpen != null && channelOps != null && cancellationToken != null;

    /// <summary>Gets the runtime's <c>ScopeFrame</c> type symbol (ADR-0174 D6).</summary>
    public TypeSymbol ScopeFrameType => TypeSymbol.FromClrType(Required(scopeFrameType));

    /// <summary>Gets the runtime's <c>Context</c> type symbol (ADR-0174 D6/D7).</summary>
    public TypeSymbol ContextType => TypeSymbol.FromClrType(Required(contextType));

    /// <summary>Gets the CLR <c>ValueTask</c> type symbol.</summary>
    public TypeSymbol ValueTaskType => TypeSymbol.FromClrType(Required(valueTask));

    /// <summary>Binds <c>ScopeFrame.Enter(ambient)</c>; the ambient context is <c>null</c> (= <c>Context.None</c>) until the hidden context parameter lands.</summary>
    /// <param name="syntax">The scope syntax.</param>
    /// <param name="ambient">The enclosing scope's <c>ctx</c>, or <c>null</c> at an outermost scope (ambient <c>Context.None</c>).</param>
    /// <returns>A call typed <c>ScopeFrame</c>.</returns>
    public BoundExpression BindScopeEnter(SyntaxNode? syntax, BoundExpression? ambient)
    {
        var frame = Required(scopeFrameType);
        var enter = frame.GetMethod("Enter", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("ScopeFrame.Enter is missing from the channel runtime.");
        scopeFrameClass ??= new ImportedClassSymbol(frame, declaration: null, references: references);
        var function = new ImportedFunctionSymbol("Enter", scopeFrameClass, enter, declaration: null, returnTypeOverride: ScopeFrameType);
        return new BoundImportedCallExpression(syntax, function, ImmutableArray.Create(ambient ?? new BoundDefaultExpression(null, ContextType)));
    }

    /// <summary>Binds <c>Context.None</c>, the ambient context of a call site that no scope encloses (ADR-0174 D7).</summary>
    /// <returns>A static property read typed <c>Context</c>.</returns>
    public BoundExpression BindContextNone()
    {
        var property = Required(contextType).GetProperty("None", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("Context.None is missing from the channel runtime.");
        return new BoundClrPropertyAccessExpression(null, receiver: null, property, ContextType, staticContainerType: ContextType);
    }

    /// <summary>
    /// Binds <c>ambient.ShieldedForCleanup()</c> — the cancellation-immune
    /// context a <c>defer</c> body runs under, bounded by the host's grace
    /// budget (ADR-0174 D7). Shielding <c>Context.None</c> yields
    /// <c>Context.None</c>, so cleanup outside any scope costs nothing.
    /// </summary>
    /// <param name="ambient">The context being unwound, or <c>null</c> for none.</param>
    /// <returns>A call typed <c>Context</c>.</returns>
    public BoundExpression BindShieldedContext(BoundExpression? ambient)
    {
        var method = Required(contextType).GetMethod("ShieldedForCleanup", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Context.ShieldedForCleanup is missing from the channel runtime.");
        return new BoundImportedInstanceCallExpression(
            null,
            ambient ?? BindContextNone(),
            method,
            ContextType,
            ImmutableArray<BoundExpression>.Empty);
    }

    /// <summary>Binds <c>shield.Dispose()</c>, releasing a cleanup shield's grace timer.</summary>
    /// <param name="shield">The shield local.</param>
    /// <returns>A call typed <c>void</c>.</returns>
    public BoundExpression BindContextDispose(VariableSymbol shield)
    {
        var method = Required(contextType).GetMethod("Dispose", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Context.Dispose is missing from the channel runtime.");
        return new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, shield),
            method,
            TypeSymbol.Void,
            ImmutableArray<BoundExpression>.Empty);
    }

    /// <summary>Binds <c>frame.Context</c>, the block's implicit <c>ctx</c> (ADR-0174 D6).</summary>
    /// <param name="frame">The frame local.</param>
    /// <returns>A property read typed <c>Context</c>.</returns>
    public BoundExpression BindScopeContext(VariableSymbol frame)
    {
        var property = Required(scopeFrameType).GetProperty("Context", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("ScopeFrame.Context is missing from the channel runtime.");
        return new BoundClrPropertyAccessExpression(null, new BoundVariableExpression(null, frame), property, ContextType);
    }

    /// <summary>Binds the blocking <c>frame.Exit(bodyException)</c>; the async pipeline turns it into an awaited <c>ExitAsync</c>.</summary>
    /// <param name="frame">The frame local.</param>
    /// <param name="bodyException">The local holding the body's exception, or <c>null</c>.</param>
    /// <returns>A call typed <c>void</c>.</returns>
    public BoundExpression BindScopeExit(VariableSymbol frame, VariableSymbol bodyException)
    {
        var exit = Required(scopeFrameType).GetMethod("Exit", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("ScopeFrame.Exit is missing from the channel runtime.");
        return new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, frame),
            exit,
            TypeSymbol.Void,
            ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, bodyException)));
    }

    /// <summary>Recognizes the blocking scope exit the binder emits.</summary>
    /// <param name="call">An imported instance call.</param>
    /// <returns><see langword="true"/> for <c>ScopeFrame.Exit</c>.</returns>
    public static bool IsScopeExit(BoundImportedInstanceCallExpression call)
        => call.Method.Name == "Exit" && call.Method.DeclaringType?.FullName == "Gsharp.Concurrency.ScopeFrame";

    /// <summary>Turns a blocking scope exit into the awaited <c>ExitAsync</c> (inside a state machine).</summary>
    /// <param name="exit">The blocking exit call.</param>
    /// <returns>An await expression typed <c>void</c>.</returns>
    public BoundExpression BindScopeExitAwait(BoundImportedInstanceCallExpression exit)
    {
        var exitAsync = Required(scopeFrameType).GetMethod("ExitAsync", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("ScopeFrame.ExitAsync is missing from the channel runtime.");
        var call = new BoundImportedInstanceCallExpression(exit.Syntax, exit.Receiver, exitAsync, ValueTaskType, exit.Arguments);
        return Await(exit.Syntax, call, TypeSymbol.Void);
    }

    /// <summary>
    /// Shapes a <c>go</c> operand for the goroutine body, which returns a plain
    /// <c>ValueTask</c> (ADR-0174 D5): a <c>ValueTask</c> passes through, a
    /// <c>ValueTask[T]</c> is discarded through <c>GoroutineRuntime.Discard</c>, a
    /// <c>Task</c> is wrapped, and anything else (a void call) is left for the
    /// closure to run as a statement.
    /// </summary>
    /// <param name="operand">The bound go operand.</param>
    /// <returns>The shaped operand.</returns>
    public BoundExpression ShapeGoOperand(BoundExpression operand)
    {
        var type = operand.Type;
        if (type == null || type == TypeSymbol.Error || type == TypeSymbol.Void)
        {
            return operand;
        }

        var clr = type.ClrType;
        if (clr == null)
        {
            return operand;
        }

        var runtime = Required(goroutineRuntimeType);
        goroutineRuntimeClass ??= new ImportedClassSymbol(runtime, declaration: null, references: references);
        if (clr.FullName == "System.Threading.Tasks.ValueTask")
        {
            return operand;
        }

        if (clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Threading.Tasks.ValueTask`1")
        {
            var discardOpen = runtime.GetMethod("Discard", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException("GoroutineRuntime.Discard is missing from the channel runtime.");
            var elementType = type is ImportedTypeSymbol { TypeArguments: { IsDefaultOrEmpty: false } args } ? args[0] : TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            var (closedElement, symbolic) = ProjectElement(elementType);
            var closed = discardOpen.MakeGenericMethod(closedElement);
            var function = new ImportedFunctionSymbol("Discard", goroutineRuntimeClass, closed, declaration: null, returnTypeOverride: ValueTaskType);
            return new BoundImportedCallExpression(
                operand.Syntax,
                function,
                ImmutableArray.Create(operand),
                argumentRefKinds: default,
                typeArgumentSymbols: symbolic ? ImmutableArray.Create<TypeSymbol?>(elementType) : default);
        }

        if (Lowering.Async.AwaitableShape.Resolve(clr) != null && IsTask(clr))
        {
            var wrap = runtime.GetMethod("Wrap", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException("GoroutineRuntime.Wrap is missing from the channel runtime.");
            var function = new ImportedFunctionSymbol("Wrap", goroutineRuntimeClass, wrap, declaration: null, returnTypeOverride: ValueTaskType);
            return new BoundImportedCallExpression(operand.Syntax, function, ImmutableArray.Create(operand));
        }

        return operand;
    }

    /// <summary>Binds <c>chan[T](capacity)</c> as a construction of the runtime class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="capacity">The capacity argument, or <c>null</c> for a rendezvous channel.</param>
    /// <returns>A constructor call typed as <c>Chan&lt;T&gt;</c>.</returns>
    public BoundExpression BindConstruction(SyntaxNode? syntax, TypeSymbol elementType, BoundExpression? capacity)
    {
        var open = Required(chanOpen);
        var (closedElement, symbolic) = ProjectElement(elementType);
        var closedType = open.MakeGenericType(closedElement);
        var constructor = closedType.GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .Single(static c => c.GetParameters().Length == 1);
        TypeSymbol resultType = symbolic
            ? ImportedTypeSymbol.GetConstructed(closedType, open, ImmutableArray.Create(elementType))
            : TypeSymbol.FromClrType(closedType);
        var arguments = ImmutableArray.Create(capacity ?? new BoundLiteralExpression(null, 0));
        return new BoundClrConstructorCallExpression(syntax, closedType, constructor, arguments, resultType);
    }

    /// <summary>Binds <c>&lt;-ch</c>: the element's zero value on a closed channel, without an exception.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.Out"/>).</param>
    /// <param name="context">The ambient <c>Context</c> to park on (ADR-0174 D7), or <see langword="null"/> for no cancellation.</param>
    /// <returns>A call typed as the element type.</returns>
    public BoundExpression BindReceive(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction, BoundExpression? context = null)
        => Call(syntax, "Receive", CarrierFor(direction), elementType, elementType, ImmutableArray.Create(channel, context ?? DefaultToken()));

    /// <summary>Binds the two-value receive as a <c>(T, bool)</c> tuple.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.Out"/>).</param>
    /// <param name="context">The ambient <c>Context</c> to park on (ADR-0174 D7), or <see langword="null"/> for no cancellation.</param>
    /// <returns>A call typed as <c>(T, bool)</c>.</returns>
    public BoundExpression BindReceive2(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction, BoundExpression? context = null)
    {
        var tuple = TupleTypeSymbol.Get(ImmutableArray.Create(elementType, TypeSymbol.Bool));
        return Call(syntax, "Receive2", CarrierFor(direction), elementType, tuple, ImmutableArray.Create(channel, context ?? DefaultToken()));
    }

    /// <summary>Binds <c>ch &lt;- v</c>.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="value">The value, already converted to the element type.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.In"/>).</param>
    /// <param name="context">The ambient <c>Context</c> to park on (ADR-0174 D7), or <see langword="null"/> for no cancellation.</param>
    /// <returns>An expression statement wrapping the call.</returns>
    public BoundStatement BindSend(SyntaxNode? syntax, BoundExpression channel, BoundExpression value, TypeSymbol elementType, ChannelDirection direction, BoundExpression? context = null)
        => new BoundExpressionStatement(
            syntax,
            Call(syntax, "Send", CarrierFor(direction), elementType, TypeSymbol.Void, ImmutableArray.Create(channel, value, context ?? DefaultToken())));

    /// <summary>
    /// ADR-0174 D4: the suspending form of <c>&lt;-ch</c> — an awaited
    /// <c>ChannelOps.ReceiveValueAsync&lt;T&gt;</c> typed as the element.
    /// Produced by the async lowering for a receive inside a state-machine body.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.Out"/>).</param>
    /// <param name="cancellation">The cancellation argument (a token or, once Phase 3 threads it, the hidden context).</param>
    /// <returns>An await expression typed as the element.</returns>
    public BoundExpression BindReceiveAwait(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction, BoundExpression? cancellation = null)
    {
        var call = Call(
            syntax,
            "ReceiveValueAsync",
            CarrierFor(direction),
            elementType,
            ValueTaskOf(elementType),
            ImmutableArray.Create(channel, cancellation ?? DefaultToken()));
        return Await(syntax, call, elementType);
    }

    /// <summary>ADR-0174 D4: the suspending two-value receive — an awaited <c>ChannelOps.ReceiveTupleAsync&lt;T&gt;</c> typed <c>(T, bool)</c>.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.Out"/>).</param>
    /// <param name="cancellation">The cancellation argument.</param>
    /// <returns>An await expression typed as <c>(T, bool)</c>.</returns>
    public BoundExpression BindReceive2Await(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction, BoundExpression? cancellation = null)
    {
        var tuple = TupleTypeSymbol.Get(ImmutableArray.Create(elementType, TypeSymbol.Bool));
        var call = Call(
            syntax,
            "ReceiveTupleAsync",
            CarrierFor(direction),
            elementType,
            ValueTaskOf(tuple),
            ImmutableArray.Create(channel, cancellation ?? DefaultToken()));
        return Await(syntax, call, tuple);
    }

    /// <summary>ADR-0174 D4: the suspending send — an awaited <c>ChannelOps.SendAsync&lt;T&gt;</c>.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="value">The value, already converted to the element type.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.In"/>).</param>
    /// <param name="cancellation">The cancellation argument.</param>
    /// <returns>An await expression typed <c>void</c>.</returns>
    public BoundExpression BindSendAwait(SyntaxNode? syntax, BoundExpression channel, BoundExpression value, TypeSymbol elementType, ChannelDirection direction, BoundExpression? cancellation = null)
    {
        var call = Call(
            syntax,
            "SendAsync",
            CarrierFor(direction),
            elementType,
            TypeSymbol.FromClrType(Required(valueTask)),
            ImmutableArray.Create(channel, value, cancellation ?? DefaultToken()));
        return Await(syntax, call, TypeSymbol.Void);
    }

    /// <summary>
    /// ADR-0174 D4: the root boundary. Wraps a call typed <c>ValueTask[R]</c> in
    /// <c>Blocking.Wait</c> so a non-suspending caller gets <c>R</c> by blocking.
    /// </summary>
    /// <param name="valueTaskCall">The suspending call, typed <c>ValueTask</c> or <c>ValueTask[R]</c>.</param>
    /// <param name="logicalType">The logical result type <c>R</c> (<see cref="TypeSymbol.Void"/> for a bare <c>ValueTask</c>).</param>
    /// <returns>A call typed <paramref name="logicalType"/>.</returns>
    public BoundExpression BindBlockingWait(BoundExpression valueTaskCall, TypeSymbol logicalType)
    {
        var blocking = Required(blockingType);
        blockingClass ??= new ImportedClassSymbol(blocking, declaration: null, references: references);
        if (logicalType == TypeSymbol.Void)
        {
            var wait = blocking.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(m => m.Name == "Wait" && !m.IsGenericMethodDefinition);
            var function = new ImportedFunctionSymbol("Wait", blockingClass, wait, declaration: null, returnTypeOverride: TypeSymbol.Void);
            return new BoundImportedCallExpression(valueTaskCall.Syntax, function, ImmutableArray.Create(valueTaskCall));
        }

        var open = blocking.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(m => m.Name == "Wait" && m.IsGenericMethodDefinition);
        var (closedResult, symbolic) = ProjectElement(logicalType);
        var closed = open.MakeGenericMethod(closedResult);
        var generic = new ImportedFunctionSymbol("Wait", blockingClass, closed, declaration: null, returnTypeOverride: logicalType);
        return new BoundImportedCallExpression(
            valueTaskCall.Syntax,
            generic,
            ImmutableArray.Create(valueTaskCall),
            argumentRefKinds: default,
            typeArgumentSymbols: symbolic ? ImmutableArray.Create<TypeSymbol?>(logicalType) : default);
    }

    /// <summary>Recognizes a bound call on the facade by name.</summary>
    /// <param name="call">The call.</param>
    /// <param name="name">The facade method name.</param>
    /// <returns><see langword="true"/> when <paramref name="call"/> targets <c>ChannelOps.&lt;name&gt;</c>.</returns>
    public static bool IsFacadeCall(BoundImportedCallExpression call, string name)
        => call.Function.Name == name
            && call.Function.ImportedClass.ClassType.FullName == ChannelOpsTypeName;

    /// <summary>
    /// ADR-0174 D7: rebinds a facade call that was bound with the
    /// uncancellable default token so it parks on <paramref name="context"/>
    /// instead. Used by the suspension pass for operations that no lexical
    /// scope encloses, whose context is the function's hidden parameter.
    /// </summary>
    /// <param name="call">A <c>ChannelOps</c> call.</param>
    /// <param name="context">The ambient context to park on.</param>
    /// <returns>The rebound call, or <paramref name="call"/> when it is not a defaulted facade operation.</returns>
    public BoundExpression RetargetFacadeCancellation(BoundImportedCallExpression call, BoundExpression context)
    {
        if (call.Function.ImportedClass.ClassType.FullName != ChannelOpsTypeName
            || call.Arguments.Length == 0
            || call.Arguments[^1] is not BoundDefaultExpression defaulted
            || defaulted.Type?.ClrType?.FullName != CancellationTokenTypeName)
        {
            return call;
        }

        var element = ElementTypeOf(call);
        var direction = DirectionOf(call);
        return call.Function.Name switch
        {
            "Receive" => BindReceive(call.Syntax, call.Arguments[0], element, direction, context),
            "Receive2" => BindReceive2(call.Syntax, call.Arguments[0], element, direction, context),
            "Send" => ((BoundExpressionStatement)BindSend(call.Syntax, call.Arguments[0], call.Arguments[1], element, direction, context)).Expression,
            _ => call,
        };
    }

    /// <summary>
    /// ADR-0174 D7: rebinds a <c>ScopeFrame.Enter(default)</c> — the outermost
    /// scope of a function, which had no enclosing block to inherit from — so
    /// it enters under <paramref name="context"/> instead. The block's <c>ctx</c>
    /// then links to the caller's scope, and cancelling the caller cancels it.
    /// </summary>
    /// <param name="call">An imported call.</param>
    /// <param name="context">The ambient context to enter under.</param>
    /// <returns>The rebound call, or <paramref name="call"/> when it is not a defaulted scope entry.</returns>
    public BoundExpression RetargetScopeEnter(BoundImportedCallExpression call, BoundExpression context)
    {
        if (call.Function.Name != "Enter"
            || call.Function.ImportedClass.ClassType.FullName != "Gsharp.Concurrency.ScopeFrame"
            || call.Arguments.Length != 1
            || call.Arguments[0] is not BoundDefaultExpression)
        {
            return call;
        }

        return BindScopeEnter(call.Syntax, context);
    }

    /// <summary>
    /// ADR-0174 D7, the cross-assembly half: supplies the ambient context to a
    /// call on an imported suspending function. The importing compilation binds
    /// that function's declared signature — the hidden context is a trailing
    /// optional parameter it knows nothing about — so the argument is appended
    /// here, or replaces the <c>nil</c> the resolver filled in.
    /// </summary>
    /// <param name="call">An imported call.</param>
    /// <param name="context">The ambient context.</param>
    /// <returns>The call with the context supplied, or <paramref name="call"/> when it takes none.</returns>
    public static BoundExpression SupplyImportedContext(BoundImportedCallExpression call, BoundExpression context)
    {
        if (!ImportedFunctionSymbol.IsSuspendingMethod(call.Function.Method))
        {
            return call;
        }

        var parameters = call.Function.Method.GetParameters();
        if (parameters.Length == 0
            || parameters[^1].ParameterType.FullName != "Gsharp.Concurrency.Context"
            || parameters[^1].Name != FunctionSymbol.HiddenContextParameterName)
        {
            return call;
        }

        ImmutableArray<BoundExpression> arguments;
        if (call.Arguments.Length == parameters.Length - 1)
        {
            arguments = call.Arguments.Add(context);
        }
        else if (call.Arguments.Length == parameters.Length && call.Arguments[^1] is BoundDefaultExpression or BoundLiteralExpression)
        {
            arguments = call.Arguments.SetItem(call.Arguments.Length - 1, context);
        }
        else
        {
            return call;
        }

        return new BoundImportedCallExpression(
            call.Syntax,
            call.Function,
            arguments,
            call.ArgumentRefKinds,
            call.TypeArgumentSymbols,
            call.StaticContainerType);
    }

    /// <summary>Recovers the direction a facade call was bound with from its carrier parameter.</summary>
    /// <param name="call">A facade call.</param>
    /// <returns>The direction.</returns>
    public static ChannelDirection DirectionOf(BoundImportedCallExpression call)
    {
        var carrier = call.Function.Method.GetParameters()[0].ParameterType;
        var name = carrier.IsGenericType ? carrier.GetGenericTypeDefinition().Name : carrier.Name;
        return name switch
        {
            "ChannelReader`1" => ChannelDirection.In,
            "ChannelWriter`1" => ChannelDirection.Out,
            _ => ChannelDirection.Both,
        };
    }

    /// <summary>Recovers the element type a facade call was bound with: the symbolic type argument when one travelled, else the closed CLR argument.</summary>
    /// <param name="call">A facade call.</param>
    /// <returns>The element type.</returns>
    public static TypeSymbol ElementTypeOf(BoundImportedCallExpression call)
    {
        if (!call.TypeArgumentSymbols.IsDefaultOrEmpty && call.TypeArgumentSymbols[0] is { } symbolic)
        {
            return symbolic;
        }

        return TypeSymbol.FromClrType(call.Function.Method.GetGenericArguments()[0]);
    }

    /// <summary>The <c>ValueTask</c> / <c>ValueTask[R]</c> type a suspending call is typed with; symbolic when <paramref name="resultType"/> is.</summary>
    /// <param name="resultType">The logical result type.</param>
    /// <returns>The wrapper type symbol.</returns>
    internal TypeSymbol ValueTaskOf(TypeSymbol resultType)
    {
        if (resultType == TypeSymbol.Void)
        {
            return TypeSymbol.FromClrType(Required(valueTask));
        }

        var open = Required(valueTaskOpen);
        var (closedResult, symbolic) = ProjectElement(resultType);
        var closed = open.MakeGenericType(closedResult);
        return symbolic
            ? ImportedTypeSymbol.GetConstructed(closed, open, ImmutableArray.Create(resultType))
            : TypeSymbol.FromClrType(closed);
    }

    private static BoundExpression Await(SyntaxNode? syntax, BoundExpression call, TypeSymbol resultType)
        => new BoundAwaitExpression(syntax, call, resultType, ExpressionBinder.TryGetAwaiterTypeSymbol(Required(call.Type)));

    private static string CarrierFor(ChannelDirection direction) => direction switch
    {
        ChannelDirection.In => "ChannelReader`1",
        ChannelDirection.Out => "ChannelWriter`1",
        _ => "Channel`1",
    };

    private static bool IsTask(Type clr)
    {
        for (var t = clr; t != null; t = t.BaseType)
        {
            if (t.FullName == "System.Threading.Tasks.Task")
            {
                return true;
            }
        }

        return false;
    }

    private static T Required<T>(T? value)
        where T : class
        => value ?? throw new InvalidOperationException("The channel runtime is not in the reference set; callers must check IsAvailable first.");

    private BoundExpression Call(
        SyntaxNode? syntax,
        string name,
        string carrierName,
        TypeSymbol elementType,
        TypeSymbol returnType,
        ImmutableArray<BoundExpression> arguments)
    {
        // The facade overloads every operation on its carrier (Channel<T> /
        // ChannelReader<T> / ChannelWriter<T>) and on its cancellation
        // argument (CancellationToken now; the hidden Context once Phase 3
        // threads it), so both select the method.
        var ops = Required(channelOps);
        var cancellationTypeName = arguments[^1].Type?.ClrType?.FullName ?? CancellationTokenTypeName;
        var open = ops.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(m =>
            m.Name == name
            && m.IsGenericMethodDefinition
            && m.GetParameters().Length == arguments.Length
            && m.GetParameters()[0].ParameterType is { IsGenericType: true } carrier
            && carrier.GetGenericTypeDefinition().Name == carrierName
            && m.GetParameters()[^1].ParameterType.FullName == cancellationTypeName);

        var (closedElement, symbolic) = ProjectElement(elementType);
        var closed = open.MakeGenericMethod(closedElement);
        channelOpsClass ??= new ImportedClassSymbol(ops, declaration: null, references: references);
        var function = new ImportedFunctionSymbol(name, channelOpsClass, closed, declaration: null, returnTypeOverride: returnType);
        return new BoundImportedCallExpression(
            syntax,
            function,
            arguments,
            argumentRefKinds: default,
            typeArgumentSymbols: symbolic ? ImmutableArray.Create<TypeSymbol?>(elementType) : default);
    }

    private BoundExpression DefaultToken()
        => new BoundDefaultExpression(null, TypeSymbol.FromClrType(Required(cancellationToken)));

    private (Type Closed, bool Symbolic) ProjectElement(TypeSymbol elementType)
    {
        // Mirrors TryResolveExplicitMethodTypeArgs (issue #320/#530): a
        // CLR-backed element (including `T?` as Nullable<T>) is projected onto
        // the reference set; anything without a reference-context CLR type
        // closes over System.Object and travels symbolically.
        var clr = NullableTypeSymbol.GetEffectiveClrType(elementType);
        if (clr != null && !TypeSymbol.RequiresSymbolicProjection(elementType))
        {
            return (references.MapClrTypeToReferences(clr), false);
        }

        // A symbolic element that still has a CLR shape — `string?` (a
        // reference-nullable annotation travels symbolically) or a named tuple
        // — must close over that shape, not System.Object: the emitter
        // re-encodes the symbolic type argument to exactly that CLR type for
        // the variable's `Chan<T>`, and ILVerify rejects a `Chan<object>`
        // construction stored into a `Chan<string>` local.
        var closed = clr != null
            ? references.MapClrTypeToReferences(clr)
            : references.GetCoreType("System.Object");
        return (closed, true);
    }
}
