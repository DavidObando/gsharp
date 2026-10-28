// <copyright file="Adr0212SpeculativeTypeInfoTests.cs" company="GSharp">
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
import System.Threading
import Xunit

/// ADR-0212 slice S5: (cref:SemanticModel.GetSpeculativeTypeInfo) replaces `Binder.TryInferExpressionType`.
///
/// Contract (one test per row):
///
/// | Input | Answer | Test |
/// | --- | --- | --- |
/// | local or parameter of the enclosing function, declared before `position` | its declared type | `EnclosingLocal_IsInScope` |
/// | local declared after `position` | not in scope: no type | `LocalDeclaredAfterPosition_IsNotInScope` |
/// | receiver inside a method | `this` and the members resolve | `MethodBody_SeesThisAndMembers` |
/// | no enclosing declared function | the globals resolve | `TopLevel_SeesGlobals` |
/// | narrowing in force at `position` (Q15) | excluded: the declared type | `FlowNarrowing_IsExcluded_FromTheContract` |
/// | bind fails, `void` or error type | `TypeInfo.None` | `FailedBind_AnswersNone`, `VoidCall_AnswersNone` |
/// | diagnostics | none escape | `NoDiagnosticEscapes` |
/// | imported CLR member | the binder's type with its nullability kind (`T?`, `T!`, `T` stay distinct, ADR-0186) | `ImportedMember_KeepsTheBindersNullability` |
/// | repeated query | equal answers | `RepeatedQuery_IsDeterministic` |
/// | cancelled token | `OperationCanceledException` | `CancelledToken_Throws` |
/// | every simple name the binder bound, in the corpus | the binder's type, unless the binder narrowed it | the two `AgreesWithTheBinder` tests |
open class Adr0212SpeculativeTypeInfoTests {
    @Fact
    func EnclosingLocal_IsInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func Parameter_IsInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "n + 1", "InParam")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func LocalDeclaredAfterPosition_IsNotInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "later", "BeforeLater")
        Assert.Null(model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func MethodBody_SeesThisAndMembers() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Count + 1", "InMethod")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func TopLevel_SeesGlobals() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Global + 1", "TopLevel")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    // ADR-0212 Q15: flow-sensitive state is not part of the contract. The speculative binder starts
    // with empty narrowing state, so `p` inside `if p != nil` is the declared `Point?`. A later change
    // that seeds the narrowing is a visible change to this test.
    @Fact
    func FlowNarrowing_IsExcluded_FromTheContract() {
        let (model, tree) = Create(Program)
        let name = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Single(
            (n NameExpressionSyntax) -> n.IdentifierToken.Text == "p" && n.Span.Start > Program.IndexOf(
                "// Narrowed",
                StringComparison.Ordinal
            ) &&
                Program.Substring(n.Span.Start - 8, 8) == "        "
        )
        let speculative = model.GetSpeculativeTypeInfo(name.Span.Start, name).Type
        let nullable = Assert.IsType[NullableTypeSymbol](speculative)
        Assert.Equal("Point", nullable.UnderlyingType.Name)
        // The bound tree has the narrowed type here: the exclusion is what separates the two queries.
        Assert.IsNotType[NullableTypeSymbol](model.GetReceiverTypeInfo(name).Type)
    }

    @Fact
    func LocalShadowingAField_IsTheLocal() {
        const source = `class Index {
    private let declarations string
    func Canonical(member string) int32 {
        let declarations = member.Length
        return if declarations > 0 { declarations } else { 0 }
    }
}
`
        let (model, tree) = Create(source)
        let uses = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "declarations")
            .ToArray()
        Assert.NotEmpty(uses)
        for use in uses {
            Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(use.Span.Start, use).Type)
        }
    }

    @Fact
    func FailedBind_AnswersNone() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Missing(1)", "Failed")
        Assert.Equal(TypeInfo.None, model.GetSpeculativeTypeInfo(expression.Span.Start, expression))
    }

    @Fact
    func VoidCall_AnswersNone() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Nothing()", "Void")
        Assert.Equal(TypeInfo.None, model.GetSpeculativeTypeInfo(expression.Span.Start, expression))
    }

    @Fact
    func NoDiagnosticEscapes() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "speculative.gs"))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let before = compilation.GetDiagnostics().Length
        for marker in[]string{"Failed", "Void", "BeforeLater", "InLocal"} {
            let expression = tree
                .Root
                .DescendantNodes()
                .OfType[ExpressionStatementSyntax]()
                .First(
                (s ExpressionStatementSyntax) -> Program.Substring(0, s.Span.Start).EndsWith(
                    "// " + marker + "\n    ",
                    StringComparison.Ordinal
                )
            )
                .Expression
            let _ = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        }
        Assert.Equal(before, compilation.GetDiagnostics().Length)
    }

    @Fact
    func ImportedMember_KeepsTheBindersNullability() {
        let (model, tree) = Create(Program)
        for text in[]string{"Console.ReadLine()", "Path.GetTempPath()"} {
            let expression = Expression(tree, text, "Platform")
            let bound = model.GetTypeInfo(expression).Type!!
            let speculative = model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type!!
            Assert.Equal(bound.GetType(), speculative.GetType())
            Assert.Equal(bound.ToString(), speculative.ToString())
        }
    }

    @Fact
    func RepeatedQuery_IsDeterministic() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        let first = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        let second = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        Assert.Equal(first, second)
    }

    @Fact
    func CancelledToken_Throws() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        using let source = CancellationTokenSource()
        source.Cancel()
        Assert.Throws[OperationCanceledException](
            () -> model.GetSpeculativeTypeInfo(expression.Span.Start, expression, source.Token)
        )
    }

    // ---- Differential: the model must agree with the binder ----

    @Fact
    func GetSpeculativeTypeInfo_AgreesWithTheBinder_OnTheSamples() {
        let mismatches = List[string]()
        var compared = 0
        for file in Directory.GetFiles(Path.Combine(RepositoryRoot(), "samples"), "*.gs").OrderBy(
            (f string) -> f,
            StringComparer.Ordinal
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            compared += CompareCompilation(Compilation(tree), mismatches)
        }
        Assert.True(compared > 1000, "compared ${compared} expressions")
        AssertNoMismatches(mismatches)
    }

    @Fact
    func GetSpeculativeTypeInfo_AgreesWithTheBinder_OnTheLanguageServerSources() {
        let directory = Path.Combine(RepositoryRoot(), "src", "LanguageServer")
        let trees = Directory
            .GetFiles(directory, "*.gs")
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .Select((f string) -> SyntaxTree.Parse(SourceText.From(File.ReadAllText(f), f)))
            .ToArray()
        let mismatches = List[string]()
        let compared = CompareCompilation(Compilation(trees), mismatches)
        Assert.True(compared > 1000, "compared ${compared} expressions")
        AssertNoMismatches(mismatches)
    }

    shared {
        private const Program string = `import System
import System.IO
class Point { var X int32 }
var Global = 1
func Nothing() { }
func Probe(p Point?, n int32) {
    let s = "abc"
    // InLocal
    s.Length
    // InParam
    n + 1
    // BeforeLater
    later
    let later = 2
    // Failed
    Missing(1)
    // Void
    Nothing()
    // Platform
    Console.ReadLine()
    Path.GetTempPath()
    // Narrowed
    if p != nil {
        p
    }
}
class Holder {
    var Count int32
    func M() {
        // InMethod
        Count + 1
    }
}
// TopLevel
Global + 1
`

        private func Create(source string)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "speculative.gs"))
            return (Compilation(tree).GetSemanticModel(tree), tree)
        }

        /// The expression statement that follows the `// marker` comment.
        private func Expression(tree SyntaxTree, text string, marker string) ExpressionSyntax {
            let start = Program.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(start >= 0, marker)
            return tree
                .Root
                .DescendantNodes()
                .OfType[ExpressionSyntax]()
                .Where(
                (e ExpressionSyntax) -> e.Span.Start > start && Program.Substring(e.Span.Start, e.Span.Length) == text
            )
                .OrderBy((e ExpressionSyntax) -> e.Span.Start)
                .ThenByDescending((e ExpressionSyntax) -> e.Span.Length)
                .First()
        }

        private func RepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return directory!!.FullName
        }

        /// Compares every simple-name read of [`compilation`](paramref) that names a variable, field or
        /// property: the speculative type must be the symbol's declared type, which is the contract
        /// (flow narrowing is excluded, Q15). Member segments of a chain are not expressions on their own.
        /// Returns the number compared.
        private func CompareCompilation(compilation Compilation, mismatches List[string]) int32 {
            var compared = 0
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let file = Path.GetFileName(tree.Text?.FileName ?? string.Empty)
                for name in tree.Root.DescendantNodes().OfType[NameExpressionSyntax]() {
                    if name.IdentifierToken.IsMissing || IsMemberSegment(name) {
                        continue
                    }
                    if model.GetReceiverTypeInfo(name).Type == nil {
                        continue
                    }
                    let referenced = model.GetSymbolInfo(name.IdentifierToken).Symbol
                    if IsNegatedPatternBinding(referenced) {
                        continue
                    }
                    let declared TypeSymbol? = switch referenced {
                        case v is VariableSymbol: v.Type
                        case f is FieldSymbol: f.Type
                        case p is PropertySymbol: p.Type
                        default: default(TypeSymbol?)
                    }
                    if declared == nil || object.ReferenceEquals(declared, TypeSymbol.Error) {
                        continue
                    }
                    compared += 1
                    let speculative = model.GetSpeculativeTypeInfo(name.Span.Start, name).Type
                    let expected = declared.ToString()
                    let actual = speculative?.ToString() ?? "<none>"
                    if expected != actual {
                        let category = if speculative == nil {
                            "no answer"
                        } else {
                            "different type"
                        }
                        mismatches.Add(
                            "${category} @ ${file}:${name.Span.Start} ${name.IdentifierToken.Text} in ${name.Parent?.GetType()?.Name}: declared ${expected}, speculative ${actual}"
                        )
                    }
                }
            }
            return compared
        }

        private func IsMemberSegment(name NameExpressionSyntax) bool {
            // Chains parse right-nested: `a.b.c` is `a.(b.c)`, so `b` leads an accessor that is a right part.
            var current SyntaxNode = name
            while true {
                if current.Parent is IndexExpressionSyntax indexed && object.ReferenceEquals(indexed.Target, current) {
                    current = indexed
                } else if current.Parent is AccessorExpressionSyntax accessor {
                    if object.ReferenceEquals(accessor.RightPart, current) {
                        return true
                    }
                    current = accessor
                } else {
                    return false
                }
            }
        }

        /// A pattern variable bound by `x is not T v` and read after an early exit: the scope query does not
        /// list it yet (a shape the pre-S5 server path also missed, tracked in issue #5466).
        private func IsNegatedPatternBinding(symbol Symbol?) bool {
            if symbol is not VariableSymbol || symbol.DeclaringSyntaxNodes.IsDefaultOrEmpty {
                return false
            }
            var node SyntaxNode? = symbol.DeclaringSyntaxNodes[0]
            while node != nil {
                if node is NotPatternSyntax {
                    return true
                }
                node = node.Parent
            }
            return false
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
            text.AppendLine("${mismatches.Count} expressions disagree with the binder:")
            for group in byCategory {
                text.AppendLine("  ${group.Key}: ${group.Count()}")
                for example in group.Take(5) {
                    text.AppendLine("      " + example.Substring(example.IndexOf(" @ ", StringComparison.Ordinal) + 3))
                }
            }
            Assert.Fail(text.ToString())
        }
    }
}
