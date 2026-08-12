// <copyright file="Issue3355GeneralBlockExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3355 end-to-end binding and emitted-runtime coverage for general
/// block expressions.
/// </summary>
public class Issue3355GeneralBlockExpressionTests
{
    [Fact]
    public void Expressions_RunInInitializersArgumentsOperandsCollectionsAndReturns()
    {
        var result = EmittedOracle.Evaluate("""
            func add(a int32, b int32) int32 {
                return a + b
            }

            func run() int32 {
                var calls = 0
                let next = (value int32) -> {
                    calls = calls + 1
                    value
                }
                let local = { let x = next(1) x + 1 }
                let array = []int32{{ let x = next(2) x }, { let x = next(3) x }}
                let answer = { let x = add(local, array[0]) x * { let y = array[1] y } }
                let nestedLeft = { { let flag = true flag } ? 0 : 100 }
                return answer * 10 + calls + nestedLeft
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void SpilledControlFlowBlock_PreservesEarlierArgumentValues()
    {
        var result = EmittedOracle.Evaluate("""
            func combine(first int32, second int32) int32 {
                return first * 10 + second
            }

            func run() int32 {
                var first = 1
                return combine(
                    first,
                    {
                        if false { return 0 }
                        first = 2
                        3
                    })
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void InstanceAndStaticFieldInitializers_RunInDeclarationOrder()
    {
        var result = EmittedOracle.Evaluate("""
            class Holder {
                var value int32 = { let x = 40 x + 2 }

                shared {
                    var SharedValue int32 = { let x = 20 x + 1 }
                }
            }

            Holder().value + Holder.SharedValue
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(63, result.Value);
    }

    [Fact]
    public void FieldInitializerBlocks_CanProduceCapturingClosures()
    {
        var result = EmittedOracle.Evaluate("""
            class Holder {
                var callback (int32) -> int32 = {
                    let offset = 2
                    (value) -> value + offset
                }

                shared {
                    var SharedCallback (int32) -> int32 = {
                        let offset = 1
                        (value) -> value + offset
                    }
                }
            }

            Holder().callback(40) + Holder.SharedCallback(20)
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(63, result.Value);
    }

    [Fact]
    public void BaseAndDelegatingConstructorArguments_AcceptBlocks()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {
                var value int32

                init(value int32) {
                    this.value = value
                }
            }

            class Derived : Base {
                init(seed int32) : base({ let x = seed + 1 x }) { }

                func Get() int32 {
                    return this.value
                }
            }

            class Delegating {
                var value int32

                init(value int32) {
                    this.value = value
                }

                convenience init() {
                    init({ let x = 41 x + 1 })
                }

                func Get() int32 {
                    return this.value
                }
            }

            Derived(41).Get() + Delegating().Get()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void ConstructorArguments_PropagateExpectedTypesThroughBlocks()
    {
        var result = EmittedOracle.Evaluate("""
            open class CallbackBase {
                var value int32

                init(callback (int32) -> int32) {
                    this.value = callback(40)
                }
            }

            class CallbackDerived : CallbackBase {
                init() : base({
                    let offset = 2
                    if true {
                        (value) -> value + offset
                    } else {
                        (value) -> value - offset
                    }
                }) { }

                func Get() int32 {
                    return this.value
                }
            }

            class Delegating {
                var value string?

                init(value string?) {
                    this.value = value
                }

                convenience init() {
                    init({ let marker = 1 default })
                }

                func Get() string {
                    return this.value ?? "ok"
                }
            }

            CallbackDerived().Get() + Delegating().Get().Length
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(44, result.Value);
    }

    [Fact]
    public void ClrBaseConstructor_UsesOtherArgumentsToSelectBlockLambdaTarget()
    {
        var result = EmittedOracle.Evaluate("""
            import GSharp.Core.Tests.Fixtures

            class Derived : Issue3355OverloadedBaseFixture {
                init() : base(40, {
                    let marker = 1
                    (value) -> value
                }) { }

                func Get() int32 {
                    return this.Value
                }
            }

            Derived().Get()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(40, result.Value);
    }

    [Fact]
    public void BlockScope_ShadowingAndNestedCapture_Work()
    {
        var result = EmittedOracle.Evaluate("""
            let x = 1
            let f (int32) -> int32 = {
                let x = 40
                {
                    let offset = x
                    (value) -> value + offset
                }
            }

            x + f(2)
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(43, result.Value);
    }

    [Fact]
    public void TypedContexts_PropagateExpectedTypeToTrailingExpression()
    {
        var result = EmittedOracle.Evaluate("""
            let nullable string? = { let marker = 1 default }
            let fn (int32) -> int32 = { let offset = 1 (value) -> value + offset }
            let values = []string?{{ let marker = 2 nil }}

            (nullable ?? "ok").Length + fn(40) + (values[0] ?? "").Length
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(43, result.Value);
    }

    [Fact]
    public void FunctionArgument_PropagatesExpectedTypeThroughBlockToLambda()
    {
        var result = EmittedOracle.Evaluate("""
            func invoke(value int32, callback (int32) -> int32) int32 {
                return callback(value)
            }

            invoke(40, { let offset = 2 (value) -> value + offset })
                + invoke(
                    39,
                    {
                        let offset = 3
                        if true {
                            (value) -> value + offset
                        } else {
                            (value) -> value - offset
                        }
                    })
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(84, result.Value);
    }

    [Fact]
    public void OverloadResolution_UsesTrailingBlockLambdaShape()
    {
        var result = EmittedOracle.Evaluate("""
            import GSharp.Core.Tests.Fixtures

            func apply(value int32, callback (int32) -> int32) int32 {
                return callback(value)
            }

            func apply(value int32, callback (int32, int32) -> int32) int32 {
                return callback(value, 0)
            }

            func applyGeneric[T](value T, callback (T) -> T) T {
                return callback(value)
            }

            let user = apply(40, { let offset = 2 (value) -> value + offset })
            let generic = applyGeneric(40, { let offset = 2 (value) -> value + offset })
            let imported = Issue3355OverloadedMethodFixture.Apply(
                40,
                { let offset = 2 (value) -> value + offset })
            let constructed = Issue3355OverloadedObjectFixture(
                40,
                { let offset = 2 (value) -> value + offset }).Value
            user + generic + imported + constructed
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(168, result.Value);
    }

    [Fact]
    public void GenericTupleAndDefaultArgumentValues_PreserveTypes()
    {
        var result = EmittedOracle.Evaluate("""
            func identity[T](value T) T {
                return value
            }

            func nullableLength(value string?) int32 {
                return (value ?? "").Length
            }

            let pair = identity({ let first = 40 (first, 2) })
            pair.Item1 + pair.Item2 + nullableLength({ let marker = 1 default })
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void EarlyReturnNarrowing_FlowsIntoTrailingExpression()
    {
        var result = EmittedOracle.Evaluate("""
            func length(value string?) int32 {
                return {
                    if value == nil { return 0 }
                    value.Length
                }
            }

            length("hi") + length(nil)
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void AddressOfBlock_EvaluatesPrefixThenTakesTrailingLvalueAddress()
    {
        var result = EmittedOracle.Evaluate("""
            func set(out value int32) {
                value = 42
            }

            func run() int32 {
                var target = 0
                var calls = 0
                set(&{ calls = calls + 1 target })
                return target * 10 + calls
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(421, result.Value);

        var readOnly = EmittedOracle.Evaluate("""
            func set(out value int32) {
                value = 42
            }

            let target = 0
            set(&{ let marker = 1 target })
            """);

        Assert.Contains(readOnly.Diagnostics, diagnostic => diagnostic.Id == "GS9005");

        var forwardedOut = EmittedOracle.Evaluate("""
            func set(out value int32) {
                value = 42
            }

            func forward(out value int32) {
                set(&{ let marker = 1 value })
            }

            func run() int32 {
                var value = 0
                forward(&value)
                return value
            }

            run()
            """);

        Assert.DoesNotContain(forwardedOut.Diagnostics, diagnostic => diagnostic.Id == "GS0238");
        Assert.DoesNotContain(forwardedOut.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(42, forwardedOut.Value);
    }

    [Fact]
    public void OutAssignmentInsideBlock_CountsForDefiniteAssignment()
    {
        var result = EmittedOracle.Evaluate("""
            func assign(out value int32) {
                let ignored = { value = 42 0 }
            }

            func run() int32 {
                var result = 0
                assign(&result)
                return result
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id is "GS0238" or "GS0239");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BlocksInConditionalAndCollectionContexts_PreserveDefiniteAssignmentFlow()
    {
        var result = EmittedOracle.Evaluate("""
            func assignConditional(out value int32, flag bool) {
                let ignored = flag
                    ? { value = 40 0 }
                    : { value = 41 0 }
            }

            func assignCollection(out value int32) {
                let ignored = []int32{{ value = 2 0 }}
            }

            func run() int32 {
                var first = 0
                var second = 0
                assignConditional(&first, true)
                assignCollection(&second)
                return first + second
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0238");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BlockInShortCircuitOperand_DoesNotFalselyAssignOutParameter()
    {
        var result = EmittedOracle.Evaluate("""
            func assign(out value int32, flag bool) {
                let ignored = flag && { value = 42 true }
            }
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0238");
    }

    [Fact]
    public void AwaitInsideBlock_SpillsAndRunsOnce()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading.Tasks

            async func answer() int32 {
                return {
                    let first = await Task.FromResult(40)
                    let second = await Task.FromResult(2)
                    first + second
                }
            }

            answer().Result
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void AwaitBlock_PreservesEarlierArgumentValues()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading.Tasks

            func combine(first int32, second int32) int32 {
                return first * 10 + second
            }

            async func run() int32 {
                var first = 1
                return combine(
                    first,
                    {
                        first = 2
                        await Task.Yield()
                        3
                    })
            }

            run().Result
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void AwaitBlocksInSelectHeader_PreserveSourceOrder()
    {
        var result = EmittedOracle.Evaluate("""
            import Gsharp.Extensions.Go
            import System.Threading.Tasks

            async func run() int32 {
                let channel = make(chan int32, 1)
                var order = 0
                select {
                    case {
                        order = order * 10 + 1
                        await Task.Yield()
                        channel
                    } <- {
                        order = order * 10 + 2
                        await Task.Yield()
                        30
                    } { }
                }

                return order + <-channel
            }

            run().Result
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void AsyncIterator_BlockAwaitAndYield_SpillWithoutReordering()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            import System.Threading.Tasks

            func values() IAsyncEnumerable[int32] {
                let ignored = {
                    await Task.Yield()
                    yield 40
                    0
                }
                yield {
                    let value = await Task.FromResult(2)
                    value
                }
            }

            async func total() int32 {
                var result = 0
                await for value in values() {
                    result = result + value
                }
                return result
            }

            total().Result
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void MissingTailAndEscapedLocal_ReportFocusedDiagnostics()
    {
        var missingTail = EmittedOracle.Evaluate("""
            let value = { let x = 1 }
            """);
        var missingTailDiagnostic = Assert.Single(missingTail.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0277"));
        Assert.Single(missingTail.Diagnostics);
        Assert.Equal("}", missingTailDiagnostic.Location.Text.ToString(missingTailDiagnostic.Location.Span));

        var escapedLocal = EmittedOracle.Evaluate("""
            let value = { let hidden = 1 hidden }
            hidden
            """);
        Assert.Contains(
            escapedLocal.Diagnostics,
            diagnostic => diagnostic.IsError && diagnostic.Message.Contains("'hidden'"));
    }

    [Fact]
    public void ThrowAndExceptionPaths_DoNotEvaluateTail()
    {
        var result = EmittedOracle.Evaluate("""
            import System

            func run() int32 {
                var calls = 0

                try {
                    let ignored = {
                        calls = calls + 1
                        throw InvalidOperationException("boom")
                        calls = calls + 100
                        calls
                    }
                } catch (e InvalidOperationException) {
                }

                return calls
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);

        var throwExpression = EmittedOracle.Evaluate("""
            import System

            func combine(first int32, second int32) int32 {
                return first + second
            }

            func run() int32 {
                try {
                    return combine(1, {
                        let marker = 0
                        (throw InvalidOperationException("boom"))
                    })
                } catch (e InvalidOperationException) {
                    return 42
                }
            }

            run()
            """);

        Assert.DoesNotContain(throwExpression.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(throwExpression.UnhandledException);
        Assert.Equal(42, throwExpression.Value);
    }

    [Fact]
    public void LoopJumpsAndIteratorYield_KeepEnclosingControlContext()
    {
        var loop = EmittedOracle.Evaluate("""
            func run() int32 {
                var value = 0
                while value < 10 {
                    let ignored = {
                        value = value + 1
                        if value == 2 { continue }
                        if value == 4 { break }
                        value
                    }
                }

                return value
            }

            run()
            """);

        Assert.DoesNotContain(loop.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(loop.UnhandledException);
        Assert.Equal(4, loop.Value);

        var iterator = EmittedOracle.Evaluate("""
            import System.Linq

            func values() sequence[int32] {
                let ignored = {
                    yield 40
                    0
                }
                yield { let value = 2 value }
            }

            values().Sum()
            """);

        Assert.DoesNotContain(iterator.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(iterator.UnhandledException);
        Assert.Equal(42, iterator.Value);

        var nestedYield = EmittedOracle.Evaluate("""
            import System.Linq

            func values() sequence[int32] {
                yield 1 + {
                    yield 40
                    2
                }
            }

            values().Sum()
            """);

        Assert.DoesNotContain(nestedYield.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(nestedYield.UnhandledException);
        Assert.Equal(43, nestedYield.Value);
    }

    [Fact]
    public void EscapingControlFlow_DoesNotLeaveParentExpressionValuesOnIlStack()
    {
        var returning = EmittedOracle.Evaluate("""
            func run() int32 {
                return 1 + { return 42 0 }
            }

            run()
            """);

        Assert.DoesNotContain(returning.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(returning.UnhandledException);
        Assert.Equal(42, returning.Value);

        var breaking = EmittedOracle.Evaluate("""
            func run() int32 {
                while true {
                    let ignored = 1 + { break 0 }
                }

                return 42
            }

            run()
            """);

        Assert.DoesNotContain(breaking.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(breaking.UnhandledException);
        Assert.Equal(42, breaking.Value);

        var throwing = EmittedOracle.Evaluate("""
            import System

            func makeError(prefix int32, value int32) Exception {
                return InvalidOperationException("unreachable")
            }

            func run() int32 {
                throw makeError(1, { return 42 0 })
            }

            run()
            """);

        Assert.DoesNotContain(throwing.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(throwing.UnhandledException);
        Assert.Equal(42, throwing.Value);

        var channelSend = EmittedOracle.Evaluate("""
            import Gsharp.Extensions.Go

            func run() int32 {
                let channel = make(chan int32, 1)
                channel <- 1 + { return 42 0 }
                return <-channel
            }

            run()
            """);

        Assert.DoesNotContain(channelSend.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(channelSend.UnhandledException);
        Assert.Equal(42, channelSend.Value);

        var goStatement = EmittedOracle.Evaluate("""
            import Gsharp.Extensions.Go

            func consume(first int32, second int32) {
            }

            func run() int32 {
                go consume(1, { return 42 0 })
                return 0
            }

            run()
            """);

        Assert.DoesNotContain(goStatement.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(goStatement.UnhandledException);
        Assert.Equal(42, goStatement.Value);

        var selectHeader = EmittedOracle.Evaluate("""
            import Gsharp.Extensions.Go

            func choose(first chan int32, second chan int32) chan int32 {
                return second
            }

            func run() int32 {
                let channel = make(chan int32, 1)
                select {
                    case choose(channel, { return 42 channel }) <- 1 { let sent = true }
                    default { let skipped = true }
                }

                return 0
            }

            run()
            """);

        Assert.DoesNotContain(selectHeader.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(selectHeader.UnhandledException);
        Assert.Equal(42, selectHeader.Value);

        var scopeBody = EmittedOracle.Evaluate("""
            import Gsharp.Extensions.Go

            func combine(first int32, second int32) int32 {
                return first + second
            }

            func run() int32 {
                scope {
                    let ignored = combine(1, { return 42 0 })
                }

                return 0
            }

            run()
            """);

        Assert.DoesNotContain(scopeBody.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(scopeBody.UnhandledException);
        Assert.Equal(42, scopeBody.Value);
    }

    [Fact]
    public void SwitchContexts_SpillEscapingBlockControlFlow()
    {
        var discriminant = EmittedOracle.Evaluate("""
            func choose(first int32, second int32) int32 {
                return first + second
            }

            func run() int32 {
                switch choose(1, { return 42 0 }) {
                    case 1 { let matched = true }
                    default { let missed = true }
                }

                return 0
            }

            run()
            """);

        Assert.DoesNotContain(discriminant.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(discriminant.UnhandledException);
        Assert.Equal(42, discriminant.Value);

        var guard = EmittedOracle.Evaluate("""
            func both(first bool, second bool) bool {
                return first && second
            }

            func run() int32 {
                switch 1 {
                    case 1 when both(true, { return 42 false }) == true { let matched = true }
                    default { let missed = true }
                }

                return 0
            }

            run()
            """);

        Assert.DoesNotContain(guard.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(guard.UnhandledException);
        Assert.Equal(42, guard.Value);

        var armBody = EmittedOracle.Evaluate("""
            func combine(first int32, second int32) int32 {
                return first + second
            }

            func run() int32 {
                switch 1 {
                    case 1 { let ignored = combine(1, { return 42 0 }) }
                    default { let missed = true }
                }

                return 0
            }

            run()
            """);

        Assert.DoesNotContain(armBody.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(armBody.UnhandledException);
        Assert.Equal(42, armBody.Value);

        var expression = EmittedOracle.Evaluate("""
            func both(first bool, second bool) bool {
                return first && second
            }

            func run() int32 {
                return switch 1 {
                    case 1 when both(true, { return 42 false }): 0
                    default: 0
                }
            }

            run()
            """);

        Assert.DoesNotContain(expression.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(expression.UnhandledException);
        Assert.Equal(42, expression.Value);
    }

    [Fact]
    public void FieldInitializer_PreservesReturnAndInstanceMemberRestrictions()
    {
        var result = EmittedOracle.Evaluate("""
            class Holder {
                var illegalReturn int32 = { return 1 2 }
                var illegalThis int32 = { let self = this self.illegalReturn }
            }
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError && diagnostic.Id == "GS0122");
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError && diagnostic.Id == "GS0377");
    }

    [Fact]
    public void InitializerBlocks_RejectBareReturnBeforeInitializationCompletes()
    {
        var field = EmittedOracle.Evaluate("""
            class Holder {
                var value int32 = { if true { return } 1 }
            }
            """);

        Assert.Single(field.Diagnostics.Where(diagnostic => diagnostic.IsError && diagnostic.Id == "GS0121"));

        var baseInitializer = EmittedOracle.Evaluate("""
            open class Base {
                init(value int32) { }
            }

            class Derived : Base {
                init() : base({ if true { return } 1 }) { }
            }
            """);

        Assert.Single(baseInitializer.Diagnostics.Where(diagnostic => diagnostic.IsError && diagnostic.Id == "GS0121"));

        var delegatingInitializer = EmittedOracle.Evaluate("""
            class Holder {
                init(value int32) { }

                convenience init() {
                    init({ if true { return } 1 })
                }
            }
            """);

        Assert.Collection(
            delegatingInitializer.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0121", diagnostic.Id));

        var baseThis = EmittedOracle.Evaluate("""
            open class Base {
                init(value int32) { }
            }

            class Derived : Base {
                init() : base({ let self = this 1 }) { }
            }
            """);

        Assert.Single(baseThis.Diagnostics.Where(diagnostic => diagnostic.IsError && diagnostic.Id == "GS0531"));

        var delegatingThis = EmittedOracle.Evaluate("""
            class Holder {
                init(value int32) { }

                convenience init() {
                    init({ let self = this 1 })
                }
            }
            """);

        Assert.Collection(
            delegatingThis.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0531", diagnostic.Id));

        var delegatingField = EmittedOracle.Evaluate("""
            class Holder {
                var value int32

                init(value int32) {
                    this.value = value
                }

                convenience init() {
                    init({ let current = value current })
                }
            }
            """);

        Assert.Collection(
            delegatingField.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0531", diagnostic.Id));

        var delegatingWrite = EmittedOracle.Evaluate("""
            class Holder {
                var value int32

                init(value int32) {
                    this.value = value
                }

                convenience init() {
                    init({ value = 1 0 })
                }
            }
            """);

        Assert.Collection(
            delegatingWrite.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0531", diagnostic.Id));

        var delegatingMethod = EmittedOracle.Evaluate("""
            class Holder {
                init(value int32) { }

                func Read() int32 {
                    return 1
                }

                convenience init() {
                    init({ let current = Read() current })
                }
            }
            """);

        Assert.Collection(
            delegatingMethod.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0531", diagnostic.Id));

        var staticMember = EmittedOracle.Evaluate("""
            class Holder {
                var value int32

                shared {
                    func InitialValue() int32 {
                        return 42
                    }
                }

                init(value int32) {
                    this.value = value
                }

                convenience init() {
                    init({ let current = InitialValue() current })
                }
            }

            Holder().value
            """);

        Assert.DoesNotContain(staticMember.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(staticMember.UnhandledException);
        Assert.Equal(42, staticMember.Value);

        var shadowedLocal = EmittedOracle.Evaluate("""
            class Holder {
                var value int32

                init(value int32) {
                    this.value = value
                }

                convenience init() {
                    init({ let value = 42 value })
                }
            }

            Holder().value
            """);

        Assert.DoesNotContain(shadowedLocal.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(shadowedLocal.UnhandledException);
        Assert.Equal(42, shadowedLocal.Value);

        var localOutAddress = EmittedOracle.Evaluate("""
            class Holder {
                init(out result int32) {
                    result = 42
                }

                convenience init() {
                    init(&{ var local int32 local })
                }
            }

            let holder = Holder()
            42
            """);

        Assert.DoesNotContain(localOutAddress.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(localOutAddress.UnhandledException);
        Assert.Equal(42, localOutAddress.Value);

        var instanceOutAddress = EmittedOracle.Evaluate("""
            class Holder {
                var value int32

                init(out result int32) {
                    result = 42
                }

                convenience init() {
                    init(&{ value })
                }
            }
            """);

        Assert.Collection(
            instanceOutAddress.Diagnostics.Where(diagnostic => diagnostic.IsError),
            diagnostic => Assert.Equal("GS0531", diagnostic.Id));

        var nestedLambda = EmittedOracle.Evaluate("""
            class Holder {
                var callback (int32) -> int32 = {
                    (value) -> { return value + 1 }
                }
            }

            Holder().callback(41)
            """);

        Assert.DoesNotContain(nestedLambda.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(nestedLambda.UnhandledException);
        Assert.Equal(42, nestedLambda.Value);
    }
}
