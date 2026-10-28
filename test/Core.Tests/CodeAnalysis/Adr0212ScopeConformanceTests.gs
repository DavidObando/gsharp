// <copyright file="Adr0212ScopeConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Xunit

/// ADR-0212 slice S3, differential conformance: the scope queries must agree with the binder.
/// For every simple-name use whose symbol the bound tree recorded, (cref:SemanticModel.LookupSymbols)
/// at that token must answer the same symbol, and for every type-clause identifier that names a type,
/// (cref:SemanticModel.GetSymbolInfo) must answer it. The corpus is every program in `samples/`, the
/// language server's own sources as one compilation, and a purpose-written program for the shapes the
/// samples do not have. A mismatch is reported by category so a fix lands on a shared rule.
open class Adr0212ScopeConformanceTests {
    @Fact
    func LookupSymbols_AgreesWithTheBinder_OnTheSamples() {
        let mismatches = List[string]()
        let root = RepositoryRoot()
        var compared = 0
        for file in Directory.GetFiles(Path.Combine(root, "samples"), "*.gs").OrderBy(
            (f string) -> f,
            StringComparer.Ordinal
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            compared += CompareCompilation(Compilation(tree), mismatches)
        }
        Assert.True(compared > 1000, "compared ${compared} names")
        AssertNoMismatches(mismatches)
    }

    @Fact
    func LookupSymbols_AgreesWithTheBinder_OnTheLanguageServerSources() {
        let mismatches = List[string]()
        let directory = Path.Combine(RepositoryRoot(), "src", "LanguageServer")
        let trees = Directory
            .GetFiles(directory, "*.gs")
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .Select((f string) -> SyntaxTree.Parse(SourceText.From(File.ReadAllText(f), f)))
            .ToArray()
        let compared = CompareCompilation(Compilation(trees), mismatches)
        Assert.True(compared > 1000, "compared ${compared} names")
        AssertNoMismatches(mismatches)
    }

