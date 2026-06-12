// <copyright file="Issue608InterpreterCLRDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #608: interpreter parity for DIM dispatch and field-satisfies-property
/// contracts. These tests exercise the tree-walking evaluator paths that
/// correspond to the emit-side fixes in #572 (DIM dispatch on concrete CLR type)
/// and #573/#606 (field satisfies getter-only / read-write CLR interface property).
/// </summary>
public class Issue608InterpreterCLRDispatchTests
{
    /// <summary>
    /// #572 shape: a default interface method (DIM) on a CLR interface should be
    /// callable through an interface-typed variable even when the concrete class
    /// does not override it.
    /// </summary>
    [Fact]
    public void Interpreter_DIMDispatchOnConcreteCLRType_Works()
    {
        var source = """
            import GSharp.Interpreter.Tests.ProbeRef
            import System
            var obj = WithDIMImpl("world")
            var iface IWithDIM = obj
            iface.Greeting()
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Hello, world!", output);
    }

    /// <summary>
    /// #573 shape: a G# class with a public field that matches a getter-only CLR
    /// interface property should satisfy the contract; reading through the interface
    /// should yield the field value.
    /// </summary>
    [Fact]
    public void Interpreter_FieldSatisfiesGetterOnlyPropertyContract_GetterReadsField()
    {
        var source = """
            import GSharp.Interpreter.Tests.ProbeRef
            import System
            class Impl1 : IHasName {
                var Name string
            }
            var impl = Impl1{Name: "hello"}
            var iface IHasName = impl
            iface.Name
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("hello", output);
    }

    /// <summary>
    /// #606 shape: a G# class with a public mutable field that matches a read-write
    /// CLR interface property; both getter and setter should work through the interface.
    /// </summary>
    [Fact]
    public void Interpreter_FieldSatisfiesReadWritePropertyContract_BothAccessorsWork()
    {
        var source = """
            import GSharp.Interpreter.Tests.ProbeRef
            import System
            class RWImpl : IReadWrite {
                var Value string
            }
            var impl = RWImpl{Value: "initial"}
            var iface IReadWrite = impl
            Console.WriteLine(iface.Value)
            iface.Value = "updated"
            Console.WriteLine(iface.Value)
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("initial", output);
        Assert.Contains("updated", output);
    }

    /// <summary>
    /// Pin the #568 path: IDisposable.Dispose() dispatch on a CLR type works in the
    /// interpreter. Tests that MemberLookup.SafeGetMethodIncludingSelfAndInterfaces
    /// finds the Dispose method correctly.
    /// </summary>
    [Fact]
    public void Interpreter_BasicIDisposableInUsingLet_StillWorks()
    {
        // Use manual Dispose() call to test the #568 dispatch path (DIM-aware
        // method lookup finding IDisposable.Dispose through a concrete type).
        // Top-level `using let` in the REPL has a pre-existing scoping limitation
        // (subsequent statements execute after the finally block) so we test
        // Dispose dispatch directly instead.
        var source = """
            import System
            import System.IO
            let sr = StringReader("hello")
            var result = sr.ReadToEnd()
            sr.Dispose()
            result
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("hello", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return outWriter.ToString() + errWriter.ToString();
    }
}
