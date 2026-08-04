// <copyright file="Issue2938DelegateExceptionDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

// Evaluator-machinery pin: asserts the interpreter's delegate-exception
// diagnostic surface; retires with the evaluator in ADR-0156 Phase 3c
// (#3176).
#pragma warning disable CS0618 // Compilation.Evaluate / Evaluator are retiring (ADR-0156 Phase 3c, #3176)

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2938: uncaught exceptions from delegates reached through CLR members
/// retain their real message and source node.
/// </summary>
public class Issue2938DelegateExceptionDiagnosticTests
{
    /// <summary>
    /// Gets delegate-storage cases that cover CLR and interpreter containers.
    /// </summary>
    // Reflection-routed storage reports the call site, while closure-routed
    // storage reports the lambda body. This is a known inconsistency, not a contract.
    public static TheoryData<string, string, string> StorageCases => new()
    {
        {
            "tuple",
            """
            let handler (int32) -> int32 = (value int32) -> 1 / value
            let pair = (handler, 0)
            pair.Item1(0)
            """,
            "pair.Item1.Invoke(0)"
        },
        {
            "list",
            """
            import System.Collections.Generic

            let handler (int32) -> int32 = (value int32) -> 1 / value
            let handlers = List[(int32) -> int32]{ handler }
            handlers[0](0)
            """,
            "handlers[0].Invoke(0)"
        },
        {
            "array",
            """
            let handler (int32) -> int32 = (value int32) -> 1 / value
            let handlers = []((int32) -> int32){ handler }
            handlers[0](0)
            """,
            "1 / value"
        },
        {
            "struct-field",
            """
            struct Holder {
                var Handler (int32) -> int32
            }

            let holder = Holder{Handler: (value int32) -> 1 / value}
            holder.Handler(0)
            """,
            "1 / value"
        },
        {
            "class-field",
            """
            class Holder {
                var Handler (int32) -> int32
            }

            let holder = Holder{}
            holder.Handler = (value int32) -> 1 / value
            holder.Handler(0)
            """,
            "1 / value"
        },
        {
            "returned",
            """
            func Handler() (int32) -> int32 {
                return (value int32) -> 1 / value
            }

            Handler()(0)
            """,
            "1 / value"
        },
    };

    [Theory]
    [MemberData(nameof(StorageCases))]
    public void StoredDelegate_UncaughtExceptionKeepsMessageAndSourceNode(
        string _,
        string source,
        string expectedLocation)
    {
        AssertDiagnostic(
            source,
            "Attempted to divide by zero.",
            expectedLocation);
    }

    [Fact]
    public void NestedDelegate_UncaughtExceptionKeepsInnermostMessage()
    {
        const string Source = """
            let inner (int32) -> int32 = (value int32) -> 1 / value
            let outer (int32) -> int32 = (value int32) -> inner(value)
            let pair = (outer, 0)
            pair.Item1(0)
            """;

        AssertDiagnostic(
            Source,
            "Attempted to divide by zero.",
            "pair.Item1.Invoke(0)");
    }

    [Fact]
    public void UserThrownException_KeepsMessage()
    {
        const string Source = """
            import System
            import System.Collections.Generic

            let handler () -> int32 = () -> throw InvalidOperationException("user boom")
            let handlers = List[() -> int32]{ handler }
            handlers[0]()
            """;

        AssertDiagnostic(Source, "user boom", "handlers[0].Invoke()");
    }

    [Fact]
    public void NullReferenceException_KeepsMessage()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            let handler () -> int32 = () -> Issue2938ExceptionProbe.ThrowNullReference()
            let pair = (handler, 0)
            pair.Item1()
            """;

        AssertDiagnostic(Source, "null boom", "pair.Item1.Invoke()");
    }

    [Fact]
    public void NestedReflectionTargetInvocationExceptions_UnwrapRecursively()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            let handler () -> int32 = () -> Issue2938ExceptionProbe.InvokeNullReferenceReflectively()
            let pair = (handler, 0)
            pair.Item1()
            """;

