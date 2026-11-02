// <copyright file="Issue2943LoopBackEdgeNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

/// Issue #2943: writes that can reach a loop back-edge must invalidate
/// narrowing inherited from outside that loop.
open class Issue2943LoopBackEdgeNarrowingTests {
    @Theory
    @InlineData("while value is string text", "text")
    @InlineData("for value is string text", "text")
    @InlineData("for ; value is string text; count++", "text")
    @InlineData("while value is string", "value.Length")
    @InlineData("while !(value is not string text)", "text")
    @InlineData("again: while value is string text", "text")
    @InlineData("while let text = value as string", "text")
    @InlineData("do", "value")
    func RepeatedCondition_RebindsInheritedTypeNarrowing(header string, observed string) {
        // #4129: SatisfiesClassConstraint's repeated type test must inspect the
        // current storage, not cast it using the preceding if's stale narrowing.
        let source = (`import System

func Main() {
    var value object = "first"
    var count = 0
    if value is string {
        ` + "$header" + ` {
            Console.WriteLine(` + "$observed" + `)
            if count == 0 {
                value = "second"
            } else {
                value = 42
            }
            ` + "${(if header.StartsWith("for ;", StringComparison.Ordinal) { "" } else { "count++" })}" + `
        }` + "${(if header == "do" { " while value is string" } else { "" })}" + `
    }
    Console.WriteLine(count)
}`)
        let expected = if observed == "value.Length" {
            `5
6
2
`
        } else {
            `first
second
2
`
        }
        Assert.Equal(expected, CompileAndRun(source, "issue4129-condition"))
    }

    @Fact
    func RepeatedCondition_OutVariableIsDeclaredInTheReboundHeader() {
        const source = `import System

func Main() {
    var value object = "42"
    if value is string {
        while value is string text && int32.TryParse(text, out var number) {
            Console.WriteLine(number)
            value = 0
        }
    }
}`
        Assert.Equal("42\n", CompileAndRun(source, "issue4129-out-variable"))
    }

