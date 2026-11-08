// <copyright file="Issue5879RegionNullAndSwitchGuardTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System.Collections.Generic
import System.Linq
import System.Text.RegularExpressions
import Xunit

class Issue5879RegionNullAndSwitchGuardTests {
    @Theory
    @MemberData("Rows")
    func Driver_ValidatesRegionEffects(name string, source string, rejected bool) {
        var diagnostics = ""
        if rejected {
            let prefix = source.Substring(0, source.LastIndexOf("Length"))
            let lines = prefix.Split('\n')
            diagnostics = "GS0158@${lines.Length}:${lines[lines.Length - 1].Length + 1}"
        }
        Issue5470And5657RegionWalkerTests().EveryProbe_MatchesExpectedResult(
            Regex.Replace(
                name.Substring(
                    0,
                    if name.Length > 80 {
                        80
                    } else {
                        name.Length
                    }
                ),
                "[^a-zA-Z0-9]",
                "_"
            ),
            source,
            diagnostics,
            if rejected {
                "reject"
            } else {
                "run"
            },
            "2"
        )
    }

    shared {
        public func Rows() IEnumerable[[]object] {
            for body in[]string{
                "let matches = value is (cast[object?](nil))",
                "let matches = value is (cast[object?](cast[int32?](nil)))",
                "const Local C? = nil\n        let matches = value is (Local)",
                "const Local string? = nil\n        let matches = value is (Local)",
                "const First C? = default(C)\n        const Local = First\n        let matches = value is (Local)",
                "const First int32? = default(int32?)\n        const Local object? = cast[object?](First)\n        let matches = value is (Local)"
            } {
                let test = body.Substring(body.LastIndexOf("let matches = ") + "let matches = ".Length)
                yield []object{"null_" + body, Loop(body + "\n        if " + test + " { } else { return -1 }"), false}
            }
            yield []object{
                "nested_const",
                Loop(
                    "const Local C? = nil\n        for var j = 0; j < 1; j++ {\n            let matches = value is (Local)\n            if value is (Local) { } else { return -1 }\n        }"
                ),
                false
            }
            for body in[]string{
                "var Local C? = nil\n        Local = replacement\n        let matches = value is (Local)",
                "const First C? = nil\n        var Local = First\n        Local = replacement\n        let matches = value is (Local)",
                "let matches = value is (cast[object?](0))"
            } {
                yield []object{"effect_" + body, Loop(body, true), true}
            }
            yield []object{
                "cast_operand_effect",
                "import System\nfunc Pass(clear () -> void) object? { clear() return nil }\n" + Loop(
                    "let converted = cast[object?](Pass(clear))",
                    true
                ).Replace("import System\n", ""),
                true
            }
            yield []object{
                "user_conversion",
                "import System\nclass Source { var Callback () -> void }\nfunc operator explicit(src Source) int64 { src.Callback() return 1 }\n" +
                    Loop("let converted = cast[int64](src)", true).Replace(
                    "    if text == nil",
                    "    let src = Source{Callback: clear}\n    if text == nil"
                )
                    .Replace("import System\n", ""),
                true
            }
            for arms in[]string{
                "case _ when { action = mutate false } { action = noop noop() }",
                "case _ when { action = mutate false } { action = noop noop() }\n        case _ when { action() false } { }",
                "default { action() }\n        case _ when { action = mutate false } { action = noop noop() }"
            } {
                for inFinally in[]bool{false, true} {
                    if !inFinally && arms.Contains("\n") {
                        continue
                    }
                    var body = `let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = noop
        switch x { ARMS }
        action()`.Replace("ARMS", arms)
                    if !inFinally {
                        body = body.Replace("let noop = func() { }", "")
                    }
                    let region = if inFinally {
                        "try { goto Done }\n    finally {\n        " + body + "\n    }\nDone:"
                    } else {
                        body
                    }
                    let source = `import System
func Run(x int32NOOP) int32 {
    var text string? = nil
    text = "safe"
    REGION
    return text.Length
}
Console.WriteLine(Run(1ARGUMENT))
`.Replace(
                        "REGION",
                        region
                    ).Replace(
                        "NOOP",
                        if inFinally {
                            ""
                        } else {
                            ", noop () -> void"
                        }
                    ).Replace(
                        "ARGUMENT",
                        if inFinally {
                            ""
                        } else {
                            ", func() { }"
                        }
                    )
                    yield []object{"switch_${inFinally}_${arms}", source, true}
                    var safe = source.Replace("action = mutate", "action = noop").Replace("\"safe\"", "\"ok\"")
                    if inFinally {
                        safe = safe
                            .Replace("let noop = func() { }", "")
                            .Replace("func Run(x int32)", "func Run(x int32, noop () -> void)")
                            .Replace("Run(1)", "Run(1, func() { })")
                    }
                    yield []object{"safe_switch_${inFinally}_${arms}", safe, false}
                }
            }
        }

        private func Loop(body string, rejected bool = false) string -> `import System
class C {}
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
Console.WriteLine(Read(nilARGUMENT))
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
    }
}
