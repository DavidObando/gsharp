// <copyright file="Issue5879RegionNullAndSwitchGuardTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

class Issue5879RegionNullAndSwitchGuardTests {
    @Theory
    @MemberData("Rows")
    func RegionEffects_PreserveOnlySafeNarrowings(name string, source string, rejected bool) {
        let result = EmittedOracle.Evaluate(source)
        if rejected {
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.Equal("GS0158", diagnostic.Id)
            Assert.Equal(source.LastIndexOf("Length"), diagnostic.Location.Span.Start)
            Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        } else {
            Assert.Empty(result.Diagnostics)
            Assert.Equal("2", result.ValueText)
        }
    }

    shared {
        public func Rows() IEnumerable[[]object] {
            for pattern in[]string{
                "cast[object?](nil)",
                "cast[C?](nil)",
                "cast[int32?](nil)",
                "cast[object?](cast[string?](nil))",
                "cast[object?](default(int32?))",
                "default(C)",
                "default(string?)"
            } {
                yield []object{
                    pattern,
                    Loop(
                        "let matches = value is (" +
                            pattern +
                            ")\n        if value is (" +
                            pattern +
                            ") { } else { return -1 }"
                    ),
                    false
                }
            }
            for declaration in[]string{
                "const Local C? = nil",
                "const Local string? = nil",
                "const Local C? = default(C)",
                "const Local int32? = default(int32?)",
                "const Local object? = cast[object?](nil)",
                "const First C? = nil\n        const Local = First",
                "const First C? = nil\n        const Local C? = cast[C?](First)",
                "const Local C? = default"
            } {
                yield []object{
                    declaration,
                    Loop(
                        declaration +
                            "\n        let matches = value is (Local)\n        if value is (Local) { } else { return -1 }"
                    ),
                    false
                }
            }
            yield []object{
                "nested_const",
                Loop(
                    "const Local C? = nil\n        for var j = 0; j < 1; j++ {\n            let matches = value is (Local)\n            if value is (Local) { } else { return -1 }\n        }"
                ),
                false
            }
            for declaration in[]string{
                "var Local C? = nil\n        Local = replacement",
                "const First C? = nil\n        var Local = First\n        Local = replacement",
                "let Local C? = nil"
            } {
                yield []object{declaration, Loop(declaration + "\n        let matches = value is (Local)", true), true}
            }
            yield []object{
                "cast_operand_effect",
                "func Pass(clear () -> void) object? { clear() return nil }\n" +
                    Loop("let converted = cast[object?](Pass(clear))", true),
                true
            }
            yield []object{"boxed_zero_is_not_null", Loop("let matches = value is (cast[object?](0))", true), true}
            yield []object{
                "user_defined_explicit_cast",
                "class Source { var Callback () -> void }\nfunc operator explicit(src Source) int64 { src.Callback() return 1 }\n" +
                    Loop("let converted = cast[int64](src)", true).Replace(
                    "    if text == nil",
                    "    let src = Source{Callback: clear}\n    if text == nil"
                ),
                true
            }
            for arms in[]string{
                "case _ when { action = mutate false } { action = noop noop() }",
                "case _ when { action = mutate false } { action = noop noop() }\n        case _ when { action() false } { }",
                "default { action() }\n        case _ when { action = mutate false } { action = noop noop() }"
            } {
                yield []object{"finally_" + arms, Switch(arms, true), true}
                yield []object{"straight_" + arms, Switch(arms, false), true}
                yield []object{
                    "safe_finally_" + arms,
                    Switch(arms.Replace("action = mutate", "action = noop"), true, true).Replace("\"safe\"", "\"ok\""),
                    false
                }
                if !arms.Contains("\n") {
                    yield []object{
                        "safe_straight_" + arms,
                        Switch(arms.Replace("action = mutate", "action = noop"), false).Replace("\"safe\"", "\"ok\""),
                        false
                    }
                }
            }
        }

        private func Loop(body string, rejected bool = false) string -> `class C {}
func Read(value object?PARAMETER) int32 {
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text == nil { return 0 }
    for var i = 0; i < COUNT; i++ {
        READ
        BODY
        RETURN
    }
    return 0
}
Read(nilARGUMENT)
`.Replace(
            "READ",
            if rejected {
                "let length = text.Length"
            } else {
                ""
            }
        ).Replace(
            "BODY",
            body
        ).Replace(
            "PARAMETER",
            if rejected {
                ", replacement C"
            } else {
                ""
            }
        ).Replace(
            "ARGUMENT",
            if rejected {
                ", C()"
            } else {
                ""
            }
        ).Replace(
            "COUNT",
            if rejected {
                "2"
            } else {
                "1"
            }
        ).Replace(
            "RETURN",
            if rejected {
                "if i == 1 { return length }"
            } else {
                "return text.Length"
            }
        )

        private func Switch(arms string, inFinally bool, externalNoop bool = false) string {
            let useExternal = externalNoop || !inFinally
            var body = `let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = noop
        switch x { ARMS }
        action()`.Replace("ARMS", arms)
            if useExternal {
                body = body.Replace("let noop = func() { }", "")
            }
            let region = if inFinally {
                "try { goto Done }\n    finally {\n        " + body + "\n    }\nDone:"
            } else {
                body
            }
            return `func Run(x int32NOOP) int32 {
    var text string? = nil
    text = "safe"
    REGION
    return text.Length
}
Run(1ARGUMENT)
`.Replace(
                "REGION",
                region
            ).Replace(
                "NOOP",
                if useExternal {
                    ", noop () -> void"
                } else {
                    ""
                }
            ).Replace(
                "ARGUMENT",
                if useExternal {
                    ", func() { }"
                } else {
                    ""
                }
            )
        }
    }
}