        AssertDiagnostic(Source, "null boom", "pair.Item1.Invoke()");
    }

    [Fact]
    public void NonTargetInvocationInnerException_IsNotOverUnwrapped()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            let handler () -> int32 = () -> throw Issue2938ExceptionProbe.CreateWithOrdinaryInner()
            handler()
            """;

        AssertDiagnostic(
            Source,
            "outer boom",
            "throw GSharp.Interpreter.Tests.Issue2938ExceptionProbe.CreateWithOrdinaryInner()");
    }

    [Fact]
    public void UserThrownTargetInvocationException_KeepsOuterMessage()
    {
        const string Source = """
            import System
            import System.Reflection

            let handler () -> int32 = () -> throw TargetInvocationException(
                "author outer",
                InvalidOperationException("author inner"))
            handler()
            """;

        var diagnostic = Assert.Single(Evaluate(Source).Diagnostics);

        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal("author outer", diagnostic.Message);
    }

    [Fact]
    public void AwaitedChannelValue_SingleAggregateTargetInvocation_UnwrapsInnerMessage()
    {
        const string Source = """
            import GSharp.Interpreter.Tests
            import Gsharp.Extensions.Go
            import System.Threading.Tasks

            let ch = make(chan ValueTask[int32], 1)
            ch <- Issue2938ExceptionProbe.CreateSingleAggregateValueTaskAsync()
            await <-ch
            """;

        AssertDiagnostic(Source, "aggregate await boom", "await <-ch");
    }

    [Fact]
    public void MultipleAggregateExceptions_RemainAggregate()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            await Issue2938ExceptionProbe.CreateMultipleAggregateValueTaskAsync()
            """;

        AssertDiagnostic(
            Source,
            "One or more errors occurred. (Exception has been thrown by the target of an invocation.) (second aggregate boom)",
            "await GSharp.Interpreter.Tests.Issue2938ExceptionProbe.CreateMultipleAggregateValueTaskAsync()");
    }

    [Fact]
    public void SingleAggregateTargetInvocation_RemainsCatchableAsAggregateException()
    {
        const string Source = """
            import System
            import System.Reflection

            var message = "none"
            try {
                throw AggregateException(TargetInvocationException(DivideByZeroException("boom")))
            } catch (ex AggregateException) {
                message = "caught-aggregate"
            } catch (ex DivideByZeroException) {
                message = "caught-dbz"
            }
            message
            """;

        var result = Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught-aggregate", result.Value);
    }

    [Fact]
    public void ClrMemberDelegateDiagnostic_RemainsAnchoredAtCallSite()
    {
        const string Source = """
            let handler (int32) -> int32 = (value int32) -> 1 / value
            let pair = (handler, 0)
            pair.Item1(0)
            """;

        var diagnostic = Assert.Single(Evaluate(Source).Diagnostics);

        Assert.Equal(
            "pair.Item1.Invoke(0)",
            diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void TypedCatch_StillReceivesRealException()
    {
        const string Source = """
            import System
            import GSharp.Interpreter.Tests

            let handler () -> int32 = () -> throw Issue2938ExceptionProbe.CreateWithOrdinaryInner()
            let pair = (handler, 0)
            var message = ""
            try {
                pair.Item1()
            } catch (ex InvalidOperationException) {
                message = ex.Message
            }
            message
            """;

        var result = Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("outer boom", result.Value);
    }

    private static void AssertDiagnostic(string source, string message, string sourceNode)
    {
        var diagnostic = Assert.Single(Evaluate(source).Diagnostics);

        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal(message, diagnostic.Message);
        Assert.Equal(sourceNode, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    private static EvaluationResult Evaluate(string source)
        => new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());
}

/// <summary>
/// CLR exception shapes used by issue #2938 interpreter tests.
/// </summary>
public static class Issue2938ExceptionProbe
{
    /// <summary>
    /// Throws a null-reference exception with a stable message.
    /// </summary>
    /// <returns>This method never returns.</returns>
    public static int ThrowNullReference()
        => throw new NullReferenceException("null boom");

    /// <summary>
    /// Invokes a throwing method through reflection to create nested runtime wrappers.
    /// </summary>
    /// <returns>This method never returns.</returns>
    public static int InvokeNullReferenceReflectively()
        => (int)typeof(Issue2938ExceptionProbe)
            .GetMethod(nameof(ThrowNullReference))
            .Invoke(null, null);

    /// <summary>
    /// Creates an ordinary exception that itself has an inner exception.
    /// </summary>
    /// <returns>Exception with a non-target-invocation inner exception.</returns>
    public static Exception CreateWithOrdinaryInner()
        => new InvalidOperationException(
            "outer boom",
            new DivideByZeroException("inner boom"));

    /// <summary>
    /// Creates an awaitable whose result throws a single-inner aggregate wrapper.
    /// </summary>
    /// <returns>Awaitable exception probe.</returns>
    public static ValueTask<int> CreateSingleAggregateValueTaskAsync()
        => new(Task.FromException<int>(
            new AggregateException(
                CreateReflectionTargetInvocationException())));

    /// <summary>
    /// Creates an awaitable whose result throws a multi-inner aggregate wrapper.
    /// </summary>
    /// <returns>Awaitable exception probe.</returns>
    public static ValueTask<int> CreateMultipleAggregateValueTaskAsync()
        => new(Task.FromException<int>(
            new AggregateException(
                CreateReflectionTargetInvocationException(),
                new InvalidOperationException("second aggregate boom"))));

    private static TargetInvocationException CreateReflectionTargetInvocationException()
    {
        try
        {
            typeof(Issue2938ExceptionProbe)
                .GetMethod(
                    nameof(ThrowAggregateAwaitBoom),
                    BindingFlags.NonPublic | BindingFlags.Static)
                .Invoke(null, null);
        }
        catch (TargetInvocationException ex)
        {
            return ex;
        }

        throw new InvalidOperationException("Reflection probe did not throw.");
    }

    private static int ThrowAggregateAwaitBoom()
        => throw new DivideByZeroException("aggregate await boom");
}
