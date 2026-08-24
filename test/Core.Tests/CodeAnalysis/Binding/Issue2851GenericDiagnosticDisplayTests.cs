// <copyright file="Issue2851GenericDiagnosticDisplayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
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
            delegate Conv[T](v T) void;

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
    public void DiagnosticDisplay_RecursesThroughConstructedTypeWrappers()
    {
        var compilation = CreateCompilation("""
            package P
            class Box[T] {}
            """);
        var definition = compilation.GlobalScope.Structs.Single(s => s.Name == "Box");
        var box = StructSymbol.Construct(definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var cases = new (TypeSymbol Type, string Display)[]
        {
            (ArrayTypeSymbol.Get(box, 3), "[3]Box[int32]"),
            (SliceTypeSymbol.Get(box), "[]Box[int32]"),
            (SequenceTypeSymbol.Get(box), "sequence[Box[int32]]"),
            (MapTypeSymbol.Get(TypeSymbol.String, box), "map[string,Box[int32]]"),
            (ChannelTypeSymbol.Get(box), "chan Box[int32]"),
            (TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(box, TypeSymbol.Int32)), "(Box[int32], int32)"),
            (FunctionTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(box), TypeSymbol.Void), "(Box[int32]) -> void"),
            (FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create<TypeSymbol>(box), box), "*func(Box[int32]) Box[int32]"),
            (FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, ImmutableArray.Create<TypeSymbol>(box), box), "unmanaged[Cdecl] (Box[int32]) -> Box[int32]"),
            (PointerTypeSymbol.Get(box), "*Box[int32]"),
            (new PinnedTypeSymbol(box), "pinned Box[int32]"),
        };

        foreach (var (type, display) in cases)
        {
            var bag = new DiagnosticBag();
            bag.ReportCannotConvert(MakeLocation(), type, TypeSymbol.String);

            var diagnostic = Assert.Single(bag);
            Assert.Equal($"Cannot convert type '{display}' to 'string'.", diagnostic.Message);
        }
    }

    [Fact]
    public void FixedArrayDisplay_DistinguishesNullableArrayFromNullableElements()
    {
        var nullableArray = NullableTypeSymbol.Get(ArrayTypeSymbol.Get(TypeSymbol.Int32, 3));
        var nullableElements = ArrayTypeSymbol.Get(NullableTypeSymbol.Get(TypeSymbol.Int32), 3);
        var nullableArrayAndElements = NullableTypeSymbol.Get(nullableElements);

        Assert.Equal("[3]?int32", SymbolDisplay.ToTypeDisplayString(nullableArray));
        Assert.Equal("[3]int32?", SymbolDisplay.ToTypeDisplayString(nullableElements));
        Assert.Equal("[3]?int32?", SymbolDisplay.ToTypeDisplayString(nullableArrayAndElements));
        Assert.NotEqual(
            SymbolDisplay.ToTypeDisplayString(nullableArray),
            SymbolDisplay.ToTypeDisplayString(nullableElements));
    }

    [Fact]
    public void SymbolDisplay_CoversInterfacesMultipleArgumentsDefinitionsAndNestedTypes()
    {
        var compilation = CreateCompilation("""
            package P

            interface Contract[T] {}
            class Pair[T, U] {}
            struct Outer[T] {
                struct Tag {}
                struct Inner[U] {}
            }

            func Use(tag Outer[int32].Tag, inner Outer[int32].Inner[string]) {}
            """);

        var contractDefinition = compilation.GlobalScope.Interfaces.Single(i => i.Name == "Contract");
        var pairDefinition = compilation.GlobalScope.Structs.Single(s => s.Name == "Pair");
        var contract = InterfaceSymbol.Construct(
            contractDefinition,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var pair = StructSymbol.Construct(
            pairDefinition,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, TypeSymbol.String));
        var use = compilation.GlobalScope.Functions.Single(f => f.Name == "Use");

        Assert.Equal("Contract[T]", SymbolDisplay.ToTypeDisplayString(contractDefinition));
        Assert.Equal("Contract[int32]", SymbolDisplay.ToTypeDisplayString(contract));
        Assert.Equal("Pair[T, U]", SymbolDisplay.ToTypeDisplayString(pairDefinition));
        Assert.Equal("Pair[int32, string]", SymbolDisplay.ToTypeDisplayString(pair));
        Assert.Equal("Outer[int32].Tag", SymbolDisplay.ToTypeDisplayString(use.Parameters[0].Type));
        Assert.Equal("Outer[int32].Inner[string]", SymbolDisplay.ToTypeDisplayString(use.Parameters[1].Type));
    }

    [Fact]
    public void ImportedTypes_DisplayAnnotatedNestedAndOpenGenericForms()
    {
        var annotated = new NullabilityAnnotatedTypeSymbol(
            ImportedTypeSymbol.Get(typeof(System.Collections.Generic.List<int>)),
            ImmutableArray.Create<byte>(1, 1));

        Assert.Equal(
            "System.Collections.Generic.List[int32]",
            SymbolDisplay.ToTypeDisplayString(annotated));
        Assert.Equal(
            "System.Collections.Generic.Dictionary[int32, string].Enumerator",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.Get(typeof(System.Collections.Generic.Dictionary<int, string>.Enumerator))));
        Assert.Equal(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2851ImportedOuter[int32].Inner[string]",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.Get(typeof(Issue2851ImportedOuter<int>.Inner<string>))));
        Assert.Equal(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue2851ImportedOuter[int32].Inner[string]",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.GetConstructed(
                    typeof(Issue2851ImportedOuter<int>.Inner<string>),
                    typeof(Issue2851ImportedOuter<>.Inner<>),
                    ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32, TypeSymbol.String))));
        Assert.Equal(
            "System.Collections.Generic.List[T]",
            SymbolDisplay.ToTypeDisplayString(
                ImportedTypeSymbol.Get(typeof(System.Collections.Generic.List<>))));
    }

    [Fact]
    public void Gs0156_UsesSameConstructedTypeDisplayWithoutChangingName()
    {
        var compilation = CreateCompilation("""
            package P
            class Box[T] {}
            delegate Conv[T](v T) void;
            func Make() Box[int32] { return Box[int32]() }
            """);
        var boxDefinition = compilation.GlobalScope.Structs.Single(s => s.Name == "Box");
        var delegateDefinition = compilation.GlobalScope.Delegates.Single(d => d.Name == "Conv");
        var make = compilation.GlobalScope.Functions.Single(f => f.Name == "Make");
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
        Assert.Equal("Box[T]", SymbolDisplay.ToTypeDisplayString(boxDefinition));
        Assert.Equal("Conv[T]", SymbolDisplay.ToTypeDisplayString(delegateDefinition));
        Assert.Contains("Box[int32]", make.ToString(), StringComparison.Ordinal);
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

internal class Issue2851ImportedOuter<T>
{
    internal class Inner<TValue>
    {
    }
}
