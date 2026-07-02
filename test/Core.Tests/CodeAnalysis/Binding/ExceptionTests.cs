// <copyright file="ExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.D — try / catch / finally / throw statements.
/// </summary>
public class ExceptionTests
{
    [Fact]
    public void TryFinally_RunsFinally()
    {
        var source = @"
var trace = """"
try {
    trace = trace + ""t""
} finally {
    trace = trace + ""f""
}
trace
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("tf", result.Value);
    }

    [Fact]
    public void TryCatch_CatchesBclException()
    {
        var source = @"
import System
var caught = ""before""
try {
    var n = Int32.Parse(""not a number"")
} catch (e Exception) {
    caught = ""caught""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught", result.Value);
    }

    [Fact]
    public void TryCatchFinally_CatchAndFinallyBothRun()
    {
        var source = @"
import System
var trace = """"
try {
    var n = Int32.Parse(""bad"")
} catch (e Exception) {
    trace = trace + ""c""
} finally {
    trace = trace + ""f""
}
trace
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("cf", result.Value);
    }

    [Fact]
    public void TryWithoutCatchOrFinally_Diagnosed()
    {
        var diagnostics = Bind("try { var x = 1 }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("catch") || d.Message.Contains("finally"));
    }

    [Fact]
    public void Throw_NonExceptionDiagnosed()
    {
        var diagnostics = Bind("throw 42\n");
        Assert.NotEmpty(diagnostics);
    }

    // Issue #1649: typed catch clauses must match the REAL exception type, not
    // the EvaluatorException wrapper EvaluateExpression attaches at each
    // expression boundary for node-context reporting.

    [Fact]
    public void TryCatch_TypedCatchMatchesThrownClrExceptionType()
    {
        var source = @"
import System
var caught = ""before""
try {
    var n = Int32.Parse(""not a number"")
} catch (e FormatException) {
    caught = ""caught""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught", result.Value);
    }

    [Fact]
    public void TryCatch_TypedCatchDoesNotMatchUnrelatedType()
    {
        // FormatException should not be caught by a clause typed to a sibling
        // exception type — confirms the matcher isn't just falling back to
        // "catch everything".
        var source = @"
import System
var caught = ""before""
try {
    var n = Int32.Parse(""not a number"")
} catch (e IndexOutOfRangeException) {
    caught = ""wrong""
} catch (e FormatException) {
    caught = ""right""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("right", result.Value);
    }

    [Fact]
    public void TryCatch_BaseTypeCatchMatchesDerivedThrow()
    {
        // FormatException derives from SystemException/Exception; a catch
        // typed to the CLR base Exception type still needs to match.
        var source = @"
import System
var caught = ""before""
try {
    var n = Int32.Parse(""not a number"")
} catch (e Exception) {
    caught = ""caught""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("caught", result.Value);
    }

    [Fact]
    public void TryCatch_HandlerVariableBindsRealExceptionObject()
    {
        // The handler variable must be the real FormatException, not the
        // EvaluatorException wrapper — so .Message reads the original text.
        var source = @"
import System
var msg = """"
try {
    var n = Int32.Parse(""not-a-number"")
} catch (e FormatException) {
    msg = e.Message
}
msg
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Contains("not-a-number", (string)result.Value, StringComparison.Ordinal);
    }

    [Fact]
    public void TryCatch_IsExpressionObservesRealExceptionType()
    {
        var source = @"
import System
var isFormat = false
try {
    var n = Int32.Parse(""bad"")
} catch (e Exception) {
    isFormat = e is FormatException
}
isFormat
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void TryCatch_RethrowPropagatesOriginalTypeToOuterTypedCatch()
    {
        var source = @"
import System
var caught = ""none""
try {
    try {
        var n = Int32.Parse(""bad"")
    } catch (e FormatException) {
        throw e
    }
} catch (e FormatException) {
    caught = ""outer-typed""
}
caught
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("outer-typed", result.Value);
    }

    [Fact]
    public void Uncaught_TypedException_StillReportsNodeContext()
    {
        // Nothing catches this — it must still surface as a diagnosed runtime
        // error (GS9999) via the EvaluatorException node-context wrapping.
        var source = @"
import System
var n = Int32.Parse(""still-bad"")
n
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => Evaluate(source).Diagnostics;
}
