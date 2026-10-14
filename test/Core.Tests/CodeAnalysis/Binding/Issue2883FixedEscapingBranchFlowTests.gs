// <copyright file="Issue2883FixedEscapingBranchFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2883: definite-return analysis must see branches that escape a
/// structured `fixed` or `scope` body.
open class Issue2883FixedEscapingBranchFlowTests {
    @Fact
    func BreakOutOfFixed_ReportsGs0100() {
        const Source = `package Issue2883.Break

func F(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                break
            }
        }
    }
}`
        AssertGs0100(Source)
    }

    @Fact
    func BreakOutOfNestedFixed_ReportsGs0100() {
        const Source = `package Issue2883.NestedBreak

func F(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                fixed q *int32 = xs {
                    break
                }
            }
        }
    }
}`
        AssertGs0100(Source)
    }

    @Fact
    func LabeledBreakOutOfFixed_ReportsGs0100() {
        const Source = `package Issue2883.LabeledBreak

func F(xs []int32) int32 {
    unsafe {
        outer: for {
            for {
                fixed p *int32 = xs {
                    break outer
                }
            }
        }
    }
}`
        AssertGs0100(Source)
    }

    @Fact
    func GotoOutOfFixed_ReportsGs0100() {
        const Source = `package Issue2883.Goto

func F(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            goto done
        }
    }
    return 1
done:
    var reached = true
}`
        AssertGs0100(Source)
    }

    @Fact
    func ContinueOutOfFixed_PreservesInfiniteLoop() {
        const Source = `package Issue2883.Continue

func F(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                continue
            }
            break
        }
    }
}`
        AssertNoGs0100(Source)
    }

    @Fact
    func LabeledContinueOutOfFixed_PreservesInfiniteLoop() {
        const Source = `package Issue2883.LabeledContinue

func F(xs []int32) int32 {
    unsafe {
        outer: for {
            for {
                fixed p *int32 = xs {
                    continue outer
                }
                break outer
            }
        }
    }
}`
        AssertNoGs0100(Source)
    }

    @Fact
    func BreakOutOfScope_ReportsGs0100() {
        const Source = `package Issue2883.ScopeBreak

func F() int32 {
    for {
        scope {
            break
        }
    }
}`
        AssertGs0100(Source)
    }

    @Fact
    func GotoOutOfScope_ReportsGs0100() {
        const Source = `package Issue2883.ScopeGoto

func F() int32 {
    scope {
        goto done
    }
    return 1
done:
    var reached = true
}`
        AssertGs0100(Source)
    }

    shared {
        private func AssertGs0100(source string) {
            let diagnostics = Compile(source)
            let diagnostic = Assert.Single(diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
            Assert.Equal("GS0100", diagnostic.Id)
            Assert.Equal("F", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        }

        private func AssertNoGs0100(source string) {
            let diagnostics = Compile(source)
            Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        }

        private func Compile(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
