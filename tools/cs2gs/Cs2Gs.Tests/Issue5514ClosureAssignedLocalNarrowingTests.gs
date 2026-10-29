// <copyright file="Issue5514ClosureAssignedLocalNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.Linq
import Xunit

/// Issues #5513 and #5514: ADR-0208 row R15 (#5237) makes gsc kill the
/// narrowing of a local that a closure assigns at every call, because the call
/// may run a closure that escaped. C# flow analysis keeps the fact, so a read
/// that C# proves non-null needs its own `!!` once a call lies between the
/// null check and the read. Without a closure write, or without a call in
/// between, gsc still narrows and the read stays bare.
open class Issue5514ClosureAssignedLocalNarrowingTests {
    @Fact
    func ClosureAssignedLocal_ReadAfterACall_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public class Demo
{
    public static void Run(List<string> sink, List<string> lines)
    {
        List<string>? current = null;
        void Flush() { current = null; }
        foreach (var line in lines)
        {
            if (current is not null)
            {
                if (line.StartsWith('+'))
                {
                    current.Add(line);
                }
            }
            else
            {
                current = new List<string>();
            }
        }
        Flush();
    }
}`)
        Assert.Contains("current!!.Add(line)", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterAnObjectCreation_IsAssertedOnTheSecondUseOnly() {
        let printed = Translate(`
using System.Collections.Generic;
public class Demo
{
    public static void Run(List<Demo> list, Dictionary<string, Demo> map, string key)
    {
        Demo? made = null;
        void Make() { made = new Demo(); }
        Make();
        if (made != null)
        {
            list.Add(made);
            map[key] = made;
        }
    }
}`)
        Assert.Contains("list.Add(made)", printed)
        Assert.Contains("map[key] = made!!", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadInACallFreeForEach_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public class Demo
{
    public static int Run(IEnumerable<int> items)
    {
        string? current = null;
        void Set() { current = null; }
        Set();
        current = "x";
        if (current != null)
        {
            var total = 0;
            foreach (var item in items)
            {
                total += current.Length;
            }
            return total;
        }
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterAUserDefinedConversion_IsAsserted() {
        let printed = Translate(`
public struct Token
{
    public static implicit operator int(Token t) => 1;
}
public class Demo
{
    public static int Run(Token token)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            int n = token;
            return n + current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterAnInitializedStaticProperty_IsAsserted() {
        let printed = Translate(`
public class Demo
{
    public static int Counter { get; } = 4;

    public static int Run()
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var n = Counter;
            return n + current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_TopLevelProgram_ReadAfterACall_IsAsserted() {
        let printed = Translate(`
using System;
string? current = "x";
void Reset() { current = null; }
if (current != null)
{
    Console.WriteLine("hi");
    Console.WriteLine(current.Length);
}
Reset();
`, OutputKind.ConsoleApplication)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterUsingStatement_IsAsserted() {
        let printed = Translate(`
using System;
public class Demo
{
    public static int Run(IDisposable resource)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            using (resource) { }
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterConditionalIndexer_IsAsserted() {
        let printed = Translate(`
public class Source
{
    public int this[int i] => i;
}
public class Demo
{
    public static int Run(Source? source)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var n = source?[0];
            return (n ?? 0) + current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterStaticFieldWithInitializer_IsAsserted() {
        let printed = Translate(`
public static class State
{
    public static int Counter = System.Environment.TickCount;
}
public class Demo
{
    public static int Run()
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var n = State.Counter;
            return n + current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterGetOnlyAndInterfaceProperty_IsAsserted() {
        let printed = Translate(`
public interface IHolder
{
    int Value { get; }
}
public class Demo
{
    public int Size { get; }

    public static int Run(IHolder holder, Demo demo)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var n = holder.Value + demo.Size;
            return n + current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterUserDefinedCompoundAssignment_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public struct Token
{
    public static Token operator +(Token a, Token b) => a;
}
public class Demo
{
    
    public static int Run(Token token, int count, KeyValuePair<int, int> pair, object gate)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            token += token;
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterCollectionExpression_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public struct Token
{
    public static Token operator +(Token a, Token b) => a;
}
public class Demo
{
    
    public static int Run(Token token, int count, KeyValuePair<int, int> pair, object gate)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            List<int> values = [];
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterLockStatement_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public struct Token
{
    public static Token operator +(Token a, Token b) => a;
}
public class Demo
{
    
    public static int Run(Token token, int count, KeyValuePair<int, int> pair, object gate)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            lock (gate) { }
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterStringConcatenation_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public struct Token
{
    public static Token operator +(Token a, Token b) => a;
}
public class Demo
{
    
    public static int Run(Token token, int count, KeyValuePair<int, int> pair, object gate)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var text = "" + count;
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadAfterDeconstruction_IsAsserted() {
        let printed = Translate(`
using System.Collections.Generic;
public struct Token
{
    public static Token operator +(Token a, Token b) => a;
}
public class Demo
{
    
    public static int Run(Token token, int count, KeyValuePair<int, int> pair, object gate)
    {
        string? current = "x";
        void Reset() { current = null; }
        if (current != null)
        {
            var (a, b) = pair;
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("current!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadThroughARefAlias_IsAsserted() {
        let printed = Translate(`
public class Demo
{
    static void Touch() { }

    public static int Run()
    {
        string? current = "x";
        ref string? alias = ref current;
        void Reset() { current = null; }
        if (alias != null)
        {
            Touch();
            return alias.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.Contains("alias!!.Length", printed)
    }

    @Fact
    func ClosureAssignedLocal_ReadWithoutACallBetween_StaysBare() {
        let printed = Translate(`
public class Demo
{
    public static int Run(string? input)
    {
        string? current = input;
        void Reset() { current = null; }
        if (current != null)
        {
            return current.Length;
        }
        Reset();
        return 0;
    }
}`)
        Assert.DoesNotContain("current!!", printed)
    }

    @Fact
    func LocalNoClosureWrites_ReadAfterACall_StaysBare() {
        let printed = Translate(`
using System.Collections.Generic;
public class Demo
{
    public static void Run(List<string> lines, string? input)
    {
        List<string>? current = input is null ? null : new List<string>();
        if (current is not null)
        {
            System.Console.WriteLine(lines.Count);
            current.Add("x");
        }
    }
}`)
        Assert.DoesNotContain("current!!", printed)
    }

    shared {
        private func Translate(source string, outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(outputKind).WithNullableContextOptions(NullableContextOptions.Enable)
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
