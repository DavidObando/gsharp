// <copyright file="Issue4354StatedNullableCompoundReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Collections.Immutable
import Xunit

/// Issue #4354: a compound member assignment (`recv.Member op= value`)
/// through a receiver STATED as `T?` bound clean and failed at run time
/// with an unattributed `NullReferenceException`, while the plain write
/// and the read through the same receiver report GS0158. The compound binder
/// took the receiver's CLR type from `NullableTypeSymbol.ClrType`, which
/// relays to the underlying type, instead of the gate the plain paths use.
class Issue4354StatedNullableCompoundReceiverTests {
    /// Each stated-nullable receiver shape reports exactly the diagnostic the
    /// plain write through the same receiver reports.
    /// @param declarations Top-level declarations.
    /// @param body The body of the program.
    @Theory
    @InlineData("", "    let xs List[int32]? = nil\n    xs.Capacity += 1")
    @InlineData("func use(xs List[int32]?) { xs.Capacity += 1 }", "")
    @InlineData("func use(xs List[int32]?) { xs.Capacity -= 1 }", "")
    @InlineData(`class Holder {
    var xs List[int32]? = nil
    func Use() { this.xs.Capacity += 1 }
}`, "")
    @InlineData("", "    let e = Exception(\"m\")\n    e.InnerException.Source += \"x\"")
    @InlineData("func use(p Process?) { p.Exited += (s, e) -> { } }", "")
    func A_StatedNullableReceiver_CompoundWrite_Reports_GS0158(declarations string, body string) {
        let diagnostics = Compile(declarations, body)
        let report = Assert.Single(diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", report.Id)
        Assert.Contains("may be nil", report.Message)
    }

    /// The plain write through the same receiver reports the same code, so the
    /// compound form is consistent with it.
    @Fact
    func The_Plain_Write_Reports_The_Same_Diagnostic() {
        let diagnostics = Compile("func use(xs List[int32]?) { xs.Capacity = 1 }", string.Empty)
        let report = Assert.Single(diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", report.Id)
        Assert.Contains("may be nil", report.Message)
    }

    /// Issue #4366: a member read or write on a stated-nullable (`T?`)
    /// receiver whose underlying type has the member reports the
    /// receiver-may-be-nil GS0158 naming the remedies (`?.`, `!!`, `if let`,
    /// or a nil check), while a missing member on `T?` keeps `Cannot find member`.
    @Theory
    @InlineData(`class Node {
    var Next Node?
    var Name string = ""
}
func f(n Node) string { return n.Next.Name }`, "", "Cannot access member Name because receiver 'n.Next' may be nil.")
    @InlineData(`class Node {
    var Next Node?
    var Name string = ""
}
func f(n Node) { n.Next.Name = "x" }`, "", "Cannot access member Name because receiver 'n.Next' may be nil.")
    @InlineData(`class Node {
    var Name string = ""
}
func f(n Node?) { n.Name = "x" }`, "", "Cannot access member Name because receiver 'n' may be nil.")
    @InlineData(
        "",
        "    let e = Exception(\"m\")\n    Console.WriteLine(e.InnerException.Message)",
        "Cannot access member Message because receiver 'e.InnerException' may be nil."
    )
    @InlineData(
        "",
        "    let e = Exception(\"m\")\n    e.InnerException.Source = \"s\"",
        "Cannot access member Source because receiver 'e.InnerException' may be nil."
    )
    @InlineData(`class Node {
    var Next Node?
}
func f(n Node) int32 { return n.Next.Missing }`, "", "Cannot find member Missing.")
    func Issue4366_NilableReceiver_MemberAccess_ExplainsNilableReceiver_And_MissingMember_StaysCannotFind(
        declarations string,
        body string,
        expectedSubstring string
    ) {
        let diagnostics = Compile(declarations, body)
        let report = Assert.Single(diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0158", report.Id)
        Assert.Contains(expectedSubstring, report.Message)
    }

    /// The remedies the diagnostic points at, and every receiver that never
    /// was nilable, still compile and run.
    /// @param declarations Top-level declarations.
    /// @param body The body of the program.
    /// @param expected The expected program output.
    @Theory
    @InlineData(
        "func use(xs List[int32]?) int32 { xs!!.Capacity += 4\n    return xs!!.Capacity }",
        "    Console.WriteLine(use(List[int32](2)) >= 6)",
        "True"
    )
    @InlineData(`func use(xs List[int32]?) int32 { if let l = xs { l.Capacity += 4
        return l.Capacity }
    return -1 }`, "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")
    @InlineData(`func use(xs List[int32]?) int32 { if xs != nil { xs.Capacity += 4
        return xs.Capacity }
    return -1 }`, "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")
    @InlineData(
        "func use(xs List[int32]) int32 { xs.Capacity += 4\n    return xs.Capacity }",
        "    Console.WriteLine(use(List[int32](2)) >= 6)",
        "True"
    )
    @InlineData("", `    let sb = StringBuilder()
    sb.Length += 0
    Console.WriteLine(sb.Length)`, "0")
    func The_Remedies_And_NonNil_Receivers_Still_Compile_And_Run(declarations string, body string, expected string) {
        let result = EmittedOracle.Evaluate(Source(declarations, body))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(expected, result.Output.Trim())
    }

    shared {
        private func Source(declarations string, body string) string -> (`package P4354
import System
import System.Text
import System.Diagnostics
import System.Collections.Generic

` + "$declarations" + `

` + "${(if body.Trim().Length == 0 { "0" } else { body.Trim() })}")

        private func Compile(declarations string, body string) ImmutableArray[Diagnostic] -> EmittedOracle.Evaluate(
            Source(declarations, body)
        )
            .Diagnostics
    }
}
