// <copyright file="L1DeclarationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// End-to-end and targeted declaration-mapping tests for issue #914 step 6
/// (ADR-0115 §B): the C#→G# translator maps the L1 corpus declarations
/// (namespace, imports, types, member signatures + fields) to the
/// <see cref="Cs2Gs.CodeModel"/> emit AST, the canonical printer renders it, and
/// the generated G# round-trip-parses cleanly even with placeholder bodies.
/// </summary>
public class L1DeclarationTranslationTests
{
    private const string L1Source = @"
using System;
using System.Collections.Generic;

namespace Corpus.L1
{
    internal sealed class Cart
    {
        private readonly string _customer;
        private readonly List<(string Name, int Price, int Quantity)> _items;

        public Cart(string customer)
        {
            _customer = customer;
            _items = new List<(string, int, int)>();
        }

        public void Add(string name, int price, int quantity)
        {
            _items.Add((name, price, quantity));
        }

        public int Subtotal()
        {
            var total = 0;
            foreach (var item in _items)
            {
                total += item.Price * item.Quantity;
            }

            return total;
        }

        public int LineCount => _items.Count;

        public void PrintReceipt()
        {
            Console.WriteLine($""Receipt for {_customer}"");
        }
    }

    internal static class Program
    {
        private static void Main()
        {
            var cart = new Cart(""Ada"");
            cart.Add(""Notebook"", 5, 3);
            cart.PrintReceipt();
        }

        private static void PrintFizzBuzz(int upTo)
        {
            Console.WriteLine(upTo);
        }
    }
}
";

    /// <summary>
    /// The full L1 document translates to canonical G# whose printed text
    /// round-trip-parses with zero error diagnostics — placeholder bodies and
    /// the named-tuple gap placeholder included (ADR-0115 §A, stage-1 gate).
    /// </summary>
    [Fact]
    public void L1Document_TranslatesAndRoundTrips()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);

        Assert.True(
            result.Success,
            "Generated G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        // Determinism: the same AST prints byte-identically.
        Assert.Equal(printed, GSharpPrinter.Print(unit));
    }

    /// <summary>B.1: the C# namespace becomes the G# <c>package</c> and each
    /// <c>using</c> becomes an <c>import</c> in original order.</summary>
    [Fact]
    public void L1Document_MapsPackageAndImports()
    {
        (CompilationUnit unit, _) = TranslateL1();

        Assert.Equal("Corpus.L1", unit.Package);
        Assert.Equal(
            new[] { "System", "System.Collections.Generic" },
            unit.Imports.Select(i => i.Name).ToArray());
    }

    /// <summary>B.4/B.6/B.10: <c>internal sealed class Cart</c> maps to an
    /// <c>internal</c> plain <c>class</c> (sealed → plain, no <c>open</c>).</summary>
    [Fact]
    public void L1Document_MapsCartClassHead()
    {
        TypeDeclaration cart = FindType("Cart");

        Assert.Equal(TypeDeclarationKind.Class, cart.Kind);
        Assert.Equal(Visibility.Internal, cart.Visibility);
        Assert.False(cart.IsOpen);
        Assert.False(cart.IsSealed);
        Assert.Null(cart.BaseType);
    }

    /// <summary>B.3/B.11/B.12: <c>private readonly string _customer</c> maps to a
    /// <c>let</c>-bound, <c>private</c>, <c>string</c>-typed field.</summary>
    [Fact]
    public void L1Document_MapsReadonlyFieldToLet()
    {
        TypeDeclaration cart = FindType("Cart");
        FieldDeclaration customer = cart.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_customer");

        Assert.Equal(BindingKind.Let, customer.Binding);
        Assert.Equal(Visibility.Private, customer.Visibility);
        Assert.Equal("string", Assert.IsType<NamedTypeReference>(customer.Type).Name);
    }

    /// <summary>Type-mapper gap: the named-tuple field type has no canonical G#
    /// form, so it is recorded as an <see cref="TranslationSeverity.Unsupported"/>
    /// diagnostic and emitted as the parseable placeholder type.</summary>
    [Fact]
    public void L1Document_NamedTupleFieldIsRecordedAsUnsupported()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                d.ConstructKind.Contains("string Name") &&
                d.ConstructKind.Contains("int Price"));

        TypeDeclaration cart = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Cart");
        FieldDeclaration items = cart.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_items");
        var list = Assert.IsType<NamedTypeReference>(items.Type);
        Assert.Equal("List", list.Name);
        Assert.Equal(
            CSharpTypeMapper.UnsupportedPlaceholderType,
            Assert.IsType<NamedTypeReference>(Assert.Single(list.TypeArguments)).Name);
    }

    /// <summary>B.11: an expression-bodied property (<c>int LineCount =&gt; ...</c>)
    /// maps to a get-only property of width-bearing type <c>int32</c>.</summary>
    [Fact]
    public void L1Document_MapsExpressionBodiedPropertyToGetOnly()
    {
        TypeDeclaration cart = FindType("Cart");
        PropertyDeclaration lineCount = cart.Members
            .OfType<PropertyDeclaration>()
            .Single(p => p.Name == "LineCount");

        Assert.Equal("int32", Assert.IsType<NamedTypeReference>(lineCount.Type).Name);
        PropertyAccessor accessor = Assert.Single(lineCount.Accessors);
        Assert.Equal(AccessorKind.Get, accessor.Kind);
        Assert.NotNull(accessor.Body);
    }

    /// <summary>B.5/B.12: <c>int Subtotal()</c> maps to an in-body method (no
    /// receiver clause) returning <c>int32</c> with a placeholder body.</summary>
    [Fact]
    public void L1Document_MapsInBodyMethodSignature()
    {
        TypeDeclaration cart = FindType("Cart");
        MethodDeclaration subtotal = cart.Members
            .OfType<MethodDeclaration>()
            .Single(m => m.Name == "Subtotal");

        Assert.Null(subtotal.Receiver);
        Assert.Equal("int32", Assert.IsType<NamedTypeReference>(subtotal.ReturnType).Name);
        Assert.NotNull(subtotal.Body);
    }

    /// <summary>B.11: a C# <c>static class</c> maps to a class whose members are
    /// all in a <c>shared { }</c> block, recorded as an Info decision; the static
    /// <c>void Main</c> becomes an in-body <c>func</c> (void → no return type).</summary>
    [Fact]
    public void L1Document_MapsStaticClassToSharedBlock()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.Message.Contains("static class Program") &&
                d.Message.Contains("shared"));

        TypeDeclaration program = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Program");
        SharedBlock shared = Assert.Single(program.Members.OfType<SharedBlock>());
        Assert.Empty(program.Members.OfType<MethodDeclaration>());

        MethodDeclaration main = shared.Members
            .OfType<MethodDeclaration>()
            .Single(m => m.Name == "Main");
        Assert.Null(main.ReturnType);
        Assert.Equal(Visibility.Private, main.Visibility);
    }

    /// <summary>Every method/property/constructor body is routed through the
    /// single body seam, recording a <c>body-pending</c> Info diagnostic (step 7
    /// replaces the seam implementation).</summary>
    [Fact]
    public void L1Document_RoutesBodiesThroughPendingSeam()
    {
        (_, TranslationContext context) = TranslateL1();

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info && d.ConstructKind == "body-pending");
    }

    private static (CompilationUnit Unit, TranslationContext Context) TranslateL1()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", L1Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "L1 inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }

    private static TypeDeclaration FindType(string name)
    {
        (CompilationUnit unit, _) = TranslateL1();
        return unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == name);
    }
}
