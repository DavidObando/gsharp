// <copyright file="Issue2193ExtensionOverloadShadowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Issue #2193. A user-defined extension function that shares a name with an
/// instance method on a BCL/imported receiver type must participate in overload
/// resolution alongside the instance method. The best type-compatible candidate
/// must win: when the BCL instance method is not applicable (or is a worse
/// match) the user extension must be selected instead of resolving to the
/// incompatible instance method.
/// </summary>
public class Issue2193ExtensionOverloadShadowTests
{
    [Fact]
    public void UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_ExplicitTypeArgs()
    {
        // SynchronizationContext.Send(SendOrPostCallback, object) returns void
        // and shadows the user extension Send[T, TResult]((T) -> TResult, T)
        // TResult. The extension is the correct (and only type-compatible)
        // match, so the call must return TResult and compile clean.
        const string source = @"
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Send[T, TResult](delgat, p)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_InferredTypeArgs()
    {
        const string source = @"
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Send(delgat, p)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SameNamedInstanceMethod_ThatIsBetterMatch_StillWins_NoRegression()
    {
        // Guard: both a genuine string instance method StartsWith(string) and a
        // same-named user extension StartsWith(string) are applicable. The
        // instance method is an identity (exact) match, so it must still win —
        // the extension (which would return false) must NOT shadow it.
        const string source = @"
import System

func (s string) StartsWith(prefix string) bool {
    return false
}

var text = ""hello world""
text.StartsWith(""hello"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_InferredLambdaArgs_Emits()
    {
        // GS0151 variant: with inferred type arguments from a literal lambda the
        // mixed candidate set (BCL void Send + user extension Send) must resolve
        // to the extension, which returns TResult; the program then evaluates.
        const string source = @"
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

var ctx = SynchronizationContext()
ctx.Send((x int32) -> x + 1, 5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void UserExtension_NonColliding_Name_Control_StillBinds()
    {
        const string source = @"
package Repro
import System.Threading

func (ctx SynchronizationContext) Run[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Run(delgat, p)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
