package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Linq
import Xunit

class Issue5858TupleReferenceTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalTupleProjection_UsesBothCallerRefScopes(viaAlias bool) {
        let body = if viaAlias {
            "var ref alias = (flag ? left : right).Text\nreturn ref alias"
        } else {
            "return ref (flag ? left : right).Text"
        }
        let source = "func Borrow(ref left (Text string, Code int32), ref right (Text string, Code int32), flag bool) ref string {\n" +
            body +
            "\n}"
        let compilation = Compilation(SyntaxTree.Parse(source))
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let unsafeSource = source.Replace("ref right", "scoped ref right", StringComparison.Ordinal)
        let rejected = Compilation(SyntaxTree.Parse(unsafeSource))
        let diagnostic = Assert.Single(rejected.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0254", diagnostic.Id)
        Assert.Contains("return ref", unsafeSource.Split('\n')[diagnostic.Location.StartLine])
    }

    @Theory
    @InlineData("(Text string, Code int32)", "(\"x\", 1)", "Text")
    @InlineData("(Inner (Text string, Code int32), Flag bool)", "((\"x\", 1), true)", "Inner.Text")
    func TupleElementAlias_SharesStorageWithItsAggregateRoot(type string, value string, member string) {
        let compilation = Compilation(
            SyntaxTree.Parse(
                "func Probe() {\nvar row " + type + " = " + value + "\nvar ref alias = row." + member + "\n}"
            )
        )
        let program = compilation.BoundProgram
        Assert.Empty(program.Diagnostics)
        let function = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Probe")
        let declarations = program.Functions[function].DescendantsAndSelf().OfType[BoundVariableDeclaration]().ToArray()
        let root = Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable.Name == "row").Variable
        let alias = Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable.Name == "alias").Variable
        Assert.True(StatementBinder.SharesStorage(root, alias))
    }

    @Fact
    func TupleElementAlias_RequiresAnAssignedOutParameterReceiver() {
        let compilation = Compilation(SyntaxTree.Parse(`func Bad(out row (Text string, Code int32)) {
    var ref alias = row.Text
    row = ("x", 1)
}`))
        let diagnostic = Assert.Single(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("GS0239", diagnostic.Id)
        Assert.Equal(2, diagnostic.Location.StartLine + 1)
    }

    @Theory
    @InlineData("local", "GS0254")
    @InlineData("value-parameter", "GS0254")
    @InlineData("scoped-parameter", "GS0254")
    @InlineData("local-alias", "GS0254")
    @InlineData("temporary", "GS0253")
    @InlineData("readonly", "GS9005")
    @InlineData("in-parameter", "GS9005")
    func TupleElement_RejectsUnsafeReferencesAtTheSource(shape string, diagnosticId string) {
        let valid = Compilation(
            SyntaxTree.Parse("func Borrow(ref row (Text string, Code int32)) ref string { return ref row.Text }")
        )
        Assert.Empty(valid.BoundProgram.Diagnostics)
        let source = switch shape {
            case "local": `func Borrow() ref string {
    var row (Text string, Code int32) = ("x", 1)
    return ref row.Text
}`
            case "value-parameter": `func Borrow(row (Text string, Code int32)) ref readonly string {
    return ref row.Text
}`
            case "scoped-parameter": `func Borrow(scoped ref row (Text string, Code int32)) ref string {
    return ref row.Text
}`
            case "local-alias": `func Borrow() ref string {
    var row (Text string, Code int32) = ("x", 1)
    var ref alias = row.Text
    return ref alias
}`
            case "temporary": `func Make() (Text string, Code int32) { return ("x", 1) }
func Borrow() ref string {
    return ref Make().Text
}`
            case "readonly": `func Read() {
    let row (Text string, Code int32) = ("x", 1)
    var ref alias = row.Text
}`
            default: `func Read(in row (Text string, Code int32)) {
    var ref alias = row.Text
}`
        }
        let compilation = Compilation(SyntaxTree.Parse(source))
        let diagnostics = compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal(diagnosticId, diagnostic.Id)
        let location = diagnostic.Location
        Assert.Contains(
            if shape == "local-alias" {
                "return ref alias"
            } else if shape == "readonly" || shape == "in-parameter" {
                "var ref alias"
            } else if shape == "temporary" {
                "return ref Make().Text"
            } else {
                "return ref row.Text"
            },
            source.Split('\n')[location.StartLine],
            StringComparison.Ordinal
        )
    }

    @Fact
    func TupleElementAlias_TracksItsRootWhenTheTupleIsOverwritten() {
        let result = EmittedOracle.Evaluate(`func Read() string {
    var row (Text string?, Code int32) = ("x", 1)
    var ref alias = row.Text
    if alias != nil {
        row = (nil, 2)
        return alias.Length.ToString()
    }
    return ""
}
Read()`)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal(6, diagnostic.Location.StartLine + 1)
    }

    @Theory
    @InlineData("(Text string?, Code int32)", "(\"x\", 1)", "Text", "row.Text = nil")
    @InlineData("(Text string?, Code int32)", "(\"x\", 1)", "Text", "row.Item1 = nil")
    @InlineData("(Text string?, Code int32)", "(\"x\", 1)", "Text", "row.0 = nil")
    @InlineData("(Text string?, Code int32)", "(\"x\", 1)", "Text", "row.Text, row.Code = nil, 2")
    @InlineData(
        "(Text string?, Code int32)",
        "(\"x\", 1)",
        "Text",
        "var step = true\nwhile step {\n    row.Text = nil\n    step = false\n}"
    )
    @InlineData(
        "(Inner (Text string?, Code int32), Flag bool)",
        "((\"x\", 1), true)",
        "Inner.Text",
        "row.Inner.Text = nil"
    )
    func TupleElementAlias_TracksItsRootWhenATupleMemberIsMutated(
        type string,
        value string,
        member string,
        mutation string
    ) {
        let source = "func Read() string {\n    var row " +
            type +
            " = " +
            value +
            "\n    var ref alias = row." +
            member +
            "\n    if alias != nil {\n        " +
            mutation +
            "\n        return alias.Length.ToString()\n    }\n    return \"\"\n}\nRead()"
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Contains(
            "return alias.Length",
            source.Split('\n')[diagnostic.Location.StartLine],
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData("let-local", "GS0127")
    @InlineData("in-parameter", "GS0127")
    @InlineData("ref-readonly-local", "GS0127")
    @InlineData("let-nested", "GS0127")
    @InlineData("let-compound", "GS0127")
    @InlineData("let-coalesce", "GS0127")
    @InlineData("temporary", "GS0499")
    @InlineData("temporary-increment", "GS0499")
    @InlineData("temporary-coalesce", "GS0499")
    @InlineData("narrowed-nullable", "GS0499")
    @InlineData("narrowed-boxed", "GS0499")
    @InlineData("unassigned-out", "GS0239")
    @InlineData("missing-member", "GS0158")
    func TupleElementAssignment_RejectsInvalidTargets(shape string, diagnosticId string) {
        let source = switch shape {
            case "let-local": `func Probe() {
    let row (Text string?, Code int32) = ("x", 1)
    row.Text = nil
}`
            case "in-parameter": `func Probe(in row (Text string?, Code int32)) {
    row.Text = nil
}`
            case "ref-readonly-local": `func Probe() {
    var stored (Text string?, Code int32) = ("x", 1)
    let ref readonly row = stored
    row.Text = nil
}`
            case "let-nested": `func Probe() {
    let outer (Inner (Text string?, Code int32), Flag bool) = (("x", 1), true)
    outer.Inner.Text = nil
}`
            case "let-compound": `func Probe() {
    let row (Text string?, Code int32) = ("x", 1)
    row.Code += 1
}`
            case "let-coalesce": `func Probe() {
    let row (Text string?, Code int32) = (nil, 1)
    row.Text ??= "y"
}`
            case "temporary": `func Make() (Text string?, Code int32) { return ("x", 1) }
func Probe() {
    Make().Text = nil
}`
            case "temporary-increment": `func Make() (Text string?, Code int32) { return ("x", 1) }
func Probe() {
    Make().Code++
}`
            case "temporary-coalesce": `func Make() (Text string?, Code int32) { return (nil, 1) }
func Probe() {
    Make().Text ??= "y"
}`
            case "narrowed-nullable": `func Probe() {
    var row (Text string?, Code int32)? = ("x", 1)
    if row != nil {
        row.Text = nil
    }
}`
            case "narrowed-boxed": `func Probe() {
    var boxed object = ("x", 1)
    if boxed is (string?, int32) {
        boxed.Item1 = nil
    }
}`
            case "unassigned-out": `func Probe(out row (Text string?, Code int32)) {
    row.Text = nil
    row = ("x", 1)
}`
            default: `func Probe() {
    var row (Text string?, Code int32) = ("x", 1)
    row.Missing = nil
}`
        }
        let compilation = Compilation(SyntaxTree.Parse(source))
        let diagnostic = Assert.Single(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(diagnosticId, diagnostic.Id)
    }
}
