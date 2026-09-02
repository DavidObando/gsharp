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
    private ImportedClassSymbol? channelOpsClass;
    private ImportedClassSymbol? blockingClass;

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
    }

    /// <summary>Gets a value indicating whether the runtime assembly is in the reference set.</summary>
    public bool IsAvailable => chanOpen != null && channelOps != null && cancellationToken != null;

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
    /// <returns>A call typed as the element type.</returns>
    public BoundExpression BindReceive(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction)
        => Call(syntax, "Receive", CarrierFor(direction), elementType, elementType, ImmutableArray.Create(channel, DefaultToken()));

    /// <summary>Binds the two-value receive as a <c>(T, bool)</c> tuple.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.Out"/>).</param>
    /// <returns>A call typed as <c>(T, bool)</c>.</returns>
    public BoundExpression BindReceive2(SyntaxNode? syntax, BoundExpression channel, TypeSymbol elementType, ChannelDirection direction)
    {
        var tuple = TupleTypeSymbol.Get(ImmutableArray.Create(elementType, TypeSymbol.Bool));
        return Call(syntax, "Receive2", CarrierFor(direction), elementType, tuple, ImmutableArray.Create(channel, DefaultToken()));
    }

    /// <summary>Binds <c>ch &lt;- v</c>.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="channel">The channel operand.</param>
    /// <param name="value">The value, already converted to the element type.</param>
    /// <param name="elementType">The element type.</param>
    /// <param name="direction">The operand's direction (never <see cref="ChannelDirection.In"/>).</param>
    /// <returns>An expression statement wrapping the call.</returns>
    public BoundStatement BindSend(SyntaxNode? syntax, BoundExpression channel, BoundExpression value, TypeSymbol elementType, ChannelDirection direction)
        => new BoundExpressionStatement(
            syntax,
            Call(syntax, "Send", CarrierFor(direction), elementType, TypeSymbol.Void, ImmutableArray.Create(channel, value, DefaultToken())));

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
