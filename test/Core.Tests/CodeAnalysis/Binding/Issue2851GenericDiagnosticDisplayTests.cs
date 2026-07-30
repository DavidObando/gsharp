// <copyright file="Issue2851GenericDiagnosticDisplayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2851: diagnostic type display preserves constructed generic arguments
/// without changing metadata-facing symbol names.
/// </summary>
public class Issue2851GenericDiagnosticDisplayTests
{
    [Fact]
    public void Gs0155_DisplaysConstructedSourceTypesAndNullableForms()
    {
        const string source = """
            package P

            class Box[T] {}
            struct Cell[T] { var Value T }
            type Conv[T] = delegate func(v T) void

            func Test() {
                var box Box[int32] = Box[int32]()
                var classText string = box

                var nullableBox Box[int32]? = nil
                var nullableClassText string = nullableBox

                var nested Box[Box[int32]] = Box[Box[int32]]()
                var nestedText string = nested

                var nullableConv Conv[int32]? = nil
                nullableConv = (s string) -> {}

                var conv Conv[int32] = (v int32) -> {}
                var delegateText string = conv
                var nullableDelegateText string = nullableConv

                var cell Cell[int32] = Cell[int32]{Value: 1}
                var structText string = cell

                var nullableCell Cell[int32]? = nil
                var nullableStructText string = nullableCell
            }
            """;

        var diagnostics = GetDiagnostics(source);

        Assert.Equal(8, diagnostics.Length);
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[int32]' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[int32]?' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Box[Box[int32]]' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type '(string) -> void' to 'Conv[int32]?'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Conv[int32]' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Conv[int32]?' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Cell[int32]' to 'string'.");
        AssertDiagnostic(diagnostics, "GS0155", "Cannot convert type 'Cell[int32]?' to 'string'.");
    }

    [Fact]
    public void Gs0156_UsesSameConstructedTypeDisplayWithoutChangingName()
    {
        var compilation = CreateCompilation("""
            package P
            class Box[T] {}
            type Conv[T] = delegate func(v T) void
            """);
        var boxDefinition = compilation.GlobalScope.Structs.Single(s => s.Name == "Box");
        var delegateDefinition = compilation.GlobalScope.Delegates.Single(d => d.Name == "Conv");
        var box = StructSymbol.Construct(boxDefinition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var conv = DelegateTypeSymbol.Construct(delegateDefinition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var nullableBox = NullableTypeSymbol.Get(box);
        var nullableConv = NullableTypeSymbol.Get(conv);
        var bag = new DiagnosticBag();
        var location = MakeLocation();

        bag.ReportCannotConvertImplicitly(location, box, nullableBox);
        bag.ReportCannotConvertImplicitly(location, nullableConv, conv);

        Assert.Equal("Box", box.Name);
        Assert.Equal("Conv", conv.Name);
        Assert.Collection(
            bag,
            diagnostic => Assert.Equal(
                "Cannot convert type 'Box[int32]' to 'Box[int32]?'. An explicit conversion exists (are you missing a cast?)",
                diagnostic.Message),
            diagnostic => Assert.Equal(
                "Cannot convert type 'Conv[int32]?' to 'Conv[int32]'. An explicit conversion exists (are you missing a cast?)",
                diagnostic.Message));
    }

    [Fact]
    public void ImportedConstructedGeneric_UsesGSharpSyntaxWithoutClrArity()
    {
        var bag = new DiagnosticBag();

        bag.ReportCannotConvertImplicitly(
            MakeLocation(),
            ImportedTypeSymbol.Get(typeof(System.Collections.Generic.List<int>)),
            TypeSymbol.String);

        var diagnostic = Assert.Single(bag);
        Assert.Equal(
            "Cannot convert type 'System.Collections.Generic.List[int32]' to 'string'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message);
    }

    private static ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var compilation = CreateCompilation(source);
        return compilation.SyntaxTrees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToImmutableArray();
    }

    private static Compilation CreateCompilation(string source)
        => new(SyntaxTree.Parse(SourceText.From(source)));

    private static void AssertDiagnostic(
        ImmutableArray<Diagnostic> diagnostics,
        string id,
        string message)
        => Assert.Contains(diagnostics, diagnostic => diagnostic.Id == id && diagnostic.Message == message);

    private static TextLocation MakeLocation()
        => new(SourceText.From("x"), new TextSpan(0, 1));
}
