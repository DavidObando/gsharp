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
        Assert.Contains("Helper", Names("PNested"))
    }

    @Fact
    func DerivedConstant_HidesTheBaseTypesSharedField() {
        let found = Assert.Single(
            Compiled.LookupSymbols(Source().IndexOf("// PLimit", StringComparison.Ordinal), "Limit")
        )
        Assert.True(Assert.IsType[FieldSymbol](found).IsConst)
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

        private func Equivalent(found Symbol, bound Symbol) bool {
            if object.ReferenceEquals(found, bound) {
                return true
            }
            if !string.Equals(found.Name, bound.Name, StringComparison.Ordinal) {
                return false
            }
            // One symbol per name: a call's overload and a constructed member are the name's symbol.
            if found is FunctionSymbol && bound is FunctionSymbol {
                return true
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
                !clause
                .GetChildren()
                .OfType[TypeClauseSyntax]()
                .Any() {
                return
            }
            let owner = clause.Parent
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
            return Helper() // PNested
        }
    }
    shared {
        func Helper() int32 { return 1 }
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
`
    }
}
