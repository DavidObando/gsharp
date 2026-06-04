// <copyright file="InterpolatedStringHandlerArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #368: <c>[InterpolatedStringHandlerArgument]</c> forwarding. An
/// interpolated string passed to a parameter typed as a user
/// <c>[InterpolatedStringHandler]</c> forwards the named sibling arguments (or
/// the receiver) to the handler constructor alongside
/// <c>(literalLength, formattedCount)</c> and an optional <c>out bool</c>
/// short-circuit flag. These tests cover tree-walk interpreter parity and
/// end-to-end emit/run across the static, receiver, and out-bool forms.
/// </summary>
public class InterpolatedStringHandlerArgumentTests
{
    [Fact]
    public void Forwarded_Argument_Evaluates_Through_Interpreter()
    {
        const string Source = @"package HandlerEval
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format(""PFX:"", ""x=${40 + 2}"")
";
        var (diagnostics, value) = EvaluateNamed(Source, "msg");
        Assert.Empty(diagnostics.Where(d => d.IsError));
        Assert.Equal("PFX:x=42", value);
    }

    [Fact]
    public void Receiver_Forwarding_Evaluates_Through_Interpreter()
    {
        const string Source = @"package HandlerReceiver
import GSharp.Core.Tests.Fixtures

let log = InterpolationLog()
let msg = log.Append(""v=${7}"")
";
        var (diagnostics, value) = EvaluateNamed(Source, "msg");
        Assert.Empty(diagnostics.Where(d => d.IsError));
        Assert.Equal("v=7", value);
    }

    [Fact]
    public void Forwarded_Argument_Emits_And_Runs()
    {
        const string Source = @"package HandlerEmit
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Format(""PFX:"", ""x=${40 + 2}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerEmitTest");
        Assert.Contains("PFX:x=42", output);
    }

    [Fact]
    public void OutBool_Gated_Handler_Enabled_Emits_And_Runs()
    {
        const string Source = @"package HandlerGatedOn
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Gated(true, ""y=${9}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerGatedOnTest");
        Assert.Contains("y=9", output);
    }

    [Fact]
    public void OutBool_Gated_Handler_Disabled_Skips_Appends()
    {
        const string Source = @"package HandlerGatedOff
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Gated(false, ""y=${9}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerGatedOffTest");
        Assert.DoesNotContain("y=9", output);
    }

    /// <summary>
    /// Issue #418 (P1-10): a string-typed hole must select
    /// <c>AppendFormatted(string)</c>, not the first reflected overload (which
    /// happens to be <c>AppendFormatted(int)</c> on this fixture). Pre-fix,
    /// the lowerer's value-blind first-match would either pick the int overload
    /// (invalid IL: <c>string</c> argument supplied where <c>int</c> is
    /// expected) or generate an <c>InvalidCastException</c> at run time.
    /// </summary>
    [Fact]
    public void TypedAppend_String_Hole_Picks_String_Overload()
    {
        const string Source = @"package HandlerTypedStr
import System
import GSharp.Core.Tests.Fixtures

let s = ""hello""
let msg = InterpolationHarness.Typed(""P:"", ""v=${s}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerTypedStrTest");
        Assert.Contains("P:v=[str:hello]", output);
        Assert.DoesNotContain("[int:", output);
        Assert.DoesNotContain("[T:", output);
    }

    /// <summary>Issue #418 (P1-10): an int-typed hole must select <c>AppendFormatted(int)</c>.</summary>
    [Fact]
    public void TypedAppend_Int_Hole_Picks_Int_Overload()
    {
        const string Source = @"package HandlerTypedInt
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Typed(""P:"", ""v=${42}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerTypedIntTest");
        Assert.Contains("P:v=[int:42]", output);
        Assert.DoesNotContain("[str:", output);
        Assert.DoesNotContain("[T:", output);
    }

    /// <summary>
    /// Issue #418 (P1-10): a hole whose static type matches neither the
    /// <c>int</c> nor the <c>string</c> overload must fall through to the
    /// generic <c>AppendFormatted&lt;T&gt;</c>.
    /// </summary>
    [Fact]
    public void TypedAppend_Bool_Hole_Picks_Generic_Overload()
    {
        const string Source = @"package HandlerTypedBool
import System
import GSharp.Core.Tests.Fixtures

let msg = InterpolationHarness.Typed(""P:"", ""v=${true}"")
Console.WriteLine(msg)
";
        var output = CompileAndRun(Source, "HandlerTypedBoolTest");
        Assert.Contains("P:v=[T:True]", output);
        Assert.DoesNotContain("[int:", output);
        Assert.DoesNotContain("[str:", output);
    }

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, object? Value) EvaluateNamed(string source, string variableName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var vars = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(vars);
        var match = vars.FirstOrDefault(kv => kv.Key.Name == variableName);
        return (result.Diagnostics, match.Key is null ? null : match.Value);
    }

    private static string CompileAndRun(string source, string contextName)
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

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, parameters: null);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
