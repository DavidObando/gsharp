// <copyright file="Issue4287StatedNullableReceiverCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Immutable
import Xunit

/// Issue #4287: a call to an imported CLR instance method on a receiver
/// somebody STATED is `T?` must be narrowed, asserted or made
/// null-safe first. The call now reports GS0159, as a member read on the
/// same receiver has since #4390 and a call to a G#-declared method always
/// has.
///
/// The call path used to bind straight through: the receiver's
/// `ClrType` is the underlying type's, and the only
/// `NullableTypeSymbol` test on that path redirects a value-type
/// `Nullable<T>`. So `this.name.ToUpper()` on a
/// `string?` field compiled with no diagnostic and threw a bare
/// `NullReferenceException` — while `this.name.Length` reported.
class Issue4287StatedNullableReceiverCallTests {
    /// Every stated-nullable reference receiver shape the re-verification on
    /// the issue found binding without a check now reports GS0159.
    /// @param declarations Top-level declarations.
    /// @param body The body of `Main`.
    @Theory
    @InlineData(`class Holder {
    let name string? = nil
    func Use() string { return this.name.ToUpper() }
}`, "")
    @InlineData(`class Holder {
    var name string?
    func Use() string { return this.name.Trim() }
}`, "")
    @InlineData(`class Holder {
    prop Name string? { get; set }
    func Use() string { return this.Name.ToUpper() }
}`, "")
    @InlineData("func get() string? { return nil }", "    let s string? = get()\n    Console.WriteLine(s.ToUpper())")
    @InlineData("func use(s string?) string { return s.ToUpper() }", "")
    @InlineData("func use(u Uri?) string { return u.GetLeftPart(UriPartial.Path) }", "")
    @InlineData("func use(b StringBuilder?) { b.Append(\"x\") }", "")
    @InlineData("func use(l List[int32]?) { l.Add(1) }", "")
    @InlineData("func use(l List[int32]?) bool { return l.Contains(1) }", "")
    @InlineData("func use(s string?) bool { return s.StartsWith(\"a\") }", "")
    @InlineData("func use(o object?) string? { return o.ToString() }", "")
    @InlineData(`class MyError : Exception {
    init() : base("m") { }
}
func use(e MyError?) Exception { return e.GetBaseException() }`, "")
    @InlineData("func use[T class](x T?) string { return x.ToString() }", "")
    @InlineData("func use(d IDisposable?) string { return d.ToString() }", "")
    @InlineData("func use(d IDisposable?) int32 { return d.GetHashCode() }", "")
    @InlineData(`class Holder {
    var F Func[string] = func() string { return "f" }
}
func use(h Holder?) string { return h.F() }`, "")
    @InlineData("", "    Console.WriteLine(Path.GetDirectoryName(\"/\").ToUpper())")
    @InlineData("", "    Console.WriteLine(Environment.GetEnvironmentVariable(\"X_4287\").Trim())")
    @InlineData("", "    Console.WriteLine(Enumerable.FirstOrDefault(List[string]()).ToUpper())")
    func A_StatedNullableReceiver_Call_Reports_GS0159(declarations string, body string) {
        let diagnostics = Compile(declarations, body)
        let report = Assert.Single(diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0159", report.Id)
        Assert.Contains("may be nil", report.Message, StringComparison.Ordinal)
    }

    /// The controls. Everything the diagnostic tells the author to write
    /// compiles, and so does every nilable receiver that never reaches an
    /// imported instance method: a null-safe call, an assertion, a nil guard,
    /// `if let`, a value-type `Nullable<T>` (whose members
    /// live on `Nullable<T>` itself and are nil-safe), and an
    /// extension declared over the nilable type.
    /// @param declarations Top-level declarations.
    /// @param body The body of `Main`.
    /// @param expected The expected program output.
    @Theory
    @InlineData("func use(s string?) string? { return s?.ToUpper() }", "    Console.WriteLine(use(\"a\"))", "A")
    @InlineData("func use(s string?) string { return s!!.ToUpper() }", "    Console.WriteLine(use(\"a\"))", "A")
    @InlineData(
        "func use(s string?) string { if s != nil { return s.ToUpper() }\n    return \"-\" }",
        "    Console.WriteLine(use(nil))",
        "-"
    )
    @InlineData(
        "func use(s string?) string { if let t = s { return t.ToUpper() }\n    return \"-\" }",
        "    Console.WriteLine(use(\"b\"))",
        "B"
    )
    @InlineData("func use(n int32?) int32 { return n.GetValueOrDefault() }", "    Console.WriteLine(use(nil))", "0")
    @InlineData(
        "func (s string?) OrDash() string { return s ?? \"-\" }\nfunc use(s string?) string { return s.OrDash() }",
        "    Console.WriteLine(use(nil))",
        "-"
    )
    @InlineData(`class Holder {
    let name string? = "n"
    func Use() string { return this.name?.ToUpper() ?? "-" }
}`, "    Console.WriteLine(Holder().Use())", "N")
    @InlineData(`class Holder {
    let memo Dictionary[string, bool]? = Dictionary[string, bool]()
    func Use() bool { return memo != nil && memo.TryGetValue("k", out var c) }
}`, "    Console.WriteLine(Holder().Use())", "False")
    @InlineData(`class Holder {
    let memo Dictionary[string, bool]? = Dictionary[string, bool]()
    func Use() bool { return this.memo != nil && this.memo.TryGetValue("k", out var c) }
}`, "    Console.WriteLine(Holder().Use())", "False")
    @InlineData(`class Holder {
    let memo Dictionary[string, bool]? = nil
    func Use() int32 { if memo != nil { return memo.Count }
        return -1 }
}`, "    Console.WriteLine(Holder().Use())", "-1")
    @InlineData(
        "func use(l List[int32]?) bool { return l != nil && l.Contains(1) }",
        "    Console.WriteLine(use(List[int32]{1}))",
        "True"
    )
    func The_Remedies_And_NilSafe_Receivers_Still_Compile_And_Run(declarations string, body string, expected string) {
        let result = EmittedOracle.Evaluate(Source(declarations, body))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(expected, result.Output.Trim())
    }

    shared {
        private func Source(declarations string, body string) string -> (`package P4287
import System
import System.IO
import System.Linq
import System.Text
import System.Collections.Generic

` + "$declarations" + `

` + "${(if body.Trim().Length == 0 { "0" } else { body.Trim() })}")

        private func Compile(declarations string, body string) ImmutableArray[Diagnostic] -> EmittedOracle.Evaluate(
            Source(declarations, body)
        )
            .Diagnostics
    }
}
