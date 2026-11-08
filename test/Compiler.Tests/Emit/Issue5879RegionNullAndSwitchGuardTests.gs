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
            for inLoop in[]bool{false, true} {
                for conversion in[]string{"cast[string](Chars)", "cast[object?](cast[string](Chars))"} {
                    yield []object{"null_chars_${inLoop}_${conversion}", NullChars(conversion, inLoop), true}
                }
            }
            yield []object{"null_chars_boxing", NullChars("cast[object?](Chars)", false, false), false}
            yield []object{"local_null_chars_boxing", NullChars("cast[object?](Chars)", true, false), false}
            yield []object{
                "boxed_null_chars_cast",
                NullChars("cast[string](cast[object?](Chars))", false, false),
                false
            }
            yield []object{"method_type_parameter_collision", GenericDefault(false), true}
            yield []object{"owner_type_parameter_collision", GenericDefault(true), true}
            yield []object{"unrelated_generic_default", GenericDefault(false, false), false}
            for source in[]string{
                "func Read() int32? { const N int32? = default(int32?) return N }\nfunc Probe() int32 { return if Read() == nil { 2 } else { -1 } }",
                "func Pass(value int32?) int32? -> value\nfunc Probe() int32 { const N int32? = default(int32?) return if Pass(N).HasValue { -1 } else { 2 } }",
                "func Probe() int32 { const N int32? = default(int32?) let boxed = cast[object?](N) return if boxed == nil { 2 } else { -1 } }",
                "func Probe() int32 { const N int32? = default(int32?) let read = () -> N return if read() == nil { 2 } else { -1 } }"
            } {
                yield []object{
                    "nullable_constant_" + source,
                    "import System\n" + source + "\nConsole.WriteLine(Probe())",
                    false
                }
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

        private func GenericDefault(inType bool, rejected bool = true) string {
            let source = NullChars(
                if rejected {
                    "default(T)"
                } else {
                    "default(C)"
                },
                false,
                rejected
            ).Replace("class C {}", "class C {}\nclass T {}")
            return if inType {
                source.Replace("func Read(", "class Container[T] { shared { func Read(").Replace(
                    "\nConsole.WriteLine(Read(nil",
                    "\n} }\nConsole.WriteLine(Container[int32].Read(nil"
                )
            } else {
                source.Replace("func Read(", "func Read[T](").Replace("Read(nil", "Read[int32](nil")
            }
        }

        private func NullChars(conversion string, inLoop bool, rejected bool = true) string {
            let declaration = if inLoop {
                "const Chars = EntryChars\n        "
            } else {
                "const Chars []?char = nil\n        "
            }
            return Loop(
                (
                    if inLoop {
                        declaration
                    } else {
                        ""
                    }
                ) +
                    "let matches = target is (" +
                    conversion +
                    ")",
                rejected
            )
                .Replace(
                "class C {}",
                "class C {}\nclass Matcher {\n    var Callback () -> void\n    override func Equals(other object?) bool { Callback() return false }\n    override func GetHashCode() int32 -> 0\n}"
            )
                .Replace(
                "    if text == nil",
                "    let target object = Matcher{Callback: clear}\n    " +
                    (
                    if inLoop {
                        "const EntryChars []?char = nil\n        "
                    } else {
                        declaration
                    }
                ) +
                    "if text == nil"
            )
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
