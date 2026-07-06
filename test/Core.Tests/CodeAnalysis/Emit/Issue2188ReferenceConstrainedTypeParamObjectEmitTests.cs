// <copyright file="Issue2188ReferenceConstrainedTypeParamObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2188 (emit): storing a reference-constrained <c>T?</c> into an
/// <c>object?</c> slot and comparing the two with <c>==</c> / <c>!=</c> must JIT
/// and run with reference-identity semantics. The emitted body boxes the open
/// type-parameter operand (<c>box !!T</c>, a no-op for a reference <c>T</c>) and
/// compares with <c>ceq</c>; before the fix these forms failed to bind (GS0155 /
/// GS0129), and a naive lowering would have produced ilverify-rejected IL
/// comparing an opaque VAR/MVAR slot against a managed reference.
/// </summary>
public class Issue2188ReferenceConstrainedTypeParamObjectEmitTests
{
    [Fact]
    public void NullableClassTypeParam_StoredInObjectAndCompared_JitsAndRuns()
    {
        const string Source = @"package Issue2188Run
import System

class Animal { init() {} }

func RoundTrips[T class init()](v T?) bool {
    var box object? = v
    var same = box == v
    var diff = box != v
    return same && !diff
}

func DiffersFromOther[T class init()](v T?, other object?) bool -> other != v

var a = Animal()
Console.WriteLine(RoundTrips[Animal](a))
Console.WriteLine(RoundTrips[Animal](nil))
Console.WriteLine(DiffersFromOther[Animal](a, Animal()))
Console.WriteLine(DiffersFromOther[Animal](a, a))
";
        var lines = CompileLoadInvokeCaptureStdout(Source, nameof(NullableClassTypeParam_StoredInObjectAndCompared_JitsAndRuns))
            .Replace("\r\n", "\n").Trim().Split('\n');

        Assert.Equal("True", lines[0].Trim());  // reference stored in object? equals itself
        Assert.Equal("True", lines[1].Trim());  // nil stored in object? equals nil
        Assert.Equal("True", lines[2].Trim());  // distinct instance differs
        Assert.Equal("False", lines[3].Trim()); // same instance does not differ
    }

    [Fact]
    public void NullableClassTypeParam_EmitsBoxAndCeqNoInvalidProgram()
    {
        // The emitted comparison must contain a `box` (for the type-parameter
        // operand) and must JIT — the reflection invoke below throws
        // InvalidProgramException on malformed IL.
        const string Source = @"package Issue2188Emit
import System

func Eq[T class](v T?, o object?) bool -> o == v

Console.WriteLine(Eq[string](""x"", ""x""))
Console.WriteLine(Eq[string](""x"", ""y""))
";
        var lines = CompileLoadInvokeCaptureStdout(Source, nameof(NullableClassTypeParam_EmitsBoxAndCeqNoInvalidProgram))
            .Replace("\r\n", "\n").Trim().Split('\n');

        Assert.Equal("True", lines[0].Trim());
        Assert.Equal("False", lines[1].Trim());
    }

    [Fact]
    public void UserDefinedEqualityOperatorOnClass_StillTakesPrecedence()
    {
        // Regression guard: a reference type with a user-declared `operator ==`
        // must keep using VALUE semantics — the #2188 reference-equality
        // fallback must NOT preempt it.
        const string Source = @"package Issue2188UserOp
import System

class Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator ==(b Vector2) bool -> a.X == b.X && a.Y == b.Y
func (a Vector2) operator !=(b Vector2) bool -> a.X != b.X || a.Y != b.Y

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 1, Y: 2}
Console.WriteLine(p == q)
Console.WriteLine(p != q)
";
        var lines = CompileLoadInvokeCaptureStdout(Source, nameof(UserDefinedEqualityOperatorOnClass_StillTakesPrecedence))
            .Replace("\r\n", "\n").Trim().Split('\n');

        // Distinct instances with equal fields: user `==` returns True (value
        // equality); a reference-identity fallback would have returned False.
        Assert.Equal("True", lines[0].Trim());
        Assert.Equal("False", lines[1].Trim());
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var originalOut = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(originalOut);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
