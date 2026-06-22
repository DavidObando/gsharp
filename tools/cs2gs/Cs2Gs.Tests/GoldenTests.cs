// <copyright file="GoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Golden tests for the canonical G# pretty-printer (ADR-0115 §B). Each test
/// builds a small emit AST by hand, asserts the exact canonical text, and
/// asserts the printed text re-parses with the real G# parser (zero error
/// diagnostics).
/// </summary>
public class GoldenTests
{
    /// <summary>B.1: a full compilation unit — package, imports, a class with a
    /// primary constructor, an in-body method, and string interpolation.</summary>
    [Fact]
    public void B1_FullCompilationUnit()
    {
        var method = new MethodDeclaration(
            "Describe",
            returnType: Type("string"),
            body: Block(
                new ReturnStatement(new InterpolatedStringExpression(List(
                    InterpolationPart.Literal("Point "),
                    InterpolationPart.Hole(new IdentifierExpression("X")),
                    InterpolationPart.Literal(", "),
                    InterpolationPart.Hole(new BinaryExpression(new IdentifierExpression("Y"), "+", LiteralExpression.Int("1"))))))));
        var cls = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Point",
            primaryConstructorParameters: List(new Parameter("X", Type("int32")), new Parameter("Y", Type("int32"))),
            members: Members(method));
        var unit = new CompilationUnit("GSharp.Example.Geometry", List(new ImportDirective("System")), Nodes(cls));

        var expected = Lines(
            "package GSharp.Example.Geometry",
            string.Empty,
            "import System",
            string.Empty,
            "class Point(X int32, Y int32) {",
            "    func Describe() string {",
            "        return \"Point $X, ${Y + 1}\"",
            "    }",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.3: <c>let</c> / <c>var</c> / <c>const</c> binding keywords.</summary>
    [Fact]
    public void B3_LetVarConst()
    {
        var unit = new CompilationUnit("Demo", List(new ImportDirective("System")), Nodes(
            new FieldDeclaration(BindingKind.Const, "Limit", Type("int32"), LiteralExpression.Int("10")),
            new FieldDeclaration(BindingKind.Let, "name", initializer: LiteralExpression.String("g")),
            new FieldDeclaration(BindingKind.Var, "count", initializer: LiteralExpression.Int("0"))));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "const Limit int32 = 10",
            "let name = \"g\"",
            "var count = 0");

        AssertGolden(expected, unit);
    }

    /// <summary>B.4: <c>data struct</c> (body form) and <c>data class</c>
    /// (primary-constructor form, with a variadic parameter).</summary>
    [Fact]
    public void B4_DataStructAndDataClass()
    {
        var dataStruct = new TypeDeclaration(
            TypeDeclarationKind.DataStruct,
            "Point",
            members: Members(
                new FieldDeclaration(BindingKind.Var, "X", Type("int32")),
                new FieldDeclaration(BindingKind.Var, "Y", Type("int32"))));
        var dataClass = new TypeDeclaration(
            TypeDeclarationKind.DataClass,
            "Names",
            primaryConstructorParameters: List(
                new Parameter("prefix", Type("string")),
                new Parameter("items", Type("string"), isVariadic: true)),
            hasBody: false);
        var unit = new CompilationUnit("Demo", members: Nodes(dataStruct, dataClass));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "data struct Point {",
            "    var X int32",
            "    var Y int32",
            "}",
            string.Empty,
            "data class Names(prefix string, items ...string)");

