// <copyright file="Issue2928CallableMaterializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2928: interpreter closures must materialize as CLR delegates before
/// entering CLR tuples, arrays, collections, constructors, and method calls.
/// </summary>
public class Issue2928CallableMaterializationTests
{
    public static TheoryData<string, string, object> ClrConsumerCases => new()
    {
        {
            "tuple",
            """
            let handler (int32) -> int32 = (value int32) -> value + 1
            let pair = (handler, 0)
            pair.Item1(41)
            """,
            42
        },
        {
            "predicate",
            """
            import System.Collections.Generic

            let predicate (int32) -> bool = (value int32) -> value == 41
            let values = List[int32]{ 41 }
            values.Exists(predicate)
            """,
            true
        },
        {
            "list",
            """
            import System.Collections.Generic

            let handler (int32) -> int32 = (value int32) -> value + 1
            let handlers = List[(int32) -> int32]()
            handlers.Add(handler)
            handlers[0](41)
            """,
            42
        },
        {
            "array",
            """
            let handler (int32) -> int32 = (value int32) -> value + 1
            let handlers = []((int32) -> int32){ handler }
            handlers[0](41)
            """,
            42
        },
        {
            "dictionary",
            """
            import System.Collections.Generic

            let handler (int32) -> int32 = (value int32) -> value + 1
            let handlers = Dictionary[string, (int32) -> int32]()
            handlers.Add("answer", handler)
            handlers["answer"](41)
            """,
            42
        },
        {
            "map",
            """
            let handler (int32) -> int32 = (value int32) -> value + 1
            let handlers = map[string,(int32) -> int32]{ "answer": handler }
            handlers["answer"](41)
            """,
            42
        },
        {
            "generic-constructor",
            """
            import System

            let factory () -> int32 = () -> 42
            let value = Lazy[int32](factory)
            value.Value
            """,
            42
        },
        {
            "action",
            """
            import System.Collections.Generic

            func run() int32 {
                var result = 0
                let handler (int32) -> void = (value int32) -> { result = value + 1 }
                List[int32]{ 41 }.ForEach(handler)
                return result
            }

            run()
            """,
            42
        },
        {
            "method-group",
            """
            import System.Collections.Generic

            func increment(value int32) int32 { return value + 1 }
            let handlers = List[(int32) -> int32]()
            handlers.Add(increment)
            handlers[0](41)
            """,
            42
        },
    };

    [Theory]
    [MemberData(nameof(ClrConsumerCases))]
    public void Callable_Materializes_ForClrConsumer(string _, string source, object expected)
    {
        Assert.Equal(expected, Evaluate(source));
    }

    [Fact]
    public void Callable_StoredInInterpreterField_StillInvokes()
    {
        const string Source = """
            class Holder {
                var Handler (int32) -> int32
            }

            let holder = Holder{}
            holder.Handler = (value int32) -> value + 1
            holder.Handler(41)
            """;

        Assert.Equal(42, Evaluate(Source));
    }

    [Fact]
    public void Callable_DirectInvocation_StillWorks()
    {
        const string Source = """
            let handler (int32) -> int32 = (value int32) -> value + 1
            handler(41)
            """;

        Assert.Equal(42, Evaluate(Source));
    }

    [Fact]
    public void Callable_DelegateFactoryIsReusedPerType()
    {
        const string Source = """
            let first (int32) -> int32 = (value int32) -> value + 1
            let second (int32) -> int32 = (value int32) -> value + 2
            (first, second)
            """;

        var pair = Assert.IsType<ValueTuple<Func<int, int>, Func<int, int>>>(Evaluate(Source));

        Assert.Equal(pair.Item1.Method, pair.Item2.Method);
        Assert.Equal(2, pair.Item1(1));
        Assert.Equal(3, pair.Item2(1));
    }

    [Fact]
    public void Callable_ExceptionStillReachesInterpreterCatch()
    {
        const string Source = """
            import System

            let handler () -> int32 = () -> throw InvalidOperationException("boom")
            var message = ""
            try {
                handler()
            } catch (ex InvalidOperationException) {
                message = ex.Message
            }
            message
            """;

        Assert.Equal("boom", Evaluate(Source));
    }

    [Fact]
    public void Callable_DirectUncaughtExceptionKeepsOriginalDiagnostic()
    {
        const string Source = """
            import System

            let handler () -> int32 = () -> throw InvalidOperationException("boom")
            handler()
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Contains("boom", diagnostic.Message);
        Assert.DoesNotContain("target of an invocation", diagnostic.Message);
    }

    private static object Evaluate(string source)
    {
        var result = new Compilation(SyntaxTree.Parse(source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        return result.Value;
    }
}
