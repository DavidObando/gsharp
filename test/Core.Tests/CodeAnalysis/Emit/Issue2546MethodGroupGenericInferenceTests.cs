// <copyright file="Issue2546MethodGroupGenericInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue2546MethodGroupGenericInferenceTests
{
    [Fact]
    public void ImportedMethodGroup_Select_InfersResultAndRuns()
    {
        const string Source = @"
package ImportedMethodGroup
import System
import System.Collections.Generic
import System.Linq

func main() int32 {
    var values = List[string]()
    values.Add(""20"")
    values.Add(""22"")
    return values.Select(Int32.Parse).Sum()
}
";
        Assert.Equal(42, CompileAndRun(Source, nameof(ImportedMethodGroup_Select_InfersResultAndRuns)));
    }

    [Fact]
    public void OverloadedSourceMethodGroup_Select_InfersResultAndRuns()
    {
        const string Source = @"
package SourceMethodGroup
import System
import System.Collections.Generic
import System.Linq

func ConvertValue(s string) int32 { return Int32.Parse(s) }
func ConvertValue(n int32) string { return n.ToString() }

func main() int32 {
    var values = List[string]()
    values.Add(""40"")
    values.Add(""2"")
    return values.Select(ConvertValue).Sum()
}
";
        Assert.Equal(42, CompileAndRun(Source, nameof(OverloadedSourceMethodGroup_Select_InfersResultAndRuns)));
    }

    [Fact]
    public void ImportedMethodGroup_StaticGenericApi_InfersResultAndRuns()
    {
        const string Source = @"
package StaticGenericApi
import System

func main() int32 {
    var values = []string{ ""40"", ""2"" }
    var parsed = Array.ConvertAll(values, Int32.Parse)
    return parsed[0] + parsed[1]
}
";
        Assert.Equal(42, CompileAndRun(Source, nameof(ImportedMethodGroup_StaticGenericApi_InfersResultAndRuns)));
    }

    [Fact]
    public void GenericSourceMethodGroup_Select_UserElementToDictionary_InfersResultAndRuns()
    {
        const string Source = @"
package DictionaryMethodGroup
import System
import System.Collections.Generic
import System.Linq

data class Record(Value string) {}

class Repro {
    shared {
        func ToDictionary[T any](record T) Dictionary[string, string] {
            var result = Dictionary[string, string]()
            result.Add(""value"", ""present"")
            return result
        }

        func Run(records IEnumerable[Record]) int32 {
            return records.Select(ToDictionary).Single().Count
        }
    }
}

func main() int32 {
    var records = List[Record]()
    records.Add(Record(""42""))
    return Repro.Run(records)
}
";
        Assert.Equal(1, CompileAndRun(Source, nameof(GenericSourceMethodGroup_Select_UserElementToDictionary_InfersResultAndRuns)));
    }

    [Fact]
    public void AmbiguousGenericSourceMethodGroup_DoesNotInferArbitraryResult()
    {
        const string Source = @"
package AmbiguousGenericMethodGroup
import System.Collections.Generic
import System.Linq

func Project[T any](value T) int32 { return 1 }
func Project[T any](value List[T]) string { return ""x"" }

func main() {
    var values = List[List[string]]()
    values.Select(Project)
}
";
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source)));
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void AmbiguousSourceMethodGroup_DoesNotInferArbitraryResult()
    {
        const string Source = @"
package AmbiguousMethodGroup
import System
import System.Collections.Generic
import System.Linq

func Project(x IComparable) int32 { return 1 }
func Project(x ICloneable) string { return ""x"" }

func main() {
    var values = List[string]()
    values.Select(Project)
}
";
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source)));
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.IsError);
    }

    private static object CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromStream(peStream);
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
            var main = program.GetMethod("main", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(main);
            return main!.Invoke(null, null);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
