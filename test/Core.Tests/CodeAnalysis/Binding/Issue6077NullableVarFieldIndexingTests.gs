// <copyright file="Issue6077NullableVarFieldIndexingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #6077: indexing/member-accessing a nullable `var` field after a nil
/// check must not produce a silent error-typed local (`?`) that crashes emit
/// in `SignatureEncoder`, and targetless method groups swallowed by `TypeSymbol.Error`
/// consumers must report `GS0582` instead of `GS9998`.
class Issue6077NullableVarFieldIndexingTests {
    @Fact
    func OriginalRepro_WithoutLinqImport_ReportsGS0158AtCountWithoutGS9998() {
        let source = `package R
import System.Collections.Generic
class Bag {
    private var items List[string]?
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return ""
    }
}`
        let errors = EmitErrors(source)
        Assert.NotEmpty(errors)
        Assert.Equal(2, errors.Length)
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS9998")
        Assert.All(
            errors,
            (d Diagnostic) -> {
                Assert.Equal("GS0158", d.Id)
                Assert.Equal("Count", d.Location.Text!!.ToString(d.Location.Span))
            }
        )
        Assert.Equal([]int32{6, 7}, errors.Select((d Diagnostic) -> d.Location.StartLine + 1).ToArray())
    }

    @Fact
    func OriginalRepro_WithLinqImport_ReportsGS0582AtCountWithoutGS9998() {
        let source = `package R
import System.Collections.Generic
import System.Linq
class Bag {
    private var items List[string]?
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return ""
    }
}`
        let errors = EmitErrors(source)
        Assert.NotEmpty(errors)
        Assert.Equal(2, errors.Length)
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS9998")
        Assert.All(
            errors,
            (d Diagnostic) -> {
                Assert.Equal("GS0582", d.Id)
                Assert.Equal("Count", d.Location.Text!!.ToString(d.Location.Span))
            }
        )
        Assert.Equal([]int32{7, 8}, errors.Select((d Diagnostic) -> d.Location.StartLine + 1).ToArray())
    }

    @Fact
    func MutableVarField_DirectIndexAfterNilCheck_StillReportsGS0116() {
        let source = `package R
import System.Collections.Generic
class Bag {
    private var items List[string]?
    func Top() string {
        if items != nil {
            return items[0]
        }
        return ""
    }
}`
        let diagnostic = Assert.Single(EmitErrors(source))
        Assert.Equal("GS0116", diagnostic.Id)
        Assert.Equal(7, diagnostic.Location.StartLine + 1)
    }

    @Fact
    func MutableVarField_LocalCopyAndImmutableLetField_CompileAndRunCleanly() {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic

class LetBag {
    private let items List[string]?
    init(items List[string]?) { this.items = items }
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return "empty"
    }
}

class VarBag {
    private var items List[string]?
    init(items List[string]?) { this.items = items }
    func Top() string {
        if let list = items {
            if list.Count > 0 {
                let top = list[list.Count - 1]
                return top
            }
        }
        return "empty"
    }
}

let a = LetBag(List[string]{"first", "last"}).Top()
let b = LetBag(nil).Top()
let c = VarBag(List[string]{"one", "two"}).Top()
let d = VarBag(nil).Top()
a + "|" + b + "|" + c + "|" + d`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("last|empty|two|empty", result.ValueText)
    }

    @Theory
    @InlineData("binary-clr-method-group", `package P
import System
class C {
    func F() int32 {
        let x = Console.WriteLine + 1
        return x
    }
}`, "WriteLine")
    @InlineData("binary-overloaded-user-method-group", `package P
class C {
    func Bar() int32 -> 1
    func Bar(n int32) int32 -> n
    func F() int32 {
        let x = Bar + 1
        return x
    }
}`, "Bar")
    @InlineData("unary-clr-method-group", `package P
import System
class C {
    func F() int32 {
        let x = -Console.WriteLine
        return x
    }
}`, "WriteLine")
    @InlineData("index-target-single", `package P
import System
class C {
    func F() {
        let x = Console.WriteLine[0]
    }
}`, "WriteLine")
    @InlineData("index-target-multi", `package P
import System
class C {
    func F() {
        let x = Console.WriteLine[0, 1]
    }
}`, "WriteLine")
    @InlineData("index-write-target", `package P
import System
class C {
    func F() {
        Console.WriteLine[0] = 1
    }
}`, "WriteLine")
    @InlineData("switch-expr-discriminant", `package P
import System
class C {
    func F() int32 {
        return switch Console.WriteLine { default: 0 }
    }
}`, "WriteLine")
    @InlineData("switch-stmt-discriminant", `package P
import System
class C {
    func F() {
        switch Console.WriteLine { default: {} }
    }
}`, "WriteLine")
    @InlineData("dereference-operand", `package P
import System
class C {
    unsafe func F() {
        let x = *Console.WriteLine
    }
}`, "WriteLine")
    @InlineData("channel-receive-operand", `package P
import System
class C {
    func F() {
        let x = <-Console.WriteLine
    }
}`, "WriteLine")
    @InlineData("null-conditional-index-arg", `package P
import System.Collections.Generic
import System.Linq
class C {
    private var items List[string]?
    func F() {
        let s = items?[items.Count]
    }
}`, "Count")
    func TargetlessMethodGroupInSwallowingContext_ReportsGS0582AtName(_ string, source string, expectedName string) {
        let errors = EmitErrors(source)
        let diagnostic = Assert.Single(errors)
        Assert.Equal("GS0582", diagnostic.Id)
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS9998")
        Assert.Equal(expectedName, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    shared {
        private func EmitErrors(source string)[]Diagnostic {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let output = MemoryStream()
            let emit = compilation.Emit(output)
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Concat(emit.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .Distinct()
                .ToArray()
        }
    }
}
