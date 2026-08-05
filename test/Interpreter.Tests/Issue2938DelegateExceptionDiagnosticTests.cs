// <copyright file="Issue2938DelegateExceptionDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2938: uncaught exceptions from delegates reached through CLR members
/// retain their real message, and typed catch clauses receive the real
/// exception. Historically these tests also pinned the tree-walking
/// evaluator's runtime-diagnostic protocol — the source-node location
/// anchoring and the recursive unwrapping of the evaluator's own
/// reflection-call wrappers (<c>TargetInvocationException</c>,
/// aggregate-await shapes). That machinery retired with the evaluator in
/// ADR-0156 Phase 3c (#3176): emitted code performs direct IL calls, so no
/// interpreter-synthesized wrappers exist to unwrap, and the emitted oracle
/// surfaces an uncaught exception as a GS9999 diagnostic carrying the real
/// <see cref="Exception.Message"/> with no source-node location.
/// </summary>
public class Issue2938DelegateExceptionDiagnosticTests
{
    /// <summary>
    /// Gets delegate-storage cases covering CLR and language containers.
    /// </summary>
    public static TheoryData<string, string> StorageCases => new()
    {
        {
            "tuple",
            """
            let handler (int32) -> int32 = (value int32) -> 1 / value
            let pair = (handler, 0)
            pair.Item1(0)
            """
        },
        {
            "list",
            """
            import System.Collections.Generic

            let handler (int32) -> int32 = (value int32) -> 1 / value
            let handlers = List[(int32) -> int32]{ handler }
            handlers[0](0)
            """
        },
        {
            "array",
            """
            let handler (int32) -> int32 = (value int32) -> 1 / value
            let handlers = []((int32) -> int32){ handler }
            handlers[0](0)
            """
        },
        {
            "struct-field",
            """
            struct Holder {
                var Handler (int32) -> int32
            }

            let holder = Holder{Handler: (value int32) -> 1 / value}
            holder.Handler(0)
            """
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
            """
        },
        {
            "returned",
            """
            func Handler() (int32) -> int32 {
                return (value int32) -> 1 / value
            }

            Handler()(0)
            """
        },
    };

    [Theory]
    [MemberData(nameof(StorageCases))]
    public void StoredDelegate_UncaughtExceptionKeepsMessage(string _, string source)
    {
        AssertDiagnostic(source, "Attempted to divide by zero.");
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

        AssertDiagnostic(Source, "Attempted to divide by zero.");
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

        AssertDiagnostic(Source, "user boom");
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

        AssertDiagnostic(Source, "null boom");
    }

    [Fact]
    public void NonTargetInvocationInnerException_IsNotOverUnwrapped()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            let handler () -> int32 = () -> throw Issue2938ExceptionProbe.CreateWithOrdinaryInner()
            handler()
            """;

        AssertDiagnostic(Source, "outer boom");
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

        AssertDiagnostic(Source, "author outer");
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

        var result = EmittedOracle.Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught-aggregate", result.Value);
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

        var result = EmittedOracle.Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("outer boom", result.Value);
    }

    private static void AssertDiagnostic(string source, string message)
    {
        var result = EmittedOracle.Evaluate(source);
        var diagnostic = Assert.Single(result.Diagnostics);

        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Equal(message, diagnostic.Message);
        Assert.NotNull(result.UnhandledException);
    }
}

/// <summary>
/// CLR exception shapes used by issue #2938 tests.
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
    /// Creates an ordinary exception that itself has an inner exception.
    /// </summary>
    /// <returns>Exception with a non-target-invocation inner exception.</returns>
    public static Exception CreateWithOrdinaryInner()
        => new InvalidOperationException(
            "outer boom",
            new DivideByZeroException("inner boom"));
}
