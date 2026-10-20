// <copyright file="ChannelRuntimeBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection

/// Lowers channel operations onto the `Gsharp.Runtime.Channels` runtime
/// (ADR-0174 D1/D2/D12) as ordinary imported calls and constructions, so the
/// proven imported-member emit path handles metadata, symbolic type arguments,
/// and load contexts, and no channel IL is hand-rolled.
/// @remarks - `chan[T](n)` → `new Gsharp.Concurrency.Chan<T>(n)`, typed as the runtime class so
/// `Length()`/`Capacity`/`Close()` bind as ordinary members;
/// - `<-ch` → `ChannelOps.Receive<T>(ch, default)` (zero on closed, no exception);
/// - `let v, ok = <-ch` → `ChannelOps.Receive2<T>(ch, default)`, a `(T, bool)` tuple;
/// - `ch <- v` → `ChannelOps.Send<T>(ch, v, default)`;
/// - `close` (member `Close()` on a `chan[T]`) → `ChannelOps.Close<T>(ch)`.
///
/// The overload is chosen by the handle's direction: a `chan[T]` or a
/// constructed `Chan<T>` uses the `Channel<T>` overloads, an
/// `in chan[T]` the `ChannelReader<T>` ones, an `out chan[T]` the
/// `ChannelWriter<T>` ones. The runtime dispatches the fast path versus the
/// documented foreign-channel fallback (D2's matrix).
///
/// The blocking `Receive`/`Send` forms are the Phase 2 target;
/// Phase 3's suspension rewriter swaps them for the `…Async` forms and awaits.
///
/// Element types are projected onto the reference set exactly as an
/// explicit generic type argument is (issue #320): a CLR-backed element is
/// mapped into the resolver's load context; a same-compilation or
/// type-parameter element closes the generic over an `object` placeholder
/// and travels as a symbolic type argument the emitter re-encodes.
internal class ChannelRuntimeBinder {
    private let references ReferenceResolver
    private let chanOpen Type?
    private let channelOps Type?
    private let cancellationToken Type?
    private let valueTaskOpen Type?
    private let valueTask Type?
    private let blockingType Type?
    private let scopeFrameType Type?
    private let selectWaiterType Type?
    private let contextType Type?
    private let goroutineRuntimeType Type?
    private let asyncLetCellType Type?
    private var channelOpsClass ImportedClassSymbol?
    private var blockingClass ImportedClassSymbol?
    private var scopeFrameClass ImportedClassSymbol?
    private var asyncLetCellClass ImportedClassSymbol?
    private var selectWaiterClass ImportedClassSymbol?
    private var goroutineRuntimeClass ImportedClassSymbol?

    /// Initializes a new instance of the (cref:ChannelRuntimeBinder) class.
    /// @param references The compilation's reference resolver.
    init(references ReferenceResolver) {
        this.references = references
        references.TryResolveType(ChanTypeName, out chanOpen)
        references.TryResolveType(ChannelOpsTypeName, out channelOps)
        references.TryResolveType(CancellationTokenTypeName, out cancellationToken)
        references.TryResolveType("System.Threading.Tasks.ValueTask`1", out valueTaskOpen)
        references.TryResolveType("System.Threading.Tasks.ValueTask", out valueTask)
        references.TryResolveType("Gsharp.Concurrency.Blocking", out blockingType)
        references.TryResolveType("Gsharp.Concurrency.ScopeFrame", out scopeFrameType)
        references.TryResolveType("Gsharp.Concurrency.SelectWaiter", out selectWaiterType)
        references.TryResolveType(ContextTypeName, out contextType)
        references.TryResolveType("Gsharp.Concurrency.GoroutineRuntime", out goroutineRuntimeType)
        references.TryResolveType(AsyncLetCellTypeName, out asyncLetCellType)
    }

    /// Gets a value indicating whether the runtime assembly is in the reference set.
    prop IsAvailable bool -> chanOpen != nil && channelOps != nil && cancellationToken != nil

    /// Gets the runtime's `ScopeFrame` type symbol (ADR-0174 D6).
    prop ScopeFrameType TypeSymbol -> TypeSymbol.FromClrTypeWithoutNullability(
        Required(scopeFrameType),
        NullabilityFreeReason.TypeLiteral
    )

    /// Gets the runtime's `AsyncLetCell` type (ADR-0174 D15).
    prop AsyncLetCellType TypeSymbol -> TypeSymbol.FromClrTypeWithoutNullability(
        Required(asyncLetCellType),
        NullabilityFreeReason.TypeLiteral
    )

    /// Gets the runtime's `SelectWaiter` type symbol (ADR-0174 D8).
    prop SelectWaiterType TypeSymbol -> TypeSymbol.FromClrTypeWithoutNullability(
        Required(selectWaiterType),
        NullabilityFreeReason.TypeLiteral
    )

    /// Gets the runtime's `Context` type symbol (ADR-0174 D6/D7).
    prop ContextType TypeSymbol -> TypeSymbol.FromClrTypeWithoutNullability(
        Required(contextType),
        NullabilityFreeReason.TypeLiteral
    )

    /// Gets the CLR `ValueTask` type symbol.
    prop ValueTaskType TypeSymbol -> TypeSymbol.FromClrTypeWithoutNullability(
        Required(valueTask),
        NullabilityFreeReason.TypeLiteral
    )

    /// Binds `ScopeFrame.Enter(ambient)`; the ambient context is `null` (= `Context.None`) until the hidden
    /// context parameter lands.
    /// @param syntax The scope syntax.
    /// @param ambient The enclosing scope's `ctx`, or `null` at an outermost scope (ambient
    /// `Context.None`).
    /// @returns A call typed `ScopeFrame`.
    func BindScopeEnter(syntax SyntaxNode?, ambient BoundExpression?) BoundExpression {
        let frame = Required(scopeFrameType)
        let enter = frame.GetMethod("Enter", BindingFlags.Public | BindingFlags.Static) ??
            throw InvalidOperationException("ScopeFrame.Enter is missing from the channel runtime.")
        scopeFrameClass ??= ImportedClassSymbol(frame, declaration: nil, references: references)
        let function = ImportedFunctionSymbol(
            "Enter",
            scopeFrameClass!!,
            enter,
            declaration: nil,
            returnTypeOverride: ScopeFrameType
        )
        return BoundImportedCallExpression(
            syntax,
            function,
            ImmutableArray.Create(ambient ?? BoundDefaultExpression(nil, ContextType))
        )
    }

    /// Binds `Context.None`, the ambient context of a call site that no scope encloses (ADR-0174 D7).
    /// @returns A static property read typed `Context`.
    func BindContextNone() BoundExpression {
        let property = Required(contextType).GetProperty("None", BindingFlags.Public | BindingFlags.Static) ??
            throw InvalidOperationException("Context.None is missing from the channel runtime.")
        return BoundClrPropertyAccessExpression(
            nil,
            receiver: nil,
            property,
            ContextType,
            staticContainerType: ContextType
        )
    }

