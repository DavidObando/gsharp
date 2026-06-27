// <copyright file="Issue1250GenericMemberSubstitutionBinderTests.cs" company="GSharp">
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
/// Issue #1250: when a member is accessed through a constructed generic receiver,
/// a member-signature type that is itself a constructed generic type using the
/// class's type parameter (e.g. <c>Holder[T]</c> on <c>Box[T]</c>) must be
/// substituted with the receiver's type arguments (<c>Holder[int32]</c> on
/// <c>Box[int32]</c>). Before the fix only bare type parameters (<c>T</c>) and
/// arrays of type parameters (<c>[]T</c>) were substituted; constructed generic
/// member types were left open and bound with <c>T</c> still free, failing
/// argument/return/assignment conversions with GS0155 ("Cannot convert type
/// 'Holder' to 'Holder'"). The recursion must also handle nested generics,
/// arrays/nullables of generics, multiple type parameters, and inherited methods
/// (composing the base-chain mapping), while still rejecting wrong type arguments.
/// </summary>
public class Issue1250GenericMemberSubstitutionBinderTests
{
    [Fact]
    public void ConstructedGenericParameter_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]) { } }
class C {
    func G(h Holder[int32]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConstructedGenericReturn_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { func Get() Holder[T] { return Holder[T]() } }
class C {
    func G() Holder[int32] {
        var b = Box[int32]()
        return b.Get()
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConstructedGenericField_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { var Item Holder[T] = Holder[T]() }
class C {
    func G() Holder[int32] {
        var b = Box[int32]()
        return b.Item
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConstructedGenericProperty_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { prop Item Holder[T] { get; set; } }
class C {
    func G(h Holder[int32]) {
        var b = Box[int32]()
        b.Item = h
        var read Holder[int32] = b.Item
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedConstructedGeneric_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { func Put(x Holder[Holder[T]]) { } }
class C {
    func G(h Holder[Holder[int32]]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ArrayOfConstructedGeneric_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { func Put(x []Holder[T]) { } }
class C {
    func G(h []Holder[int32]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableConstructedGeneric_NoDiagnostic()
    {
        var source = @"
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]?) { } }
class C {
    func G(h Holder[int32]?) {
        var b = Box[int32]()
        b.Put(h)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MultipleTypeParameters_NoDiagnostic()
    {
        var source = @"
class Pair[K, V]() { }
class Map[K, V]() { func Put(x Pair[K, V]) { } }
class C {
    func G(p Pair[int32, string]) {
        var m = Map[int32, string]()
        m.Put(p)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InheritedMethodConstructedGenericParameter_NoDiagnostic()
    {
        // The constructed-generic parameter type `FilterBase[TOut]` is on an
        // INHERITED method; substitution must compose the inheritance mapping
        // TOut -> FrameEntry from the base chain
        // AudioFilter : TransformBase[FrameEntry, FrameEntry].
        var source = @"
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] {
    func LinkTo(next FilterBase[TOut]) { }
}
class FrameEntry { }
class AudioFilter : TransformBase[FrameEntry, FrameEntry] { }
class C {
    func G(arg FilterBase[FrameEntry]) {
        var f = AudioFilter()
        f.LinkTo(arg)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BareTypeParameterParameter_StillWorks_NoDiagnostic()
    {
        // Control / regression: a bare `T` parameter already substituted today.
        var source = @"
class Box[T]() { func Put(x T) { } }
class C {
    func G() {
        var b = Box[int32]()
        b.Put(5)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ArrayOfTypeParameterParameter_StillWorks_NoDiagnostic()
    {
        // Control / regression: a `[]T` parameter already substituted today.
        var source = @"
class Box[T]() { func Put(x []T) { } }
class C {
    func G(arr []int32) {
        var b = Box[int32]()
        b.Put(arr)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void WrongTypeArgument_StillDiagnosticGS0155()
    {
        // Negative: Box[int32].Put expects Holder[int32]; passing Holder[string]
        // must still fail even though the display name 'Holder' matches.
        var source = @"
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]) { } }
class C {
    func G(h Holder[string]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void WrongTypeArgument_Return_StillDiagnosticGS0155()
    {
        // Negative: Box[int32].Get returns Holder[int32], not Holder[string].
        var source = @"
class Holder[T]() { }
class Box[T]() { func Get() Holder[T] { return Holder[T]() } }
class C {
    func G() Holder[string] {
        var b = Box[int32]()
        return b.Get()
    }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0155");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
