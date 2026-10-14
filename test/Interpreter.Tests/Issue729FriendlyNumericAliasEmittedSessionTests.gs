// <copyright file="Issue729FriendlyNumericAliasEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #729: Emitted-session coverage for friendly numeric alias.
/// Traceability: ADR-0098.
open class Issue729FriendlyNumericAliasEmittedSessionTests {
    @Theory
    @MemberData("AliasCases")
    func Alias_AndCanonical_ProduceSameOutput(
        alias string,
        canonical string,
        aliasLiteral string,
        canonicalLiteral string
    ) {
        let aliasSource = (`
func pair(x ` + "$alias" + `, y ` + "$alias" + `) ` + "$alias" + ` { return x + y }
Console.WriteLine(pair(` + "$aliasLiteral" + `, ` + "$aliasLiteral" + `))
`)
        let canonicalSource = (`
func pair(x ` + "$canonical" + `, y ` + "$canonical" + `) ` + "$canonical" + ` { return x + y }
Console.WriteLine(pair(` + "$canonicalLiteral" + `, ` + "$canonicalLiteral" + `))
`)
        Assert.Equal(RunSubmission(canonicalSource), RunSubmission(aliasSource))
    }

    @Fact
    func Mixed_AliasAndCanonical_Interoperate() {
        // Sanity check that calling a canonically-typed function from an
        // alias-typed wrapper (and storing the result back into a
        // canonical-typed variable) works end-to-end through the REPL.
        const source = `
func sumCanonical(a int32, b int32) int32 { return a + b }
func sumAlias(a int, b int) int { return sumCanonical(a, b) }

let x int = sumCanonical(2, 3)
let y int32 = sumAlias(x, 4)
Console.WriteLine(y)
`
        Assert.Equal("9${Environment.NewLine}", RunSubmission(source))
    }

    shared {
        prop AliasCases IEnumerable[[]object] -> [][]object{
            []object{"int", "int32", "42", "42"},
            []object{"uint", "uint32", "uint32(42)", "uint32(42)"},
            []object{"long", "int64", "42L", "42L"},
            []object{"ulong", "uint64", "42UL", "42UL"},
            []object{"short", "int16", "int16(42)", "int16(42)"},
            []object{"ushort", "uint16", "uint16(42)", "uint16(42)"},
            []object{"byte", "uint8", "uint8(42)", "uint8(42)"},
            []object{"sbyte", "int8", "int8(42)", "int8(42)"},
            []object{"float", "float32", "1.5F", "1.5F"},
            []object{"double", "float64", "1.5", "1.5"}
        }

        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
