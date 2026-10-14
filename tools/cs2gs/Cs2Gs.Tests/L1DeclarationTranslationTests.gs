// <copyright file="L1DeclarationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import Xunit

/// End-to-end and targeted declaration-mapping tests for issue #914 step 6
/// (ADR-0115 §B): the C#→G# translator maps the L1 corpus declarations
/// (namespace, imports, types, member signatures + fields) to the
/// (cref:Cs2Gs.CodeModel) emit AST, the canonical printer renders it, and
/// the generated G# round-trip-parses cleanly even with placeholder bodies.
open class L1DeclarationTranslationTests {
    /// The full L1 document translates to canonical G# whose printed text
    /// round-trip-parses with zero error diagnostics — placeholder bodies and
    /// the named-tuple gap placeholder included (ADR-0115 §A, stage-1 gate).
    @Fact
    func L1Document_TranslatesAndRoundTrips() {
        let (unit, context) = TranslateL1()
        let printed = GSharpPrinter.Print(unit)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            result!!.Success,
            "Generated G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
        )
        // Determinism: the same AST prints byte-identically.
        Assert.Equal(printed, GSharpPrinter.Print(unit))
    }

    /// B.1: the C# namespace becomes the G# `package` and each
    /// `using` becomes an `import` in original order.
    @Fact
    func L1Document_MapsPackageAndImports() {
        let (unit, _) = TranslateL1()
        Assert.Equal("Corpus.L1", unit.Package)
        Assert.Equal(
            []string{"System", "System.Collections.Generic"},
            unit.Imports.Select((i ImportDirective) -> i.Name).ToArray()
        )
    }

    /// B.4/B.6/B.10: `internal sealed class Cart` maps to an
    /// `internal` plain `class` (sealed → plain, no `open`).
    @Fact
    func L1Document_MapsCartClassHead() {
        let cart = FindType("Cart")
        Assert.Equal(TypeDeclarationKind.Class, cart.Kind)
        Assert.Equal(Visibility.Internal, cart.Visibility)
        Assert.False(cart.IsOpen)
        Assert.False(cart.IsSealed)
        Assert.Null(cart.BaseType)
    }

    /// B.3 (T2): explicit class constructors and their private
    /// `readonly` fields preserve their CLR shape.
    @Fact
    func L1Document_PreservesImmutableFieldInitializationAbi() {
        let (unit, context) = TranslateL1()
        let cart = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Cart")
        Assert.True(cart.PrimaryConstructorParameters == nil || cart.PrimaryConstructorParameters!!.Count == 0)
        let fields = cart.Members.OfType[FieldDeclaration]().ToArray()
        Assert.Equal([]string{"_customer", "_items"}, fields.Select((field FieldDeclaration) -> field.Name))
        Assert.All(fields, (field FieldDeclaration) -> Assert.Equal(Visibility.Private, field.Visibility))
        Assert.All(fields, (field FieldDeclaration) -> Assert.Equal(BindingKind.Let, field.Binding))
        Assert.All(fields, (field FieldDeclaration) -> Assert.Null(field.Initializer))
        let constructor = Assert.Single(cart.Members.OfType[ConstructorDeclaration]())
        Assert.Equal("customer", Assert.Single(constructor.Parameters).Name)
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Message!!.Contains(
                "primary constructor",
                StringComparison.Ordinal
            )
        )
    }

    /// T1 (ADR-0115 §B.4 as amended by ADR-0172): a C# named-tuple
    /// field type maps to the native G# tuple type with its element names
    /// PRESERVED name-first (`(Name string, Price int32, Quantity int32)`);
    /// nothing is Unsupported and no name-drop Info diagnostic remains.
    @Fact
    func L1Document_MapsNamedTupleFieldToNamedTuple() {
        let (unit, context) = TranslateL1()
        // ADR-0172 retired the ADR-0115 §B.4 name-drop Info diagnostic.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("element names are dropped")
        )
        // No tuple is left as an Unsupported placeholder.
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "value-tuple"
            )
        )
        let cart = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Cart")
        let items = cart.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "_items")
        let list = Assert.IsType[NamedTypeReference](items.Type)
        Assert.Equal("List", list.Name)
        let tuple = Assert.IsType[TupleTypeReference](Assert.Single(list.TypeArguments))
        Assert.Equal(
            []string{"string", "int32", "int32"},
            tuple.ElementTypes.Select((e GTypeReference) -> Assert.IsType[NamedTypeReference](e).Name)
        )
        Assert.Equal([]string{"Name", "Price", "Quantity"}, tuple.ElementNames)
    }

    /// B.11 / ADR-0131: an expression-bodied property
    /// (`int LineCount => ...`) maps to a get-only computed property of
    /// width-bearing type `int32`, rendered with the G# property-level arrow
    /// (`prop LineCount int32 -> expr`) via (cref:PropertyDeclaration.ExpressionBody).
    @Fact
    func L1Document_MapsExpressionBodiedPropertyToGetOnly() {
        let cart = FindType("Cart")
        let lineCount = cart
            .Members
            .OfType[PropertyDeclaration]()
            .Single((p PropertyDeclaration) -> p.Name == "LineCount")
        Assert.Equal("int32", Assert.IsType[NamedTypeReference](lineCount.Type).Name)
        Assert.Empty(lineCount.Accessors)
        Assert.NotNull(lineCount.ExpressionBody)
        Assert.IsType[ReturnStatement](lineCount.ExpressionBody)
    }

    /// B.5/B.12: `int Subtotal()` maps to an in-body method (no
    /// receiver clause) returning `int32` with a placeholder body.
    @Fact
    func L1Document_MapsInBodyMethodSignature() {
        let cart = FindType("Cart")
        let subtotal = cart.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "Subtotal")
        Assert.Null(subtotal.Receiver)
        Assert.Equal("int32", Assert.IsType[NamedTypeReference](subtotal.ReturnType).Name)
        Assert.NotNull(subtotal.Body)
    }

    /// B.11 / ADR-0195: a C# `static class` maps to a `shared class`
    /// whose members sit directly in its body, recorded as an Info decision; the static
    /// `void Main` becomes an in-body `func` (void → no return type).
    @Fact
    func L1Document_MapsStaticClassToSharedClass() {
        let (unit, context) = TranslateL1()
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Info && d.Message!!.Contains(
                "static class Program"
            ) &&
                d.Message!!.Contains("shared")
        )
        let program = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Program")
        // ADR-0195: the class is a `shared class`, so its static `Main` is a direct member
        // of the body (no `shared { }` block).
        Assert.True(program.IsShared)
        Assert.DoesNotContain(program.Members, (member GMember) -> member is SharedBlock)
        let main = program.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "Main")
        Assert.Null(main.ReturnType)
        Assert.Equal(Visibility.Private, main.Visibility)
    }

    /// Every method/property/constructor body is translated by the
    /// step-7 statement/expression translator: no `body-pending` placeholder
    /// diagnostic remains, and the printed G# round-trips.
    @Fact
    func L1Document_TranslatesBodiesWithNoPendingPlaceholder() {
        let (unit, context) = TranslateL1()
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.ConstructKind == "body-pending")
        let printed = GSharpPrinter.Print(unit)
        Assert.DoesNotContain("// pending", printed)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
    }

    shared {
        private const L1Source string = `
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
            Console.WriteLine($"Receipt for {_customer}");
        }
    }

    internal static class Program
    {
        private static void Main()
        {
            var cart = new Cart("Ada");
            cart.Add("Notebook", 5, 3);
            cart.PrintReceipt();
        }

        private static void PrintFizzBuzz(int upTo)
        {
            Console.WriteLine(upTo);
        }
    }
}
`

        private func TranslateL1()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, L1Source string){("Program.cs", L1Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "L1 inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func FindType(name string) TypeDeclaration {
            let (unit, _) = TranslateL1()
            return unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == name)
        }
    }
}
