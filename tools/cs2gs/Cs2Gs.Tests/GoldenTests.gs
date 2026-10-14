// <copyright file="GoldenTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Golden tests for the canonical G# pretty-printer (ADR-0115 §B). Each test
/// builds a small emit AST by hand, asserts the exact canonical text, and
/// asserts the printed text re-parses with the real G# parser (zero error
/// diagnostics).
open class GoldenTests {
    /// B.1: a full compilation unit — package, imports, a class with a
    /// primary constructor, an in-body method, and string interpolation.
    @Fact
    func B1_FullCompilationUnit() {
        let method = MethodDeclaration(
            "Describe",
            returnType: GoldenTests.Type("string"),
            body: Block(
                ReturnStatement(
                    InterpolatedStringExpression(
                        GoldenTests.List(
                            InterpolationPart.Literal("Point "),
                            InterpolationPart.Hole(IdentifierExpression("X")),
                            InterpolationPart.Literal(", "),
                            InterpolationPart.Hole(
                                BinaryExpression(IdentifierExpression("Y"), "+", LiteralExpression.Int("1"))
                            )
                        )
                    )
                )
            )
        )
        let cls = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Point",
            primaryConstructorParameters: GoldenTests.List(
                Parameter("X", GoldenTests.Type("int32")),
                Parameter("Y", GoldenTests.Type("int32"))
            ),
            members: Members(method)
        )
        let unit = CompilationUnit("GSharp.Example.Geometry", GoldenTests.List(ImportDirective("System")), Nodes(cls))
        let expected = Lines(
            "package GSharp.Example.Geometry",
            string.Empty,
            "import System",
            string.Empty,
            "class Point(X int32, Y int32) {",
            "    func Describe() string {",
            "        return \"Point $$X, $${Y + 1}\"",
            "    }",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.3: `let` / `var` / `const` binding keywords.
    @Fact
    func B3_LetVarConst() {
        let unit = CompilationUnit(
            "Demo",
            GoldenTests.List(ImportDirective("System")),
            Nodes(
                FieldDeclaration(BindingKind.Const, "Limit", GoldenTests.Type("int32"), LiteralExpression.Int("10")),
                FieldDeclaration(BindingKind.Let, "name", initializer: LiteralExpression.String("g")),
                FieldDeclaration(BindingKind.Var, "count", initializer: LiteralExpression.Int("0"))
            )
        )
        let expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "const Limit int32 = 10",
            "let name = \"g\"",
            "var count = 0"
        )
        AssertGolden(expected, unit)
    }

