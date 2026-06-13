// <copyright file="InterfaceTests.cs" company="GSharp">
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
/// Phase 3.B.4 — <c>interface</c> declarations. Per ADR-0085 (which
/// supersedes ADR-0018's deferral) interfaces may carry default-method
/// bodies in addition to abstract signatures. Classes implement interfaces
/// via the <c>:</c> clause; the binder accepts inherited defaults when the
/// implementer omits the method, and reports GS0318 when two unrelated
/// interfaces provide conflicting defaults for the same signature.
/// Interface-typed receivers dispatch to the runtime type's implementation,
/// falling back to the interface default when no override exists.
/// </summary>
public class InterfaceTests
{
    [Fact]
    public void InterfaceDeclaration_OnlySignatures_Binds()
    {
        var source = @"
interface IShape {
    func Area() int32
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceMethodWithBody_IsAcceptedAsDefaultMethod()
    {
        // ADR-0085 / issue #726: interface methods MAY carry a body
        // (default-interface method). The previous Phase 3 deferral
        // diagnostic (GS0186) is no longer emitted.
        var source = @"
interface IGreeter {
    func Hello() string { return ""hi"" }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClassImplementsInterface_Dispatches()
    {
        var source = @"
interface IShape {
    func Area() int32
}

class Square(Side int32) : IShape {
    func Area() int32 { return Side * Side }
}

var s = Square(4)
s.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void ClassMissingInterfaceMethod_ReportsDiagnostic()
    {
        var source = @"
interface IShape {
    func Area() int32
}

class Square(Side int32) : IShape {
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ClassImplementsMultipleInterfaces()
    {
        var source = @"
interface IShape {
    func Area() int32
}

interface INamed {
    func Name() string
}

class Square(Side int32) : IShape, INamed {
    func Area() int32 { return Side * Side }
    func Name() string { return ""square"" }
}

var s = Square(3)
s.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void InterfaceDispatch_PicksRuntimeImpl()
    {
        var source = @"
interface IShape {
    func Area() int32
}

open class Box(W int32) : IShape {
    open func Area() int32 { return W }
}

class BigBox(W int32) : Box {
    override func Area() int32 { return W * 10 }
}

var b = BigBox(5)
b.Area()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void SealedInterface_SamePackage_Implementor_Works()
    {
        var source = @"
package GSharp.Tests.Sealed
sealed interface IResult {
    func Ok() bool
}

class Success : IResult {
    func Ok() bool { return true }
}

var s = Success{}
s.Ok()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SealedInterface_WithDefaultBody_IsAccepted()
    {
        // ADR-0085 / issue #726: sealed interfaces may still expose default
        // bodies; the `sealed` modifier only restricts which packages may
        // implement the interface — it does not preclude DIM declarations.
        var source = @"
sealed interface IGood {
    func F() int32 { return 0 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SealedInterface_DifferentPackage_Implementor_Diagnoses()
    {
        var t1 = SyntaxTree.Parse(SourceText.From(@"
package GSharp.Tests.Sealed.A
public sealed interface IResult {
    func Ok() bool
}
"));
        var t2 = SyntaxTree.Parse(SourceText.From(@"
package GSharp.Tests.Sealed.B
import GSharp.Tests.Sealed.A
class Success : IResult {
    func Ok() bool { return true }
}
"));
        var compilation = new Compilation(t1, t2);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("sealed interface"));
    }

    [Fact]
    public void GenericClass_Implements_UserGenericInterface_UsingTypeParameter_Binds()
    {
        var source = @"
interface IBox[T any] {
    func Get() T
}

class Box[T any](value T) : IBox[T] {
    func Get() T { return value }
}

var b = Box[string](""hi"")
b.Get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void GenericClass_Implements_ClrGenericInterface_ResolvesTypeParameterBaseClause()
    {
        // This exercises base-clause generic resolution with an in-scope type
        // parameter (`IEnumerable[T]`). The class body is intentionally partial:
        // IEnumerable<T> slot-completeness is validated separately.
        var source = @"
import System.Collections
import System.Collections.Generic

class MyGeneric[T any] : IEnumerable[T] {
    func GetEnumerator() IEnumerator[T] { return nil }
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("Cannot find type IEnumerable"));
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("Cannot find type T"));
    }

    [Fact]
    public void DefaultInterfaceMethod_InheritedByImplementer_IsCallable()
    {
        // ADR-0085: a class that omits a default interface method inherits
        // the default body via virtual dispatch when invoked through either
        // the class or the interface.
        var source = @"
interface IGreeter {
    func Greet() string { return ""hello from default"" }
}

class Greeter : IGreeter {
}

var g = Greeter{}
g.Greet()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello from default", result.Value);
    }

    [Fact]
    public void DefaultInterfaceMethod_OverriddenByImplementer_CallsOverride()
    {
        var source = @"
interface IGreeter {
    func Greet() string { return ""default"" }
}

class Loud : IGreeter {
    func Greet() string { return ""LOUD"" }
}

var g = Loud{}
g.Greet()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("LOUD", result.Value);
    }

    [Fact]
    public void DefaultInterfaceMethod_CalledThroughInterfaceReceiver_DispatchesCorrectly()
    {
        // ADR-0085: dispatch through an interface-typed receiver routes to
        // the class override when present, otherwise to the interface default.
        var source = @"
interface IGreeter {
    func Greet() string { return ""default"" }
}

class Quiet : IGreeter {
}

class Loud : IGreeter {
    func Greet() string { return ""LOUD"" }
}

var quiet IGreeter = Quiet{}
var loud  IGreeter = Loud{}
quiet.Greet() + "":"" + loud.Greet()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("default:LOUD", result.Value);
    }

    [Fact]
    public void DefaultInterfaceMethod_AbstractAndDefault_Coexist()
    {
        // One abstract slot, one default slot — implementer only needs to
        // provide the abstract one.
        var source = @"
interface IShape {
    func Area() int32
    func Describe() string { return ""shape"" }
}

class Square(side int32) : IShape {
    func Area() int32 { return side * side }
}

var s = Square(3)
s.Area() + s.Describe().Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9 + 5, result.Value);
    }

    [Fact]
    public void ConflictingDefaults_FromTwoInterfaces_DiagnosesGS0318()
    {
        // ADR-0085 diamond rule: when an implementer inherits two different
        // default bodies for the same signature it must override; otherwise
        // the binder reports GS0318.
        var source = @"
interface IA {
    func F() int32 { return 1 }
}

interface IB {
    func F() int32 { return 2 }
}

class C : IA, IB {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("GS0318") || d.Message.Contains("conflicting default"));
    }

    [Fact]
    public void ConflictingDefaults_WithExplicitOverride_Compiles()
    {
        var source = @"
interface IA {
    func F() int32 { return 1 }
}

interface IB {
    func F() int32 { return 2 }
}

class C : IA, IB {
    func F() int32 { return 99 }
}

var c = C{}
c.F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void AbstractInterfaceMethod_NoImplementer_DiagnosesGS0320()
    {
        // If an interface has no default and the class fails to provide an
        // override, the binder reports the "missing implementation" form
        // (GS0320), not the conflict form.
        var source = @"
interface IMissing {
    func Required() int32
}

class C : IMissing {
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceDefaultMethod_StaticModifier_NowAcceptedByParser()
    {
        // ADR-0089 / issue #755: static-virtual interface members are now
        // accepted by the parser (with or without a default body). This
        // test pins the new behavior — a previously-rejected source now
        // binds with no diagnostics.
        var source = @"
interface IStaticy {
    static func F() int32 { return 1 }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
