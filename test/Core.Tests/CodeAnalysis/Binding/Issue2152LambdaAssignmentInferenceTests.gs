// <copyright file="Issue2152LambdaAssignmentInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2152 — a block-body lambda whose trailing expression is an
/// assignment (e.g. `(x bool) -> { field = x }`) must infer a
/// `void` return type on the target-less inference path (overload
/// resolution), not the assigned value's type. In G#'s Kotlin-like
/// semantics an assignment yields Unit/void, so such a lambda matches an
/// `Action`-style `(bool) -> void` delegate parameter. Before the
/// fix the lambda was inferred as `(bool) -> bool`, producing spurious
/// GS0266 (ambiguous overloads) / GS0154 (parameter type mismatch). The
/// target-typed path (issue #889) was already correct; these tests pin the
/// target-less path and guard that value-producing bodies still infer their
/// real value type.
open class Issue2152LambdaAssignmentInferenceTests {
    @Fact
    func OverloadResolution_TrailingSimpleAssignment_InfersVoidAndResolvesVoidDelegate() {
        let source = `
package Test
class C {
    var inProgress bool
    func M() {
        let g = G((x bool) -> { inProgress = x })
    }
}
class G {
    init(b () -> void) {}
    init(c (bool) -> void) {}
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func OverloadResolution_TrailingCompoundAssignment_InfersVoid() {
        let source = `
package Test
class C {
    var count int32
    func M() {
        let g = G((x int32) -> { count += x })
    }
}
class G {
    init(b () -> void) {}
    init(c (int32) -> void) {}
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func OverloadResolution_TrailingFieldAssignment_DoesNotMatchFuncOverload() {
        // Only a value-returning overload would match if inference wrongly
        // produced (bool) -> bool. With the fix the lambda infers void, so the
        // (bool) -> void overload is selected and binding is clean.
        let source = `
package Test
class C {
    var inProgress bool
    func M() {
        let g = G((x bool) -> { inProgress = x })
    }
}
class G {
    init(c (bool) -> void) {}
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func OverloadResolution_ValueProducingTrailing_StillInfersValueType() {
        // Guard: a genuine value-producing trailing expression must keep its
        // value type so it resolves to the (int32) -> int32 overload.
        let source = `
package Test
class C {
    func M() {
        let g = G((x int32) -> { x + 1 })
    }
}
class G {
    init(c (int32) -> int32) {}
}
`
        AssertBindsWithoutErrors(source)
    }

    @Fact
    func OverloadResolution_ExplicitReturn_StillInfersReturnType() {
        // Guard: an explicit `return expr` continues to pin the value type.
        let source = `
package Test
class C {
    func M() {
        let g = G((x int32) -> { return x + 1 })
    }
}
class G {
    init(c (int32) -> int32) {}
}
`
        AssertBindsWithoutErrors(source)
    }

    shared {
        private func AssertBindsWithoutErrors(source string) {
            let paths = List[string]()
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if !string.IsNullOrEmpty(tpa) {
                for p in tpa.Split(Path.PathSeparator) {
                    if !string.IsNullOrWhiteSpace(p) && File.Exists(p) {
                        paths.Add(p)
                    }
                }
            }
            using let resolver = ReferenceResolver.WithReferences(paths)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = Binder.BindProgram(globalScope, resolver)
            let diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }
    }
}