        AssertGolden(expected, unit);
    }

    /// <summary>B.5: an in-body method on an owned class versus a receiver-clause
    /// extension function on the non-owned <c>int32</c> type.</summary>
    [Fact]
    public void B5_InBodyVersusReceiverClause()
    {
        var owned = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Counter",
            members: Members(
                new FieldDeclaration(BindingKind.Var, "Value", Type("int32")),
                new MethodDeclaration(
                    "Increment",
                    returnType: Type("int32"),
                    body: Block(new ReturnStatement(new BinaryExpression(new IdentifierExpression("Value"), "+", LiteralExpression.Int("1")))))));
        var extension = new MethodDeclaration(
            "Abs",
            returnType: Type("int32"),
            receiver: new Receiver("value", Type("int32")),
            body: Block(new ReturnStatement(new IdentifierExpression("value"))));
        var unit = new CompilationUnit("Demo", members: Nodes(owned, extension));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "class Counter {",
            "    var Value int32",
            string.Empty,
            "    func Increment() int32 {",
            "        return Value + 1",
            "    }",
            "}",
            string.Empty,
            "func (value int32) Abs() int32 {",
            "    return value",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.6: an interface plus an <c>open</c> base class and an
    /// implementing class with a base-first <c>:</c> clause and <c>override</c>.</summary>
    [Fact]
    public void B6_InheritanceAndBaseClause()
    {
        var iface = new TypeDeclaration(
            TypeDeclarationKind.Interface,
            "IBark",
            members: Members(new MethodDeclaration("Bark", returnType: Type("string"), body: null)));
        var animal = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Animal",
            isOpen: true,
            members: Members(new MethodDeclaration(
                "Speak",
                returnType: Type("string"),
                isOpen: true,
                body: Block(new ReturnStatement(LiteralExpression.String("..."))))));
        var dog = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Dog",
            baseType: Type("Animal"),
            interfaces: List<GTypeReference>(Type("IBark")),
            members: Members(
                new MethodDeclaration(
                    "Speak",
                    returnType: Type("string"),
                    isOverride: true,
                    body: Block(new ReturnStatement(LiteralExpression.String("Woof")))),
                new MethodDeclaration(
                    "Bark",
                    returnType: Type("string"),
                    body: Block(new ReturnStatement(LiteralExpression.String("Yip"))))));
        var unit = new CompilationUnit("Demo", members: Nodes(iface, animal, dog));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "interface IBark {",
            "    func Bark() string;",
            "}",
            string.Empty,
            "open class Animal {",
            "    open func Speak() string {",
            "        return \"...\"",
            "    }",
            "}",
            string.Empty,
            "class Dog : Animal, IBark {",
            "    override func Speak() string {",
            "        return \"Woof\"",
            "    }",
            string.Empty,
            "    func Bark() string {",
            "        return \"Yip\"",
            "    }",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.7: a generic function with a <c>comparable</c> constraint and a
    /// generic class with a <c>class</c> flag constraint (bracket generics).</summary>
    [Fact]
    public void B7_GenericsAndConstraints()
    {
        var func = new MethodDeclaration(
            "Eq",
            parameters: List(new Parameter("a", Type("T")), new Parameter("b", Type("T"))),
            returnType: Type("bool"),
            typeParameters: List(new TypeParameter("T", "comparable")),
            body: Block(new ReturnStatement(new BinaryExpression(new IdentifierExpression("a"), "==", new IdentifierExpression("b")))));
        var box = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Box",
            typeParameters: List(new TypeParameter("T", flagConstraints: List("class"))),
            members: Members(new FieldDeclaration(BindingKind.Var, "Value", Type("T"))));
        var unit = new CompilationUnit("Demo", members: Nodes(func, box));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "func Eq[T comparable](a T, b T) bool {",
            "    return a == b",
            "}",
            string.Empty,
            "class Box[T class] {",
            "    var Value T",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.8: an arrow delegate-typed parameter and a named delegate
    /// declaration (the one place <c>func</c> stays in a type position).</summary>
    [Fact]
    public void B8_ArrowDelegateTypes()
    {
        var apply = new MethodDeclaration(
            "apply",
            parameters: List(
                new Parameter("f", new ArrowTypeReference(List<GTypeReference>(Type("int32")), List<GTypeReference>(Type("int32")))),
                new Parameter("v", Type("int32"))),
            returnType: Type("int32"),
            body: Block(new ReturnStatement(new InvocationExpression(new IdentifierExpression("f"), List<GExpression>(new IdentifierExpression("v"))))));
        var named = new NamedDelegateDeclaration(
            "Combine",
            List(new Parameter("a", Type("int32")), new Parameter("b", Type("int32"))),
            Type("int32"));
        var unit = new CompilationUnit("Demo", members: Nodes(apply, named));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "func apply(f (int32) -> int32, v int32) int32 {",
            "    return f(v)",
            "}",
            string.Empty,
            "type Combine = delegate func(a int32, b int32) int32");

        AssertGolden(expected, unit);
    }

    /// <summary>B.8: an arrow delegate type with a <c>void</c> return on a field.</summary>
    [Fact]
    public void B8_ArrowDelegateVoidReturn()
    {
        var unit = new CompilationUnit("Demo", members: Nodes(
            new FieldDeclaration(
                BindingKind.Var,
                "log",
                new ArrowTypeReference(List<GTypeReference>(Type("string")), List<GTypeReference>(Type("void"))))));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "var log (string) -> void");

        AssertGolden(expected, unit);
    }

    /// <summary>B.9: interpolation with a <c>${expr}</c> hole, a <c>$ident</c>
    /// shorthand, and a literal <c>$</c> escaped to <c>$$</c>.</summary>
    [Fact]
    public void B9_StringInterpolation()
    {
        var unit = new CompilationUnit("Demo", List(new ImportDirective("System")), Nodes(
            new FieldDeclaration(BindingKind.Let, "n", initializer: LiteralExpression.Int("6")),
            new FieldDeclaration(BindingKind.Let, "who", initializer: LiteralExpression.String("world")),
            new ExpressionStatement(new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression("Console"), "WriteLine"),
                List<GExpression>(new InterpolatedStringExpression(List(
                    InterpolationPart.Literal("hi "),
                    InterpolationPart.Hole(new IdentifierExpression("who")),
                    InterpolationPart.Literal(", answer = "),
                    InterpolationPart.Hole(new BinaryExpression(new IdentifierExpression("n"), "*", LiteralExpression.Int("7"))),
                    InterpolationPart.Literal(" cost $5"))))))));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "let n = 6",
            "let who = \"world\"",
            "Console.WriteLine(\"hi $who, answer = ${n * 7} cost $$5\")");

        AssertGolden(expected, unit);
    }

    /// <summary>B.10: accessibility emitted only when non-default — a default
    /// (omitted) top-level class, an <c>internal</c> class, and a
    /// <c>private</c> member.</summary>
    [Fact]
    public void B10_VisibilityEmittedOnlyWhenNonDefault()
    {
        var visible = new TypeDeclaration(TypeDeclarationKind.Class, "Visible", visibility: Visibility.Default);
        var hidden = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Hidden",
            visibility: Visibility.Internal,
            members: Members(new FieldDeclaration(BindingKind.Var, "secret", Type("int32"), visibility: Visibility.Private)));
        var unit = new CompilationUnit("Demo", members: Nodes(visible, hidden));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "class Visible {",
            "}",
            string.Empty,
            "internal class Hidden {",
            "    private var secret int32",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.11: an auto-property, a computed property, a <c>shared</c>
    /// static block, an <c>init</c> constructor, an enum, and an attribute.</summary>
    [Fact]
    public void B11_MembersPropertiesSharedEnumAttribute()
    {
        var rect = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Rect",
            members: Members(
                new PropertyDeclaration("Width", Type("int32")),
                new PropertyDeclaration(
                    "Area",
                    Type("int32"),
                    List(new PropertyAccessor(
                        AccessorKind.Get,
                        Block(new ReturnStatement(new MemberAccessExpression(new ThisExpression(), "Width")))))),
                new SharedBlock(Members(new MethodDeclaration(
                    "Zero",
                    returnType: Type("int32"),
                    body: Block(new ReturnStatement(LiteralExpression.Int("0")))))),
                new ConstructorDeclaration(
                    List(new Parameter("w", Type("int32"))),
                    Block(new AssignmentStatement(new IdentifierExpression("Width"), new IdentifierExpression("w"))))));
        var color = new EnumDeclaration("Color", List(new EnumCase("Red"), new EnumCase("Green"), new EnumCase("Blue")));
        var old = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Old",
            attributes: List(new AttributeUse("Obsolete", List(new AttributeArgument(LiteralExpression.String("use New"))))));
        var unit = new CompilationUnit("Demo", List(new ImportDirective("System")), Nodes(rect, color, old));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "class Rect {",
            "    prop Width int32",
            string.Empty,
            "    prop Area int32 {",
            "        get {",
            "            return this.Width",
            "        }",
            "    }",
            string.Empty,
            "    shared {",
            "        func Zero() int32 {",
            "            return 0",
            "        }",
            "    }",
            string.Empty,
            "    init(w int32) {",
            "        Width = w",
            "    }",
            "}",
            string.Empty,
            "enum Color { Red, Green, Blue }",
            string.Empty,
            "@Obsolete(\"use New\")",
            "class Old {",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.11: an <c>init</c> constructor that chains to a base
    /// constructor via the <c>: base(args)</c> clause.</summary>
    [Fact]
    public void B11_ConstructorBaseChaining()
    {
        var animal = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Animal",
            isOpen: true,
            primaryConstructorParameters: List(new Parameter("Name", Type("string"))),
            hasBody: false);
        var dog = new TypeDeclaration(
            TypeDeclarationKind.Class,
            "Dog",
            baseType: Type("Animal"),
            members: Members(
                new FieldDeclaration(BindingKind.Var, "Tricks", Type("int32")),
                new ConstructorDeclaration(
                    List(new Parameter("name", Type("string")), new Parameter("tricks", Type("int32"))),
                    Block(new AssignmentStatement(new IdentifierExpression("Tricks"), new IdentifierExpression("tricks"))),
                    baseArguments: List<GExpression>(new IdentifierExpression("name")))));
        var unit = new CompilationUnit("Demo", members: Nodes(animal, dog));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "open class Animal(Name string)",
            string.Empty,
            "class Dog : Animal {",
            "    var Tricks int32",
            string.Empty,
            "    init(name string, tricks int32) : base(name) {",
            "        Tricks = tricks",
            "    }",
            "}");

        AssertGolden(expected, unit);
    }

    /// <summary>B.12: width-bearing numeric type names on typed fields.</summary>
    [Fact]
    public void B12_WidthBearingNumerics()
    {
        var unit = new CompilationUnit("Demo", members: Nodes(
            new FieldDeclaration(BindingKind.Var, "a", Type("int64"), LiteralExpression.Int("1")),
            new FieldDeclaration(BindingKind.Var, "b", Type("float64"), LiteralExpression.Float("2.0")),
            new FieldDeclaration(BindingKind.Var, "c", Type("uint8"), LiteralExpression.Int("3"))));

        var expected = Lines(
            "package Demo",
            string.Empty,
            "var a int64 = 1",
            "var b float64 = 2.0",
            "var c uint8 = 3");

        AssertGolden(expected, unit);
    }

    /// <summary>
    /// Documents the §B.5 discrepancy: ADR-0115 §B.5 states in-body methods apply
    /// to "both class and struct" receivers, but the real G# parser rejects a
    /// <c>func</c> member inside a <c>struct</c> body (<c>GS0005</c>). This test
    /// pins that behavior so the suite fails loudly if the parser ever changes —
    /// at which point the §B.5 golden can be widened to cover structs.
    /// </summary>
    [Fact]
    public void B5_StructInBodyMethodDoesNotRoundTrip()
    {
        var structWithMethod = new TypeDeclaration(
            TypeDeclarationKind.Struct,
            "Vec",
            members: Members(
                new FieldDeclaration(BindingKind.Var, "X", Type("int32")),
                new MethodDeclaration(
                    "Negate",
                    returnType: Type("int32"),
                    body: Block(new ReturnStatement(new UnaryExpression("-", new IdentifierExpression("X")))))));
        var unit = new CompilationUnit("Demo", members: Nodes(structWithMethod));

        var printed = GSharpPrinter.Print(unit);

        // The printer faithfully renders the ADR's described form...
        Assert.Contains("func Negate()", printed);

        // ...but the real parser rejects an in-body func inside a struct body.
        var result = GSharpRoundTrip.Validate(printed);
        Assert.False(result.Success);
        Assert.Contains(result.Errors, e => e.StartsWith("GS0005", System.StringComparison.Ordinal));
    }

    private static void AssertGolden(string expected, CompilationUnit unit)
    {
        var printed = GSharpPrinter.Print(unit);
        Assert.Equal(expected, printed);

        // Determinism: the same AST prints byte-identically.
        Assert.Equal(printed, GSharpPrinter.Print(unit));

        var result = GSharpRoundTrip.Validate(printed);
        Assert.True(result.Success, "Round-trip errors:\n" + string.Join("\n", result.Errors));
    }

    private static NamedTypeReference Type(string name) => new NamedTypeReference(name);

    private static BlockStatement Block(params GStatement[] statements) => new BlockStatement(statements.ToList());

    private static List<GMember> Members(params GMember[] members) => members.ToList();

    private static List<GNode> Nodes(params GNode[] nodes) => nodes.ToList();

    private static List<T> List<T>(params T[] items) => items.ToList();

    private static string Lines(params string[] lines) => string.Join("\n", lines) + "\n";
}
