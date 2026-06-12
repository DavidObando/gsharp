// <copyright file="AttributeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Phase 6 of #141: interpreter parity for ADR-0047 Kotlin-style attribute
/// syntax. The interpreter shares Core's parser/binder, so accepting the
/// syntax is automatic; these tests pin that down and verify that the
/// new GS0204 (<c>[Obsolete]</c>) warning from Phase 5 surfaces without
/// blocking evaluation.
/// </summary>
public class AttributeInterpreterTests
{
    [Fact]
    public void Interpreter_Accepts_Obsolete_Annotation_On_Function()
    {
        // @Obsolete on the declaration parses and binds; calling Helper()
        // is a use site so the GS0204 warning fires, but the value still
        // evaluates and prints (warnings do not block evaluation).
        var source = "@Obsolete\nfunc Helper() int32 {\n  return 42\n}\nHelper()";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.Contains("warning GS0204", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Interpreter_Reports_Obsolete_Warning_At_Call_Site_And_Continues()
    {
        var source = "@Obsolete(\"use Bar\")\nfunc Old() int32 {\n  return 7\n}\nOld()";
        var output = RunSubmission(source);

        Assert.Contains("GS0204", output);
        Assert.Contains("use Bar", output);
        Assert.Contains("7", output);
    }

    [Fact]
    public void Interpreter_Reports_Obsolete_Error_When_IsError_Is_True()
    {
        var source = "@Obsolete(\"dead\", true)\nfunc Old() int32 {\n  return 1\n}\nOld()";
        var output = RunSubmission(source);

        Assert.Contains("GS0204", output);
        Assert.Contains("error GS0204", output);
    }

    [Fact]
    public void Interpreter_Rejects_Reserved_CompilerGenerated_Attribute()
    {
        var source = "import System.Runtime.CompilerServices\n@CompilerGenerated\nfunc Helper() {\n}\n";
        var output = RunSubmission(source);
        Assert.Contains("GS0205", output);
    }

    [Fact]
    public void Interpreter_Accepts_AttributeSugar_Class_Declaration()
    {
        var source = "import System\n@Attribute\nclass Trace {\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Interpreter_Reports_Obsolete_Warning_On_Struct_Field_Read()
    {
        // Issue #186: reading an `@Obsolete` field surfaces GS0204 at the
        // use site; the value still evaluates and prints.
        var source = "data struct Point {\n  @Obsolete(\"use NewX\")\n  var X int32\n  var Y int32\n}\nlet p = Point{ X: 1, Y: 2 }\np.X";
        var output = RunSubmission(source);
        Assert.Contains("warning GS0204", output);
        Assert.Contains("Point.X", output);
        Assert.Contains("use NewX", output);
        Assert.DoesNotContain("error GS", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
