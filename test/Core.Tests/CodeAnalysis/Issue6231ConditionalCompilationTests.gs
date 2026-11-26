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
import System.Reflection
import System.Reflection.Emit
import System.Threading
import System.Text
import Xunit

class Issue6231ConditionalCompilationTests {
    @Theory
    @InlineData(`c.Log(value)`, false)
    @InlineData(`c.Log(value)`, true)
    @InlineData(`KeepFree(value)`, false)
    @InlineData(`KeepFree(value)`, true)
    @InlineData(`value.LogExtension(1)`, false)
    @InlineData(`value.LogExtension(1)`, true)
    @InlineData(`(1).LogExtension(value)`, false)
    @InlineData(`(1).LogExtension(value)`, true)
    @InlineData(`Calls.Keep[int32](value)`, false)
    @InlineData(`Calls.Keep[int32](value)`, true)
    @InlineData(`GenericCalls[int32].Keep(value)`, false)
    @InlineData(`GenericCalls[int32].Keep(value)`, true)
    @InlineData(`Calls.KeepPlain(value)`, false)
    @InlineData(`Calls.KeepPlain(value)`, true)
    @InlineData(`Debug.Assert(value > 0)`, false)
    @InlineData(`Debug.Assert(value > 0)`, true)
    @InlineData(`trace.TraceInformation(value.ToString())`, false)
    @InlineData(`trace.TraceInformation(value.ToString())`, true)
    func ConditionalOperands_KeepTheirActiveSemanticIndex(call string, enabled bool) {
        let tree = SyntaxTree.Parse(SourceText.From(SemanticOperandSource(call), "semantic-operands.gs"))
        let compilation = Compilation(tree){
            IsLibrary = true,
            PreprocessorSymbols = if enabled {
                ImmutableHashSet.Create("A", "DEBUG", "TRACE")
            } else {
                ImmutableHashSet[string].Empty
            }
        }
        AssertIndexedConditionalOperands(compilation, tree, enabled)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalOperandIndex_SurvivesBodyReuseAndPartialBinding(enabled bool) {
        let source = SemanticOperandSource(`c.Log(value)`)
        let tree = SyntaxTree.Parse(SourceText.From(source, "reused-semantic-operands.gs"))
        let compilation = Compilation(tree){
            IsLibrary = true,
            IncrementalBodyReuse = true,
            PreprocessorSymbols = if enabled {
                ImmutableHashSet.Create("A")
            } else {
                ImmutableHashSet[string].Empty
            }
        }
        AssertIndexedConditionalOperands(compilation, tree, enabled)
        let editedSource = source.Replace("c.Log(value)", "c.Log(value + 1)", StringComparison.Ordinal)
        let edited = SyntaxTree.Parse(SourceText.From(editedSource, "reused-semantic-operands.gs"))
        let successor = compilation.ReplaceSyntaxTree(tree, edited)
        AssertIndexedConditionalOperands(successor, edited, enabled)
        let prefix = successor.BindPrefix(
            edited,
            editedSource.IndexOf("    let after", StringComparison.Ordinal),
            PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        )
        AssertIndexedConditionalOperands(prefix.Compilation, prefix.SyntaxTree, enabled)
    }

    private func SemanticOperandSource(call string) string -> `import System.Diagnostics
class C { @Conditional("A") func Log(value int32) {} }
@Conditional("A") func KeepFree(value int32) {}
@Conditional("A") func (self int32) LogExtension(value int32) {}
class Calls { shared {
    @Conditional("A") func Keep[T](value T) {}
    @Conditional("A") func KeepPlain(value int32) {}
} }
class GenericCalls[T] { shared { @Conditional("A") func Keep(value T) {} } }
@If(false) func Hidden() { Missing(unbound) }
func Read(c C, value int32, trace TraceSource) {
    ` + call + `
    let after = 1
}`

    private func AssertIndexedConditionalOperands(compilation Compilation, tree SyntaxTree, enabled bool) {
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let model = compilation.GetSemanticModel(tree)
        let read = tree
            .Root
            .DescendantNodesAndSelf()
            .OfType[FunctionDeclarationSyntax]()
            .Single((function FunctionDeclarationSyntax) -> function.Identifier.Text == "Read")
        let names = read
            .DescendantNodesAndSelf()
            .OfType[NameExpressionSyntax]()
            .Where((name NameExpressionSyntax) -> name.IdentifierToken.Text is "c" or "value" or "trace")
            .ToArray()
        Assert.Contains(names, (name NameExpressionSyntax) -> name.IdentifierToken.Text == "value")
        for name in names {
            Assert.True(compilation.IsActive(name))
            let parameter = read.Parameters.Single(
                (p ParameterSyntax) -> p.Identifier?.Text == name.IdentifierToken.Text
            )
            let declared = Assert.IsAssignableFrom[VariableSymbol](model.GetDeclaredSymbol(parameter))
            Assert.NotEqual(TypeSymbol.Error, declared.Type)
            let bound = Assert.IsAssignableFrom[BoundExpression](model.GetBoundNode(name))
            Assert.Equal(declared.Type, bound.Type)
            Assert.Equal(declared.Type, model.GetTypeInfo(name).Type)
            Assert.Same(declared, model.GetSymbolInfo(name).Symbol)
            if name.IdentifierToken.Text == "value" {
                Assert.Equal(TypeSymbol.Int32, declared.Type)
                Assert.Equal(
                    TypeSymbol.Int32,
                    model.GetSpeculativeTypeInfo(name.Span.Start, SyntaxTree.ParseExpression("value")!!).Type
                )
            }
        }
        let call = read
            .DescendantNodesAndSelf()
            .OfType[CallExpressionSyntax]()
            .OrderBy((node CallExpressionSyntax) -> node.Span.Start)
            .First()
        let operation = Assert.IsAssignableFrom[BoundCallOperationExpression](model.GetBoundNode(call))
        Assert.Equal(!enabled, operation.IsElidedConditionalCall)
        let inactive = tree
            .Root
            .DescendantNodesAndSelf()
            .OfType[NameExpressionSyntax]()
            .Single((name NameExpressionSyntax) -> name.IdentifierToken.Text == "unbound")
        Assert.False(compilation.IsActive(inactive))
        Assert.Null(model.GetBoundNode(inactive))
        Assert.Null(model.GetTypeInfo(inactive).Type)
        Assert.Null(model.GetSymbolInfo(inactive).Symbol)
    }

    @Theory
    @InlineData(`Omit(other.Read())`, "Read", false)
    @InlineData(`Omit(other.Read())`, "Read", true)
    @InlineData(`other.Next().Keep(1)`, "Next", false)
    @InlineData(`other.Next().Keep(1)`, "Next", true)
    @InlineData(`other.Read().KeepExtension(1)`, "Read", false)
    @InlineData(`other.Read().KeepExtension(1)`, "Read", true)
    @InlineData(`(1).KeepExtension(other.Read())`, "Read", false)
    @InlineData(`(1).KeepExtension(other.Read())`, "Read", true)
    @InlineData(`Calls.Keep[int32](other.Read())`, "Read", false)
    @InlineData(`Calls.Keep[int32](other.Read())`, "Read", true)
    @InlineData(`GenericCalls[int32].Keep(other.Read())`, "Read", false)
    @InlineData(`GenericCalls[int32].Keep(other.Read())`, "Read", true)
    @InlineData(`Calls.KeepPlain(other.Read())`, "Read", false)
    @InlineData(`Calls.KeepPlain(other.Read())`, "Read", true)
    @InlineData(`KeepFree(other.Read())`, "Read", false)
    @InlineData(`KeepFree(other.Read())`, "Read", true)
    func OmittedCallOperands_StillValidateNestedProtectedReceivers(call string, member string, enabled bool) {
        let source = `import System.Diagnostics
open class Parent {
    protected func Read() int32 -> 1
    protected func Next() Parent -> Parent()
    @Conditional("A") func Keep(value int32) {}
}
@Conditional("A") func (self int32) KeepExtension(value int32) {}
@Conditional("A") func KeepFree(value int32) {}
class Calls { shared {
    @Conditional("A") func Keep[T](value T) {}
    @Conditional("A") func KeepPlain(value int32) {}
} }
class GenericCalls[T] { shared { @Conditional("A") func Keep(value T) {} } }
class Child : Parent {
    @Conditional("A") func Omit(value int32) {}
    func Bad(other Parent) { ` + call + ` }
}`
        let compilation = Compilation(SyntaxTree.Parse(source)){
            IsLibrary = true,
            PreprocessorSymbols = if enabled {
                ImmutableHashSet.Create("A")
            } else {
                ImmutableHashSet[string].Empty
            }
        }
        let diagnostic = Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0379", diagnostic.Id)
        Assert.Equal(source.LastIndexOf(member + "(", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(member.Length, diagnostic.Location.Span.Length)
    }

    @Theory
    @InlineData(64)
    @InlineData(512)
    func ConsecutiveDefinedStatements_ScanEachPredicateOnlyOnce(count int32) {
        let source = string.Join("\n", Enumerable.Repeat(`@defined("A")`, count))
        using let measurements = CompilationMeasurements.Start("test")
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(count, tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Count())
        Assert.InRange(measurements.GetCounter("parser.defined-lookahead.tokens"), int64(3 * count), int64(12 * count))
    }

    @Theory
    @InlineData(`@defined("ordinary") @Other class Marked {}`, 0)
    @InlineData(`@defined(("ordinary")) public open class Marked {}`, 0)
    @InlineData(`@defined("ordinary") @defined("second") func Marked() {}`, 0)
    @InlineData(`@defined("A(").ToString()`, 1)
    @InlineData(`func F() { @defined("A") @defined("B") && true return }`, 2)
    func DefinedLookahead_PreservesExpressionContinuationsAndOrdinaryAttributes(source string, queries int32) {
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(queries, tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Count())
    }

    @Theory
    @InlineData(`@If(ENABLED) prop Value int32 { get; }`, false)
    @InlineData(`@If(ENABLED) prop Value int32 { get; }`, true)
    @InlineData(`@If(ENABLED) event Changed () -> void`, false)
    @InlineData(`@If(ENABLED) event Changed () -> void`, true)
    @InlineData(`shared { @If(ENABLED) public var Saved int32 }`, false)
    @InlineData(`shared { @If(ENABLED) public var Saved int32 }`, true)
    func ProtocolShapeRestrictions_InspectOnlyActiveMembers(member string, enabled bool) {
        let source = "protocol P { " + member.Replace(
            "ENABLED",
            if enabled {
                "true"
            } else {
                "false"
            },
            StringComparison.Ordinal
        ) +
            " }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics.Where((d Diagnostic) -> d.IsError))
        let errors = Compilation(tree){IsLibrary = true}.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        if enabled {
            let diagnostic = Assert.Single(errors)
            Assert.Equal("GS0629", diagnostic.Id)
            Assert.Equal(9, diagnostic.Location.Span.Start)
            Assert.Equal(1, diagnostic.Location.Span.Length)
        } else {
            Assert.Empty(errors)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalProtectedCalls_AlwaysValidateTheReceiverAtTheMemberSpan(enabled bool) {
        const source = `import System.Diagnostics
open class Parent {
    @Conditional("A") protected func Ping(value int32) {}
}
class Child : Parent {
    func Bad(other Parent) { other.Ping(1) }
}`
        let compilation = Compilation(SyntaxTree.Parse(source)){
            IsLibrary = true,
            PreprocessorSymbols = if enabled {
                ImmutableHashSet.Create("A")
            } else {
                ImmutableHashSet[string].Empty
            }
        }
        let diagnostic = Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0379"))
        Assert.Equal(source.IndexOf("Ping(1)", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(4, diagnostic.Location.Span.Length)
    }

    @Theory
    @InlineData(`@DefineSymbol("") {}`)
    @InlineData(`@DefineSymbol(1) {}`)
    @InlineData(`@DefineSymbol("A") @UndefineSymbol("A") {}`)
    @InlineData(`@return:DefineSymbol("A") {}`)
    func BodyOnlyEdits_ValidateStructuralAnnotationsBeforeReusingDeclarations(annotation string) {
        const source = `func Read() int32 {
    @DefineSymbol("A") {}
    return 1
}`
        let original = SyntaxTree.Parse(SourceText.From(source, "structural-reuse.gs"))
        let compilation = Compilation(original){IsLibrary = true, IncrementalBodyReuse = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let previousScope = compilation.GlobalScope
        let edited = SyntaxTree.Parse(
            SourceText.From(
                source.Replace(`@DefineSymbol("A") {}`, annotation, StringComparison.Ordinal),
                "structural-reuse.gs"
            )
        )
        using let measurements = CompilationMeasurements.Start("test")
        let successor = compilation.ReplaceSyntaxTree(original, edited)
        let fresh = Compilation(edited){IsLibrary = true}
        let expected = fresh.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Contains(expected, (d Diagnostic) -> d.Id == "GS9309")
        let actual = successor.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.Equal(
            expected.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length)),
            actual.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length))
        )
        Assert.NotSame(previousScope, successor.GlobalScope)
        let prefix = successor.BindPrefix(
            edited,
            edited.Text.Length,
            PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        )
        Assert.Equal(
            expected.Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length)),
            prefix
                .Compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.IsError)
                .Select((d Diagnostic) -> (d.Id, d.Location.Span.Start, d.Location.Span.Length))
        )
        Assert.Equal(0, measurements.GetCounter("declarations.reuses"))
    }

    @Fact
    func ValidBodyOnlySymbolEdit_StillReusesDeclarationsAndRebindsItsEnvironment() {
        const source = `func Read() bool {
    @DefineSymbol("A") { return @defined("A") }
}`
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree){IsLibrary = true, IncrementalBodyReuse = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let previousScope = compilation.GlobalScope
        let edited = SyntaxTree.Parse(
            source.Replace(`@DefineSymbol("A")`, `@DefineSymbol("B")`, StringComparison.Ordinal)
        )
        using let measurements = CompilationMeasurements.Start("test")
        let successor = compilation.ReplaceSyntaxTree(tree, edited)
        Assert.Empty(successor.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Same(previousScope, successor.GlobalScope)
        Assert.Equal(1L, measurements.GetCounter("declarations.reuses"))
        let query = edited.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Single()
        let bound = Assert.IsType[BoundLiteralExpression](successor.GetSemanticModel(edited).GetBoundNode(query))
        Assert.False(cast[bool](bound.Value))
    }

    @Theory
    @InlineData(64)
    @InlineData(512)
    func AnnotatedSiblingLookups_ProbeLogarithmicallyRatherThanScanningTheFile(count int32) {
        let source = StringBuilder()
        for var i = 0; i < count; i++ {
            source
                .Append(`@DefineSymbol("A") func F`)
                .Append(i)
                .AppendLine(`() bool { @UndefineSymbol("A") { let hidden = @defined("A") } return @defined("A") }`)
        }
        let tree = SyntaxTree.Parse(source.ToString())
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let activity = compilation.ConditionalCompilation
        Assert.True(activity.IsActive(tree.Root))
        let members = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        using let measurements = CompilationMeasurements.Start("test")
        for member in members {
            let queries = member.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().ToArray()
            Assert.True(activity.IsActive(member))
            Assert.False(activity.SymbolsAt(tree, queries[0].Span.Start).Contains("A"))
            Assert.True(activity.SymbolsAt(queries[1]).Contains("A"))
        }
        let lookups = int64(3 * count)
        Assert.InRange(measurements.GetCounter("conditional.regions.probed"), lookups, lookups * 24)
    }

    @Fact
    func RegionIndex_MatchesOriginalContainmentAndBoundaryRules() {
        const source = `import System
@file:DefineSymbol("BASE")
@DefineSymbol("A") func First() bool {
    @UndefineSymbol("A") { let hidden = @defined("A") }
    return @defined("A")
}
@If(false) func Hidden() { Missing() }
@DefineSymbol("B") func Second() bool -> @defined("A")
`
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree){IsLibrary = true}
        let activity = compilation.ConditionalCompilation
        activity.IsActive(tree.Root)
        let flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public
        let treeMap = typeof(ConditionalCompilationMap).GetMethod("GetTree", flags)!!.Invoke(activity, []object{tree})!!
        let regions = cast[System.Collections.IEnumerable](
            treeMap.GetType().GetField("Regions", flags)!!.GetValue(treeMap)!!
        )
            .Cast[object]()
            .OrderBy((region object) -> cast[int32](region.GetType().GetProperty("Order", flags)!!.GetValue(region)!!))
            .Select(
            (region object) -> (
                Span: cast[TextSpan](region.GetType().GetProperty("Span", flags)!!.GetValue(region)!!),
                Symbols: cast[ImmutableHashSet[string]](
                    region.GetType().GetProperty("Symbols", flags)!!.GetValue(region)!!
                ),
                Active: cast[bool](region.GetType().GetProperty("Active", flags)!!.GetValue(region)!!),
                Open: cast[bool](region.GetType().GetProperty("OpenAtEnd", flags)!!.GetValue(region)!!),
                Order: cast[int32](region.GetType().GetProperty("Order", flags)!!.GetValue(region)!!)
            )
        )
            .ToArray()
        for var position = 0; position <= source.Length; position++ {
            let span = TextSpan(position, 0)
            var expected = regions[0]
            for region in regions {
                if region.Span.Start <= span.Start &&
                    (region.Span.End > span.Start || (region.Open && region.Span.End == span.Start)) &&
                    region.Span.Length <= expected.Span.Length {
                    expected = region
                }
            }
            Assert.Equal(expected.Active, activity.IsActiveAt(tree, position))
            Assert.True(expected.Symbols.SetEquals(activity.SymbolsAt(tree, position)))
        }
    }

    @Theory
    @InlineData(`class C { prop P int32 { @Missing get { return 1 } } }`, `@Missing`)
    @InlineData(`class C { prop P int32 { @Obsolete get { return 1 } } }`, `@Obsolete`)
    @InlineData(`class C { event Changed () -> void { @Missing add {} remove {} } }`, `@Missing`)
    @InlineData(`class C { event Changed () -> void { add {} @Obsolete remove {} } }`, `@Obsolete`)
    func ActiveAccessors_RejectOrdinaryAnnotationsInsteadOfDiscardingThem(source string, offending string) {
        let compilation = Compilation(SyntaxTree.Parse("import System\n" + source)){IsLibrary = true}
        let diagnostic = Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0206"))
        Assert.Equal(14 + source.IndexOf(offending, StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(offending.Length, diagnostic.Location.Span.Length)
    }

    @Fact
    func InactiveAccessorOwners_DoNotValidateOrdinaryAnnotations() {
        let compilation = Compilation(SyntaxTree.Parse(`@If(false) class Hidden {
    prop P int32 { @Missing get { return Missing() } }
    event Changed () -> void { @Missing add { Missing() } @Missing remove { Missing() } }
}`)){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Theory
    @InlineData(`if true @If(false) { Missing() }`)
    @InlineData(`if false {} else @If(false) { Missing() }`)
    @InlineData(`for false @If(false) { Missing() }`)
    @InlineData(`for var i = 0; i < 1; i++ @If(false) { Missing() }`)
    @InlineData(`for item in []int32{1} @If(false) { Missing() }`)
    @InlineData(`lock Object() @If(false) { Missing() }`)
    func InactiveRequiredBodies_BindAsEmptyWithoutBindingTheirContents(body string) {
        let tree = SyntaxTree.Parse("import System\nfunc F() { " + body + " }")
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let inactive = tree
            .Root
            .DescendantNodesAndSelf()
            .OfType[BlockStatementSyntax]()
            .Single((node BlockStatementSyntax) -> !compilation.IsActive(node))
        Assert.Null(compilation.GetSemanticModel(tree).GetTypeInfo(inactive).Type)
    }

    @Theory
    @InlineData(`func F() { @defined("A").ToString() }`, 1)
    @InlineData(`@defined("A").ToString()`, 1)
    @InlineData(`func F() { @defined("A") }`, 1)
    @InlineData(`@defined("A")`, 1)
    @InlineData(`func F() { @defined("A") && true }`, 1)
    @InlineData(`func F() { @defined("A") @defined("B").ToString() }`, 2)
    @InlineData(`@defined("A") @defined("B")`, 2)
    func IntrinsicLedStatements_ReachDedicatedExpressionParsing(source string, queries int32) {
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(queries, tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]().Count())
        let compilation = Compilation(tree){IsLibrary = !tree.Root.Members.OfType[GlobalStatementSyntax]().Any()}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func DefinedNamedAttributeChains_KeepTheirDeclarationOwner() {
        let tree = SyntaxTree.Parse(`@defined("ordinary") @defined("second") class Marked {}`)
        Assert.Empty(tree.Diagnostics)
        Assert.Empty(tree.Root.DescendantNodesAndSelf().OfType[DefinedExpressionSyntax]())
        Assert.Equal(2, Assert.Single(tree.Root.Members).Annotations.Length)
    }

    @Fact
    func ChangedBaseSymbols_CannotBeOverwrittenByADelayedInitialMapPublisher() {
        let tree = SyntaxTree.Parse(`@If(@defined("NEW")) func Selected() {}
@If(!@defined("NEW")) func Hidden() { Missing() }`)
        let compilation = Compilation(tree){IsLibrary = true}
        let stale = ConditionalCompilationMap(ImmutableHashSet[string].Empty)
        let field = typeof(Compilation).GetField(
            "conditionalCompilation",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!!
        let compareExchange = typeof(Interlocked)
            .GetMethods()
            .Single((method MethodInfo) -> method.Name == "CompareExchange" && method.IsGenericMethodDefinition)
            .MakeGenericMethod(typeof(ConditionalCompilationMap))
        let publication = DynamicMethod(
            "PublishDelayedConditionalMap",
            typeof(Void),
            []Type{typeof(Compilation), typeof(ConditionalCompilationMap)},
            typeof(Compilation),
            true
        )
        let il = publication.GetILGenerator()
        il.Emit(OpCodes.Ldarg_0)
        il.Emit(OpCodes.Ldflda, field)
        il.Emit(OpCodes.Ldarg_1)
        il.Emit(OpCodes.Ldnull)
        il.Emit(OpCodes.Call, compareExchange)
        il.Emit(OpCodes.Pop)
        il.Emit(OpCodes.Ret)

        // Replay the lazy initializer's CAS after a setter, without scheduler timing or a production hook.
        compilation.PreprocessorSymbols = ImmutableHashSet.Create("NEW")
        publication.Invoke(nil, []object{compilation, stale})
        Assert.True(compilation.IsActive(tree.Root.Members[0]))
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
    }

    @Theory
    @InlineData(false, 1)
    @InlineData(true, 3)
    func OrdinaryAttributes_DoNotCreateConditionalLookupRegions(conditional bool, expectedRegions int32) {
        let source = "import System\n" + string.Join(
            "\n",
            Enumerable.Range(0, 40).Select((i int32) -> "@Obsolete func F" + i.ToString() + "() {}")
        ) +
            if conditional {
            "\n@If(false) @Obsolete func Hidden() { Missing() }\n" +
                `@DefineSymbol("A") @Obsolete func Scoped() bool -> @defined("A")`
        } else {
            ""
        }
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let activity = compilation.ConditionalCompilation
        let treeMap = typeof(ConditionalCompilationMap).GetMethod(
            "GetTree",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!!.Invoke(activity, []object{tree})!!
        let regions = cast[System.Collections.ICollection](
            treeMap.GetType().GetField("Regions", BindingFlags.Instance | BindingFlags.NonPublic)!!.GetValue(treeMap)!!
        )
        Assert.Equal(expectedRegions, regions.Count)
    }

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