    /// Binds `ambient.ShieldedForCleanup()` — the cancellation-immune
    /// context a `defer` body runs under, bounded by the host's grace
    /// budget (ADR-0174 D7). Shielding `Context.None` yields
    /// `Context.None`, so cleanup outside any scope costs nothing.
    /// @param ambient The context being unwound, or `null` for none.
    /// @returns A call typed `Context`.
    func BindShieldedContext(ambient BoundExpression?) BoundExpression {
        let method = Required(contextType).GetMethod(
            "ShieldedForCleanup",
            BindingFlags.Public | BindingFlags.Instance
        ) ??
            throw InvalidOperationException("Context.ShieldedForCleanup is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            nil,
            ambient ?? BindContextNone(),
            method,
            ContextType,
            ImmutableArray[BoundExpression].Empty
        )
    }

    /// Binds `shield.Dispose()`, releasing a cleanup shield's grace timer.
    /// @param shield The shield local.
    /// @returns A call typed `void`.
    func BindContextDispose(shield VariableSymbol) BoundExpression {
        let method = Required(contextType).GetMethod("Dispose", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("Context.Dispose is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, shield),
            method,
            TypeSymbol.Void,
            ImmutableArray[BoundExpression].Empty
        )
    }

    /// ADR-0174 D8/D9: recognizes a non-channel `select` receive operand —
    /// anything implementing `Gsharp.Concurrency.ISelectable[T]`, which is
    /// how the library's timers (`after`, `tick`) join a select
    /// without pretending to be channels.
    /// @param type The operand's type.
    /// @param element The element the operand yields.
    /// @returns `true` when the operand is selectable.
    func TryGetSelectableElement(type TypeSymbol?, @NotNullWhen(true) out element TypeSymbol?) bool {
        element = nil
        if type?.ClrType is not{} clr {
            return false
        }
        for candidate in clr.GetInterfaces() {
            if candidate.IsGenericType && candidate.GetGenericTypeDefinition()
                .FullName == "Gsharp.Concurrency.ISelectable`1" {
                element = TypeSymbol.FromClrTypeWithoutNullability(
                    candidate.GetGenericArguments()[0],
                    NullabilityFreeReason.TypeStructure
                )
                return true
            }
        }
        return false
    }

    /// Binds `SelectWaiter.Rent(arms, context)` (ADR-0174 D8).
    /// @param syntax The select syntax.
    /// @param arms The number of non-default arms.
    /// @param context The ambient context, or `null`.
    /// @returns A call typed `SelectWaiter`.
    func BindSelectRent(syntax SyntaxNode?, arms int32, context BoundExpression?) BoundExpression {
        let waiter = Required(selectWaiterType)
        let rent = waiter.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == "Rent" &&
                m
                .GetParameters()[^1]
                .ParameterType
                .FullName == "Gsharp.Concurrency.Context"
        )
        selectWaiterClass ??= ImportedClassSymbol(waiter, declaration: nil, references: references)
        let function = ImportedFunctionSymbol(
            "Rent",
            selectWaiterClass!!,
            rent,
            declaration: nil,
            returnTypeOverride: SelectWaiterType
        )
        return BoundImportedCallExpression(
            syntax,
            function,
            ImmutableArray.Create(
                BoundLiteralExpression(nil, arms, TypeSymbol.Int32),
                context ?? BoundDefaultExpression(nil, ContextType)
            )
        )
    }

    /// ADR-0174 D7/D8: rebinds a `SelectWaiter.Rent(n, default)` — a select
    /// bound outside any lexical `scope` — so it parks under
    /// [`context`](paramref). Without this a select in a callee never
    /// observes the caller's scope, and a `case cancelled` arm is dead.
    /// @param call An imported call.
    /// @param context The ambient context to park under.
    /// @returns The rebound call, or [`call`](paramref) when it is not a defaulted rent.
    func RetargetSelectRent(call BoundImportedCallExpression, context BoundExpression) BoundExpression {
        if call
            .Function
            .Name != "Rent" ||
            call
            .Function
            .ImportedClass
            .ClassType
            .FullName != SelectWaiterTypeName ||
            call
            .Arguments
            .Length != 2 ||
            !(call.Arguments[1] is BoundDefaultExpression) {
            return call
        }
        return BoundImportedCallExpression(
            call.Syntax,
            call.Function,
            ImmutableArray.Create(call.Arguments[0], context)
        )
    }

