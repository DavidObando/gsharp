// <copyright file="Issue3340StaticPropertyAssignmentRewriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// PR #3340. `BoundPropertyAssignmentExpression.Receiver` is null for a
/// STATIC property assignment, and
/// `BoundTreeRewriter.RewritePropertyAssignmentExpression` reproduces that
/// null deliberately:
/// ```
/// var receiver = node.Receiver != null ? RewriteExpression(node.Receiver) : null;
/// ```
///
/// The ADR-0155 migration wrapped that value in `Invariant.Required` before
/// handing it to the constructor — whose `receiver` parameter is nullable
/// precisely to accept it. The early return one line below only covers the case
/// where the VALUE is unchanged too, so any lowering pass that rewrites the
/// right-hand side of a static property assignment hit GS9998. Assigning an
/// interpolated string is enough, because interpolation lowering rewrites the
/// value.
///
/// ADR-0154 witness: with the assertion restored this test reports GS9998 and
/// fails; the merge-base compiles the same source successfully. Verified by
/// building both.
open class Issue3340StaticPropertyAssignmentRewriteTests {
    @Fact
    func StaticPropertyAssignment_WithRewrittenValue_Compiles() {
        const source = `
package p
class Issue3340Holder {
    shared {
        prop Name string { get; set }
    }
}
func Issue3340Run(who string) {
    Issue3340Holder.Name = "hello ${who}"
}
func main() {
    Issue3340Run("world")
}
`
        // Evaluate() emits and runs. CompileDiagnostics() does NOT -- it only
        // collects binder diagnostics -- so it cannot observe a crash in a
        // lowering rewriter, which is where this defect lives. Verified: with
        // the assertion restored, this assertion fails and the
        // CompileDiagnostics form does not.
        let result = EmittedOracle.Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// The instance form, which has a real receiver and therefore never
    /// exercised the null path. It passed throughout and is kept as a control:
    /// if BOTH tests go red, the cause is property assignment generally rather
    /// than the static/null-receiver shape.
    @Fact
    func InstancePropertyAssignment_WithRewrittenValue_Compiles() {
        const source = `
package p
class Issue3340Box {
    prop Name string { get; set }
}
func Issue3340RunInstance(b Issue3340Box, who string) {
    b.Name = "hello ${who}"
}
func main() {
    Issue3340RunInstance(Issue3340Box{}, "world")
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }
}
