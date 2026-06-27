// <copyright file="Issue1238ConditionalArgumentTargetTypingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1238: an <c>if</c>/<c>else</c> (conditional), ternary, or
/// switch-expression used directly as a CALL ARGUMENT must be target-typed to
/// the corresponding parameter type — the same target-typing path already used
/// for <c>return</c> statements and typed <c>let</c>. Previously the argument's
/// branches were unified in isolation, so a <c>nil</c> (or narrower) branch
/// failed to widen to the parameter's nullable type with GS0155. These tests
/// pin the fixed behavior for call, constructor, and nested-call arguments,
/// and confirm genuine no-common-type errors are still reported.
/// </summary>
public class Issue1238ConditionalArgumentTargetTypingTests
{
    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> EmitDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    [Fact]
    public void IfExpressionArgument_NilBranch_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.IfArg

class C {
    func Sink(data string?) { }
    func Call(s string?) {
        Sink(if s == nil { nil } else { s!! })
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void IfExpressionArgument_AmongOtherArguments_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.IfArgMulti

import System.Text

class C {
    func Sink(name string, data []uint8?) { }
    func Call(data string?) {
        Sink(""x"", if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) })
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void TernaryArgument_NilBranch_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.TernaryArg

class C {
    func Sink(data string?) { }
    func Call(s string?) {
        Sink(s == nil ? nil : s!!)
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void SwitchExpressionArgument_NilArm_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.SwitchArg

class C {
    func Sink(data string?) { }
    func Call(n int32) {
        Sink(switch n { case 0: nil default: ""x"" })
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void ConstructorArgument_IfExpressionNilBranch_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.CtorArg

class Holder {
    init(name string, data string?) { }
}

class C {
    func Make(s string?) Holder {
        return Holder(""n"", if s == nil { nil } else { s!! })
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void NestedCallArgument_IfExpressionNilBranch_TargetTypedToParameter()
    {
        const string Source = @"package Issue1238.NestedArg

class C {
    func Sink(data string?) { }
    func Wrap(s string?) string? { return s }
    func Call(s string?) {
        Sink(Wrap(if s == nil { nil } else { s!! }))
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void ReturnAndTypedLetPositions_StillBindCleanly()
    {
        // Regression guard: the positions that already worked must keep working.
        const string Source = @"package Issue1238.AlreadyOk

import System.Text

class C {
    func R(data string?) []uint8? {
        return if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) }
    }
    func L(data string?) []uint8? {
        let r []uint8? = if data == nil { nil } else { Encoding.UTF8.GetBytes(data!!) }
        return r
    }
    func Sink(data []uint8?) { }
    func PlainNil() { Sink(nil) }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void OverloadResolution_WithIfExpressionArgument_NotRegressed()
    {
        // The if-expression arms unify naturally to int32 and must still select
        // the int32 overload (defer path is not engaged for a clean unification).
        const string Source = @"package Issue1238.Overload

class C {
    func F(x int32) string { return ""int"" }
    func F(x string) string { return ""str"" }
    func Pick(b bool) string {
        return F(if b { 1 } else { 2 })
    }
}
";
        Assert.Empty(EmitDiagnostics(Source).Where(d => d.IsError));
    }

    [Fact]
    public void GenuineNoCommonTypeArgument_StillReportsError()
    {
        // Neither branch is convertible to the other or to the parameter type;
        // the error must surface (not be swallowed by the defer mechanism).
        const string Source = @"package Issue1238.BadArg

class C {
    func Sink(data string?) { }
    func Call(b bool) {
        Sink(if b { 1 } else { 2 })
    }
}
";
        Assert.Contains(EmitDiagnostics(Source), d => d.IsError && d.Id == "GS0155");
    }

    [Fact]
    public void UntypedLetWithNoCommonType_StillReportsError()
    {
        // Outside argument position the defer flag is never set, so an untyped
        // local with mismatched branches keeps reporting immediately.
        const string Source = @"package Issue1238.UntypedLet

class C {
    func Call(b bool) {
        let x = if b { 1 } else { ""s"" }
    }
}
";
        Assert.Contains(EmitDiagnostics(Source), d => d.IsError && d.Id == "GS0263");
    }
}
