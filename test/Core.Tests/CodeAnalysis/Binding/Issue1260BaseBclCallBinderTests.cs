// <copyright file="Issue1260BaseBclCallBinderTests.cs" company="GSharp">
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
/// Issue #1260: a <c>base.Member(...)</c>/<c>base.Prop</c> access into an
/// imported / BCL base class (e.g. <c>System.IO.Stream.Dispose(bool)</c>,
/// <see cref="object.ToString"/>, <c>System.IO.MemoryStream.Position</c>) must
/// bind, resolving the inherited member against the class's CLR base type and
/// honoring accessibility/virtuality. A base call to an <c>abstract</c> BCL
/// member with no implementation (e.g. <c>Stream.Read</c>) stays an error
/// (GS0413). Method bodies are bound (and their diagnostics captured) without
/// being executed, so these are pure binder coverage independent of the tree
/// interpreter (which cannot materialize a real CLR base instance for a
/// <c>base</c> call).
/// </summary>
public class Issue1260BaseBclCallBinderTests
{
    [Fact]
    public void BaseCall_IntoBclStream_BindsClean()
    {
        var source = @"
import System.IO
class MyStream : Stream {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void BaseCall_ObjectToString_BindsClean_WhenDerivingOnlyFromObject()
    {
        var source = @"
class Greeter {
    open func ToString() string { return base.ToString() }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void BaseCall_MultiLevel_UserBaseThenBcl_BindsClean()
    {
        var source = @"
import System.IO
open class Wrapper : MemoryStream { }
class MyMem : Wrapper {
    open func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void BaseProperty_ReadAndWrite_IntoBclBase_BindsClean()
    {
        var source = @"
import System.IO
class MyMem : MemoryStream {
    func RoundTrip() int64 {
        base.Position = 0
        return base.Position
    }
}
";
        AssertNoErrors(Evaluate(source));
    }

    [Fact]
    public void BaseCall_AbstractBclMember_DiagnosticGS0413()
    {
        var source = @"
import System.IO
open class MyStream : Stream {
    open func TryRead(buffer []byte, offset int32, count int32) int32 {
        return base.Read(buffer, offset, count)
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0413");
    }

    [Fact]
    public void BaseCall_MemberNotOnBclBase_DiagnosticGS0384()
    {
        var source = @"
import System.IO
class MyMem : MemoryStream {
    func F() {
        base.NotARealMember()
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0384");
    }

    private static void AssertNoErrors(EvaluationResult result)
    {
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
