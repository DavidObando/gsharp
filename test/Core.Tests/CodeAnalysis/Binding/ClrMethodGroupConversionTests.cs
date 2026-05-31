// <copyright file="ClrMethodGroupConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #337: converting a CLR member method group (static or instance) to a
/// delegate value, with overload selection driven by the target delegate
/// signature.
/// </summary>
public class ClrMethodGroupConversionTests
{
    [Fact]
    public void StaticMethodGroup_ToFunc_SelectsOverloadAndInvokes()
    {
        // Int32.Parse(string) is selected by the Func[string, int32] target.
        var result = Evaluate(@"
import System

var parse Func[string, int32] = Int32.Parse
parse.Invoke(""41"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(41, result.Value);
    }

    [Fact]
    public void StaticMethodGroup_ToAction_SelectsVoidOverload()
    {
        // Console.WriteLine has many overloads; the Action[string] target picks
        // WriteLine(string). The resulting value is a real System.Action<string>.
        var result = Evaluate(@"
import System

var write Action[string] = Console.WriteLine
write
");
        Assert.Empty(result.Diagnostics);
        Assert.IsType<Action<string>>(result.Value);
    }

    [Fact]
    public void InstanceMethodGroup_ToFunc_CapturesReceiver()
    {
        // sb.Append(string) is selected; the receiver `sb` is captured as the
        // delegate target, so invoking the delegate mutates that instance.
        var result = Evaluate(@"
import System.Text

var sb = StringBuilder()
var append Func[string, StringBuilder] = sb.Append
append.Invoke(""ab"")
append.Invoke(""cd"")
sb.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("abcd", result.Value);
    }

    [Fact]
    public void MethodGroup_ToNonDelegateType_ReportsDiagnostic()
    {
        // A method group converted to a non-delegate target is rejected (GS0218).
        var result = Evaluate(@"
import System

var x int32 = Console.WriteLine
");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0218");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