    @Fact
    func ConstAndSharedFieldTypeClauses_NameTheirTypes() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        for fieldName in[]string{"Cap", "Field"} {
            let field = tree
                .Root
                .DescendantNodes()
                .OfType[FieldDeclarationSyntax]()
                .First(
                (f FieldDeclarationSyntax) -> f.Identifier.Text == fieldName && f.Type?.Identifier?.Text == "Color"
            )
            Assert.IsType[EnumSymbol](model.GetSymbolInfo(field.Type.Identifier).Symbol)
        }
    }

    @Fact
    func FixedPointer_IsVisibleInItsBodyOnly() {
        Assert.Contains("p", Names("PInFixed"))
        Assert.DoesNotContain("p", Names("PAfterFixed"))
    }

    @Fact
    func SelectBinding_IsVisibleInItsOwnCaseBodyOnly() {
        Assert.Contains("v", Names("PInSelect"))
        Assert.DoesNotContain("v", Names("PInOtherSelect"))
        Assert.DoesNotContain("v", Names("PAfterSelect"))
        Assert.DoesNotContain("w", Names("PInSelect"))
    }

    @Fact
    func DiscardParameters_AreNotNames() {
        let names = Names("PDiscards")
        Assert.DoesNotContain("_", names)
        Assert.Contains("kept", names)
        Assert.Empty(Compiled.LookupSymbols(Source().IndexOf("// PDiscards", StringComparison.Ordinal), "_"))
    }

    @Fact
    func EscapedIdentifiers_AreFoundByTheirSemanticName() {
        let names = Names("PEscaped")
        Assert.Contains("params", names)
        Assert.Contains("type", names)
        Assert.IsType[ParameterSymbol](
            Assert.Single(Compiled.LookupSymbols(Source().IndexOf("// PEscaped", StringComparison.Ordinal), "params"))
        )
    }

    @Fact
    func NestedType_SeesTheStaticMembersOfEveryEnclosingType() {
        Assert.Contains("OnlyOuter", Names("PNested"))
    }

    @Fact
    func InterfaceProperty_AccessorHasAnEnclosingSymbol() {
        let enclosing = Compiled.GetEnclosingSymbol(Program.IndexOf("// PIfaceGet", StringComparison.Ordinal))
        Assert.NotNull(enclosing)
        Assert.IsNotType[InterfaceSymbol](enclosing)
    }

    @Fact
    func ConstructorBaseInitializer_SeesParametersButNoInstanceMembersOrThis() {
        let model = Compiled
        let inArguments = Program.IndexOf("base(n)", StringComparison.Ordinal) + 5
        let names = model.LookupSymbols(inArguments).Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("n", names)
        Assert.DoesNotContain("Field2", names)
        Assert.DoesNotContain("this", names)
        Assert.Contains("Field2", Names("PCtorBody"))
        Assert.Contains("this", Names("PCtorBody"))
    }

    @Fact
    func Deconstruction_IsNotVisibleInItsOwnInitializer() {
        let inInitializer = Program.IndexOf("(x, 2)", StringComparison.Ordinal) + 1
        let found = Assert.Single(Compiled.LookupSymbols(inInitializer, "x"))
        Assert.True(found.DeclaringSyntaxNodes[0].Span.Start < Program.IndexOf("let (x, y)", StringComparison.Ordinal))
        Assert.Contains("y", Names("PDecon"))
    }

    @Fact
    func ImplicitScopeContext_IsVisibleInsideItsScopeOnly() {
        Assert.Contains("ctx", Names("PInScope"))
        Assert.DoesNotContain("ctx", Names("PAfterScope"))
        Assert.DoesNotContain("ctx", Names("PEscaped"))
    }

    @Fact
    func InterfaceSharedMember_SeesStaticMembersOnly() {
        let names = Names("PIfaceShared")
        Assert.Contains("Hidden", names)
        Assert.DoesNotContain("Inst", names)
    }

    @Fact
    func ExplicitInterfaceImplementation_IsNotACallableName() {
        let found = Assert.Single(
            Compiled.LookupSymbols(Program.IndexOf("// PExplicit", StringComparison.Ordinal), "M")
        )
        Assert.False(Assert.IsType[FunctionSymbol](found).HasExplicitInterfaceClause)
    }

    @Fact
    func RepeatedDiscardParameters_PairByPosition() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        let second = tree
            .Root
            .DescendantNodes()
            .OfType[FunctionDeclarationSyntax]()
            .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == "D")
            .Parameters[1]
        Assert.Same(TypeSymbol.String, model.GetSymbolInfo(second.Type!!.Identifier!!).Symbol)
    }

    @Fact
    func EscapedLocalFunction_DeclarationAnswersItsFunction() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        let declaration = tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((d VariableDeclarationSyntax) -> d.Identifier.Text == "$$generic")
        Assert.IsType[FunctionSymbol](model.GetSymbolInfo(declaration.Identifier).Symbol)
    }

    @Fact
    func SameNamedFunctionsOfDifferentOwners_AreNotEquivalent() {
        let outside = Assert.Single(
            Compiled.LookupSymbols(Program.IndexOf("// PEscaped", StringComparison.Ordinal), "Helper")
        )
        let outer = Assert.IsType[StructSymbol](Assert.Single(Compiled.LookupSymbols(0, "Outer")))
        let nested = outer.StaticMethods.Single((f FunctionSymbol) -> f.Name == "Helper")
        Assert.False(Equivalent(outside, nested))
    }

    @Fact
    func DerivedConstant_HidesTheBaseTypesSharedField() {
        let found = Assert.Single(
            Compiled.LookupSymbols(Source().IndexOf("// PLimit", StringComparison.Ordinal), "Limit")
        )
        Assert.True(Assert.IsType[FieldSymbol](found).IsConst)
    }

    // ---- #5340: one test per row of the contract of the rare declaration shapes ----
    // Row: field initializer -> the `shared` members of its type, never the instance ones.
    // Row: `deinit` -> the destructor function; `this` and the members resolve.
    // Row: a part of a nested partial type -> the merged type, at any depth.
    // Row: type clause of an interface `const` or `shared` field -> the type it names.
    // Row: instance member of a base and `shared` member of a derived type of one name -> the instance member.
    // Row: implicit `ctx` of a `scope` -> visible in the scope body only.
    // Row: globals -> source order across kinds, files by name.

    @Fact
    func FieldInitializer_SeesTheSharedMembersOfItsType() {
        let position = Program.IndexOf("Make() + S", StringComparison.Ordinal) + 8
        let names = Compiled.LookupSymbols(position).Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("Make", names)
        Assert.Contains("S", names)
        Assert.DoesNotContain("A", names)
        Assert.DoesNotContain("this", names)
    }

    @Fact
    func Deinit_IsADeclarationWithThis() {
        let enclosing = Compiled.GetEnclosingSymbol(Program.IndexOf("// PFuDeinit", StringComparison.Ordinal))
        Assert.IsType[FunctionSymbol](enclosing)
        let names = Names("PFuDeinit")
        Assert.Contains("this", names)
        Assert.Contains("Tag", names)
    }

    @Fact
    func NestedPartialType_EveryPartIsTheMergedType() {
        let position = Program.IndexOf("// PFuPart", StringComparison.Ordinal)
        Assert.Equal("UsePart", Compiled.GetEnclosingSymbol(position)!!.Name)
        Assert.Contains("A", Names("PFuPart"))
        let second = Program.IndexOf("func UsePart()", StringComparison.Ordinal)
        Assert.Equal("N", Compiled.GetEnclosingSymbol(second - 5)!!.Name)
    }

    @Fact
    func InterfaceConstTypeClause_NamesItsType() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        let field = tree
            .Root
            .DescendantNodes()
            .OfType[FieldDeclarationSyntax]()
            .Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "K")
        Assert.Same(TypeSymbol.Int32, model.GetSymbolInfo(field.Type.Identifier).Symbol)
        let sharedField = tree
            .Root
            .DescendantNodes()
            .OfType[FieldDeclarationSyntax]()
            .Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "W")
        Assert.Same(TypeSymbol.Int32, model.GetSymbolInfo(sharedField.Type.Identifier).Symbol)
    }

    @Fact
    func InstanceMemberOfABase_WinsOverASharedMemberOfTheDerivedType() {
        let found = Assert.Single(Compiled.LookupSymbols(Program.IndexOf("// PFuHides", StringComparison.Ordinal), "X"))
        Assert.False(Assert.IsType[FieldSymbol](found).IsStatic)
        let listed = Names("PFuHides").Count((n string) -> n == "X")
        Assert.Equal(1, listed)
    }

    @Fact
    func InstanceInitializer_SeesPrimaryConstructorParameters() {
        let position = Program.IndexOf("= n + 1", StringComparison.Ordinal) + 2
        Assert.IsType[ParameterSymbol](Assert.Single(Compiled.LookupSymbols(position, "n")))
    }

    @Fact
    func FieldInitializer_DoesNotSeeInheritedStaticsAheadOfGlobals() {
        let position = Program.IndexOf("= FuShadow() + 1", StringComparison.Ordinal) + 2
        Assert.Null(
            Assert.IsType[FunctionSymbol](Assert.Single(Compiled.LookupSymbols(position, "FuShadow"))).ContainingType
        )
    }

    @Fact
    func ConstInitializer_DoesNotSeePrimaryParametersOrInheritedConstants() {
        let inherited = Program.IndexOf("var V int32 = 2", StringComparison.Ordinal) + 16
        Assert.Empty(Compiled.LookupSymbols(inherited, "FuK"))
        let primary = Program.IndexOf("const Z int32 = 3", StringComparison.Ordinal) + 16
        Assert.Empty(Compiled.LookupSymbols(primary, "FuP"))
    }

    @Fact
    func InheritedMethod_DoesNotShadowASharedVariable() {
        let found = Assert.Single(
            Compiled.LookupSymbols(Program.IndexOf("// PFuMethodVar", StringComparison.Ordinal), "MX")
        )
        Assert.IsType[FieldSymbol](found)
    }

    @Fact
    func StaticInitializer_SeesTheImplicitScopeContext() {
        Assert.Contains("ctx", Names("PFuStaticCtx"))
    }

    @Fact
    func NestedPartialType_InAnUnnamedTree_IsTheMergedType() {
        let text = "class Outer {\n partial class N { var A int32 }\n partial class N {\n func Use() int32 { return A }\n }\n}\n"
        let tree = SyntaxTree.Parse(text)
        let model = Compilation(tree).GetSemanticModel(tree)
        let position = text.IndexOf("return A", StringComparison.Ordinal) + 7
        Assert.Contains("A", model.LookupSymbols(position).Select((s Symbol) -> s.Name).ToList())
    }

    // Row: the empty part of a nested partial type -> the merged type, the same as a part with members.
    @Fact
    func NestedPartialType_EmptyPart_IsTheMergedType() {
        let text = "class Outer {\n partial class N { var A int32 }\n partial class N { /* here */ }\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(text, "empty-part.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        let position = text.IndexOf("/* here */", StringComparison.Ordinal)
        let enclosing = model.GetEnclosingSymbol(position)
        Assert.Equal("N", enclosing!!.Name)
        Assert.IsType[StructSymbol](enclosing)
        Assert.Equal(
            "Outer",
            model.GetEnclosingSymbol(text.IndexOf("partial class N { var", StringComparison.Ordinal) - 2)!!.Name
        )
    }

    @Fact
    func NestedPartialType_EmptyPartsAtEveryDepthAndKind_AreTheMergedType() {
        let text = "class Outer {\n partial class Mid {\n  partial class Deep { }\n  partial class Deep { /* deep */ }\n }\n partial class Mid { /* mid */ }\n partial interface I { }\n partial interface I { /* iface */ }\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(text, "empty-parts.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        Assert.Equal("Deep", model.GetEnclosingSymbol(text.IndexOf("/* deep */", StringComparison.Ordinal))!!.Name)
        Assert.Equal("Mid", model.GetEnclosingSymbol(text.IndexOf("/* mid */", StringComparison.Ordinal))!!.Name)
        let iface = model.GetEnclosingSymbol(text.IndexOf("/* iface */", StringComparison.Ordinal))
        Assert.Equal("I", iface!!.Name)
        Assert.IsType[InterfaceSymbol](iface)
    }

    @Fact
    func NestedPartialType_InterleavedParts_AreEachTheirOwnMergedType() {
        let text = "class Outer {\n partial class A { }\n partial class B { }\n partial class B { /* b */ }\n partial class A { func F() { } /* a */ }\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(text, "interleaved.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        Assert.Equal("B", model.GetEnclosingSymbol(text.IndexOf("/* b */", StringComparison.Ordinal))!!.Name)
        Assert.Equal("A", model.GetEnclosingSymbol(text.IndexOf("/* a */", StringComparison.Ordinal))!!.Name)
        Assert.Equal(
            "Outer",
            model.GetEnclosingSymbol(text.IndexOf("partial class B { }", StringComparison.Ordinal) - 2)!!.Name
        )
    }

    @Fact
    func Globals_AreListedInSourceOrderAcrossKinds() {
        let text = "var first = 1\nfunc second() int32 { return 1 }\nenum Third { A }\nvar fourth = 2\n"
        let tree = SyntaxTree.Parse(SourceText.From(text, "order.gs"))
        let model = Compilation(tree).GetSemanticModel(tree)
        let names = model.LookupSymbols(0).Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"first", "second", "Third", "fourth"}, names)
    }

    @Fact
    func LookupSymbols_AgreesWithTheBinder_OnThePurposeWrittenProgram() {
        let mismatches = List[string]()
        let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let compared = CompareCompilation(compilation, mismatches)
        Assert.True(compared > 25, "compared ${compared} names")
        AssertNoMismatches(mismatches)
    }

    shared {
        private func Source() string -> Program

        private let Compiled SemanticModel = CompileProgram()

        private func CompileProgram() SemanticModel {
            let tree = SyntaxTree.Parse(SourceText.From(Program, "conformance.gs"))
            return Compilation(tree).GetSemanticModel(tree)
        }

        private func Names(marker string) List[string] {
            return Compiled
                .LookupSymbols(Program.IndexOf("// " + marker + "\n", StringComparison.Ordinal))
                .Select((s Symbol) -> s.Name)
                .ToList()
        }

        private func RepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return directory!!.FullName
        }

        private func AssertNoMismatches(mismatches List[string]) {
            if mismatches.Count == 0 {
                return
            }
            let byCategory = mismatches
                .GroupBy((m string) -> m.Substring(0, m.IndexOf(" @ ", StringComparison.Ordinal)))
                .OrderBy((g IGrouping[string, string]) -> g.Key, StringComparer.Ordinal)
                .ToArray()
            let text = StringBuilder()
            text.AppendLine("${mismatches.Count} names disagree with the binder:")
            for group in byCategory {
                text.AppendLine("  ${group.Key}: ${group.Count()}")
                for example in group.Take(3) {
                    text.AppendLine("      " + example.Substring(example.IndexOf(" @ ", StringComparison.Ordinal) + 3))
                }
            }
            Assert.Fail(text.ToString())
        }

        /// Compares every tree of [`compilation`](paramref); returns the number of names compared.
        private func CompareCompilation(compilation Compilation, mismatches List[string]) int32 {
            var compared = 0
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let file = Path.GetFileName(tree.Text?.FileName ?? string.Empty)
                for node in tree.Root.DescendantNodes() {
                    if SimpleNameToken(node) is {} token {
                        compared += CompareName(model, token, file, mismatches)
                    } else if node is TypeClauseSyntax clause {
                        CompareTypeClause(model, clause, file, mismatches)
                    }
                }
            }
            return compared
        }

        /// The identifier of a simple-name use: a name or call that is not a member selection.
        private func SimpleNameToken(node SyntaxNode) SyntaxToken? {
            let token SyntaxToken? = switch node {
                case name is NameExpressionSyntax: name.IdentifierToken
                case call is CallExpressionSyntax: call.Identifier
                default: default(SyntaxToken?)
            }
            if token == nil || token.IsMissing || token.Kind != SyntaxKind.IdentifierToken {
                return nil
            }
            // `Items[0]` selects like `Items`.
            var target SyntaxNode = node
            while target.Parent is IndexExpressionSyntax indexed && object.ReferenceEquals(indexed.Target, target) {
                target = indexed
            }
            if target.Parent is AccessorExpressionSyntax accessor {
                if !object.ReferenceEquals(accessor.LeftPart, target) {
                    return nil
                }
                var current SyntaxNode = accessor
                while current.Parent is AccessorExpressionSyntax outer {
                    if object.ReferenceEquals(outer.RightPart, current) {
                        return nil
                    }
                    current = outer
                }
            }
            return token
        }

        private func CompareName(model SemanticModel, token SyntaxToken, file string, mismatches List[string]) int32 {
            let bound = model.GetSymbolInfo(token).Symbol
            if bound == nil || bound is TypeParameterSymbol || bound is ImportedFunctionSymbol {
                return 0
            }
            // Known gap, #5334: the variable of an `is` pattern follows the binder's flow regions.
            if bound.GetType().Name == "PatternVariableSymbol" {
                return 0
            }
            // Only source symbols: an imported or built-in one has no declaring syntax.
            if bound.DeclaringSyntaxNodes.IsDefaultOrEmpty && bound is not ParameterSymbol {
                return 0
            }
            let found = model.LookupSymbols(token.Span.Start, token.ValueText)
            let category = "name " + bound.GetType().Name + " in " + token.Parent?.GetType().Name
            if found.IsDefaultOrEmpty {
                mismatches.Add(category + " found nothing @ ${file}:${token.Span.Start} '${token.Text}'")
            } else if !Equivalent(found[0], bound) {
                mismatches.Add(
                    category + " found " + found[0].GetType().Name + " @ ${file}:${token.Span.Start} '${token.Text}'"
                )
            }
            return 1
        }

        /// Two functions of one name are the same group only when one type (or none) owns both.
        private func SameOwner(found Symbol, bound Symbol) bool {
            let foundOwner = found.ContainingType
            let boundOwner = bound.ContainingType
            if object.ReferenceEquals(foundOwner, boundOwner) {
                return true
            }
            let foundDefinition = (foundOwner as StructSymbol)?.Definition ?? foundOwner
            let boundDefinition = (boundOwner as StructSymbol)?.Definition ?? boundOwner
            return foundDefinition != nil && object.ReferenceEquals(foundDefinition, boundDefinition)
        }

        private func Equivalent(found Symbol, bound Symbol) bool {
            if object.ReferenceEquals(found, bound) {
                return true
            }
            if !string.Equals(found.Name, bound.Name, StringComparison.Ordinal) {
                return false
            }
            // One symbol per name: a call's overload and a constructed member are the name's symbol.
            if found is FunctionSymbol && bound is FunctionSymbol {
                return SameOwner(found, bound)
            }
            let foundSyntax = found.DeclaringSyntaxNodes
            let boundSyntax = bound.DeclaringSyntaxNodes
            if !foundSyntax.IsDefaultOrEmpty && !boundSyntax.IsDefaultOrEmpty {
                return object.ReferenceEquals(foundSyntax[0], boundSyntax[0])
            }
            return found.GetType() == bound.GetType()
        }

        /// A type clause that names a single type must answer it, whatever declares the clause.
        private func CompareTypeClause(
            model SemanticModel,
            clause TypeClauseSyntax,
            file string,
            mismatches List[string]
        ) {
            if clause.Identifier is not{} identifier ||
                identifier.IsMissing ||
                !clause
                .QualifierIdentifierTokens
                .IsDefaultOrEmpty ||
                clause
                .GetChildren()
                .OfType[TypeClauseSyntax]()
                .Any() {
                return
            }
            let owner = clause.Parent
            // Known gap, #5340: a lambda inside a call the binder could not bind (an unresolved import) has no
            // bound parameter, so no symbol exists to answer.
            if owner is ParameterSyntax parameterOwner &&
                parameterOwner.Identifier is {} parameterName &&
                model.GetDeclaredSymbol(parameterName) == nil && owner.Parent is LambdaExpressionSyntax {
                return
            }
            // Only clauses of declarations: a parameter, a field (also `const` and `shared`), a function result.
            if owner is not(
                ParameterSyntax or FieldDeclarationSyntax or FunctionDeclarationSyntax or VariableDeclarationSyntax
            ) {
                return
            }
            let symbol = model.GetSymbolInfo(identifier).Symbol
            if symbol == nil && NamesAType(model, identifier) {
                mismatches.Add(
                    "type clause of " + owner?.GetType()
                        .Name +
                        " answered nothing @ ${file}:${identifier.Span.Start} '${identifier.Text}'"
                )
            }
        }

        /// Whether the identifier names a type the compilation declares or a builtin one.
        private func NamesAType(model SemanticModel, identifier SyntaxToken) bool {
            if identifier.Text is "int32" or
                "int64" or
                "string" or
                "bool" or
                "float64" or
                "uint8" or
                "int16" or
                "float32" {
                return true
            }
            let found = model.LookupSymbols(identifier.Span.Start, identifier.Text)
            return !found.IsDefaultOrEmpty &&
                found[0] is StructSymbol or
                EnumSymbol or
                InterfaceSymbol or
                DelegateTypeSymbol
        }

        private const Program string = `package Conformance

import System

enum Color { Red, Green }

type Alias = int32

class Outer {
    class Inner {
        func Caller() int32 {
            return Helper() + OnlyOuter() // PNested
        }
    }
    shared {
        func Helper() int32 { return 1 }
        func OnlyOuter() int32 { return 3 }
        var Counter int32 = 0
    }
}

open class Base {
    shared {
        var Limit int32 = 3
        func Twice(v int32) int32 { return v * 2 }
    }
    var Inherited int32
    private var Secret int32
}

class Derived : Base {
    const Cap Color = Color.Red
    shared {
        const Limit int32 = 7
        var Field Color
        func Read() int32 {
            return Limit + Twice(1) // PLimit
        }
    }
    prop this[i int32] int32 {
        get {
            return i
        }
    }
    func Use(extra Alias) int32 {
        let Item = Inherited
        return Item + extra
    }
}

class Primary(id int64, extra int64) {
    const Cap int32 = 5
    var Label string
    func Total() int64 {
        return id + extra + Cap
    }
}

func Discards(_ int32, _ int32, kept int32) int32 {
    let f = (_ int32, y int32) -> y
    return kept + f(1, 2) // PDiscards
}

func Helper() int32 {
    return 0
}

open class Base2 {
    var Field2 int32
    init(v int32) { }
}

class Derived2 : Base2 {
    init(n int32) : base(n) {
        Field2 = n // PCtorBody
    }
}

func Decon() int32 {
    let x = 1
    if true {
        let (x, y) = (x, 2) // PDecon
        return x + y
    }
    return x
}

func Scoped() int32 {
    scope {
        let a = 1
        let c = ctx
        a + 0 // PInScope
    }
    return 0 // PAfterScope
}

interface IStat {
    func Inst() int32 { return 1 }
    shared {
        private func Hidden() int32 { return 2 }
        func Run() int32 {
            return Hidden() // PIfaceShared
        }
    }
}

interface IProp {
    prop P int32 {
        get {
            return 1 // PIfaceGet
        }
    }
}

interface IFoo {
    func M() int32
}

class Explicit : IFoo {
    private func (IFoo) M() int32 { return 1 }
    func M() int32 { return 2 }
    func Use() int32 {
        return M() // PExplicit
    }
}

interface IDiscard {
    func D(_ int32, _ string) int32
}

func EscapedLocalFunction() int32 {
    let $generic[T] = func(v T) T { return v }
    return $generic(1)
}

func Escaped($params string) string {
    let $type = $params + "!"
    return $type // PEscaped
}

func Binding(input string?, fallback string?, items []int32) int32 {
    guard let first = input, let second = fallback else {
        if let inner = fallback {
            return inner.Length
        }
        return 0
    }
    var total = first.Length + second.Length
    if let a = input && a.Length > 0 {
        total += a.Length
    } else {
        total += 1
    }
    while let w = fallback {
        total += w.Length
        break
    }
    for item in items {
        total += item
    }
    let probe object = items[0]
    switch probe {
        case typed is int32 {
            total += typed
        }
        case other is string {
            total += other.Length
        }
        default { }
    }
    return total
}

unsafe struct Bone {
    fixed Name [32]int8

    func First() int8 {
        var first int8 = 0
        fixed p *int8 = Name {
            first = p[0] // PInFixed
        }
        return first // PAfterFixed
    }
}

func Channels() int32 {
    let ready = chan[int32](1)
    ready <- 4
    let other = chan[int32](1)
    other <- 5
    var seen = 0
    select {
        case let v = <-ready {
            seen += v // PInSelect
        }
        case let w = <-other {
            seen += w // PInOtherSelect
        }
    }
    let afterSelect = seen // PAfterSelect
    return afterSelect
}

class FuInit {
    shared {
        var S int32 = 1
        func Make() int32 { return 1 }
    }
    var A int32 = Make() + S
    var B int32 = S + 1
}

open class FuRes(Tag string) {
    deinit {
        Console.WriteLine(this.Tag)
        // PFuDeinit
    }
}

class FuOuter {
    partial class N {
        var A int32
    }
    partial class N {
        func UsePart() int32 {
            return A // PFuPart
        }
    }
}

interface FuIC {
    shared {
        const K int32 = 1
        var W int32 = 2
    }
}

interface FuIS {
    shared {
        func Make() int32 { return 1 }
        func Twice() int32 {
            return Make() * 2 // PFuIShared
        }
    }
}

class FuPrimary(n int32) {
    var value int32 = n + 1
}

func FuShadow() int32 { return 5 }

open class FuSBase {
    shared {
        func FuShadow() int32 { return 1 }
    }
}

class FuSDerived : FuSBase {
    var Q int32 = FuShadow() + 1
}

open class FuCBase {
    const FuK int32 = 1
}

class FuCDerived : FuCBase {
    var V int32 = 2
}

class FuCPrimary(FuP int32) {
    const Z int32 = 3
}

open class FuMBase {
    func MX() int32 { return 1 }
}

class FuMDerived : FuMBase {
    shared {
        var MX int32 = 1
    }
    func G() int32 {
        return MX // PFuMethodVar
    }
}

class FuStaticCtx {
    shared {
        init {
            scope {
                let c = ctx
                c // PFuStaticCtx
            }
        }
    }
}

open class FuBase {
    var X int32
}

class FuDerived : FuBase {
    shared {
        var X int32 = 1
    }
    func F() int32 {
        return X // PFuHides
    }
}
`
    }
}
