// <copyright file="Issue4212NamedFunctionInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

open class Issue4212NamedFunctionInvocationTests {
    @Theory
    @InlineData("d(c: 7)", "127")
    @InlineData("d.Invoke(c: 7)", "127")
    @InlineData("d(a: 9, c: 7)", "927")
    @InlineData("d(c: 7, b: 8, a: 9)", "987")
    @InlineData("d(a: 9, b: 8, c: 7)", "987")
    @InlineData("d(9, c: 7, b: 8)", "987")
    @InlineData("d()", "123")
    @InlineData("d(9, 8, 7)", "987")
    func Delegate_ArgumentsBindByOrdinal(call string, expected string) {
        let printed = Verify((`namespace Demo
{
    public delegate int D(int a = 1, int b = 2, int c = 3);
    public class C
    {
        public void Run()
        {
            D d = (a, b, c) => a * 100 + b * 10 + c;
            System.Console.WriteLine(` + "$call" + `);
        }
    }
}`), expected)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("c:", printed, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("Add(c: 7, b: 8, a: 9)", "987")
    @InlineData("Add(a: 9, b: 8, c: 7)", "987")
    @InlineData("Add(9, c: 7, b: 8)", "987")
    @InlineData("Add(9, 8, 7)", "987")
    func ClaimedLocalFunction_FullArityWithoutDefaults(call string, expected string) {
        let printed = Verify((`namespace Demo
{
    public class C
    {
        public void Run()
        {
            int Add(int a, int b, int c)
            {
                return a > 100 ? Partner(a - 1) : a * 100 + b * 10 + c;
            }
            int Partner(int n) { return Add(n, 2, 3); }
            System.Console.WriteLine(` + "$call" + `);
        }
    }
}`), expected)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("Add!!(9, 8, 7)", printed, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PermutedArguments_SnapshotReadsAndEvaluateOnce(claimed bool) {
        let declaration = if claimed {
            `int Add(int a = 1, int b = 2, int c = 3)
{
    return a > 100 ? Partner(a - 1) : a * 100 + b * 10 + c;
}
int Partner(int n) { return Add(n); }`
        } else {
            "D Add = (a, b, c) => a * 100 + b * 10 + c;"
        }
        let printed = Verify((`namespace Demo
{
    public delegate int D(int a = 1, int b = 2, int c = 3);
    public class C
    {
        public void Run()
        {
            int x = 5;
            int order = 0;
            int Next(int digit) { order = order * 10 + digit; x = 99; return digit; }
            ` + "$declaration" + `
            int result = Add(c: x, b: Next(8), a: Next(9));
            System.Console.WriteLine(result + ":" + order);
        }
    }
}`), "985:89")
        Assert.Contains("= x", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("c:", printed, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("d")
    @InlineData("d.Invoke")
    @InlineData("Get()")
    @InlineData("Get().Invoke")
    func Delegate_ReceiverCapturedBeforeArguments(target string) {
        Verify((`namespace Demo
{
    public delegate int D(int a = 1, int b = 2, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            D d = (a, b, unused) => a * 10 + b;
            D Get() { order = order * 10 + 1; return d; }
            int Next(int digit)
            {
                order = order * 10 + digit;
                d = (a, b, unused) => 999;
                return digit;
            }
            int result = ` + "$target" + `(b: Next(2), a: Next(3));
            System.Console.WriteLine(result + ":" + order);
        }
    }
}`), if target.StartsWith(
                "Get",
                StringComparison.Ordinal
            ) {
                "32:123"
            } else {
                "32:23"
            })
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PermutedArguments_StayAtInvocationEvaluationPoint(claimed bool) {
        let declaration = if claimed {
            `int Add(int a, int b)
{
    return a > 100 ? Partner(a - 1) : a * 10 + b;
}
int Partner(int n) { return Add(n, 2); }`
        } else {
            "D Add = (a, b, unused) => a * 10 + b;"
        }
        Verify((`namespace Demo
{
    public delegate int D(int a, int b, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int Next(int digit) { order = order * 10 + digit; return digit; }
            ` + "$declaration" + `
            int sum = Next(1) + Add(b: Next(2), a: Next(3));
            bool skip = false;
            bool ignored = skip && Add(b: Next(4), a: Next(5)) > 0;
            int iteration = 0;
            while (iteration < 2 && Add(b: Next(6), a: Next(7)) > 0) { iteration++; }
            System.Console.WriteLine(sum + ":" + order + ":" + iteration + ":" + ignored);
        }
    }
}`), "33:1236767:2:False")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalDelegate_ArgumentsRunOnlyForNonNullReceiver(returnsVoid bool) {
        let resultType = if returnsVoid {
            "void"
        } else {
            "int"
        }
        let body = if returnsVoid {
            "{ total = a * 10 + b; }"
        } else {
            "{ total = a * 10 + b; return total; }"
        }
        Verify((`#nullable enable
namespace Demo
{
    public delegate ` + "$resultType" + ` D(int a = 1, int b = 2, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int total = 0;
            D? d = null;
            int Next(int digit) { order = order * 10 + digit; d = null; return digit; }
            d?.Invoke(b: Next(8), a: Next(9));
            d = (a, b, unused) => ` + "$body" + `;
            d?.Invoke(b: Next(2), a: Next(3));
            System.Console.WriteLine(total + ":" + order);
        }
    }
}`), "32:23")
    }

    @Theory
    @InlineData("ref", "cell = a + bonus;", "105")
    @InlineData("out", "cell = a + bonus;", "105")
    @InlineData("in", "observed = a + cell + bonus;", "115")
    func Delegate_RefKindArgumentCapturesAddressInSourceOrder(refKind string, body string, expected string) {
        Verify((`namespace Demo
{
    public delegate void D(int a, ` + "$refKind" + ` int cell, int bonus = 100);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int observed = 0;
            int[] slots = new int[2];
            int[] original = slots;
            int Idx() { order = order * 10 + 1; return 1; }
            int Val()
            {
                order = order * 10 + 2;
                original[1] = 10;
                slots = new int[2];
                return 5;
            }
            D d = (int a, ` + "$refKind" + ` int cell, int bonus) => { ` + "$body" + ` };
            d(cell: ` + "$refKind" + ` slots[Idx()], a: Val());
            System.Console.WriteLine(
                ` + "${(if refKind == "in" { "observed" } else { "original[1]" })}" + ` + ":" + slots[1] + ":" + order);
        }
    }
}`), expected + ":0:12")
    }

    @Fact
    func Delegate_OutDeclarationRemainsVisibleAfterReorderedCall() {
        Verify(`namespace Demo
{
    public delegate void D(int a, out int cell, int bonus = 100);
    public class C
    {
        public void Run()
        {
            int Val() { return 5; }
            D d = (int a, out int cell, int bonus) => { cell = a + bonus; };
            d(cell: out int value, a: Val());
            System.Console.WriteLine(value);
        }
    }
}`, "105")
    }

    @Theory
    @InlineData("d(xs: new int[] { 2, 3 })", "6")
    @InlineData("d(xs: new int[] { 2, 3 }, a: 9)", "14")
    @InlineData("d(a: 9, 2, 3)", "14")
    @InlineData("d()", "1")
    func Delegate_ParamsArrayForms(call string, expected string) {
        Verify((`namespace Demo
{
    public delegate int D(int a = 1, params int[] xs);
    public class C
    {
        public void Run()
        {
            D d = (int a, params int[] xs) =>
            {
                int sum = a;
                foreach (int x in xs) { sum += x; }
                return sum;
            };
            System.Console.WriteLine(` + "$call" + `);
        }
    }
}`), expected)
    }

    @Fact
    func Delegate_NumericEnumAndNullDefaults() {
        let printed = Verify(`#nullable enable
namespace Demo
{
    public enum Color { Red, Blue }
    public delegate string D(byte a = 2, Color color = Color.Blue, string? text = null);
    public class C
    {
        public void Run()
        {
            D d = (a, color, text) => a + ":" + color + ":" + (text ?? "nil");
            System.Console.WriteLine(d(text: "set"));
            System.Console.WriteLine(d(color: Color.Red, a: 3));
        }
    }
}`, "2:Blue:set" + Environment.NewLine + "3:Red:nil")
        Assert.DoesNotContain("text:", printed, StringComparison.Ordinal)
    }

    @Fact
    func ImportedDelegate_NamesNormalizeForStructuralArrow() {
        Verify(`namespace Demo
{
    public class C
    {
        public void Run()
        {
            System.Func<int, int, int> f = (x, y) => x * 10 + y;
            System.Console.WriteLine(f(arg2: 2, arg1: 3));
        }
    }
}`, "32")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func PermutedArguments_EvaluateImplicitConversionsInSourceOrder(claimed bool) {
        let declaration = if claimed {
            `int Add(int a, Box b)
{
    return a > 100 ? Partner(a - 1) : a * 10 + b.Value;
}
int Partner(int n) { return Add(n, 3); }`
        } else {
            "D Add = (a, b) => a * 10 + b.Value;"
        }
        Verify((`namespace Demo
{
    public class Box
    {
        public int Value;
        public static implicit operator Box(int value)
        {
            C.Order = C.Order * 10 + value;
            return new Box { Value = value };
        }
    }
    public delegate int D(int a, Box b);
    public class C
    {
        public static int Order;
        public void Run()
        {
            int Next() { Order = Order * 10 + 2; return 2; }
            ` + "$declaration" + `
            int result = Add(b: 3, a: Next());
            System.Console.WriteLine(result + ":" + Order);
        }
    }
}`), "23:32")
    }

    @Fact
    func Delegate_ImplicitInRvalueGetsValueTemporary() {
        Verify(`namespace Demo
{
    public delegate int D(int a, in int b, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int Next(int x) { order = order * 10 + x; return x; }
            D d = (int a, in int b, int unused) => a * 10 + b;
            int result = d(b: Next(2), a: Next(3));
            System.Console.WriteLine(result + ":" + order);
        }
    }
}`, "32:23")
    }

    @Fact
    func Delegate_FieldInitializerAndExpressionBodyKeepLocalSpillScope() {
        Verify(`namespace Demo
{
    public delegate int D(int a, int b);
    public class C
    {
        private static int order;
        private static D d = (a, b) => a * 10 + b;
        private int value = d(b: Next(2), a: Next(3));
        private static int Next(int digit) { order = order * 10 + digit; return digit; }
        private int Read() => d(b: Next(4), a: Next(5));
        public void Run()
        {
            int result = Read();
            System.Console.WriteLine(value + ":" + result + ":" + order);
        }
    }
}`, "32:54:2345")
    }

    @Theory
    @InlineData("d!")
    @InlineData("(d!)")
    @InlineData("d!.Invoke")
    @InlineData("(d!).Invoke")
    func Delegate_NullTargetStillEvaluatesArgumentsBeforeThrowing(target string) {
        Verify((`#nullable enable
namespace Demo
{
    public delegate int D(int a, int b, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int Next(int digit) { order = order * 10 + digit; return digit; }
            D? d = null;
            try { ` + "$target" + `(b: Next(2), a: Next(3)); }
            catch (System.NullReferenceException) { System.Console.WriteLine(order); }
        }
    }
}`), "23")
    }

    @Fact
    func ConditionalDelegate_NestedContinuationsUseTheirOwnReceiver() {
        Verify(`#nullable enable
namespace Demo
{
    public delegate int? D(int a = 1, int b = 2, int unused = 0);
    public class C
    {
        public void Run()
        {
            int order = 0;
            int Next(int digit) { order = order * 10 + digit; return digit; }
            D? d = (a, b, unused) => a * 10 + b;
            D? other = null;
            string? first = d?.Invoke(b: Next(2), a: Next(3))?.ToString();
            int? second = d?.Invoke(b: other?.Invoke() ?? 0, a: Next(4));
            d = null;
            string? last = d?.Invoke(b: Next(5), a: Next(6))?.ToString();
            System.Console.WriteLine(first + ":" + second + ":" + (last ?? "nil") + ":" + order);
        }
    }
}`, "32:40:nil:234")
    }

    @Fact
    func Delegate_AwaitedArgumentsKeepSourceOrder() {
        Verify(`using System.Threading.Tasks;
namespace Demo
{
    public delegate int D(int a, int b, int unused = 0);
    public class C
    {
        private int order;
        private async Task<int> Next(int digit)
        {
            await Task.Yield();
            order = order * 10 + digit;
            return digit;
        }
        private async Task<int> Read()
        {
            D d = (a, b, unused) => a * 10 + b;
            return d(b: await Next(2), a: await Next(3));
        }
        public void Run()
        {
            int result = Read().GetAwaiter().GetResult();
            System.Console.WriteLine(result + ":" + order);
        }
    }
}`, "32:23")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func Delegate_EntryPointRefSpillsStayStackLocal(topLevel bool, returnsValue bool) {
        let returnType = if returnsValue {
            "int"
        } else {
            "void"
        }
        let declaration = "public delegate $returnType D(int a, ref int cell, int bonus = 100);"
        let body = (`int[] order = new int[1];
int[] cells = new int[1];
D d = (int a, ref int cell, int bonus) =>
{
    cell = a + bonus;
    ` + "${(if returnsValue { "return cell;" } else { string.Empty })}" + `
};
` + "${(if returnsValue { "int result = " } else { string.Empty })}" + `d(
    cell: ref cells[(order[0] = 1) - 1], a: (order[0] = order[0] * 10 + 2) - 7);
System.Console.WriteLine(` + "${(if returnsValue { "result" } else { "cells[0]" })}" + ` + ":" + order[0]);`)
        let source = if topLevel {
            body + "\n" + declaration
        } else {
            declaration + "\npublic static class Program { public static void Main() { " + body + " } }"
        }
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Program.cs", source)},
            outputKind: OutputKind.ConsoleApplication
        )
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "105:12")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConditionalDelegate_OutDeclarationUsesEnclosingScope(returnsValue bool, present bool) {
        Verify((`#nullable enable
namespace Demo
{
    public delegate ` + "${(if returnsValue { "int" } else { "void" })}" + ` D(int a, out int cell);
    public class C
    {
        public void Run()
        {
            int calls = 0;
            int observed = 0;
            int Next() { calls++; return 42; }
            D? d = null;
            if (` + "${(if present { "true" } else { "false" })}" + `)
            {
                d = (int a, out int cell) =>
                {
                    cell = a;
                    observed = cell;
                    ` + "${(if returnsValue { "return cell;" } else { string.Empty })}" + `
                };
            }
            ` + "${(if returnsValue { "int? returned = " } else { string.Empty })}" + `d?.Invoke(cell: out int value, a: Next());
            value = 7;
            System.Console.WriteLine(value + ":" + observed + ":" + calls` + "${(if returnsValue { " + \":\" + (returned ?? -1)" } else { string.Empty })}" + `);
        }
    }
}`), (
                if present {
                    "7:42:1"
                } else {
                    "7:0:0"
                }
            ) +
                (
                if returnsValue {
                    (
                        if present {
                            ":42"
                        } else {
                            ":-1"
                        }
                    )
                } else {
                    string.Empty
                }
            ))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Delegate_TernaryOutDeclarationUsesEnclosingScope(enabled bool) {
        Verify((`namespace Demo
{
    public delegate int D(int a, out int cell);
    public class C
    {
        public void Run()
        {
            int calls = 0;
            int Next() { calls++; return calls; }
            D d = (int a, out int cell) => { cell = a; return a; };
            bool enabled = ` + "${(if enabled { "true" } else { "false" })}" + `;
            int answer = enabled ? d(cell: out int value, a: Next()) : 0;
            value = 7;
            System.Console.WriteLine(value + ":" + answer + ":" + calls);
        }
    }
}`), if enabled {
                "7:1:1"
            } else {
                "7:0:0"
            })
    }

    @Fact
    func Delegate_NestedArgumentOutDeclarationUsesEnclosingScope() {
        Verify(`namespace Demo
{
    public delegate int D(int a, out int cell);
    public class C
    {
        public void Run()
        {
            int calls = 0;
            int Next() { calls++; return calls; }
            D d = (int a, out int cell) => { cell = a; return a; };
            System.Func<int, int, int> sum = (a, b) => a + b;
            int answer = sum(arg2: d(cell: out int value, a: Next()), arg1: Next());
            value = 7;
            System.Console.WriteLine(value + ":" + answer + ":" + calls);
        }
    }
}`, "7:3:2")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConditionalDelegate_OutDeclarationStaysInsideExpressionBody(localFunction bool) {
        let declaration = if localFunction {
            "int Read() =>"
        } else {
            "System.Func<int> Read = () =>"
        }
        Verify((`#nullable enable
namespace Demo
{
    public delegate int D(int a, out int cell);
    public class C
    {
        public void Run()
        {
            int calls = 0;
            int Next() { calls++; return calls; }
            D? d = null;
            ` + "$declaration" + ` (d?.Invoke(cell: out int value, a: Next()) ?? 0) + (value = 7);
            int answer = Read();
            d = (int a, out int cell) => { cell = a; return a; };
            answer += Read();
            System.Console.WriteLine(answer + ":" + calls);
        }
    }
}`), "15:1")
    }

    shared {
        private func Verify(source string, expected string) string {
            let printed = LocalFunctionHoistTranslationTests.TranslateUnit(source)
            LocalFunctionHoistTranslationTests.CompileAndRun(printed, "C().Run()", expected)
            return printed
        }
    }
}
