// <copyright file="Issue1239CoalesceCommonTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1239: the null-coalescing operator <c>a ?? b</c> must compute the
/// C# §12.15 best common type rather than requiring both operands to share an
/// exact type. When the left's non-null type implicitly converts to the right
/// operand's type (a reference upcast / interface implementation or a numeric
/// widening) — or vice versa — <c>??</c> binds cleanly instead of reporting
/// GS0129.
/// </summary>
public class Issue1239CoalesceCommonTypeTests
{
    private static ImmutableArray<Diagnostic> EmitDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    [Fact]
    public void RightImplementsInterface_BindsToInterface()
    {
        const string Source = @"package Issue1239.Iface

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 1 } }
class C {
    func ToIface(f Foo?, g IFoo) IFoo { return f ?? g }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void RightSubtypeConvertsToNullableLeftInterface()
    {
        const string Source = @"package Issue2540.Iface

interface ILogger { func Name() string; }
class NullLogger : ILogger { func Name() string { return ""null"" } }
class C {
    func Pick(logger ILogger?) ILogger { return logger ?? NullLogger() }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedRightSubtypeConvertsToNullableLeftInterface()
    {
        const string Source = @"package Issue2540.ImportedIface

import System
import System.IO

class C {
    func Pick(resource IDisposable?) IDisposable { return resource ?? MemoryStream() }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void RightDelegateFactoryConvertsToNullableLeftDelegate()
    {
        const string Source = @"package Issue2540.Delegate

interface ILogger { func Name() string; }
class NullLogger : ILogger { func Name() string { return ""null"" } }
class C {
    func Pick(factory (() -> ILogger)?) () -> ILogger {
        return factory ?? (() -> NullLogger())
    }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UnrelatedDelegateFactoryReturnStillReportsError()
    {
        const string Source = @"package Issue2540.InvalidDelegate

interface ILogger { }
class Other { }
class C {
    func Bad(factory (() -> ILogger)?) () -> ILogger {
        return factory ?? (() -> Other())
    }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.Contains(diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void ExplicitTargetType_BindsToInterface()
    {
        const string Source = @"package Issue1239.Target

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 1 } }
class C {
    func WithTarget(f Foo?, g IFoo) IFoo {
        let r IFoo = f ?? g
        return r
    }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void RightIsBaseClass_BindsToBaseClass()
    {
        const string Source = @"package Issue1239.BaseClass

open class Animal { func Speak() int32 { return 10 } }
class Dog : Animal { }
class C {
    func Pick(d Dog?, a Animal) Animal { return d ?? a }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NumericWidening_RightWidensToLeft_BindsToLeftType()
    {
        const string Source = @"package Issue1239.NumWiden

class C {
    func Coalesce(a int32?, b uint16) int32 { return a ?? b }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_BindsToRightType()
    {
        const string Source = @"package Issue1239.NumWiden2

class C {
    func Coalesce(a int32?, b int64) int64 { return a ?? b }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0129");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SameType_StillBinds()
    {
        const string Source = @"package Issue1239.Same

class Foo { func Bar() int32 { return 1 } }
class C {
    func Same(f Foo?, g Foo) Foo { return f ?? g }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Unrelated_TypesStillReportError()
    {
        // Regression guard: when no implicit conversion exists in either
        // direction, `??` still reports GS0129.
        const string Source = @"package Issue1239.Unrelated

class Foo { }
class Bar { }
class C {
    func Bad(f Foo?, g Bar) Foo { return f ?? g }
}
";
        var diagnostics = EmitDiagnostics(Source);
        Assert.Contains(diagnostics, d => d.Id == "GS0129");
    }
}
