// <copyright file="Evaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Emit = GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Program evaluator.
/// </summary>
/// <remarks>
/// Issue #1651: this type owns a <see cref="ThreadLocal{T}"/> (<c>executionState</c>)
/// but is intentionally not <see cref="IDisposable"/>. Fire-and-forget
/// <c>go</c> tasks (ADR-0022) may still be running on background threads
/// after <see cref="Evaluate"/> returns, so eagerly disposing the
/// ThreadLocal here would risk an <see cref="ObjectDisposedException"/> on
/// one of those threads. The per-thread slots are reclaimed once every
/// thread that touched them exits; CA1001 is suppressed for that
/// deliberate trade-off.
/// </remarks>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private readonly BoundProgram program;
    private readonly Dictionary<VariableSymbol, object> globals;

    // Issue #1651: everything below this point used to be an ordinary
    // instance field. That is correct only because the interpreter was
    // assumed single-threaded, but `go`/`scope` spawn the goroutine body on
    // a ThreadPool thread via Task.Run while the spawning thread keeps
    // running the enclosing block concurrently. Sharing the locals stack
    // and control-transfer flags (isReturning/pendingGotoLabel/lastValue)
    // between those threads corrupts frame resolution and lets a `return`
    // inside a goroutine make an unrelated caller's function return early.
    // `executionState` gives every thread (main thread and every goroutine)
    // its own copy of that per-execution state, held in a ThreadLocal. Only
    // true interpreter globals (globals/static fields/iterator cache/random)
    // remain shared, guarded by <see cref="globalsLock"/>.
    private readonly ThreadLocal<ExecutionState> executionState = new(() => new ExecutionState());

    // Guards every read/write of state that is genuinely shared across
    // goroutines: global variables, struct/interface static fields, the
    // iterator-function cache, and the lazily-created Random instance.
    // None of the .NET collections backing them are thread-safe.
    private readonly object globalsLock = new object();

    private readonly Dictionary<Symbols.FunctionSymbol, bool> iteratorFunctionCache = [];
    private readonly Dictionary<(Symbols.StructSymbol, Symbols.FieldSymbol), object> staticFields = [];

    // ADR-0089 / issue #1030: interface static-field storage. Keyed by the
    // owning interface symbol so each closed construction of a generic interface
    // (`IBox[int32]` vs `IBox[string]`) owns independent storage, matching CLR
    // static-field semantics. The non-generic case keys by the single interface.
    private readonly Dictionary<(Symbols.InterfaceSymbol, Symbols.FieldSymbol), object> interfaceStaticFields = [];
    private Random random;

    // Issue #1656: BoundBlockStatement is immutable, so the label->index map
    // is the same on every execution of a given block. Every function/method
    // call, switch arm, scope/try/select body, and await-for iteration used
    // to rebuild this dictionary from scratch, making it an O(statements)
    // allocation on the hottest path in the interpreter. Cache it per block
    // instance instead; ConditionalWeakTable.GetValue is thread-safe and the
    // factory is idempotent (rebuilding the same map is harmless), and
    // entries are reclaimed once the owning block is unreachable.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<BoundBlockStatement, Dictionary<BoundLabel, int>> LabelIndexCache = new();

    // Issue #1799: a G# map value is Go-style reference-shared — the SAME
    // Dictionary<,> instance can be captured by multiple goroutine closures
    // and read/written concurrently. Plain Dictionary<,> is not thread-safe
    // under concurrent access (a write racing another write, or even a read
    // racing a write, can corrupt its internal buckets/entries array mid-
    // resize). The map's declared CLR type must stay Dictionary<,> (see
    // EvaluateMapLiteralExpression), so — unlike frames/StructValue.Fields
    // in #1718 — this can't be fixed by swapping the storage type. Instead,
    // every interpreter-owned map access (index read, index write, delete,
    // len) takes a lock keyed by the dictionary instance itself via this
    // table, giving the same "no corruption under concurrent access"
    // guarantee ConcurrentDictionary provides, scoped to the operations the
    // interpreter itself performs.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, object> MapLocks = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="Evaluator"/> class.
    /// </summary>
    /// <param name="program">The program.</param>
    /// <param name="variables">The variables.</param>
    public Evaluator(BoundProgram program, Dictionary<VariableSymbol, object> variables)
    {
        this.program = program;
        globals = variables;
        Locals.Push(new ConcurrentDictionary<VariableSymbol, object>());
    }

    // Issue #1718: a frame dictionary is shared by reference with every
    // goroutine spawned while it is on the locals stack (see
    // CloneExecutionStateForGoroutine), so a captured enclosing-scope
    // variable can be assigned from the spawning thread and a goroutine at
    // the same time. Plain Dictionary<,> is not thread-safe under
    // concurrent writes (can corrupt buckets/throw on resize); every frame
    // is a ConcurrentDictionary so those racing reads/writes are safe.
    private Stack<ConcurrentDictionary<VariableSymbol, object>> Locals => executionState.Value.Locals;

    private Stack<ScopeFrame> ScopeFrames => executionState.Value.ScopeFrames;

    private Stack<System.Collections.IList> IteratorSinks => executionState.Value.IteratorSinks;

    private object LastValue
    {
        get => executionState.Value.LastValue;
        set => executionState.Value.LastValue = value;
    }

    // Issue #738: control-transfer state for nested blocks (switch arms,
    // try/catch/finally bodies, scope bodies, select cases, await-for-range
    // bodies). Those constructs are kept as nested BoundBlockStatements after
    // lowering, so a `return` or a `break`/`continue` (lowered to a labeled
    // `goto` whose target lives in the enclosing function block) inside one
    // of them used to be swallowed by the inner EvaluateStatement loop. The
    // fields below let an inner loop signal an in-flight control transfer to
    // outer loops, which propagate it until it either resolves at the right
    // label or unwinds to a function boundary (where `EvaluateFunctionBody`
    // consumes it). Issue #1651: per-thread via <see cref="executionState"/>
    // so a return inside a goroutine cannot flip the caller's flag.
    private bool IsReturning
    {
        get => executionState.Value.IsReturning;
        set => executionState.Value.IsReturning = value;
    }

    private BoundLabel PendingGotoLabel
    {
        get => executionState.Value.PendingGotoLabel;
        set => executionState.Value.PendingGotoLabel = value;
    }

    /// <summary>
    /// Evaluates the program and returns the evaluated result.
    /// </summary>
    /// <returns>The evaluation result.</returns>
    public object Evaluate()
    {
        return EvaluateFunctionBody(program.Statement);
    }

    // Issue #1651: goroutines run with their own locals/control-transfer
    // state (see EvaluateGoStatement), but globals, struct/interface static
    // fields, the iterator-function cache and the lazily-created Random
    // instance are genuinely shared across every thread. None of the
    // backing collections are thread-safe, so every access is funneled
    // through these helpers, guarded by globalsLock.
    private object GetGlobal(VariableSymbol variable)
    {
        lock (globalsLock)
        {
            return globals[variable];
        }
    }

    private bool TryGetGlobal(VariableSymbol variable, out object value)
    {
        lock (globalsLock)
        {
            return globals.TryGetValue(variable, out value);
        }
    }

    private void SetGlobal(VariableSymbol variable, object value)
    {
        lock (globalsLock)
        {
            globals[variable] = value;
        }
    }

    private bool TryGetStaticField(Symbols.StructSymbol structType, Symbols.FieldSymbol field, out object value)
    {
        lock (globalsLock)
        {
            return staticFields.TryGetValue((structType, field), out value);
        }
    }

    private void SetStaticField(Symbols.StructSymbol structType, Symbols.FieldSymbol field, object value)
    {
        lock (globalsLock)
        {
            staticFields[(structType, field)] = value;
        }
    }

    private bool TryGetInterfaceStaticField(Symbols.InterfaceSymbol interfaceType, Symbols.FieldSymbol field, out object value)
    {
        lock (globalsLock)
        {
            return interfaceStaticFields.TryGetValue((interfaceType, field), out value);
        }
    }

    private void SetInterfaceStaticField(Symbols.InterfaceSymbol interfaceType, Symbols.FieldSymbol field, object value)
    {
        lock (globalsLock)
        {
            interfaceStaticFields[(interfaceType, field)] = value;
        }
    }

    private bool TryGetCachedIsIteratorFunction(Symbols.FunctionSymbol function, out bool isIterator)
    {
        lock (globalsLock)
        {
            return iteratorFunctionCache.TryGetValue(function, out isIterator);
        }
    }

    private void CacheIsIteratorFunction(Symbols.FunctionSymbol function, bool isIterator)
    {
        lock (globalsLock)
        {
            iteratorFunctionCache[function] = isIterator;
        }
    }

    private int NextRandom(int max)
    {
        lock (globalsLock)
        {
            random ??= new Random();
            return random.Next(max);
        }
    }

    /// <summary>
    /// Issue #1650: pushes a locals frame for a user-function call (plain
    /// call, closure/indirect call, instance/base call, property or event
    /// accessor, constrained static call, constructor body, etc.) and
    /// returns a guard that pops it on <see cref="IDisposable.Dispose"/>.
    /// Use with a <c>using</c> statement/declaration so the frame is always
    /// popped — including when the callee throws and a caller-level
    /// try/catch handles the exception. Without this guard, an unwound
    /// exception used to leave the callee's dead frame on the stack,
    /// corrupting every subsequent local-variable read/write in the caller.
    /// </summary>
    /// <param name="frame">The frame to push (parameters, 'this', captured locals).</param>
    /// <returns>A disposable guard that pops <paramref name="frame"/> exactly once.</returns>
    private FrameScope PushFrame(ConcurrentDictionary<VariableSymbol, object> frame) => new(Locals, frame);

    private static Dictionary<BoundLabel, int> GetLabelToIndex(BoundBlockStatement body) =>
        LabelIndexCache.GetValue(body, static b =>
        {
            var map = new Dictionary<BoundLabel, int>();

            for (var i = 0; i < b.Statements.Length; i++)
            {
                if (b.Statements[i] is BoundLabelStatement l)
                {
                    map.Add(l.Label, i + 1);
                }
            }

            return map;
        });

    /// <summary>
    /// Disposable guard returned by <see cref="PushFrame(ConcurrentDictionary{VariableSymbol, object})"/>
    /// that pops the associated locals frame when disposed, guaranteeing the
    /// pop runs on both normal and exceptional (unwind) control flow.
    /// </summary>
    private readonly struct FrameScope : IDisposable
    {
        private readonly Stack<ConcurrentDictionary<VariableSymbol, object>> stack;

        /// <summary>
        /// Initializes a new instance of the <see cref="FrameScope"/> struct,
        /// pushing <paramref name="frame"/> onto <paramref name="stack"/>.
        /// </summary>
        /// <param name="stack">The locals stack to push onto and later pop from.</param>
        /// <param name="frame">The frame to push.</param>
        public FrameScope(Stack<ConcurrentDictionary<VariableSymbol, object>> stack, ConcurrentDictionary<VariableSymbol, object> frame)
        {
            this.stack = stack;
            this.stack.Push(frame);
        }

        /// <summary>
        /// Pops the frame pushed by the constructor.
        /// </summary>
        public void Dispose() => stack.Pop();
    }

    /// <summary>
    /// Issue #491 (ADR-0060 follow-up): sentinel stored in the locals dictionary
    /// for a ref-aliasing local. Reads of the local re-evaluate <see cref="Operand"/>;
    /// writes are routed back to <see cref="Operand"/> via <see cref="WriteBackToOperand"/>.
    /// </summary>
    private sealed class RefAlias
    {
        public RefAlias(Binding.BoundExpression operand)
        {
            Operand = operand;
        }

        public Binding.BoundExpression Operand { get; }
    }

    private sealed class InterpAsyncEnumerableBuffer<T> :
        System.Collections.Generic.IAsyncEnumerable<T>,
        System.Collections.Generic.IAsyncEnumerator<T>
    {
        private readonly System.Collections.Generic.IList<T> items;
        private int index = -1;

        public InterpAsyncEnumerableBuffer(System.Collections.Generic.IList<T> items)
        {
            this.items = items;
        }

        public T Current => items[index];

        public System.Collections.Generic.IAsyncEnumerator<T> GetAsyncEnumerator(
            System.Threading.CancellationToken cancellationToken = default)
        {
            return new InterpAsyncEnumerableBuffer<T>(items);
        }

        public System.Threading.Tasks.ValueTask<bool> MoveNextAsync()
        {
            index++;
            return new System.Threading.Tasks.ValueTask<bool>(index < items.Count);
        }

        public System.Threading.Tasks.ValueTask DisposeAsync()
        {
            return default;
        }
    }

    private sealed class ScopeFrame
    {
        public List<Task> Tasks { get; } = [];

        public System.Threading.CancellationTokenSource Cts { get; } = new System.Threading.CancellationTokenSource();
    }

    /// <summary>
    /// Issue #1651: per-thread interpreter state. One instance lives on the
    /// main thread and one more is created for every goroutine (<c>go</c>/
    /// <c>scope</c> task), so pushing/popping locals frames or flipping a
    /// control-transfer flag on one thread is invisible to every other
    /// thread. See <see cref="EvaluateGoStatement"/> for how a goroutine's
    /// instance is seeded from its parent's locals chain to preserve
    /// closure visibility while still isolating call-frame push/pop.
    /// </summary>
    private sealed class ExecutionState
    {
        public Stack<ConcurrentDictionary<VariableSymbol, object>> Locals { get; set; } = new();

        public Stack<ScopeFrame> ScopeFrames { get; set; } = new();

        public Stack<System.Collections.IList> IteratorSinks { get; set; } = new();

        public object LastValue { get; set; }

        public bool IsReturning { get; set; }

        public BoundLabel PendingGotoLabel { get; set; }
    }
}
