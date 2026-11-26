package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue6231ConditionalCompilationTests {
    @Theory
    @InlineData("", false)
    @InlineData("@A", false)
    @InlineData(" A", false)
    @InlineData("A B", false)
    @InlineData("true", false)
    @InlineData("false", false)
    @InlineData("0A", false)
    @InlineData("_A2", true)
    @InlineData("class", true)
    @InlineData("True", true)
    @InlineData("é", true)
    func SymbolNames_UseIdentifierRulesWithoutBooleanKeywords(name string, valid bool) {
        Assert.Equal(valid, ConditionalSymbols.IsValidName(name))
    }

    @Theory
    @InlineData(`@DefineSymbol("") func F() {}`, "GS9309", `""`)
    @InlineData(`@DefineSymbol("A", "B") @UndefineSymbol("A") func F() {}`, "GS9309", `"A") func`)
    @InlineData(`@DefineSymbol(name: "A") func F() {}`, "GS9309", `name: "A"`)
    @InlineData(`func F(@DefineSymbol("A") x int32) {}`, "GS9309", `@DefineSymbol`)
    @InlineData(`@return:DefineSymbol("A") func F() int32 -> 1`, "GS9309", `@return:`)
    @InlineData(`enum E { @DefineSymbol("A") A }`, "GS9309", `@DefineSymbol`)
    @InlineData(`@DefineSymbol("A") Missing()`, "GS9309", `@DefineSymbol`)
    @InlineData(`@If(true) Missing()`, "GS9310", `@If`)
    @InlineData(`class C { prop P int32 { @If(false) get { return 1 } } }`, "GS9310", `@If`)
    @InlineData(`func F() { var x = 0 @DefineSymbol("A") let fresh, x = 1, 2 }`, "GS9309", `@DefineSymbol`)
    @InlineData(`func F() { @Unknown let (a, b) = (1, 2) }`, "GS0206", `@Unknown`)
    @InlineData(`@If(true || Missing()) func F() {}`, "GS9310", `Missing()`)
    @InlineData(`@If(false && defined("A")) func F() {}`, "GS9310", `defined("A")`)
    @InlineData(`@If(@defined("A") == true) func F() {}`, "GS9310", `@defined("A") == true`)
    @InlineData(`@If(true) @If(false) func F() {}`, "GS9310", `@If(false)`)
    @InlineData(`func F() { let x = @defined("true") }`, "GS9311", `@defined("true")`)
    @InlineData(`func F() { let x = @defined("A", "B") }`, "GS9311", `@defined("A", "B")`)
    func InvalidIntrinsics_ReportOwnedDiagnosticAtOriginalSpan(source string, id string, offending string) {
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let errors = compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(errors)
        let expected = source.IndexOf(offending, StringComparison.Ordinal)
        Assert.Contains(errors, (d Diagnostic) -> d.Id == id && d.Location.Span.Start == expected)
    }

    @Fact
    func InactiveAncestors_StillValidatePredicatesButNotOrdinaryAttributesOrBodies() {
        const source = `@If(false)
class Hidden {
    @If(true || Missing())
    @Unknown
    func F() Missing { return Missing() }
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let errors = compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        let error = Assert.Single(errors)
        Assert.Equal("GS9310", error.Id)
        Assert.Equal(source.IndexOf("Missing()", StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal("Missing()".Length, error.Location.Span.Length)
    }

    @Fact
    func InactiveAncestors_StillValidateIntrinsicDefinitionArguments() {
        const source = `@If(false) class Hidden { @DefineSymbol("") func F() Missing { return Missing() } }`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let error = Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS9309", error.Id)
        Assert.Equal(source.IndexOf(`""`, StringComparison.Ordinal), error.Location.Span.Start)
        Assert.Equal(2, error.Location.Span.Length)
    }

    @Fact
    func InactiveSource_RetainsParserDiagnostics() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(false) func F() { let broken = }`))
        Assert.NotEmpty(tree.Diagnostics)
        let compilation = Compilation(tree){IsLibrary = true}
        let diagnostics = compilation.GetDiagnostics()
        for error in tree.Diagnostics {
            Assert.Contains(
                diagnostics,
                (d Diagnostic) -> d.Id == error.Id && d.Location.Span.Equals(error.Location.Span)
            )
        }
    }

    @Fact
    func InactiveEmptyFile_ContributesNoImports() {
        const source = "import System.Text\n@file:If(false)"
        let inactive = SyntaxTree.Parse(SourceText.From(source))
        let active = SyntaxTree.Parse(SourceText.From(source.Replace("false", "true", StringComparison.Ordinal)))
        let absent = Compilation(inactive){IsLibrary = true}
        let present = Compilation(active){IsLibrary = true}
        Assert.Empty(absent.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Empty(present.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.DoesNotContain(
            absent.GlobalScope.Imports,
            (i ImportSymbol) -> object.ReferenceEquals(i.Declaration?.SyntaxTree, inactive)
        )
        Assert.Contains(
            present.GlobalScope.Imports,
            (i ImportSymbol) -> object.ReferenceEquals(i.Declaration?.SyntaxTree, active)
        )
    }

    @Fact
    func ChangingBaseSymbols_InvalidatesBoundSymbolsAndExistingSemanticModels() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(@defined("A")) func Selected() int32 -> 1
@If(!@defined("A")) func Selected() int32 -> 2`))
        let compilation = Compilation(tree){IsLibrary = true}
        let model = compilation.GetSemanticModel(tree)
        let declarations = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Null(model.GetDeclaredSymbol(declarations[0]))
        Assert.NotNull(model.GetDeclaredSymbol(declarations[1]))
        compilation.PreprocessorSymbols = ImmutableHashSet.Create("A")
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.NotNull(model.GetDeclaredSymbol(declarations[0]))
        Assert.Null(model.GetDeclaredSymbol(declarations[1]))
    }

    @Fact
    func InactiveSyntax_HasNoTypeOrReferencedSymbol() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(false) func Hidden() int32 -> Unknown()
func Active() bool -> @defined("A")`))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let inactive = tree.Root.DescendantNodesAndSelf().OfType[CallExpressionSyntax]().Single()
        Assert.Null(model.GetBoundNode(inactive))
        Assert.Null(model.GetTypeInfo(inactive).Type)
        let query = tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Single()
        Assert.Equal(TypeSymbol.Bool, model.GetTypeInfo(query).Type)
        Assert.False(cast[bool](cast[BoundLiteralExpression](model.GetBoundNode(query)).Value))
        Assert.Null(model.GetEnclosingSymbol(inactive.Span.Start))
        Assert.Empty(model.LookupSymbols(inactive.Span.Start))
    }

    @Fact
    func ActiveStructuralPredicate_QueryHasBooleanTypeWithoutOrdinaryBinding() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(!@defined("A")) func Read() {}`))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let query = tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Single()
        Assert.Null(model.GetBoundNode(query))
        Assert.Equal(TypeSymbol.Bool, model.GetTypeInfo(query).Type)
    }

    @Fact
    func InactiveSpanEnd_DoesNotExcludeAnAdjacentActiveDeclaration() {
        const source = `@If(false) class Hidden {}func Active() {}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let symbol = model.GetEnclosingSymbol(source.IndexOf("func Active", StringComparison.Ordinal))
        Assert.NotNull(symbol)
        Assert.Equal("Active", symbol!!.Name)
    }

    @Fact
    func InactiveBlock_QueryFallbacksDoNotReturnTheEnclosingFunctionContext() {
        const source = `func Read(s string) int32 { @If(false) { return 1 } return 2 }`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let inactive = source.IndexOf("1", StringComparison.Ordinal)
        let active = source.LastIndexOf("2", StringComparison.Ordinal)
        Assert.Null(model.GetExpectedType(inactive))
        Assert.Null(model.GetEnclosingSymbol(inactive))
        Assert.Empty(model.LookupSymbols(inactive))
        Assert.Empty(model.LookupMembers(inactive, TypeSymbol.String))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(active))
        Assert.Equal("Read", model.GetEnclosingSymbol(active)!!.Name)
    }

    @Fact
    func IncrementalInclusionEdit_RefreshesIteratorSignatureClassification() {
        const source = `func Read() int32 {
    @If(false) { yield 1 }
    return 2
}`
        let original = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(original){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let updated = SyntaxTree.Parse(SourceText.From(source.Replace("false", "true", StringComparison.Ordinal)))
        let successor = compilation.ReplaceSyntaxTree(original, updated)
        let full = Compilation(updated){IsLibrary = true}
        let incrementalErrors = successor.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        let fullErrors = full.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(fullErrors)
        Assert.Equal(
            fullErrors.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length)),
            incrementalErrors.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length))
        )
    }

    @Fact
    func SpeculativeExpression_UsesOriginalPositionAndRejectsInactiveContext() {
        const source = `@DefineSymbol("A") func Enabled() { let inside = 0 }
func Disabled() { let outside = 0 }
@If(false) func Hidden() { let inactive = 0 }`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let expression = SyntaxTree.ParseExpression(`() -> { @If(@defined("A")) { return 1 } }`)!!
        let enabled = model.GetSpeculativeTypeInfo(source.IndexOf("inside", StringComparison.Ordinal), expression)
        let disabled = model.GetSpeculativeTypeInfo(source.IndexOf("outside", StringComparison.Ordinal), expression)
        Assert.Equal(TypeSymbol.Int32, cast[FunctionTypeSymbol](enabled.Type).ReturnType)
        Assert.Equal(TypeSymbol.Void, cast[FunctionTypeSymbol](disabled.Type).ReturnType)
        Assert.Null(
            model.GetSpeculativeTypeInfo(
                source.IndexOf("inactive", StringComparison.Ordinal),
                SyntaxTree.ParseExpression("1")!!
            )
                .Type
        )
    }

    @Fact
    func ScriptPrefixReuse_PreservesScopedQueriesAndRejectsChangedBaseSymbols() {
        const source = `@file:DefineSymbol("FILE")
let root = @defined("BASE")
@UndefineSymbol("FILE") let suppressed = @defined("FILE")
@DefineSymbol("MEMBER")
func Read() bool {
    let localMember = @defined("MEMBER")
    let localBase = @defined("BASE")
    let localFile = @defined("FILE")
    return localMember && localBase && localFile
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "scoped-script.gs"))
        let compilation = Compilation(tree)
        let options = PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        let AssertQuery = func (result PrefixBindResult, name string, expected bool) {
            let declaration = result
                .SyntaxTree
                .Root
                .DescendantNodesAndSelf()
                .OfType[VariableDeclarationSyntax]()
                .Single((v VariableDeclarationSyntax) -> v.Identifier.ValueText == name)
            let query = declaration.DescendantNodes().OfType[DefinedExpressionSyntax]().Single()
            let bound = Assert.IsType[BoundLiteralExpression](
                result.Compilation.GetSemanticModel(result.SyntaxTree).GetBoundNode(query)
            )
            Assert.Equal(expected, cast[bool](bound.Value))
        }
        using let measurements = CompilationMeasurements.Start("test")
        let first = compilation.BindPrefix(tree, source.IndexOf("    let localBase", StringComparison.Ordinal), options)
        let second = compilation.BindPrefix(
            tree,
            source.IndexOf("    return", StringComparison.Ordinal),
            options,
            first
        )
        Assert.True(measurements.GetCounter("declarations.reuses") > 0)
        AssertQuery(second, "localMember", true)
        AssertQuery(second, "localBase", false)
        AssertQuery(second, "localFile", true)
        let root = second
            .SyntaxTree
            .Root
            .DescendantNodesAndSelf()
            .OfType[VariableDeclarationSyntax]()
            .Single((v VariableDeclarationSyntax) -> v.Identifier.ValueText == "root")
        let symbol = second.Compilation.GetSemanticModel(second.SyntaxTree).GetDeclaredSymbol(root)
        Assert.Same(second.SyntaxTree, Assert.IsAssignableFrom[Symbol](symbol).DeclaringSyntaxNodes.Single().SyntaxTree)
        let before = measurements.GetCounter("declarations.reuses")
        compilation.PreprocessorSymbols = ImmutableHashSet.Create("BASE")
        let changed = compilation.BindPrefix(
            tree,
            source.IndexOf("    return", StringComparison.Ordinal),
            options,
            second
        )
        Assert.Equal(before, measurements.GetCounter("declarations.reuses"))
        AssertQuery(changed, "root", true)
        AssertQuery(changed, "localMember", true)
        AssertQuery(changed, "localBase", true)
        AssertQuery(changed, "localFile", true)
    }

    @Fact
    func PrefixCut_PreservesInactiveContextAndOpenOwnerDefinitions() {
        const hidden = `func F() {
    @If(false) {
        let hidden = 0
/*CUT*/
    }
}`
        const active = `@DefineSymbol("A") func F() {
    let active = 0
/*CUT*/
}`
        const closed = `func F() { @If(false) {}/*CUT*/ }`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let hiddenCut = hidden.IndexOf("/*CUT*/", StringComparison.Ordinal)
            let hiddenTree = SyntaxTree.Parse(SourceText.From(hidden.Replace("/*CUT*/", string.Empty)))
            let hiddenPrefix = Compilation(hiddenTree){IsLibrary = true}.BindPrefix(
                hiddenTree,
                hiddenCut,
                PrefixBindOptions(remainder)
            )
            let hiddenModel = hiddenPrefix.Compilation.GetSemanticModel(hiddenPrefix.SyntaxTree)
            Assert.Null(hiddenModel.GetEnclosingSymbol(hiddenCut))
            Assert.Empty(hiddenModel.LookupSymbols(hiddenCut))
            Assert.Null(hiddenModel.GetSpeculativeTypeInfo(hiddenCut, SyntaxTree.ParseExpression("1")!!).Type)
            let activeCut = active.IndexOf("/*CUT*/", StringComparison.Ordinal)
            let activeTree = SyntaxTree.Parse(SourceText.From(active.Replace("/*CUT*/", string.Empty)))
            let activePrefix = Compilation(activeTree){IsLibrary = true}.BindPrefix(
                activeTree,
                activeCut,
                PrefixBindOptions(remainder)
            )
            let expression = SyntaxTree.ParseExpression(`() -> { @If(@defined("A")) { return 1 } }`)!!
            let type = activePrefix
                .Compilation
                .GetSemanticModel(activePrefix.SyntaxTree)
                .GetSpeculativeTypeInfo(activeCut, expression)
                .Type
            Assert.Equal(TypeSymbol.Int32, cast[FunctionTypeSymbol](type).ReturnType)
            let closedCut = closed.IndexOf("/*CUT*/", StringComparison.Ordinal)
            let closedTree = SyntaxTree.Parse(SourceText.From(closed.Replace("/*CUT*/", string.Empty)))
            let closedPrefix = Compilation(closedTree){IsLibrary = true}.BindPrefix(
                closedTree,
                closedCut,
                PrefixBindOptions(remainder)
            )
            Assert.Equal(
                "F",
                closedPrefix.Compilation.GetSemanticModel(closedPrefix.SyntaxTree).GetEnclosingSymbol(closedCut)!!.Name
            )
        }
    }

    @Fact
    func InactiveDocumentation_DoesNotReportUnknownOrFloatingTags() {
        const source = `/// @unknown ignored
@If(false) class Hidden {
    /// @unknown ignored
    func F() {}
    /// floating ignored

}
/// @unknown visible
func Active() {
    /// @unknown ignored local
    @If(false) let unavailable = Missing()
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        let diagnostics = compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0231").ToArray()
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal(source.IndexOf("/// @unknown visible", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0227")
    }

    @Fact
    func CompilationAnalyzer_ReportsOnlyActiveSourceLocations() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(false) func Hidden() int32 -> 1
func Active() int32 -> 2`))
        let compilation = Compilation(tree){IsLibrary = true}
        let diagnostics = GSharpAnalyzerDriver.Run(
            compilation,
            ImmutableArray.Create[GSharpDiagnosticAnalyzer](AllLiteralAnalyzer())
        )
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("TEST6231", diagnostic.Id)
        Assert.Equal(tree.Text.ToString().LastIndexOf("2", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    private class AllLiteralAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] ->
        ImmutableArray.Create(Issue6231ConditionalCompilationTests.Rule)

        override func Initialize(context AnalysisContext) {
            context.RegisterCompilationAction(
                (ctx CompilationAnalysisContext) -> {
                    for tree in ctx.Compilation.SyntaxTrees {
                        for literal in tree.Root.DescendantNodesAndSelf().OfType[LiteralExpressionSyntax]() {
                            ctx.ReportDiagnostic(
                                Diagnostic.Create(Issue6231ConditionalCompilationTests.Rule, literal.Location)
                            )
                        }
                    }
                }
            )
        }
    }

    shared {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
            "TEST6231",
            "Active source",
            "Literal.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
    }
}