    @Theory
    @InlineData("while value.Length > 0", "")
    @InlineData("for ; value.Length > 0;", "")
    @InlineData("do", " while value.Length > 0")
    func RepeatedCondition_CannotDereferenceAnInvalidatedTypeNarrowing(header string, suffix string) {
        let source = (`func Main() {
    var value object = "first"
    if value is string {
        ` + "$header" + ` {
            value = 42
        }` + "$suffix" + `
    }
}`)
        let (exitCode, diagnostics) = CompileWithDriver(source, "issue4129-unsafe-condition")
        Assert.NotEqual(0, exitCode)
        Assert.Contains("Length", diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("initializer", "GS0159")
    @InlineData("for-clause", "GS0159")
    @InlineData("while", "GS0503")
    @InlineData("infinite", "GS0159")
    @InlineData("ellipsis", "GS0159")
    @InlineData("range", "GS0159")
    @InlineData("await-range", "GS0159")
    @InlineData("do-while", "GS0159")
    @InlineData("nested-loop", "GS0159")
    @InlineData("nested-if", "GS0159")
    @InlineData("continue", "GS0159")
    @InlineData("labeled-continue", "GS0159")
    @InlineData("post", "GS0159")
    @InlineData("before-use", "GS0159")
    @InlineData("member-call", "GS0159")
    @InlineData("implicit-field", "GS0159")
    @InlineData("closure", "GS0159")
    @InlineData("break-only", "GS0159")
    @InlineData("labeled-break", "GS0159")
    @InlineData("other-instance-field", "GS0159")
    func AssignmentReachingBackEdge_InvalidatesInheritedNarrowing(shape string, expectedDiagnostic string) {
        let compilation = Compile(BuildRejectedSource(shape))
        let errors = compilation.BoundProgram.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError).ToArray()
        Assert.Contains(errors, (diagnostic Diagnostic) -> diagnostic.Id == expectedDiagnostic)
    }

    @Theory
    @InlineData("function-literal")
    @InlineData("arrow-lambda")
    @InlineData("inline-argument")
    func ClosureWrite_InvalidatesNarrowingOutsideLoop(shape string) {
        let errors = Compile(BuildClosureWriteSource(shape))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Contains(errors, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Theory
    @InlineData("unchanged", `ok
ok
`)
    @InlineData("condition-renarrow", "ok\n")
    @InlineData("inner-renarrow", "ok\n")
    @InlineData("assignment-renarrow", `ok
ok
`)
    @InlineData("initializer-renarrow", "ok\n")
    @InlineData("literal-false-do-while", "ok\n")
    @InlineData("literal-false-while", "")
    @InlineData("shadowed-assignment", `ok
ok
`)
    @InlineData("post-condition-renarrow", "ok\n")
    @InlineData("type-test-condition", "5\n")
    func SafeNarrowing_RemainsAcceptedAndRuns(shape string, expectedOutput string) {
        Assert.Equal(expectedOutput, CompileAndRun(BuildAcceptedSource(shape), shape))
    }

    @Fact
    func NonNullAssignmentAfterUse_FromAConstruction_PreservesInheritedNarrowing() {
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}",
            CompileAndRun(NonNullAssignmentSource("c = C(33)", "function"), "non-null-after-use-constructor")
        )
    }

    // ADR-0213 row R7 (b), question 1: a variable or a call is no proof across the back edge, so the
    // fact is removed at the loop entry and `c.Print()` reports GS0159.
    @Theory
    @InlineData("local", "c = fresh")
    @InlineData("function", "c = Mk(33)")
    func NonNullAssignmentAfterUse_FromAVariableOrACall_IsRejected(shape string, secondIterationAssignment string) {
        let source = NonNullAssignmentSource(secondIterationAssignment, "function")
        let (exitCode, output) = CompileWithDriver(source, "non-null-after-use-rejected-$shape")
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0159", output, StringComparison.Ordinal)
    }

    // ADR-0208 R11 (#5170): a call may assign a top-level variable, so `c.Print()` cannot rely on
    // the guard of a top-level `c`.
    @Theory
    @InlineData("constructor", "c = C(33)")
    @InlineData("local", "c = fresh")
    @InlineData("function", "c = Mk(33)")
    func NonNullAssignmentAfterUse_OnTopLevelVariable_ReportsNullableReceiver(
        shape string,
        secondIterationAssignment string
    ) {
        let source = NonNullAssignmentSource(secondIterationAssignment, "top-level")
        let (exitCode, output) = CompileWithDriver(source, "non-null-after-use-top-level-$shape")
        Assert.NotEqual(0, exitCode)
        let marker = "c.Print()"
        let index = source.IndexOf(marker, StringComparison.Ordinal)
        let line = source.Substring(0, index).Count((character char) -> character == '\n') + 1
        let column = index - source.LastIndexOf('\n', index) + 2
        Assert.Contains("test.gs($line,$column,$line,${column + 7}): error GS0159", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("function")
    @InlineData("top-level")
    func OriginalAssignmentAfterUse_RemainsRejected($scope string) {
        const Declarations = `class C {
    func Print() { }
}`
        const Body = `var c C? = C()
if c != nil {
    for var i = 0; i < 2; i++ {
        c.Print()
        c = nil
    }
}`
        let source = if $scope == "top-level" {
            Declarations + Environment.NewLine + Body
        } else {
            Declarations + Environment.NewLine + (`func Main() {
` + "${Indent(Body)}" + `
}`)
        }
        let (exitCode, output) = CompileWithDriver(source, "original-rejected-$$scope")
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0159", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("straight-line")
    @InlineData("while")
    func TopLevelNullableReassignment_RemainsRejected(shape string) {
        let body = switch shape {
            case "straight-line": `var c C? = C()
if c != nil {
    c.Print()
}
c = nil
c.Print()`
            case "while": `var c C? = C()
if c != nil {
    var i = 0
    while i < 2 {
        c.Print()
        c = nil
        i++
    }
}`
            default: throw ArgumentOutOfRangeException("shape", shape, nil)
        }
        let source = `class C {
    func Print() { }
}` + Environment.NewLine + body
        let (exitCode, output) = CompileWithDriver(source, "top-level-rejected-$shape")
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0159", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("field")
    @InlineData("function")
    @InlineData("shadowed-constructor")
    @InlineData("out-alias")
    @InlineData("imported")
    @InlineData("parameter")
    func RuntimeNullableSource_DoesNotPreserveInheritedNarrowing(shape string) {
        let source = switch shape {
            case "field": `class C { func M() { } }
class Box { var Value C }
func Run() {
    let box = Box{}
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = box.Value
        }
    }
}`
            case "function": `class C { func M() { } }
class Box { var Value C }
func Bad() C { return Box{}.Value }
func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = Bad()
        }
    }
}`
            case "shadowed-constructor": `class C { func M() { } }
class Box { var Value C }
func C() C { return Box{}.Value }
func Mk() C { return C() }
func Run() {
    var c C? = C{}
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = Mk()
        }
    }
}`
            case "out-alias": `class C { func M() { } }
func Run(out c C?, ref alias C?) {
    c = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = C()
            alias = nil
        }
    }
}
var x C? = nil
Run(out x, ref x)`
            case "imported": `import System
func Run() {
    var value string? = "ok"
    if value != nil {
        for var i = 0; i < 2; i++ {
            let length = value.Length
            value = Console.ReadLine()
        }
    }
}`
            case "parameter": `class C { func M() { } }
class Box { var Value C }
func Run(value C) {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = value
        }
    }
}
Run(Box{}.Value)`
            default: throw ArgumentOutOfRangeException("shape", shape, nil)
        }
        Assert.Contains(Compile(source).BoundProgram.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func UnrelatedMemberInvalidation_DoesNotMaskNonNullLocalAssignment() {
        const Source = `import System

class C {
    let Value int32

    init(value int32) {
        Value = value
    }

    func Print() {
        Console.WriteLine(Value)
    }
}

class Box {
    var Value C?
}

func Main() {
    var c C? = C(11)
    let box = Box{}
    box.Value = C(99)
    if c != nil {
        if box.Value != nil {
            for var i = 0; i < 3; i++ {
                c.Print()
                if i == 0 {
                    c = C(22)
                }
                if i == 1 {
                    c = C(33)
                }
            }
        }
    }
}`
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}",
            CompileAndRun(Source, "non-null-with-member-invalidation")
        )
    }

    @Fact
    func NonNullAssignmentToDifferentSubtype_InvalidatesTypeNarrowing() {
        const Source = `open class Base {
}

class A : Base {
    func OnlyA() {
    }
}

class B : Base {
}

func Run() {
    var value Base? = A()
    if value is A {
        for var i = 0; i < 3; i++ {
            value.OnlyA()
            if i == 1 {
                value = B()
            }
        }
    }
}`
        let errors = Compile(Source)
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        let error = Assert.Single(errors)
        Assert.Equal("GS0159", error.Id)
    }

    @Fact
    func LoopBody_KeepsOneDiagnosticAndTheLabelState() {
        const Source = `class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            mutation: c = nil
            c.M()
        }
    }
}`
        let errors = Compile(Source)
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        let diagnostic = Assert.Single(errors)
        Assert.Equal("GS0159", diagnostic.Id)
    }

    @Fact
    func LoopBody_DoesNotDuplicateLambdaReturnDiagnostic() {
        const Source = `class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            let choose = func(flag bool) int32 {
                if flag {
                    return 1
                }
            }
            c.M()
            c = nil
        }
    }
}`
        let errors = Compile(Source)
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Single(errors, (diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
        Assert.Single(errors, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
    }

    @Fact
    func LoopBody_LeavesTheLoopStack() {
        const Source = `class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = nil
        }
    }
    break
}`
        let errors = Compile(Source)
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Contains(errors, (diagnostic Diagnostic) -> diagnostic.Id == "GS0120")
    }

    @Fact
    func LoopBody_DoesNotSkipALambdaOrdinal() {
        const Source = `import System

class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            let print = func() { Console.WriteLine(i) }
            print()
            if c != nil {
                c.M()
            }
            c = nil
        }
    }
}`
        let program = Compile(Source).BoundProgram
        let collector = FunctionLiteralNameCollector()
        for body in program.Functions.Values {
            collector.VisitStatement(body)
        }
        Assert.Contains("<lambda1>", collector.Names)
        Assert.DoesNotContain("<lambda2>", collector.Names)
    }

    @Fact
    func LoopBody_DoesNotDuplicateGotoHandlerDiagnostics() {
        const Source = `import System

class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            if i == 0 {
                goto handler
            }
            c.M()
            c = nil
            c.M()
        }
    }
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        handler:
        {
        }
    }
}`
        let errors = Compile(Source)
            .BoundProgram
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Single(errors, (diagnostic Diagnostic) -> diagnostic.Id == "GS0498")
        Assert.Equal(2, errors.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0159"))
    }

    private class FunctionLiteralNameCollector : BoundTreeWalker {
        init() {
            Names = List[string]()
        }

        /// Gets function-literal symbol names found in visited bodies.
        prop Names List[string] {
            get;
        }

        override func VisitExpression(node BoundExpression) {
            if node is BoundFunctionLiteralExpression literal {
                Names.Add(literal.Function.Name)
                if literal.Body != nil {
                    VisitStatement(literal.Body)
                }
                return
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func NonNullAssignmentSource(secondIterationAssignment string, $scope string) string {
            let declarations = `import System

class C {
    let Value int32

    init(value int32) {
        Value = value
    }

    func Print() {
        Console.WriteLine(Value)
    }
}

func Mk(value int32) C {
    return C(value)
}`
            let body = (`var c C? = C(11)
let fresh C = C(33)
if c != nil {
    for var i = 0; i < 3; i++ {
        c.Print()
        if i == 0 {
            c = C(22)
        }
        if i == 1 {
            ` + "$secondIterationAssignment" + `
        }
    }
}`)
            if $scope == "top-level" {
                return declarations + Environment.NewLine + body
            }
            return declarations + Environment.NewLine + (`
func Main() {
` + "${Indent(body)}" + `
}`)
        }

        private func Compile(source string) GsCompilation -> GsCompilation(GsSyntaxTree.Parse(SourceText.From(source)))

        private func Indent(source string) string -> string.Join(
            Environment.NewLine,
            source.Split(Environment.NewLine).Select((line string) -> "    " + line)
        )

        private func BuildRejectedSource(shape string) string {
            if shape == "other-instance-field" {
                return `import System
import System.Diagnostics.CodeAnalysis

class C {
    func M() {
        Console.WriteLine("ok")
    }
}

class Box {
    var _c C?

    @MemberNotNull("_c")
    func EnsureInit() {
        _c = C()
    }

    func Run(other Box) {
        this.EnsureInit()
        for var i = 0; i < 2; i++ {
            other._c = nil
            _c.M()
        }
    }
}

func Main() {
    Box{}.Run(Box{})
}`
            }
            if shape == "implicit-field" {
                return `import System.Diagnostics.CodeAnalysis

class C {
    func M() { }
}

class Box {
    var _c C?

    @MemberNotNull("_c")
    func EnsureInit() {
        _c = C()
    }

    func Run() {
        this.EnsureInit()
        for var i = 0; i < 2; i++ {
            _c.M()
            _c = nil
        }
    }
}`
            }
            if shape == "member-call" {
                return `open class Animal { }
class Dog : Animal {
    func Bark() { }
}
class Box {
    let Pet Animal
}

func Run(box Box) {
    if box.Pet is Dog {
        for var i = 0; i < 2; i++ {
            box.Pet.Bark()
        }
    }
}`
            }
            let loop = switch shape {
                case "initializer": `for c = nil; true; {
    c.M()
    break
}`
                case "for-clause": `for var i = 0; i < 2; i++ {
    c.M()
    c = nil
}`
                case "infinite": `for {
    c.M()
    c = nil
    continue
}`
                case "ellipsis": `for i in 0 ... 2 {
    c.M()
    c = nil
}`
                case "range": `for i in []int32{1, 2} {
    c.M()
    c = nil
}`
                case "await-range": `await for i in Numbers() {
    c.M()
    c = nil
}`
                case "do-while": `do {
    c.M()
    c = nil
} while true`
                case "nested-loop": `for var i = 0; i < 2; i++ {
    c.M()
    for var j = 0; j < 1; j++ {
        c = nil
    }
}`
                case "nested-if": `for var i = 0; i < 2; i++ {
    c.M()
    if i == 0 {
        c = nil
    }
}`
                case "continue": `for var i = 0; i < 2; i++ {
    c.M()
    c = nil
    continue
}`
                case "labeled-continue": `outer: for var i = 0; i < 2; i++ {
    c.M()
    for var j = 0; j < 1; j++ {
        c = nil
        continue outer
    }
}`
                case "post": `for var i = 0; i < 2; c = nil {
    c.M()
    i++
}`
                case "before-use": `for var i = 0; i < 2; i++ {
    c = nil
    c.M()
}`
                case "break-only": `for var i = 0; i < 2; i++ {
    c.M()
    c = nil
    break
}`
                case "labeled-break": `outer: for var i = 0; i < 2; i++ {
    c.M()
    for var j = 0; j < 1; j++ {
        c = nil
        break outer
    }
}`
                case "closure": `for var i = 0; i < 2; i++ {
    c.M()
    let clear = func() { c = nil }
    clear()
}`
                case "while": `var i = 0
while i < 2 {
    d(i)
    d = nil
    i++
}`
                default: throw ArgumentOutOfRangeException("shape", shape, nil)
            }
            if shape == "while" {
                return (`import System

func Run() {
    var d System.Action[int32]? = (value int32) -> Console.WriteLine(value)
    if d != nil {
        ` + "$loop" + `
    }
}`)
            }
            let asyncPrefix = if shape == "await-range" {
                `import System.Collections.Generic

async func Numbers() IAsyncEnumerable[int32] {
    yield 1
    yield 2
}
`
            } else {
                string.Empty
            }
            let functionKeyword = if shape == "await-range" {
                "async func"
            } else {
                "func"
            }
            return ("" + "$asyncPrefix" + `class C {
    func M() { }
}

` + "$functionKeyword" + ` Run() {
    var c C? = C()
    if c != nil {
        ` + "$loop" + `
    }
}`)
        }

        private func BuildClosureWriteSource(shape string) string {
            let closure = switch shape {
                case "function-literal": "let clear = func() { c = nil }\nclear()"
                case "arrow-lambda": "let clear Action = () -> c = nil\nclear()"
                case "inline-argument": "Apply(func() { c = nil })"
                default: throw ArgumentOutOfRangeException("shape", shape, nil)
            }
            return (`import System

class C {
    func M() { }
}

func Apply(action Action) {
    action()
}

func Run() {
    var c C? = C()
    if c != nil {
        ` + "$closure" + `
        c.M()
    }
}`)
        }

        private func BuildAcceptedSource(shape string) string {
            let loop = switch shape {
                case "unchanged": `for var i = 0; i < 2; i++ {
    c.M()
}`
                case "condition-renarrow": `while c != nil {
    c.M()
    c = nil
}`
                case "inner-renarrow": `for var i = 0; i < 2; i++ {
    if c != nil {
        c.M()
    }
    c = nil
}`
                case "assignment-renarrow": `for var i = 0; i < 2; i++ {
    c = C()
    c.M()
}`
                case "initializer-renarrow": `for c = C(); true; {
    c.M()
    break
}`
                case "literal-false-do-while": `do {
    c.M()
    c = nil
} while false`
                case "literal-false-while": `while false {
    c.M()
    c = nil
}`
                case "shadowed-assignment": `for var i = 0; i < 2; i++ {
    {
        var c C? = nil
        c = nil
    }
    c.M()
}`
                case "post-condition-renarrow": `for ; c != nil; c = nil {
    c.M()
}`
                case "type-test-condition": `while o is string {
    Console.WriteLine(o.Length)
    break
}`
                default: throw ArgumentOutOfRangeException("shape", shape, nil)
            }
            if shape == "type-test-condition" {
                return (`import System

func Main() {
    let o object = "hello"
    ` + "$loop" + `
}`)
            }
            return (`import System

class C {
    func M() {
        Console.WriteLine("ok")
    }
}

func Main() {
    var c C? = C()
    if c != nil {
        ` + "$loop" + `
    }
}`)
        }

        private func CompileAndRun(source string, caseName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue2943-artifacts",
                caseName + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    let exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                    Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                let assembly = EmittedFixture.Load(assemblyPath)
                let _ = assembly.GetTypes()
                let startInfo = ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                let (processExitCode, output, error) = IlVerifier.RunProcess(startInfo, assemblyPath, 30_000)
                Assert.True(processExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileWithDriver(source string, caseName string)(ExitCode int32, Output string) {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "issue2943-artifacts",
                caseName + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    let exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                    return (exitCode, stdout.ToString() + Environment.NewLine + stderr.ToString())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
