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
        private func Translate(source string) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }
    }
}
