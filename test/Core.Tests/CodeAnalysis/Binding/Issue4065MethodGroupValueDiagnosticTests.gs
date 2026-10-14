// <copyright file="Issue4065MethodGroupValueDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4065: an unresolved method group used without a delegate target must
/// be rejected by binding rather than reaching emit as `GS9998`.
class Issue4065MethodGroupValueDiagnosticTests {
    @Theory
    @MemberData("InvalidValueContexts")
    func MethodGroupWithoutDelegateTarget_ReportsGS0582AtName(
        _ string,
        source string,
        methodGroupKind string,
        expectedNames[]string
    ) {
        let diagnostics = Errors(source)
        Assert.Equal(expectedNames.Length, diagnostics.Length)
        for (diagnostic, expectedName) in diagnostics.Zip(expectedNames) {
            Assert.Equal("GS0582", diagnostic.Id)
            Assert.Equal(
                "The $methodGroupKind '$expectedName' cannot be used as a value without a target delegate type. Invoke it with '(...)' or convert it to a delegate.",
                diagnostic.Message
            )
            Assert.Equal(expectedName, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        }
    }

    @Fact
    func IncompatibleDelegateTarget_StillReportsGS0218() {
        let diagnostic = Assert.Single(Errors(`package P
import System
import System.Collections.Generic

func Test() {
    let values = List[int32]()
    let bad Action[string] = values.Add
}`))
        Assert.Equal("GS0218", diagnostic.Id)
    }

    @Fact
    func InvalidDeclaredTarget_DoesNotCascadeGS0582() {
        let diagnostics = Errors(`package P
import System

func Test() {
    let value MissingType = Console.WriteLine
}`)
        Assert.Single(diagnostics)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0582")
    }

    @Fact
    func CallsAndDelegateTargets_StillBind() {
        Assert.Empty(Errors(`package P
import System
import System.Collections.Generic
import System.Linq

func Use(action Action[int32]) {
    action.Invoke(3)
}

func Pick(values List[int32]) Action[int32] {
    return values.Add
}

func Test() {
    let values = List[int32]()
    values.Add(1)
    Use(values.Add)
    let add Action[int32] = values.Add
    add.Invoke(4)
    let selected Action[int32] = true ? values.Add : values.Add
    selected.Invoke(5)

    let maybeValues List[int32]? = values
    let count Func[int32] = maybeValues.Count
    Console.WriteLine(maybeValues.Count())
    Console.WriteLine(count.Invoke())
    Pick(values).Invoke(6)

    let normalizer Func[string, string]? = nil
    let normalizeText = normalizer ?? Normalize
    Console.WriteLine(normalizeText.Invoke("ok"))
}

func Normalize(value string) string -> value`))
    }

    shared {
        func InvalidValueContexts() sequence[[]object] {
            yield Case("member-chain", `package P
import System.Collections.Generic

func Test() object {
    let values = List[int32]()
    return values.Add.ToString()
}`, "imported instance method group", "Add")
            yield Case("assignment", `package P
import System.Collections.Generic

func Test() {
    let values = List[int32]()
    var value object = values.Add
}`, "imported instance method group", "Add")
            yield Case("inference", `package P
import System.Collections.Generic

func Test() {
    let values = List[int32]()
    var value = values.Add
}`, "imported instance method group", "Add")
            yield Case("top-level-inference", `package P
import System.Collections.Generic

let values = List[int32]()
let value = values.Add`, "imported instance method group", "Add")
            yield Case("argument", `package P
import System.Collections.Generic

func Consume(value object) {}
func Test() {
    let values = List[int32]()
    Consume(values.Add)
}`, "imported instance method group", "Add")
            yield Case("user-argument", `package P

func Read() int32 -> 1
func Consume(value object) {}
func Test() {
    Consume(Read)
}`, "user method group", "Read")
            yield Case("interpolation", `package P
import System
import System.Collections.Generic

func Test() {
    let values = List[int32]()
    Console.WriteLine("value=${values.Add}")
}`, "imported instance method group", "Add")
            yield Case("return", `package P
import System.Collections.Generic

func Test() object {
    let values = List[int32]()
    return values.Add
}`, "imported instance method group", "Add")
            yield[]object{"conditional", `package P
import System.Collections.Generic

func Test() {
    let values = List[int32]()
    var value = true ? values.Add : values.Add
}`, "imported instance method group", []string{"Add", "Add"}}
            yield Case("imported-static", `package P
import System

func Test() object -> Console.WriteLine.ToString()`, "imported static method group", "WriteLine")
            yield Case("user-group", `package P
import System

func Convert(value string) int32 -> value.Length
func Convert(value int32) string -> value.ToString()
func Test() string -> "value=${Convert}"`, "user method group", "Convert")
            yield Case("user-instance", `package P

class Box {
    func Read() int32 -> 1
    func Read(value int32) int32 -> value
    func Test() object -> this.Read
}`, "user instance method group", "Read")
            yield Case("user-instance-single", `package P

class Box {
    func Read() int32 -> 1
    func Test() object -> this.Read
}`, "user instance method group", "Read")
            yield Case("user-static", `package P

class Box {
    shared {
        func Read() int32 -> 1
    }

    func Test() object -> Box.Read
}`, "user static method group", "Read")
            yield Case("user-extension", `package P

func (value string) Measure() int32 -> value.Length
func (value string) Measure(radix int32) int32 -> value.Length + radix
func Test() object -> "abc".Measure`, "user extension method group", "Measure")
            yield Case("nullable-receiver-extension", `package P
import System.Collections.Generic
import System.Linq

func Test() object {
    let values List[int32]? = List[int32]()
    return values.Count.ToString()
}`, "imported extension method group", "Count")
        }

        private func Case(
            name string,
            source string,
            methodGroupKind string,
            expectedNames ...string
        )[]object -> []object{name, source, methodGroupKind, expectedNames}

        private func Errors(source string)[]Diagnostic {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToArray()
        }
    }
}