    /// Binds `waiter.AddTask(task, arm)` or `waiter.AddTask[T](task, arm)`
    /// — the `case await task` arms of ADR-0174 D8.
    /// @param waiter The waiter local.
    /// @param task The task operand, already evaluated into a local.
    /// @param resultType The task's result type, or `null` for a bare `Task`.
    /// @param arm The arm index.
    /// @returns A call typed `void`.
    func BindSelectAddTask(
        waiter VariableSymbol,
        task BoundExpression,
        resultType TypeSymbol?,
        arm int32
    ) BoundExpression {
        let candidates = Required(selectWaiterType).GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(
            (m MethodInfo) -> m.Name == "AddTask"
        )
        let arguments = ImmutableArray.Create(task, BoundLiteralExpression(nil, arm, TypeSymbol.Int32))
        if resultType == nil {
            return BoundImportedInstanceCallExpression(
                nil,
                BoundVariableExpression(nil, waiter),
                candidates.Single((m MethodInfo) -> !m.IsGenericMethodDefinition),
                TypeSymbol.Void,
                arguments
            )
        }
        // `Task<T>` is invariant, so a same-compilation result type must travel
        // symbolically for the same reason a channel element does (issue #2965).
        let (closedResult, symbolic) = ProjectElement(resultType)
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, waiter),
            candidates.Single((m MethodInfo) -> m.IsGenericMethodDefinition).MakeGenericMethod(closedResult),
            TypeSymbol.Void,
            arguments,
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](resultType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// Binds `waiter.AddCancelled(arm)` — the `case cancelled` arm of
    /// ADR-0174 D8. The syntax travels with the call so the suspension pass can
    /// report GS0557 against the arm when the container turns out to have no
    /// ambient context to observe.
    /// @param waiter The waiter local.
    /// @param syntax The arm's syntax.
    /// @param arm The arm index.
    /// @returns A call typed `void`.
    func BindSelectAddCancelled(waiter VariableSymbol, syntax SyntaxNode?, arm int32) BoundExpression {
        let method = Required(selectWaiterType).GetMethod(
            "AddCancelled",
            BindingFlags.Public | BindingFlags.Instance
        ) ??
            throw InvalidOperationException("SelectWaiter.AddCancelled is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            syntax,
            BoundVariableExpression(nil, waiter),
            method,
            TypeSymbol.Void,
            ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, arm, TypeSymbol.Int32))
        )
    }

    /// Binds `waiter.AddReceive[T](channel, arm)` or `AddSend[T](channel, value, arm)` (ADR-0174 D8).
    /// @param waiter The waiter local.
    /// @param channel The channel operand, already evaluated into a local.
    /// @param value The value for a send arm, or `null` for a receive arm.
    /// @param elementType The arm's element type.
    /// @param direction The channel's direction, which selects the carrier overload.
    /// @param arm The arm index.
    /// @param selectable Whether the operand is an `ISelectable[T]` rather than a channel carrier.
    /// @returns A call typed `void`.
    func BindSelectAdd(
        waiter VariableSymbol,
        channel BoundExpression,
        value BoundExpression?,
        elementType TypeSymbol,
        direction ChannelDirection,
        arm int32,
        selectable bool = false
    ) BoundExpression {
        let name = if value == nil {
            "AddReceive"
        } else {
            "AddSend"
        }
        let carrier = if selectable {
            "ISelectable`1"
        } else {
            CarrierFor(direction)
        }
        let open_ = Required(selectWaiterType).GetMethods(BindingFlags.Public | BindingFlags.Instance).Single(
            (m MethodInfo) -> m.Name == name &&
                m.IsGenericMethodDefinition &&
                m
                .GetParameters()[0]
                .ParameterType is {IsGenericType: true} first &&
                first
                .GetGenericTypeDefinition().Name == carrier
        )
        // A same-compilation element (a user struct, say) has no reference-context
        // CLR type, so the method closes over System.Object here and travels
        // symbolically; without that the emitted call would be `AddReceive<object>`
        // against a `Channel<Pair>` argument (issue #2965).
        let (closedElement, symbolic) = ProjectElement(elementType)
        let closed = open_.MakeGenericMethod(closedElement)
        let arguments = if value == nil {
            ImmutableArray.Create(channel, BoundLiteralExpression(nil, arm, TypeSymbol.Int32))
        } else {
            ImmutableArray.Create(channel, value, BoundLiteralExpression(nil, arm, TypeSymbol.Int32))
        }
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, waiter),
            closed,
            TypeSymbol.Void,
            arguments,
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](elementType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// Binds the blocking `waiter.Wait()`; the async pipeline turns it into an awaited `WaitAsync`.
    /// @param waiter The waiter local.
    /// @returns A call typed `int32`.
    func BindSelectWait(waiter VariableSymbol) BoundExpression -> BindSelectCall(waiter, "Wait", TypeSymbol.Int32)

    /// Binds `waiter.TryNow()`, the non-blocking probe a `default` arm needs.
    /// @param waiter The waiter local.
    /// @returns A call typed `int32`.
    func BindSelectTryNow(waiter VariableSymbol) BoundExpression -> BindSelectCall(waiter, "TryNow", TypeSymbol.Int32)

    /// Binds `waiter.Return()`.
    /// @param waiter The waiter local.
    /// @returns A call typed `void`.
    func BindSelectReturn(waiter VariableSymbol) BoundExpression -> BindSelectCall(waiter, "Return", TypeSymbol.Void)

    /// Binds `waiter.NeedsReprobe`.
    /// @param waiter The waiter local.
    /// @returns A property read typed `bool`.
    func BindSelectNeedsReprobe(waiter VariableSymbol) BoundExpression {
        let property = Required(selectWaiterType).GetProperty(
            "NeedsReprobe",
            BindingFlags.Public | BindingFlags.Instance
        ) ??
            throw InvalidOperationException("SelectWaiter.NeedsReprobe is missing from the channel runtime.")
        return BoundClrPropertyAccessExpression(nil, BoundVariableExpression(nil, waiter), property, TypeSymbol.Bool)
    }

    /// Binds `waiter.TakeValue[T]()`, the value the winning receive arm transferred.
    /// @param waiter The waiter local.
    /// @param elementType The arm's element type.
    /// @returns A call typed as the element.
    func BindSelectTakeValue(waiter VariableSymbol, elementType TypeSymbol) BoundExpression {
        let open_ = Required(selectWaiterType).GetMethod("TakeValue", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("SelectWaiter.TakeValue is missing from the channel runtime.")
        let (closedElement, symbolic) = ProjectElement(elementType)
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, waiter),
            open_.MakeGenericMethod(closedElement),
            elementType,
            ImmutableArray[BoundExpression].Empty,
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](elementType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// Binds `frame.Context`, the block's implicit `ctx` (ADR-0174 D6).
    /// @param frame The frame local.
    /// @returns A property read typed `Context`.
    func BindScopeContext(frame VariableSymbol) BoundExpression {
        let property = Required(scopeFrameType).GetProperty("Context", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("ScopeFrame.Context is missing from the channel runtime.")
        return BoundClrPropertyAccessExpression(nil, BoundVariableExpression(nil, frame), property, ContextType)
    }

    /// Binds the blocking `frame.Exit(bodyException)`; the async pipeline turns it into an awaited
    /// `ExitAsync`.
    /// @param frame The frame local.
    /// @param bodyException The local holding the body's exception, or `null`.
    /// @returns A call typed `void`.
    func BindScopeExit(frame VariableSymbol, bodyException VariableSymbol) BoundExpression {
        let exit = Required(scopeFrameType).GetMethod("Exit", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("ScopeFrame.Exit is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, frame),
            exit,
            TypeSymbol.Void,
            ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, bodyException))
        )
    }

    /// Turns a blocking scope exit into the awaited `ExitAsync` (inside a state machine).
    /// @param exit The blocking exit call.
    /// @returns An await expression typed `void`.
    func BindScopeExitAwait(exit BoundImportedInstanceCallExpression) BoundExpression {
        let exitAsync = Required(scopeFrameType).GetMethod("ExitAsync", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("ScopeFrame.ExitAsync is missing from the channel runtime.")
        let call = BoundImportedInstanceCallExpression(
            exit.Syntax,
            exit.Receiver,
            exitAsync,
            ValueTaskType,
            exit.Arguments
        )
        return Await(exit.Syntax, call, TypeSymbol.Void)
    }

    /// ADR-0174 D8: the suspending form of a select's wait — an awaited
    /// `SelectWaiter.WaitAsync` typed `int32`. Produced by the async
    /// lowering for a select inside a state-machine body, so a parked select
    /// holds no thread.
    /// @param wait The blocking `Wait()` call the binder emitted.
    /// @returns An await expression typed `int32`.
    func BindSelectWaitAwait(wait BoundImportedInstanceCallExpression) BoundExpression {
        let waitAsync = Required(selectWaiterType).GetMethod(
            "WaitAsync",
            BindingFlags.Public | BindingFlags.Instance
        ) ??
            throw InvalidOperationException("SelectWaiter.WaitAsync is missing from the channel runtime.")
        let call = BoundImportedInstanceCallExpression(
            wait.Syntax,
            wait.Receiver,
            waitAsync,
            ValueTaskOf(TypeSymbol.Int32),
            wait.Arguments
        )
        return Await(wait.Syntax, call, TypeSymbol.Int32)
    }

    /// Shapes a `go` operand for the goroutine body, which returns a plain
    /// `ValueTask` (ADR-0174 D5): a `ValueTask` passes through, a
    /// `ValueTask[T]` is discarded through `GoroutineRuntime.Discard`, a
    /// `Task` is wrapped, and anything else (a void call) is left for the
    /// closure to run as a statement.
    /// @param operand The bound go operand.
    /// @returns The shaped operand.
    func ShapeGoOperand(operand BoundExpression) BoundExpression {
        let type TypeSymbol? = operand.Type
        if type == nil || type == TypeSymbol.Error || type == TypeSymbol.Void {
            return operand
        }
        let clr Type? = type.ClrType
        if clr == nil {
            return operand
        }
        let runtime = Required(goroutineRuntimeType)
        goroutineRuntimeClass ??= ImportedClassSymbol(runtime, declaration: nil, references: references)
        if clr.FullName == "System.Threading.Tasks.ValueTask" {
            return operand
        }
        if clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Threading.Tasks.ValueTask`1" {
            let discardOpen = runtime.GetMethod("Discard", BindingFlags.Public | BindingFlags.Static) ??
                throw InvalidOperationException("GoroutineRuntime.Discard is missing from the channel runtime.")
            let elementType = if type is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false} args} {
                args[0]
            } else {
                TypeSymbol.FromClrTypeWithoutNullability(
                    clr.GetGenericArguments()[0],
                    NullabilityFreeReason.TypeStructure
                )
            }
            let (closedElement, symbolic) = ProjectElement(elementType)
            let closed = discardOpen.MakeGenericMethod(closedElement)
            let function = ImportedFunctionSymbol(
                "Discard",
                goroutineRuntimeClass!!,
                closed,
                declaration: nil,
                returnTypeOverride: ValueTaskType
            )
            return BoundImportedCallExpression(
                operand.Syntax,
                function,
                ImmutableArray.Create(operand),
                argumentRefKinds: default(ImmutableArray[RefKind]),
                typeArgumentSymbols: if symbolic {
                    ImmutableArray.Create[TypeSymbol?](elementType)
                } else {
                    default(ImmutableArray[TypeSymbol?])
                }
            )
        }
        if AwaitableShape.Resolve(clr) != nil && IsTask(clr) {
            let wrap = runtime.GetMethod("Wrap", BindingFlags.Public | BindingFlags.Static) ??
                throw InvalidOperationException("GoroutineRuntime.Wrap is missing from the channel runtime.")
            let function = ImportedFunctionSymbol(
                "Wrap",
                goroutineRuntimeClass!!,
                wrap,
                declaration: nil,
                returnTypeOverride: ValueTaskType
            )
            return BoundImportedCallExpression(operand.Syntax, function, ImmutableArray.Create(operand))
        }
        return operand
    }

    /// Binds `chan[T](capacity)` as a construction of the runtime class.
    /// @param syntax The originating syntax.
    /// @param elementType The element type.
    /// @param capacity The capacity argument, or `null` for a rendezvous channel.
    /// @returns A constructor call typed as `Chan<T>`.
    func BindConstruction(syntax SyntaxNode?, elementType TypeSymbol, capacity BoundExpression?) BoundExpression {
        let open_ = Required(chanOpen)
        let (closedElement, symbolic) = ProjectElement(elementType)
        let closedType = open_.MakeGenericType(closedElement)
        let constructor = closedType.GetConstructors(BindingFlags.Public | BindingFlags.Instance).Single(
            (c ConstructorInfo) -> c.GetParameters().Length == 1
        )
        let resultType = if symbolic {
            cast[TypeSymbol](ImportedTypeSymbol.GetConstructed(closedType, open_, ImmutableArray.Create(elementType)))
        } else {
            TypeSymbol.FromClrTypeWithoutNullability(closedType, NullabilityFreeReason.CompilerProduced)
        }
        let arguments = ImmutableArray.Create(capacity ?? BoundLiteralExpression(nil, 0))
        return BoundClrConstructorCallExpression(syntax, closedType, constructor, arguments, resultType)
    }

    /// Binds `<-ch`: the element's zero value on a closed channel, without an exception.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.Out)).
    /// @param context The ambient `Context` to park on (ADR-0174 D7), or `null` for no cancellation.
    /// @returns A call typed as the element type.
    func BindReceive(
        syntax SyntaxNode?,
        channel BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        context BoundExpression? = nil
    ) BoundExpression -> Call(
        syntax,
        "Receive",
        CarrierFor(direction),
        elementType,
        elementType,
        ImmutableArray.Create(channel, context ?? DefaultToken())
    )

    /// Binds the two-value receive as a `(T, bool)` tuple.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.Out)).
    /// @param context The ambient `Context` to park on (ADR-0174 D7), or `null` for no cancellation.
    /// @returns A call typed as `(T, bool)`.
    func BindReceive2(
        syntax SyntaxNode?,
        channel BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        context BoundExpression? = nil
    ) BoundExpression {
        let tuple = TupleTypeSymbol.Get(ImmutableArray.Create(elementType, TypeSymbol.Bool))
        return Call(
            syntax,
            "Receive2",
            CarrierFor(direction),
            elementType,
            tuple,
            ImmutableArray.Create(channel, context ?? DefaultToken())
        )
    }

    /// Binds `ch <- v`.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param value The value, already converted to the element type.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.In)).
    /// @param context The ambient `Context` to park on (ADR-0174 D7), or `null` for no cancellation.
    /// @returns An expression statement wrapping the call.
    func BindSend(
        syntax SyntaxNode?,
        channel BoundExpression,
        value BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        context BoundExpression? = nil
    ) BoundStatement -> BoundExpressionStatement(
        syntax,
        Call(
            syntax,
            "Send",
            CarrierFor(direction),
            elementType,
            TypeSymbol.Void,
            ImmutableArray.Create(channel, value, context ?? DefaultToken())
        )
    )

    /// ADR-0174 D4: the suspending form of `<-ch` — an awaited
    /// `ChannelOps.ReceiveValueAsync<T>` typed as the element.
    /// Produced by the async lowering for a receive inside a state-machine body.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.Out)).
    /// @param cancellation The cancellation argument (a token or, once Phase 3 threads it, the hidden
    /// context).
    /// @returns An await expression typed as the element.
    func BindReceiveAwait(
        syntax SyntaxNode?,
        channel BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        cancellation BoundExpression? = nil
    ) BoundExpression {
        let call = Call(
            syntax,
            "ReceiveValueAsync",
            CarrierFor(direction),
            elementType,
            ValueTaskOf(elementType),
            ImmutableArray.Create(channel, cancellation ?? DefaultToken())
        )
        return Await(syntax, call, elementType)
    }

    /// ADR-0174 D4: the suspending two-value receive — an awaited `ChannelOps.ReceiveTupleAsync<T>` typed
    /// `(T, bool)`.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.Out)).
    /// @param cancellation The cancellation argument.
    /// @returns An await expression typed as `(T, bool)`.
    func BindReceive2Await(
        syntax SyntaxNode?,
        channel BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        cancellation BoundExpression? = nil
    ) BoundExpression {
        let tuple = TupleTypeSymbol.Get(ImmutableArray.Create(elementType, TypeSymbol.Bool))
        let call = Call(
            syntax,
            "ReceiveTupleAsync",
            CarrierFor(direction),
            elementType,
            ValueTaskOf(tuple),
            ImmutableArray.Create(channel, cancellation ?? DefaultToken())
        )
        return Await(syntax, call, tuple)
    }

    /// ADR-0174 D4: the suspending send — an awaited `ChannelOps.SendAsync<T>`.
    /// @param syntax The originating syntax.
    /// @param channel The channel operand.
    /// @param value The value, already converted to the element type.
    /// @param elementType The element type.
    /// @param direction The operand's direction (never (cref:ChannelDirection.In)).
    /// @param cancellation The cancellation argument.
    /// @returns An await expression typed `void`.
    func BindSendAwait(
        syntax SyntaxNode?,
        channel BoundExpression,
        value BoundExpression,
        elementType TypeSymbol,
        direction ChannelDirection,
        cancellation BoundExpression? = nil
    ) BoundExpression {
        let call = Call(
            syntax,
            "SendAsync",
            CarrierFor(direction),
            elementType,
            TypeSymbol.FromClrTypeWithoutNullability(Required(valueTask), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create(channel, value, cancellation ?? DefaultToken())
        )
        return Await(syntax, call, TypeSymbol.Void)
    }

    /// ADR-0174 D4: the root boundary. Wraps a call typed `ValueTask[R]` in
    /// `Blocking.Wait` so a non-suspending caller gets `R` by blocking.
    /// @param valueTaskCall The suspending call, typed `ValueTask` or `ValueTask[R]`.
    /// @param logicalType The logical result type `R` ((cref:TypeSymbol.Void) for a bare `ValueTask`).
    /// @returns A call typed [`logicalType`](paramref).
    func BindBlockingWait(valueTaskCall BoundExpression, logicalType TypeSymbol) BoundExpression {
        let blocking = Required(blockingType)
        blockingClass ??= ImportedClassSymbol(blocking, declaration: nil, references: references)
        if logicalType == TypeSymbol.Void {
            let wait = blocking.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
                (m MethodInfo) -> m.Name == "Wait" && !m.IsGenericMethodDefinition
            )
            let function = ImportedFunctionSymbol(
                "Wait",
                blockingClass!!,
                wait,
                declaration: nil,
                returnTypeOverride: TypeSymbol.Void
            )
            return BoundImportedCallExpression(valueTaskCall.Syntax, function, ImmutableArray.Create(valueTaskCall))
        }
        let open_ = blocking.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == "Wait" && m.IsGenericMethodDefinition
        )
        let (closedResult, symbolic) = ProjectElement(logicalType)
        let closed = open_.MakeGenericMethod(closedResult)
        let generic = ImportedFunctionSymbol(
            "Wait",
            blockingClass!!,
            closed,
            declaration: nil,
            returnTypeOverride: logicalType
        )
        return BoundImportedCallExpression(
            valueTaskCall.Syntax,
            generic,
            ImmutableArray.Create(valueTaskCall),
            argumentRefKinds: default(ImmutableArray[RefKind]),
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](logicalType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// ADR-0174 D7: rebinds a facade call that was bound with the
    /// uncancellable default token so it parks on [`context`](paramref)
    /// instead. Used by the suspension pass for operations that no lexical
    /// scope encloses, whose context is the function's hidden parameter.
    /// @param call A `ChannelOps` call.
    /// @param context The ambient context to park on.
    /// @returns The rebound call, or [`call`](paramref) when it is not a defaulted facade operation.
    func RetargetFacadeCancellation(call BoundImportedCallExpression, context BoundExpression) BoundExpression {
        if call
            .Function
            .ImportedClass
            .ClassType
            .FullName != ChannelOpsTypeName ||
            call
            .Arguments
            .Length == 0 ||
            call.Arguments[^1] is not BoundDefaultExpression defaulted ||
            defaulted
            .Type
            ?.ClrType
            ?.FullName != CancellationTokenTypeName {
            return call
        }
        let element = ElementTypeOf(call)
        let direction = DirectionOf(call)
        return switch call.Function.Name {
            case "Receive": BindReceive(call.Syntax, call.Arguments[0], element, direction, context)
            case "Receive2": BindReceive2(call.Syntax, call.Arguments[0], element, direction, context)
            case "Send": (
                cast[BoundExpressionStatement](
                    BindSend(call.Syntax, call.Arguments[0], call.Arguments[1], element, direction, context)
                )
            ).Expression
            default: cast[BoundExpression](call)
        }
    }

    /// ADR-0174 D7: rebinds a `ScopeFrame.Enter(default)` — the outermost
    /// scope of a function, which had no enclosing block to inherit from — so
    /// it enters under [`context`](paramref) instead. The block's `ctx`
    /// then links to the caller's scope, and cancelling the caller cancels it.
    /// @param call An imported call.
    /// @param context The ambient context to enter under.
    /// @returns The rebound call, or [`call`](paramref) when it is not a defaulted scope entry.
    func RetargetScopeEnter(call BoundImportedCallExpression, context BoundExpression) BoundExpression {
        if call
            .Function
            .Name != "Enter" ||
            call
            .Function
            .ImportedClass
            .ClassType
            .FullName != "Gsharp.Concurrency.ScopeFrame" ||
            call
            .Arguments
            .Length != 1 ||
            !(call.Arguments[0] is BoundDefaultExpression) {
            return call
        }
        return BindScopeEnter(call.Syntax, context)
    }

    /// Binds `AsyncLetCell.Start(frame)` (ADR-0174 D15).
    /// @param syntax The declaration's syntax.
    /// @param frame The enclosing scope's frame local.
    /// @returns A call typed `AsyncLetCell`.
    func BindAsyncLetStart(syntax SyntaxNode?, frame VariableSymbol) BoundExpression {
        let cell = Required(asyncLetCellType)
        let start = cell.GetMethod("Start", BindingFlags.Public | BindingFlags.Static) ??
            throw InvalidOperationException("AsyncLetCell.Start is missing from the channel runtime.")
        asyncLetCellClass ??= ImportedClassSymbol(cell, declaration: nil, references: references)
        let function = ImportedFunctionSymbol(
            "Start",
            asyncLetCellClass!!,
            start,
            declaration: nil,
            returnTypeOverride: AsyncLetCellType
        )
        return BoundImportedCallExpression(
            syntax,
            function,
            ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, frame))
        )
    }

    /// Binds `cell.Run[R](body)`, the goroutine body of an `async let`
    /// (ADR-0174 D15). The overload follows the operand's type after the
    /// suspension pass has rewritten it: a suspending call yields
    /// `ValueTask[R]`, an `async func` a `Task[R]`, and an
    /// ordinary call the value itself.
    /// @param cell A read of the cell.
    /// @param body The child's body.
    /// @param resultType The child's result type.
    /// @returns A call typed `ValueTask`.
    func BindAsyncLetRun(cell BoundExpression, body BoundExpression, resultType TypeSymbol) BoundExpression {
        let shape = BodyShapeOf(body.Type)
        let open_ = Required(asyncLetCellType).GetMethods(BindingFlags.Public | BindingFlags.Instance).Single(
            (m MethodInfo) -> m.Name == "Run" && ParameterShapeOf(m.GetParameters()[0].ParameterType) == shape
        )
        let (closedResult, symbolic) = ProjectElement(resultType)
        return BoundImportedInstanceCallExpression(
            nil,
            cell,
            open_.MakeGenericMethod(closedResult),
            ValueTaskType,
            ImmutableArray.Create(body),
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](resultType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// Binds `cell.Context` — the context the child runs under (ADR-0174
    /// D15). It is linked to the scope's, so the scope still collapses the
    /// child, but cancelling it alone unwinds one unread binding without
    /// disturbing its siblings.
    /// @param cell A read of the cell.
    /// @returns A property read typed `Context`.
    func BindAsyncLetContext(cell BoundExpression) BoundExpression {
        let property = Required(asyncLetCellType).GetProperty("Context", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("AsyncLetCell.Context is missing from the channel runtime.")
        return BoundClrPropertyAccessExpression(nil, cell, property, ContextType)
    }

    /// Binds `cell.CancelIfUnread()`, the scope-exit join of an unread `async let` (ADR-0174 D15).
    /// @param cell The cell local.
    /// @returns A call typed `void`.
    func BindAsyncLetCancelIfUnread(cell VariableSymbol) BoundExpression {
        let method = Required(asyncLetCellType).GetMethod(
            "CancelIfUnread",
            BindingFlags.Public | BindingFlags.Instance,
            Type.EmptyTypes
        ) ??
            throw InvalidOperationException("AsyncLetCell.CancelIfUnread is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, cell),
            method,
            TypeSymbol.Void,
            ImmutableArray[BoundExpression].Empty
        )
    }

    /// Binds `cell.AwaitAsync[R]()`, the read of an `async let` binding (ADR-0174 D15).
    /// @param cell The cell local.
    /// @param resultType The child's result type.
    /// @returns A call typed `ValueTask[R]`.
    func BindAsyncLetAwait(cell VariableSymbol, resultType TypeSymbol) BoundExpression {
        let open_ = Required(asyncLetCellType).GetMethod("AwaitAsync", BindingFlags.Public | BindingFlags.Instance) ??
            throw InvalidOperationException("AsyncLetCell.AwaitAsync is missing from the channel runtime.")
        let (closedResult, symbolic) = ProjectElement(resultType)
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, cell),
            open_.MakeGenericMethod(closedResult),
            ValueTaskOf(resultType),
            ImmutableArray[BoundExpression].Empty,
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](resultType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    /// Turns a blocking `CancelIfUnread` into the awaited `CancelIfUnreadAsync` (ADR-0174 D15).
    /// @param join The blocking join call.
    /// @returns An await expression typed `void`.
    func BindAsyncLetCancelIfUnreadAwait(join BoundImportedInstanceCallExpression) BoundExpression {
        let async_ = Required(asyncLetCellType).GetMethod(
            "CancelIfUnreadAsync",
            BindingFlags.Public | BindingFlags.Instance
        ) ??
            throw InvalidOperationException("AsyncLetCell.CancelIfUnreadAsync is missing from the channel runtime.")
        let call = BoundImportedInstanceCallExpression(
            join.Syntax,
            join.Receiver,
            async_,
            ValueTaskType,
            join.Arguments
        )
        return Await(join.Syntax, call, TypeSymbol.Void)
    }

    /// The `ValueTask` / `ValueTask[R]` type a suspending call is typed with; symbolic when
    /// [`resultType`](paramref) is.
    /// @param resultType The logical result type.
    /// @returns The wrapper type symbol.
    internal func ValueTaskOf(resultType TypeSymbol) TypeSymbol {
        if resultType == TypeSymbol.Void {
            return TypeSymbol.FromClrTypeWithoutNullability(Required(valueTask), NullabilityFreeReason.TypeLiteral)
        }
        let open_ = Required(valueTaskOpen)
        let (closedResult, symbolic) = ProjectElement(resultType)
        let closed = open_.MakeGenericType(closedResult)
        return if symbolic {
            cast[TypeSymbol](ImportedTypeSymbol.GetConstructed(closed, open_, ImmutableArray.Create(resultType)))
        } else {
            TypeSymbol.FromClrTypeWithoutNullability(closed, NullabilityFreeReason.CompilerProduced)
        }
    }

    private func Call(
        syntax SyntaxNode?,
        name string,
        carrierName string,
        elementType TypeSymbol,
        returnType TypeSymbol,
        arguments ImmutableArray[BoundExpression]
    ) BoundExpression {
        // The facade overloads every operation on its carrier (Channel<T> /
        // ChannelReader<T> / ChannelWriter<T>) and on its cancellation
        // argument (CancellationToken now; the hidden Context once Phase 3
        // threads it), so both select the method.
        let ops = Required(channelOps)
        let cancellationTypeName = arguments[^1].Type?.ClrType?.FullName ?? CancellationTokenTypeName
        let open_ = ops.GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == name && m.IsGenericMethodDefinition && m.GetParameters()
                .Length == arguments.Length &&
                m
                .GetParameters()[0]
                .ParameterType is {IsGenericType: true} carrier &&
                carrier
                .GetGenericTypeDefinition()
                .Name == carrierName &&
                m
                .GetParameters()[^1]
                .ParameterType
                .FullName == cancellationTypeName
        )
        let (closedElement, symbolic) = ProjectElement(elementType)
        let closed = open_.MakeGenericMethod(closedElement)
        channelOpsClass ??= ImportedClassSymbol(ops, declaration: nil, references: references)
        let function = ImportedFunctionSymbol(
            name,
            channelOpsClass!!,
            closed,
            declaration: nil,
            returnTypeOverride: returnType
        )
        return BoundImportedCallExpression(
            syntax,
            function,
            arguments,
            argumentRefKinds: default(ImmutableArray[RefKind]),
            typeArgumentSymbols: if symbolic {
                ImmutableArray.Create[TypeSymbol?](elementType)
            } else {
                default(ImmutableArray[TypeSymbol?])
            }
        )
    }

    private func DefaultToken() BoundExpression -> BoundDefaultExpression(
        nil,
        TypeSymbol.FromClrTypeWithoutNullability(Required(cancellationToken), NullabilityFreeReason.TypeLiteral)
    )

    private func BindSelectCall(waiter VariableSymbol, name string, returnType TypeSymbol) BoundExpression {
        let method = Required(selectWaiterType).GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Instance,
            Type.EmptyTypes
        ) ??
            throw InvalidOperationException("SelectWaiter.$name is missing from the channel runtime.")
        return BoundImportedInstanceCallExpression(
            nil,
            BoundVariableExpression(nil, waiter),
            method,
            returnType,
            ImmutableArray[BoundExpression].Empty
        )
    }

    private func ProjectElement(elementType TypeSymbol)(Closed Type, Symbolic bool) {
        // Mirrors TryResolveExplicitMethodTypeArgs (issue #320/#530): a
        // CLR-backed element (including `T?` as Nullable<T>) is projected onto
        // the reference set; anything without a reference-context CLR type
        // closes over System.Object and travels symbolically.
        let clr Type? = NullableTypeSymbol.GetEffectiveClrType(elementType)
        if clr != nil && !TypeSymbol.RequiresSymbolicProjection(elementType) {
            return (references.MapClrTypeToReferences(clr)!!, false)
        }
        // A symbolic element that still has a CLR shape — `string?` (a
        // reference-nullable annotation travels symbolically) or a named tuple
        // — must close over that shape, not System.Object: the emitter
        // re-encodes the symbolic type argument to exactly that CLR type for
        // the variable's `Chan<T>`, and ILVerify rejects a `Chan<object>`
        // construction stored into a `Chan<string>` local.
        let closed = if clr != nil {
            references.MapClrTypeToReferences(clr)!!
        } else {
            references.GetCoreType("System.Object")
        }
        return (closed, true)
    }

    shared {
        /// The runtime's constructed channel class.
        const ChanTypeName string = ChannelTypeSymbol.ConstructedChannelFullName

        /// The runtime's static operation facade.
        const ChannelOpsTypeName string = "Gsharp.Concurrency.ChannelOps"

        /// The runtime's `select` waiter.
        const SelectWaiterTypeName string = "Gsharp.Concurrency.SelectWaiter"

        private const CancellationTokenTypeName string = "System.Threading.CancellationToken"
        private const ContextTypeName string = "Gsharp.Concurrency.Context"
        private const AsyncLetCellTypeName string = "Gsharp.Concurrency.AsyncLetCell"

        /// Whether [`node`](paramref) is the `AddCancelled` call a
        /// `case cancelled` arm lowers to (ADR-0174 D8).
        /// @param node A bound node.
        /// @returns `true` for a cancelled-arm registration.
        func IsSelectAddCancelled(node BoundExpression) bool -> node is BoundImportedInstanceCallExpression call &&
            call
            .Method
            .Name == "AddCancelled" &&
            call
            .Method
            .DeclaringType
            ?.FullName == SelectWaiterTypeName

        /// Recognizes the blocking select wait the binder emits (ADR-0174 D8).
        /// @param call An imported instance call.
        /// @returns `true` for `SelectWaiter.Wait`.
        func IsSelectWait(call BoundImportedInstanceCallExpression) bool -> call.Receiver is BoundVariableExpression{
            Variable: {Name: var name}
        } &&
            name.StartsWith("<select$$waiter$$", StringComparison.Ordinal) &&
            call
            .Method
            .Name == "Wait" &&
            call
            .Method
            .DeclaringType
            ?.FullName == "Gsharp.Concurrency.SelectWaiter"

        /// Recognizes the blocking scope exit the binder emits.
        /// @param call An imported instance call.
        /// @returns `true` for `ScopeFrame.Exit`.
        func IsScopeExit(call BoundImportedInstanceCallExpression) bool -> call.Receiver is BoundVariableExpression{
            Variable: {Name: var name}
        } &&
            name.StartsWith("<scope$$frame$$", StringComparison.Ordinal) &&
            call
            .Method
            .Name == "Exit" &&
            call
            .Method
            .DeclaringType
            ?.FullName == "Gsharp.Concurrency.ScopeFrame"

        /// Recognizes a bound call on the facade by name.
        /// @param call The call.
        /// @param name The facade method name.
        /// @returns `true` when [`call`](paramref) targets `ChannelOps.<name>`.
        func IsFacadeCall(call BoundImportedCallExpression, name string) bool -> call
            .Function
            .Name == name &&
            call
            .Function
            .ImportedClass
            .ClassType
            .FullName == ChannelOpsTypeName

        /// ADR-0174 D4/D7: distinguishes a facade call the BINDER lowered from a
        /// channel operator (`<-ch`, `ch <- v`, a channel
        /// `range`, a `select` arm) from one the AUTHOR wrote by name.
        /// @remarks Every lowered operation is bound with a cancellation the binder
        /// itself supplied — the uncancellable default token when no lexical scope
        /// encloses it, or that scope's `Context` when one does — precisely so
        /// the suspension pass can later park it on the ambient context via
        /// (cref:RetargetFacadeCancellation). A call written out as
        /// `ChannelOps.Receive2(ch, token)` has already chosen its
        /// cancellation, so there is nothing for that pass to retarget: it is an
        /// ordinary blocking call to a public library method.
        ///
        /// That distinction is load-bearing for the COLORING. Marking the
        /// caller suspending prepends a hidden `Context` parameter and retypes
        /// the return as `ValueTask` — an ABI change — which is the point for a
        /// channel operator but is pure cost for a written facade call, whose body
        /// the pass leaves untouched. It also breaks callers that reflect over the
        /// signature: an xUnit `[Fact]` that drains a channel through the
        /// facade is rejected at discovery as "not allowed to have parameters"
        /// (#3501, migrated `test/Extensions.Tests`).
        /// @param call A facade call, already matched by (cref:IsFacadeCall).
        /// @returns `true` when the trailing cancellation argument was written by the author rather than
        /// supplied by the binder.
        func HasAuthorWrittenCancellation(call BoundImportedCallExpression) bool -> call
            .Arguments
            .Length != 0 &&
            (!(call.Arguments[^1] is BoundDefaultExpression) || call.Arguments[^1].Syntax is DefaultExpressionSyntax) &&
            (call.Arguments[^1].Type?.ClrType?.FullName is CancellationTokenTypeName or ContextTypeName)

        /// ADR-0174 D7, the cross-assembly half: supplies the ambient context to a
        /// call on an imported suspending function. The importing compilation binds
        /// that function's declared signature — the hidden context is a trailing
        /// optional parameter it knows nothing about — so the argument is appended
        /// here, or replaces the `nil` the resolver filled in.
        /// @param call An imported call.
        /// @param context The ambient context.
        /// @returns The call with the context supplied, or [`call`](paramref) when it takes none.
        func SupplyImportedContext(call BoundImportedCallExpression, context BoundExpression) BoundExpression {
            if !TryAppendImportedContext(call.Function.Method, call.Arguments, context, out var arguments) {
                return call
            }
            return BoundImportedCallExpression(
                call.Syntax,
                call.Function,
                arguments,
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.StaticContainerType
            )
        }

        /// ADR-0174 D7, the cross-assembly half for instance methods (issue #4392):
        /// supplies the ambient context to a call on an imported suspending
        /// instance method, ordinary or through `base`, exactly as
        /// (cref:SupplyImportedContext(BoundImportedCallExpression, BoundExpression))
        /// does for a static one.
        /// @param call An imported instance call.
        /// @param context The ambient context.
        /// @returns The call with the context supplied, or [`call`](paramref) when it takes none.
        func SupplyImportedContext(call BoundImportedInstanceCallExpression, context BoundExpression) BoundExpression {
            if !TryAppendImportedContext(call.Method, call.Arguments, context, out var arguments) {
                return call
            }
            return BoundImportedInstanceCallExpression(
                call.Syntax,
                call.Receiver,
                call.Method,
                call.Type,
                arguments,
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.ConstrainedReceiverTypeParameter,
                call.ConstrainedInterfaceType,
                call.IsNonVirtualBaseCall
            )
        }

        /// Supplies the ambient context to a synthesized CLR static call used by
        /// an imported suspending method-group adapter.
        /// @param call A CLR static call.
        /// @param context The ambient context.
        /// @returns The call with the context supplied, or [`call`](paramref) when it takes none.
        func SupplyImportedContext(call BoundClrStaticCallExpression, context BoundExpression) BoundExpression {
            if !TryAppendImportedContext(call.Method, call.Arguments, context, out var arguments) {
                return call
            }
            let refKinds = if call.ArgumentRefKinds.IsDefault {
                default(ImmutableArray[RefKind])
            } else {
                call.ArgumentRefKinds.Add(RefKind.None)
            }
            return call.WithArguments(arguments, refKinds)
        }

        /// Recovers the direction a facade call was bound with from its carrier parameter.
        /// @param call A facade call.
        /// @returns The direction.
        func DirectionOf(call BoundImportedCallExpression) ChannelDirection {
            let carrier = call.Function.Method.GetParameters()[0].ParameterType
            let name = if carrier.IsGenericType {
                carrier.GetGenericTypeDefinition().Name
            } else {
                carrier.Name
            }
            return switch name {
                case "ChannelReader`1": ChannelDirection.In
                case "ChannelWriter`1": ChannelDirection.Out
                default: ChannelDirection.Both
            }
        }

        /// Recovers the element type a facade call was bound with: the symbolic type argument when one
        /// travelled, else the closed CLR argument.
        /// @param call A facade call.
        /// @returns The element type.
        func ElementTypeOf(call BoundImportedCallExpression) TypeSymbol {
            if !call.TypeArgumentSymbols.IsDefaultOrEmpty && call.TypeArgumentSymbols[0] is {} symbolic {
                return symbolic
            }
            return TypeSymbol.FromClrTypeWithoutNullability(
                call.Function.Method.GetGenericArguments()[0],
                NullabilityFreeReason.TypeStructure
            )
        }

        /// Whether [`node`](paramref) is the scope-exit join of an `async let` cell (ADR-0174 D15).
        /// @param node A bound node.
        /// @returns `true` for a blocking `CancelIfUnread` call.
        func IsAsyncLetCancelIfUnread(node BoundExpression) bool -> node is BoundImportedInstanceCallExpression{
            Method: {Name: "CancelIfUnread"}
        } call &&
            call
            .Method
            .DeclaringType
            ?.FullName == AsyncLetCellTypeName

        private func Await(
            syntax SyntaxNode?,
            call BoundExpression,
            resultType TypeSymbol
        ) BoundExpression -> BoundAwaitExpression
            .CreateImplicitCompletion(
            syntax,
            call,
            resultType,
            ExpressionBinder.TryGetAwaiterTypeSymbol(Required(call.Type))
        )

        private func CarrierFor(direction ChannelDirection) string -> switch direction {
            case ChannelDirection.In: "ChannelReader`1"
            case ChannelDirection.Out: "ChannelWriter`1"
            default: "Channel`1"
        }

        private func IsTask(clr Type) bool {
            for var t Type? = clr; t != nil; t = t!!.BaseType {
                if t.FullName == "System.Threading.Tasks.Task" {
                    return true
                }
            }
            return false
        }

        private func Required[T class](value T?) T -> value ??
            throw InvalidOperationException(
            "The channel runtime is not in the reference set; callers must check IsAvailable first."
        )

        private func BodyShapeOf(type TypeSymbol?) string {
            let clr Type? = type?.ClrType
            if clr == nil || !clr.IsGenericType {
                return "value"
            }
            return switch clr.GetGenericTypeDefinition().FullName {
                case "System.Threading.Tasks.ValueTask`1": "valuetask"
                case "System.Threading.Tasks.Task`1": "task"
                default: "value"
            }
        }

        private func ParameterShapeOf(parameter Type) string {
            if !parameter.IsGenericType {
                return "value"
            }
            return switch parameter.GetGenericTypeDefinition().FullName {
                case "System.Threading.Tasks.ValueTask`1": "valuetask"
                case "System.Threading.Tasks.Task`1": "task"
                default: "value"
            }
        }

        private func TryAppendImportedContext(
            method MethodInfo,
            callArguments ImmutableArray[BoundExpression],
            context BoundExpression,
            out arguments ImmutableArray[BoundExpression]
        ) bool {
            arguments = callArguments
            if !ImportedFunctionSymbol.HasHiddenContextParameter(method) {
                return false
            }
            let parameters = method.GetParameters()
            if callArguments.Length == parameters.Length - 1 {
                arguments = callArguments.Add(context)
                return true
            }
            if callArguments.Length == parameters.Length &&
                (callArguments[^1] is BoundDefaultExpression or BoundLiteralExpression) {
                arguments = callArguments.SetItem(callArguments.Length - 1, context)
                return true
            }
            return false
        }
    }
}