    /// B.4: `data struct` (body form) and `data class`
    /// (primary-constructor form, with a variadic parameter).
    @Fact
    func B4_DataStructAndDataClass() {
        let dataStruct = TypeDeclaration(
            TypeDeclarationKind.DataStruct,
            "Point",
            members: Members(
                FieldDeclaration(BindingKind.Var, "X", GoldenTests.Type("int32")),
                FieldDeclaration(BindingKind.Var, "Y", GoldenTests.Type("int32"))
            )
        )
        let dataClass = TypeDeclaration(
            TypeDeclarationKind.DataClass,
            "Names",
            primaryConstructorParameters: GoldenTests.List(
                Parameter("prefix", GoldenTests.Type("string")),
                Parameter("items", GoldenTests.Type("string"), isVariadic: true)
            ),
            hasBody: false
        )
        let unit = CompilationUnit("Demo", members: Nodes(dataStruct, dataClass))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "data struct Point {",
            "    var X int32",
            "    var Y int32",
            "}",
            string.Empty,
            "data class Names(prefix string, items ...string)"
        )
        AssertGolden(expected, unit)
    }

    /// B.5: an in-body method on an owned class versus a receiver-clause
    /// extension function on the non-owned `int32` type.
    @Fact
    func B5_InBodyVersusReceiverClause() {
        let owned = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Counter",
            members: Members(
                FieldDeclaration(BindingKind.Var, "Value", GoldenTests.Type("int32")),
                MethodDeclaration(
                    "Increment",
                    returnType: GoldenTests.Type("int32"),
                    body: Block(
                        ReturnStatement(
                            BinaryExpression(IdentifierExpression("Value"), "+", LiteralExpression.Int("1"))
                        )
                    )
                )
            )
        )
        let extension = MethodDeclaration(
            "Abs",
            returnType: GoldenTests.Type("int32"),
            receiver: Receiver("value", GoldenTests.Type("int32")),
            body: Block(ReturnStatement(IdentifierExpression("value")))
        )
        let unit = CompilationUnit("Demo", members: Nodes(owned, extension))
        let expected = Lines(
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
            "}"
        )
        AssertGolden(expected, unit)
    }

    @Fact
    func B5_ReceiverAttributesUseOrdinaryParameterRendering() {
        let receiver = Receiver(
            "value",
            GoldenTests.Type("object"),
            GoldenTests.List(
                AttributeUse("NotNullWhen", GoldenTests.List(AttributeArgument(LiteralExpression.Bool(true))), "param")
            )
        )
        let method = MethodDeclaration(
            "Present",
            receiver: receiver,
            returnType: GoldenTests.Type("bool"),
            body: Block(ReturnStatement(LiteralExpression.Bool(true)))
        )
        let unit = CompilationUnit("Demo", members: Nodes(method))
        AssertGolden(
            Lines(
                "package Demo",
                string.Empty,
                "func (@param:NotNullWhen(true) value object) Present() bool {",
                "    return true",
                "}"
            ),
            unit
        )
    }

    /// B.6: an interface plus an `open` base class and an
    /// implementing class with a base-first `:` clause and `override`.
    @Fact
    func B6_InheritanceAndBaseClause() {
        let iface = TypeDeclaration(
            TypeDeclarationKind.Interface,
            "IBark",
            members: Members(MethodDeclaration("Bark", returnType: GoldenTests.Type("string"), body: nil))
        )
        let animal = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Animal",
            isOpen: true,
            members: Members(
                MethodDeclaration(
                    "Speak",
                    returnType: GoldenTests.Type("string"),
                    isOpen: true,
                    body: Block(ReturnStatement(LiteralExpression.String("...")))
                )
            )
        )
        let dog = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Dog",
            baseType: GoldenTests.Type("Animal"),
            interfaces: List[GTypeReference](GoldenTests.Type("IBark")),
            members: Members(
                MethodDeclaration(
                    "Speak",
                    returnType: GoldenTests.Type("string"),
                    isOverride: true,
                    body: Block(ReturnStatement(LiteralExpression.String("Woof")))
                ),
                MethodDeclaration(
                    "Bark",
                    returnType: GoldenTests.Type("string"),
                    body: Block(ReturnStatement(LiteralExpression.String("Yip")))
                )
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(iface, animal, dog))
        let expected = Lines(
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
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.7: a generic function with a `comparable` constraint and a
    /// generic class with a `class` flag constraint (bracket generics).
    @Fact
    func B7_GenericsAndConstraints() {
        let func_ = MethodDeclaration(
            "Eq",
            parameters: GoldenTests.List(Parameter("a", GoldenTests.Type("T")), Parameter("b", GoldenTests.Type("T"))),
            returnType: GoldenTests.Type("bool"),
            typeParameters: GoldenTests.List(TypeParameter("T", "comparable")),
            body: Block(ReturnStatement(BinaryExpression(IdentifierExpression("a"), "==", IdentifierExpression("b"))))
        )
        let box = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Box",
            typeParameters: GoldenTests.List(TypeParameter("T", flagConstraints: GoldenTests.List("class"))),
            members: Members(FieldDeclaration(BindingKind.Var, "Value", GoldenTests.Type("T")))
        )
        let unit = CompilationUnit("Demo", members: Nodes(func_, box))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func Eq[T comparable](a T, b T) bool {",
            "    return a == b",
            "}",
            string.Empty,
            "class Box[T class] {",
            "    var Value T",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.8: an arrow delegate-typed parameter and a named delegate
    /// declaration (the one place `func` stays in a type position).
    @Fact
    func B8_ArrowDelegateTypes() {
        let apply = MethodDeclaration(
            "apply",
            parameters: GoldenTests.List(
                Parameter(
                    "f",
                    ArrowTypeReference(
                        List[GTypeReference](GoldenTests.Type("int32")),
                        List[GTypeReference](GoldenTests.Type("int32"))
                    )
                ),
                Parameter("v", GoldenTests.Type("int32"))
            ),
            returnType: GoldenTests.Type("int32"),
            body: Block(
                ReturnStatement(
                    InvocationExpression(IdentifierExpression("f"), List[GExpression](IdentifierExpression("v")))
                )
            )
        )
        let named = NamedDelegateDeclaration(
            "Combine",
            GoldenTests.List(Parameter("a", GoldenTests.Type("int32")), Parameter("b", GoldenTests.Type("int32"))),
            GoldenTests.Type("int32")
        )
        let unit = CompilationUnit("Demo", members: Nodes(apply, named))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func apply(f (int32) -> int32, v int32) int32 {",
            "    return f(v)",
            "}",
            string.Empty,
            "delegate Combine(a int32, b int32) int32;"
        )
        AssertGolden(expected, unit)
    }

    /// B.8: an arrow delegate type with a `void` return on a field.
    @Fact
    func B8_ArrowDelegateVoidReturn() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(
                    BindingKind.Var,
                    "log",
                    ArrowTypeReference(
                        List[GTypeReference](GoldenTests.Type("string")),
                        List[GTypeReference](GoldenTests.Type("void"))
                    )
                )
            )
        )
        let expected = Lines("package Demo", string.Empty, "var log (string) -> void")
        AssertGolden(expected, unit)
    }

    /// B.9: interpolation with a `${expr}` hole, a `$ident`
    /// shorthand, and a literal `$` escaped to `$$`.
    @Fact
    func B9_StringInterpolation() {
        let unit = CompilationUnit(
            "Demo",
            GoldenTests.List(ImportDirective("System")),
            Nodes(
                FieldDeclaration(BindingKind.Let, "n", initializer: LiteralExpression.Int("6")),
                FieldDeclaration(BindingKind.Let, "who", initializer: LiteralExpression.String("world")),
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                        List[GExpression](
                            InterpolatedStringExpression(
                                GoldenTests.List(
                                    InterpolationPart.Literal("hi "),
                                    InterpolationPart.Hole(IdentifierExpression("who")),
                                    InterpolationPart.Literal(", answer = "),
                                    InterpolationPart.Hole(
                                        BinaryExpression(IdentifierExpression("n"), "*", LiteralExpression.Int("7"))
                                    ),
                                    InterpolationPart.Literal(" cost $$5")
                                )
                            )
                        )
                    )
                )
            )
        )
        let expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "let n = 6",
            "let who = \"world\"",
            "Console.WriteLine(\"hi $$who, answer = $${n * 7} cost $$$$5\")"
        )
        AssertGolden(expected, unit)
    }

    /// Issue #3948: multiline interpolation uses existing string
    /// concatenation syntax, including empty runs and backticks.
    @Fact
    func B9_MultilineStringInterpolation() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(
                    BindingKind.Let,
                    "value",
                    initializer: InterpolatedStringExpression(
                        GoldenTests.List(
                            InterpolationPart.Literal(string.Empty),
                            InterpolationPart.Literal("head\n"),
                            InterpolationPart.Hole(IdentifierExpression("x"), "4", "D2"),
                            InterpolationPart.Literal("`\n"),
                            InterpolationPart.Hole(IdentifierExpression("y")),
                            InterpolationPart.Literal(string.Empty)
                        )
                    )
                )
            )
        )
        let expected = Lines(
            "package Demo",
            string.Empty,
            "let value = (\"\" + `head",
            "` + \"$${x,4:D2}\" + \"\\u0060\" + `",
            "` + \"$$y\" + \"\")"
        )
        AssertGolden(expected, unit)
    }

    /// B.10: accessibility emitted only when non-default — a default
    /// (omitted) top-level class, an `internal` class, and a
    /// `private` member.
    @Fact
    func B10_VisibilityEmittedOnlyWhenNonDefault() {
        let visible = TypeDeclaration(TypeDeclarationKind.Class, "Visible", visibility: Visibility.Default)
        let hidden = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Hidden",
            visibility: Visibility.Internal,
            members: Members(
                FieldDeclaration(BindingKind.Var, "secret", GoldenTests.Type("int32"), visibility: Visibility.Private)
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(visible, hidden))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "class Visible {",
            "}",
            string.Empty,
            "internal class Hidden {",
            "    private var secret int32",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.11: an auto-property, a computed property, a `shared`
    /// static block, an `init` constructor, an enum, and an attribute.
    @Fact
    func B11_MembersPropertiesSharedEnumAttribute() {
        let rect = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Rect",
            members: Members(
                PropertyDeclaration("Width", GoldenTests.Type("int32")),
                PropertyDeclaration(
                    "Area",
                    GoldenTests.Type("int32"),
                    GoldenTests.List(
                        PropertyAccessor(
                            AccessorKind.Get,
                            Block(ReturnStatement(MemberAccessExpression(ThisExpression(), "Width")))
                        )
                    )
                ),
                SharedBlock(
                    Members(
                        MethodDeclaration(
                            "Zero",
                            returnType: GoldenTests.Type("int32"),
                            body: Block(ReturnStatement(LiteralExpression.Int("0")))
                        )
                    )
                ),
                ConstructorDeclaration(
                    GoldenTests.List(Parameter("w", GoldenTests.Type("int32"))),
                    Block(AssignmentStatement(IdentifierExpression("Width"), IdentifierExpression("w")))
                )
            )
        )
        let color = EnumDeclaration("Color", GoldenTests.List(EnumCase("Red"), EnumCase("Green"), EnumCase("Blue")))
        let old = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Old",
            attributes: GoldenTests.List(
                AttributeUse("Obsolete", GoldenTests.List(AttributeArgument(LiteralExpression.String("use New"))))
            )
        )
        let unit = CompilationUnit("Demo", GoldenTests.List(ImportDirective("System")), Nodes(rect, color, old))
        let expected = Lines(
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
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.11: an `init` constructor that chains to a base
    /// constructor via the `: base(args)` clause.
    @Fact
    func B11_ConstructorBaseChaining() {
        let animal = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Animal",
            isOpen: true,
            primaryConstructorParameters: GoldenTests.List(Parameter("Name", GoldenTests.Type("string"))),
            hasBody: false
        )
        let dog = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Dog",
            baseType: GoldenTests.Type("Animal"),
            members: Members(
                FieldDeclaration(BindingKind.Var, "Tricks", GoldenTests.Type("int32")),
                ConstructorDeclaration(
                    GoldenTests.List(
                        Parameter("name", GoldenTests.Type("string")),
                        Parameter("tricks", GoldenTests.Type("int32"))
                    ),
                    Block(AssignmentStatement(IdentifierExpression("Tricks"), IdentifierExpression("tricks"))),
                    baseArguments: List[GExpression](IdentifierExpression("name"))
                )
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(animal, dog))
        let expected = Lines(
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
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.12: width-bearing numeric type names on typed fields.
    @Fact
    func B12_WidthBearingNumerics() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(BindingKind.Var, "a", GoldenTests.Type("int64"), LiteralExpression.Int("1")),
                FieldDeclaration(BindingKind.Var, "b", GoldenTests.Type("float64"), LiteralExpression.Float("2.0")),
                FieldDeclaration(BindingKind.Var, "c", GoldenTests.Type("uint8"), LiteralExpression.Int("3"))
            )
        )
        let expected = Lines("package Demo", string.Empty, "var a int64 = 1", "var b float64 = 2.0", "var c uint8 = 3")
        AssertGolden(expected, unit)
    }

    /// Issue #938: ADR-0115 §B.5 states in-body methods apply to "both class and
    /// struct" receivers, and as of issue #938 the real G# parser and binder
    /// honour that — a `func` member inside a `struct` body now binds
    /// as a value-type instance method and compiles warning-free. This test pins
    /// that the printed in-body struct method round-trips cleanly (no
    /// `GS0005`, no `GS0314`).
    @Fact
    func B5_StructInBodyMethodRoundTrips() {
        let structWithMethod = TypeDeclaration(
            TypeDeclarationKind.Struct,
            "Vec",
            members: Members(
                FieldDeclaration(BindingKind.Var, "X", GoldenTests.Type("int32")),
                MethodDeclaration(
                    "Negate",
                    returnType: GoldenTests.Type("int32"),
                    body: Block(ReturnStatement(UnaryExpression("-", IdentifierExpression("X"))))
                )
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(structWithMethod))
        let printed = GSharpPrinter.Print(unit)
        // The printer renders the ADR's described in-body form...
        Assert.Contains("func Negate()", printed)
        // ...and the real parser + binder now accept it warning-free.
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success)
        Assert.DoesNotContain(result!!.Errors, (e string) -> e.StartsWith("GS0005", StringComparison.Ordinal))
        Assert.DoesNotContain(result!!.Errors, (e string) -> e.Contains("GS0314", StringComparison.Ordinal))
    }

    /// B.12 / §Type clauses: a nullable type renders with a trailing
    /// `?` (C# `T?` / `Nullable<T>` and annotated nullable
    /// reference types map to (cref:GTypeReference.IsNullable)).
    @Fact
    func BNullable_TrailingQuestionMark() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(BindingKind.Var, "maybe", NamedTypeReference("int32"){IsNullable = true}),
                FieldDeclaration(BindingKind.Var, "name", NamedTypeReference("string"){IsNullable = true})
            )
        )
        let expected = Lines("package Demo", string.Empty, "var maybe int32?", "var name string?")
        AssertGolden(expected, unit)
    }

    /// ADR-0137 / #1399: a nullable function type renders parenthesized
    /// as `((T) -> R)?`, not `(T) -> R?` (which would bind the `?`
    /// to the return type). A nullable return still renders `(T) -> R?`.
    @Fact
    func BNullable_FunctionTypeParenthesized() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(
                    BindingKind.Var,
                    "onClick",
                    ArrowTypeReference(List[GTypeReference](GoldenTests.Type("int32")), List[GTypeReference]()){
                        IsNullable = true
                    }
                ),
                FieldDeclaration(
                    BindingKind.Var,
                    "nullableReturn",
                    ArrowTypeReference(
                        List[GTypeReference](GoldenTests.Type("int32")),
                        List[GTypeReference](NamedTypeReference("int32"){IsNullable = true})
                    )
                )
            )
        )
        let expected = Lines(
            "package Demo",
            string.Empty,
            "var onClick ((int32) -> void)?",
            "var nullableReturn (int32) -> int32?"
        )
        AssertGolden(expected, unit)
    }

    @Fact
    func BFor_CStyleThreeClause() {
        let loop = ForStatement(
            LocalDeclarationStatement(BindingKind.Var, "i", initializer: LiteralExpression.Int("0")),
            BinaryExpression(IdentifierExpression("i"), "<", LiteralExpression.Int("3")),
            IncrementDecrementStatement(IdentifierExpression("i"), "++"),
            Block(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                        List[GExpression](IdentifierExpression("i"))
                    )
                )
            )
        )
        let unit = CompilationUnit("Demo", GoldenTests.List(ImportDirective("System")), Nodes(loop))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "for var i = 0; i < 3; i++ {",
            "    Console.WriteLine(i)",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// §Statements: `++` / `--` are statement forms on
    /// identifiers (`IncDecStmt`).
    @Fact
    func BIncrementDecrement_StatementForm() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                LocalDeclarationStatement(BindingKind.Var, "n", initializer: LiteralExpression.Int("0")),
                IncrementDecrementStatement(IdentifierExpression("n"), "++"),
                IncrementDecrementStatement(IdentifierExpression("n"), "--")
            )
        )
        let expected = Lines("package Demo", string.Empty, "var n = 0", "n++", "n--")
        AssertGolden(expected, unit)
    }

    /// §Primary expressions: a tuple literal `(a, b, c)`.
    @Fact
    func BTupleLiteral_Parenthesized() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                LocalDeclarationStatement(
                    BindingKind.Var,
                    "t",
                    initializer: TupleLiteralExpression(
                        List[GExpression](
                            LiteralExpression.Int("1"),
                            LiteralExpression.Int("2"),
                            LiteralExpression.Int("3")
                        )
                    )
                )
            )
        )
        let expected = Lines("package Demo", string.Empty, "var t = (1, 2, 3)")
        AssertGolden(expected, unit)
    }

    /// §Type syntax (T1, ADR-0115 §B.4): a positional tuple TYPE
    /// `(string, int32, int32)` — here as the element type of a
    /// `List[...]` field — renders parenthesized and comma-joined.
    @Fact
    func BTupleType_PositionalElements() {
        let unit = CompilationUnit(
            "Demo",
            members: Nodes(
                FieldDeclaration(
                    BindingKind.Let,
                    "_items",
                    NamedTypeReference(
                        "List",
                        List[GTypeReference](
                            TupleTypeReference(
                                List[GTypeReference](
                                    GoldenTests.Type("string"),
                                    GoldenTests.Type("int32"),
                                    GoldenTests.Type("int32")
                                )
                            )
                        )
                    ),
                    initializer: InvocationExpression(
                        IdentifierExpression("List"),
                        List[GExpression](),
                        List[GTypeReference](
                            TupleTypeReference(
                                List[GTypeReference](
                                    GoldenTests.Type("string"),
                                    GoldenTests.Type("int32"),
                                    GoldenTests.Type("int32")
                                )
                            )
                        )
                    ),
                    visibility: Visibility.Private
                )
            )
        )
        let expected = Lines(
            "package Demo",
            string.Empty,
            "private let _items List[(string, int32, int32)] = List[(string, int32, int32)]()"
        )
        AssertGolden(expected, unit)
    }

    /// §For loops: the key/value `for k, v in coll { }` form.
    @Fact
    func BForIn_KeyValue() {
        let loop = ForInStatement(
            "k",
            "v",
            IdentifierExpression("pairs"),
            Block(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                        List[GExpression](IdentifierExpression("v"))
                    )
                )
            )
        )
        let unit = CompilationUnit("Demo", GoldenTests.List(ImportDirective("System")), Nodes(loop))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "for k, v in pairs {",
            "    Console.WriteLine(v)",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.22: a `switch` expression with a type pattern, a
    /// relational pattern, a constant pattern, and a `default` arm, in
    /// return position (samples `SwitchExpression.gs`).
    @Fact
    func B22_SwitchExpression() {
        let sw = SwitchExpression(
            IdentifierExpression("shape"),
            GoldenTests.List(
                SwitchArm(
                    TypePattern("c", GoldenTests.Type("Circle")),
                    MemberAccessExpression(IdentifierExpression("c"), "Radius")
                ),
                SwitchArm(RelationalPattern("<", LiteralExpression.Float("10.0")), LiteralExpression.Float("1.0")),
                SwitchArm(ConstantPattern(LiteralExpression.Int("0")), LiteralExpression.Float("0.0")),
                SwitchArm(nil, LiteralExpression.Float("9.0"))
            )
        )
        let method = MethodDeclaration(
            "Classify",
            returnType: GoldenTests.Type("float64"),
            parameters: GoldenTests.List(Parameter("shape", GoldenTests.Type("Shape"))),
            body: Block(ReturnStatement(sw))
        )
        let unit = CompilationUnit("Demo", List[ImportDirective](), Nodes(method))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func Classify(shape Shape) float64 {",
            "    return switch shape {",
            "        case c is Circle: c.Radius",
            "        case < 10.0: 1.0",
            "        case 0: 0.0",
            "        default: 9.0",
            "    }",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.20: a canonical arrow lambda with a typed, parenthesized
    /// parameter, as an argument to a method call (samples
    /// `ArrowLambda.gs`).
    @Fact
    func B20_ArrowLambda() {
        let lambda = LambdaExpression(
            GoldenTests.List(Parameter("n", GoldenTests.Type("int32"))),
            expressionBody: BinaryExpression(
                BinaryExpression(IdentifierExpression("n"), "%", LiteralExpression.Int("2")),
                "==",
                LiteralExpression.Int("0")
            )
        )
        let call = InvocationExpression(
            MemberAccessExpression(IdentifierExpression("numbers"), "Where"),
            List[GExpression](lambda)
        )
        let method = MethodDeclaration("Evens", returnType: nil, body: Block(ExpressionStatement(call)))
        let unit = CompilationUnit("Demo", List[ImportDirective](), Nodes(method))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func Evens() {",
            "    numbers.Where((n int32) -> n % 2 == 0)",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.23: an `async func` whose body `await`s a call and
    /// returns the unwrapped result (samples `AsyncTask.gs`).
    @Fact
    func B23_AsyncAwait() {
        let await_ = AwaitExpression(
            InvocationExpression(
                MemberAccessExpression(IdentifierExpression("Task"), "FromResult"),
                List[GExpression](IdentifierExpression("n"))
            )
        )
        let method = MethodDeclaration(
            "IdentityAsync",
            returnType: GoldenTests.Type("int32"),
            parameters: GoldenTests.List(Parameter("n", GoldenTests.Type("int32"))),
            body: Block(ReturnStatement(await_)),
            isAsync: true
        )
        let unit = CompilationUnit("Demo", List[ImportDirective](), Nodes(method))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "async func IdentityAsync(n int32) int32 {",
            "    return await Task.FromResult(n)",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.5: a C# operator overload prints as the receiver-clause
    /// `func (a T) operator +(b T) T` form, lifted to a top-level sibling
    /// (sample `Operators.gs`, ADR-0035).
    @Fact
    func BOperator_ReceiverClauseForm() {
        let op = MethodDeclaration(
            "operator +",
            parameters: GoldenTests.List(Parameter("b", GoldenTests.Type("Money"))),
            returnType: GoldenTests.Type("Money"),
            receiver: Receiver("a", GoldenTests.Type("Money")),
            body: Block(
                ReturnStatement(
                    BinaryExpression(
                        MemberAccessExpression(IdentifierExpression("a"), "Cents"),
                        "+",
                        MemberAccessExpression(IdentifierExpression("b"), "Cents")
                    )
                )
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(op))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func (a Money) operator +(b Money) Money {",
            "    return a.Cents + b.Cents",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.* ternary: an (cref:IfExpression) prints as the
    /// value-producing `if c { a } else { b }` form (sample
    /// `IfExpression.gs`, ADR-0064).
    @Fact
    func BIfExpression_ValuePosition() {
        let method = MethodDeclaration(
            "Pick",
            parameters: GoldenTests.List(Parameter("c", GoldenTests.Type("bool"))),
            returnType: GoldenTests.Type("int32"),
            body: Block(
                ReturnStatement(
                    IfExpression(IdentifierExpression("c"), LiteralExpression.Int("1"), LiteralExpression.Int("2"))
                )
            )
        )
        let unit = CompilationUnit("Demo", members: Nodes(method))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "func Pick(c bool) int32 {",
            "    return if c { 1 } else { 2 }",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.* exceptions: a (cref:TryStatement) prints as
    /// `try { } catch (e T) { } finally { }` (sample
    /// `Exceptions.gs`).
    @Fact
    func BTry_CatchFinally() {
        let tryStmt = TryStatement(
            Block(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                        List[GExpression](LiteralExpression.String("work"))
                    )
                )
            ),
            GoldenTests.List(
                CatchClause(
                    "e",
                    GoldenTests.Type("Exception"),
                    Block(
                        ExpressionStatement(
                            InvocationExpression(
                                MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                                List[GExpression](MemberAccessExpression(IdentifierExpression("e"), "Message"))
                            )
                        )
                    )
                )
            ),
            Block(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(IdentifierExpression("Console"), "WriteLine"),
                        List[GExpression](LiteralExpression.String("done"))
                    )
                )
            )
        )
        let method = MethodDeclaration("Run", body: Block(tryStmt))
        let unit = CompilationUnit("Demo", GoldenTests.List(ImportDirective("System")), Nodes(method))
        let expected = Lines(
            "package Demo",
            string.Empty,
            "import System",
            string.Empty,
            "func Run() {",
            "    try {",
            "        Console.WriteLine(\"work\")",
            "    } catch (e Exception) {",
            "        Console.WriteLine(e.Message)",
            "    } finally {",
            "        Console.WriteLine(\"done\")",
            "    }",
            "}"
        )
        AssertGolden(expected, unit)
    }

    /// B.* using: a `using let r = ...` resource declaration prints
    /// with the `using` prefix (sample `Defer.gs`).
    @Fact
    func BUsing_LetResourceDeclaration() {
        let decl = LocalDeclarationStatement(
            BindingKind.Let,
            "r",
            initializer: InvocationExpression(IdentifierExpression("Acquire"), List[GExpression]()),
            isUsing: true
        )
        let method = MethodDeclaration("Run", body: Block(decl))
        let unit = CompilationUnit("Demo", members: Nodes(method))
        let expected = Lines("package Demo", string.Empty, "func Run() {", "    using let r = Acquire()", "}")
        AssertGolden(expected, unit)
    }

    /// B.13: an `init` constructor that chains to a base
    /// constructor prints as `init(params) : base(args) { ... }` (sample
    /// `ExplicitConstructor.gs`).
    @Fact
    func BConstructor_BaseChaining() {
        let ctor = ConstructorDeclaration(
            GoldenTests.List(Parameter("message", GoldenTests.Type("string"))),
            Block(),
            baseArguments: List[GExpression](IdentifierExpression("message"))
        )
        let cls = TypeDeclaration(
            TypeDeclarationKind.Class,
            "MyError",
            baseType: GoldenTests.Type("Exception"),
            members: Members(ctor)
        )
        let unit = CompilationUnit("Demo", GoldenTests.List(ImportDirective("System")), Nodes(cls))
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("init(message string) : base(message) {", printed)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, "Round-trip errors:\n" + string.Join("\n", result!!.Errors))
    }

    /// ADR-0144 §G: a `partial` class/struct/interface renders the
    /// `partial` modifier immediately before the aggregate keyword.
    @Theory
    @InlineData(TypeDeclarationKind(0), "partial class Foo {")
    @InlineData(TypeDeclarationKind(1), "partial struct Foo {")
    @InlineData(TypeDeclarationKind(5), "partial interface Foo {")
    func GTooling_PartialRendersBeforeKindKeyword(kind TypeDeclarationKind, expected string) {
        let cls = TypeDeclaration(kind, "Foo", isPartial: true)
        let unit = CompilationUnit("Demo", members: Nodes(cls))
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains(expected, printed)
    }

    /// ADR-0144 §G: `partial` follows `open` in canonical
    /// order (`open partial class`).
    @Fact
    func GTooling_OpenPartialClassOrder() {
        let cls = TypeDeclaration(TypeDeclarationKind.Class, "Foo", isOpen: true, isPartial: true)
        let unit = CompilationUnit("Demo", members: Nodes(cls))
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("open partial class Foo {", printed)
    }

    /// ADR-0144 §G: accessibility, `open` and `partial` render
    /// in canonical order (`public open partial class`).
    @Fact
    func GTooling_PublicOpenPartialClassOrder() {
        let cls = TypeDeclaration(
            TypeDeclarationKind.Class,
            "Foo",
            visibility: Visibility.Public,
            isOpen: true,
            isPartial: true
        )
        let unit = CompilationUnit("Demo", members: Nodes(cls))
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("public open partial class Foo {", printed)
    }

    /// ADR-0144 §G: `partial` follows `sealed` and precedes the
    /// kind keyword (`sealed partial class`).
    @Fact
    func GTooling_SealedPartialClassOrder() {
        let cls = TypeDeclaration(TypeDeclarationKind.Class, "Foo", isSealed: true, isPartial: true)
        let unit = CompilationUnit("Demo", members: Nodes(cls))
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("sealed partial class Foo {", printed)
    }

    shared {
        private func AssertGolden(expected string, unit CompilationUnit) {
            let printed = GSharpPrinter.Print(unit)
            Assert.Equal(expected, printed)
            // Determinism: the same AST prints byte-identically.
            Assert.Equal(printed, GSharpPrinter.Print(unit))
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Golden printer samples intentionally use semantically incomplete hand-built ASTs."
            )
            Assert.True(result.Success, "Round-trip errors:\n" + string.Join("\n", result.Errors))
        }

        private func Type(name string) NamedTypeReference -> NamedTypeReference(name)

        private func Block(statements ...GStatement) BlockStatement -> BlockStatement(statements.ToList())

        private func Members(members ...GMember) List[GMember] -> members.ToList()

        private func Nodes(nodes ...GNode) List[GNode] -> nodes.ToList()

        private func List[T](items ...T) List[T] -> items.ToList()

        private func Lines(lines ...string) string -> string.Join("\n", lines) + "\n"
    }
}
