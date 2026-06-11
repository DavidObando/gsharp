// <copyright file="Issue319ClrBaseInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #319: regression tests proving the interpreter (Evaluator) actually
/// invokes the CLR base constructor of a GSharp class that inherits an imported
/// CLR base type, so inherited CLR instance state (properties, fields, methods)
/// is observable through normal member access — matching the emit path.
///
/// Before the fix, `: base(args)` was a no-op under interpretation because the
/// interpreter modelled class instances as plain field dictionaries; properties
/// such as <c>Exception.Message</c> read as their defaults even though the same
/// program produced the correct value when compiled and run.
/// </summary>
public class Issue319ClrBaseInterpreterTests
{
    [Fact]
    public void InitConstructor_ChainingToClrException_InterpreterObservesBaseMessage()
    {
        // Explicit `init(...) : base(msg)` against System.Exception.
        var source = @"
import System
type MyErr class : Exception {
    var Code int32
    init(message string, code int32) : base(message) {
        Code = code
    }
}
var e = MyErr(""boom"", 42)
e.Message
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("boom", result.Value);
    }

    [Fact]
    public void InitConstructor_ChainingToClrException_BodyAlsoRuns()
    {
        // Confirms the body still runs (`Code` field gets set) after the CLR
        // base ctor has run — the two were previously fighting for the same
        // 'this' representation.
        var source = @"
import System
type MyErr class : Exception {
    var Code int32
    init(message string, code int32) : base(message) {
        Code = code
    }
}
var e = MyErr(""boom"", 42)
e.Code
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_ChainingToClrException_InterpreterObservesBaseMessage()
    {
        // Kotlin-style primary ctor `: Exception(arg)` — the second of the two
        // shapes covered by issue #306 / #319.
        var source = @"
import System
type MyErr class(Detail string) : Exception(Detail) {
}
var e = MyErr(""nope"")
e.Message
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("nope", result.Value);
    }

    [Fact]
    public void PrimaryConstructor_ChainingToClrException_BaseArgIsAComputedExpression()
    {
        // Base-init argument is a non-trivial expression that references this
        // class's primary-ctor parameter. The interpreter must evaluate it in a
        // scope where the parameter is bound before invoking the CLR ctor.
        var source = @"
import System
type LabeledErr class(Label string) : Exception(Label + ""!"") {
}
var e = LabeledErr(""oops"")
e.Message
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("oops!", result.Value);
    }

    [Fact]
    public void InheritedClrProperty_RoundTripsThroughWriteAndRead()
    {
        // Mutate an inherited CLR instance property (Exception.HResult) and
        // read it back. Confirms both the read path (BoundClrPropertyAccess)
        // and the write path (BoundClrPropertyAssignment) unwrap to the real
        // CLR backing.
        var source = @"
import System
type MyErr class(Detail string) : Exception(Detail) {
}
var e = MyErr(""x"")
e.HResult = 123
e.HResult
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void InheritedClrMethod_DispatchesAgainstBackingInstance()
    {
        // Calling an inherited CLR instance method (Exception.ToString()) must
        // dispatch to the real backing instance so it sees the base ctor's
        // state. Before the fix this threw a TargetException because the
        // receiver was a StructValue, not a System.Exception.
        var source = @"
import System
type MyErr class(Detail string) : Exception(Detail) {
}
var e = MyErr(""hello"")
var s = e.ToString()
s.Contains(""hello"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NonExceptionClrBase_PrimaryCtor_InterpreterObservesBaseState()
    {
        // Non-Exception CLR base — proves the path is general, not Exception-
        // specific. MemoryStream(int capacity) preallocates a backing buffer
        // whose size is observable via the inherited `Capacity` property.
        var source = @"
import System.IO
type SizedStream class(Cap int32) : MemoryStream(Cap) {
}
var s = SizedStream(128)
s.Capacity
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(128, result.Value);
    }

    [Fact]
    public void NonExceptionClrBase_InheritedMethodMutatesObservableState()
    {
        // Calling an inherited CLR instance method that mutates internal state
        // (MemoryStream.SetLength) must be observable through a subsequent
        // inherited property read (`Length`). Validates that read AND write
        // routes share the same CLR backing.
        var source = @"
import System.IO
type SizedStream class(Cap int32) : MemoryStream(Cap) {
}
var s = SizedStream(16)
s.SetLength(7)
s.Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7L, result.Value);
    }

    [Fact]
    public void ThrowingUserClass_CarriesBaseMessageThroughCatch()
    {
        // Throwing a GSharp class that inherits System.Exception must surface
        // the real CLR exception instance (carrying the base-set Message) so a
        // `catch (e Exception)` clause sees the correct value. Before the fix
        // the interpreter wrapped the StructValue in a new
        // Exception(value.ToString()).
        var source = @"
import System
type MyErr class(Detail string) : Exception(Detail) {
}
var msg = """"
try {
    throw MyErr(""kaboom"")
} catch (e Exception) {
    msg = e.Message
}
msg
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("kaboom", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
