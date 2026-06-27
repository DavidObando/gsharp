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

    /// <summary>B.3 (T2): the parameter-sourced <c>readonly</c> field
    /// <c>_customer</c> is canonicalized to a primary-constructor parameter; the
    /// independently-initialized <c>readonly</c> field <c>_items</c> becomes a
    /// <c>let</c> field carrying its initializer, and the explicit <c>init</c> is
    /// dropped.</summary>
    [Fact]
    public void L1Document_CanonicalizesImmutableFieldInitialization()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();
        TypeDeclaration cart = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Cart");

        // `_customer = customer` lifts to a primary-constructor parameter named
        // after the field; the standalone `_customer` field is gone.
        Parameter customer = Assert.Single(cart.PrimaryConstructorParameters);
        Assert.Equal("_customer", customer.Name);
        Assert.Equal("string", Assert.IsType<NamedTypeReference>(customer.Type).Name);
        Assert.DoesNotContain(cart.Members.OfType<FieldDeclaration>(), f => f.Name == "_customer");

        // `_items = new List<...>()` stays a `let` field but gains the initializer.
        FieldDeclaration items = cart.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_items");
        Assert.Equal(BindingKind.Let, items.Binding);
        Assert.Equal(Visibility.Private, items.Visibility);
        Assert.NotNull(items.Initializer);

        // The fully-consumed constructor is dropped (no in-body constructor remains).
        Assert.DoesNotContain(cart.Members.OfType<MethodDeclaration>(), m => m.Name == "Cart");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.Message.Contains("primary constructor") &&
                d.Message.Contains("_customer"));
    }

    /// <summary>T1 (ADR-0115 §B.4): a C# named-tuple field type maps to the
    /// canonical G# positional tuple type <c>(string, int32, int32)</c> — element
    /// names dropped — recorded as an Info decision, no longer Unsupported.</summary>
    [Fact]
    public void L1Document_MapsNamedTupleFieldToPositionalTuple()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.Message.Contains("positional tuple"));

        // No tuple is left as an Unsupported placeholder.
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("value-tuple"));

        TypeDeclaration cart = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Cart");
        FieldDeclaration items = cart.Members
            .OfType<FieldDeclaration>()
            .Single(f => f.Name == "_items");
        var list = Assert.IsType<NamedTypeReference>(items.Type);
        Assert.Equal("List", list.Name);
        var tuple = Assert.IsType<TupleTypeReference>(Assert.Single(list.TypeArguments));
        Assert.Equal(
            new[] { "string", "int32", "int32" },
            tuple.ElementTypes.Select(e => Assert.IsType<NamedTypeReference>(e).Name));
    }

    /// <summary>B.11 / ADR-0131: an expression-bodied property
    /// (<c>int LineCount =&gt; ...</c>) maps to a get-only computed property of
    /// width-bearing type <c>int32</c>, rendered with the G# property-level arrow
    /// (<c>prop LineCount int32 -&gt; expr</c>) via <see cref="PropertyDeclaration.ExpressionBody"/>.</summary>
    [Fact]
    public void L1Document_MapsExpressionBodiedPropertyToGetOnly()
    {
        TypeDeclaration cart = FindType("Cart");
        PropertyDeclaration lineCount = cart.Members
            .OfType<PropertyDeclaration>()
            .Single(p => p.Name == "LineCount");

        Assert.Equal("int32", Assert.IsType<NamedTypeReference>(lineCount.Type).Name);
        Assert.Empty(lineCount.Accessors);
        Assert.NotNull(lineCount.ExpressionBody);
        Assert.IsType<ReturnStatement>(lineCount.ExpressionBody);
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

    /// <summary>Every method/property/constructor body is translated by the
    /// step-7 statement/expression translator: no <c>body-pending</c> placeholder
    /// diagnostic remains, and the printed G# round-trips.</summary>
    [Fact]
    public void L1Document_TranslatesBodiesWithNoPendingPlaceholder()
    {
        (CompilationUnit unit, TranslationContext context) = TranslateL1();

        Assert.DoesNotContain(context.Diagnostics, d => d.ConstructKind == "body-pending");

        string printed = GSharpPrinter.Print(unit);
        Assert.DoesNotContain("// pending", printed);
        Assert.True(GSharpRoundTrip.Validate(printed).Success);
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
