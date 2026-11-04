// <copyright file="BlockLambdaArrowTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.IO
import System.Reflection
import Xunit

/// Translator-fidelity tests (ADR-0128 / issue #1172, follow-up to #1160): now that
/// a block-bodied arrow lambda is a STATEMENT block with an optional trailing value
/// expression (full parity with func literals), a block-bodied C# lambda renders as
/// the idiomatic G# arrow form `(params) -> { … }` rather than the
/// function-literal form `func (params) RetType { … }` that #1160 emitted as a
/// workaround. The arrow lambda infers its return type, so no explicit return type
/// is emitted. C# local functions (not arrow lambdas) keep the func-literal form.
open class BlockLambdaArrowTranslationTests {
    @Fact
    func VoidBlockLambda_WithIfWithoutElse_RendersArrowBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public class C
    {
        public void F()
        {
            Action<int> g = d =>
            {
                if (d > 0)
                {
                    H(d);
                }

                H(d);
            };
            g(1);
        }

        private void H(int x)
        {
        }
    }
}`)
        Assert.Contains("(d int32) -> {", printed)
        Assert.DoesNotContain("func (d int32)", printed)
    }

    @Fact
    func ValueReturningBlockLambda_RendersArrowBlock_NoReturnType() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            Func<int, int> f = x =>
            {
                if (x > 0)
                {
                    return x + 1;
                }

                return 0;
            };
            return f(1);
        }
    }
}`)
        Assert.Contains("(x int32) -> {", printed)
        Assert.DoesNotContain("func (x int32)", printed)
    }

    @Fact
    func ExpressionBodiedLambda_StaysArrow() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            Func<int, int> f = x => x + 1;
            return f(1);
        }
    }
}`)
        Assert.Contains("(x int32) -> x + 1", printed)
        Assert.DoesNotContain("func (x int32)", printed)
    }

    @Fact
    func AsyncBlockLambda_RendersAsyncArrowBlock() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;
    using System.Threading.Tasks;

    public class C
    {
        public void F()
        {
            Func<int, Task<int>> f = async x =>
            {
                if (x > 0)
                {
                    return x + 1;
                }

                return 0;
            };
        }
    }
}`)
        Assert.Contains("async (x int32) -> {", printed)
        Assert.DoesNotContain("func (x int32)", printed)
    }

    @Fact
    func RecursiveLocalFunction_LiftsToMethod() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            int Fact(int n)
            {
                if (n <= 1)
                {
                    return 1;
                }

                return n * Fact(n - 1);
            }

            return Fact(5);
        }
    }
}`)
        // Issue #3501 A2: direct self-recursion stays as an in-place `let`
        // literal — gsc's self-reference support removed the lift.
        Assert.DoesNotContain("__local_F_Fact", printed)
        Assert.Contains("let Fact = func", printed)
        Assert.DoesNotContain("(n int32) -> {", printed)
    }

    @Fact
    func VoidStatementLambda_WithValueCapableTails_EmitsTrailingReturn_AndPreservesActionOverloadChoice() {
        const source = `
namespace Demo
{
    using System;
    using System.Collections.Generic;
    using System.Text;
    using System.Threading.Tasks;

    public sealed class Disposer : IDisposable
    {
        public void Dispose() { }
    }

    public static class Probe
    {
        private static event Action? Changed;
        private static void OnChanged() { }
        private static int Step(int x) => x + 1;
        private static Task BgWork() => Task.CompletedTask;
        private static string Pick(Action a) { a(); return "Action"; }
        private static string Pick<T>(Func<T> f) { f(); return "Func"; }
        private static string PickAsync(Func<Task> f) { f().GetAwaiter().GetResult(); return "FuncTask"; }
        private static string PickAsync<T>(Func<Task<T>> f) { f().GetAwaiter().GetResult(); return "FuncTaskT"; }

        public static string Run(object obj, bool flag)
        {
            var list = new List<int> { 1, 2 };
            var sb = new StringBuilder();
            int count = 0;

            var directCall = Pick(() => { Step(1); });
            var assignTail = Pick(() => { count = 10; });
            var eventSimpleAssign = Pick(() => { Changed = OnChanged; });
            var eventAddAssign = Pick(() => { Changed += OnChanged; });
            var incTail = Pick(() => { count++; });
            var nestedAssignTail = Pick(() =>
            {
                if (flag)
                {
                    count = 20;
                }
                else
                {
                    count++;
                }
            });
            var ifElseSameType = Pick(() =>
            {
                if (flag)
                {
                    Step(1);
                }
                else
                {
                    Step(2);
                }
            });
            var ifElseMixedTypes = Pick(() =>
            {
                if (flag)
                {
                    list.Remove(1);
                }
                else
                {
                    sb.Append('x');
                }
            });
            var ifLetChain = Pick(() =>
            {
                if (obj is string s)
                {
                    Step(s.Length);
                }
                else
                {
                    Step(0);
                }
            });
            var usingBlock = Pick(() =>
            {
                using (var d = new Disposer())
                {
                    Step(3);
                }
            });
            var asyncVoidTask = PickAsync(async () =>
            {
                await Task.Yield();
                Step(4);
            });
            var taskRun = Task.Run(() => { BgWork(); });
            taskRun.GetAwaiter().GetResult();
            bool isPlainTask = taskRun.GetType() == typeof(Task) || taskRun.GetType().BaseType == typeof(Task);

            return string.Join("|", directCall, assignTail, eventSimpleAssign, eventAddAssign, incTail, nestedAssignTail, count, ifElseSameType, ifElseMixedTypes, ifLetChain, usingBlock, asyncVoidTask, isPlainTask);
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let csharpImage = MemoryStream()
        Assert.True(project.Compilation.Emit(csharpImage).Success)
        let baseline = Assembly.Load(csharpImage.ToArray())
        let expected = baseline.GetType("Demo.Probe", throwOnError: true)!!.GetMethod("Run")!!.Invoke(
            nil,
            []object{"hello", true}
        )
        let printed = TranslateUnit(source)
        Assert.Contains("Step(1)\n            return", printed, StringComparison.Ordinal)
        Assert.Contains("count = 10\n            return", printed, StringComparison.Ordinal)
        Assert.Contains("Changed = OnChanged\n            return", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Changed += OnChanged\n            return", printed, StringComparison.Ordinal)
        Assert.Contains("count++\n            return", printed, StringComparison.Ordinal)
        using let gsharpImage = MemoryStream()
        let compilation = GSharpCompilation(GSharpSyntaxTree.Parse(SourceText.From(printed))){IsLibrary = true}
        let emit = compilation.Emit(gsharpImage, nil, nil, "Issue4977Translated")
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let migrated = Assembly.Load(gsharpImage.ToArray())
        let actual = migrated.GetType("Demo.Probe", throwOnError: true)!!.GetMethod("Run")!!.Invoke(
            nil,
            []object{"hello", true}
        )
        Assert.Equal(expected, actual)
        Assert.Equal("Action|Action|Action|Action|Action|Action|20|Action|Action|Action|Action|FuncTask|True", actual)
    }

    shared {
        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
