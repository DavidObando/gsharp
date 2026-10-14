// <copyright file="Issue2744RecordAbiEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// C# compile/runtime coverage for issue #2744.
class Issue2744RecordAbiEmitTests {
    @Fact
    func DataClass_IsCSharpRecordCompatible_AndPreservesEqualityTypeBoundary() {
        const gsharp = `package Records

data class Config {
    prop Name string { get; init; }
}
data class Credentials(Username string, Password string) {
}
data class PatternRecord(Value int32) {
}
class PatternProbe {
    shared {
        func Match(value PatternRecord) string -> switch value {
            case { Value: 1 }: "match"
            default: "miss"
        }
    }
}
open data class Base() {
}
data class Left() : Base() {
}
data class Right() : Base() {
}
class Plain {
}`
        const csharp = `using System;
using System.Linq;
using System.Reflection;
using Records;

public static class Probe
{
    public static string Run()
    {
        var original = new Config { Name = "old" };
        var copy = original with { Name = "new" };
        var credentials = new Credentials("user", "secret") with { Password = "changed" };
        var leftCopy = new Left() with { };
        var copyCtor = typeof(Config).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(c => c.GetParameters().Length == 1 && c.GetParameters()[0].ParameterType == typeof(Config));
        var baseCopyCtor = typeof(Base).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(c => c.GetParameters().Length == 1 && c.GetParameters()[0].ParameterType == typeof(Base));
        return $"{original.Name}|{copy.Name}|{credentials.Username}:{credentials.Password}|{PatternProbe.Match(new PatternRecord(1))}|{leftCopy.GetType().Name}|{copyCtor.IsPrivate}|{baseCopyCtor.IsFamily}|{typeof(Config).GetProperty("EqualityContract", BindingFlags.Instance | BindingFlags.NonPublic) != null}|{new Left().Equals((Base)new Right())}|{typeof(Plain).GetMethod("<Clone>$") == null}";
    }
}`
        Assert.Equal("old|new|user:changed|match|Left|True|True|True|False|True", CompileAndRun(gsharp, csharp))
    }

    @Fact
    func PositionalDataStruct_HasCSharpConstructorAndInitProperties() {
        const gsharp = `package Records

data struct Point(X int32, Y int32) {
}
class StructPatternProbe {
    shared {
        func Match(point Point) string -> switch point {
            case { X: 1, Y: 2 }: "match"
            default: "miss"
        }
    }
}`
        const csharp = `using Records;

public static class Probe
{
    public static string Run()
    {
        var point = new Point(1, 2);
        var copy = point with { X = 3 };
        return $"{point.X},{point.Y}|{copy.X},{copy.Y}|{StructPatternProbe.Match(point)}";
    }
}`
        Assert.Equal("1,2|3,2|match", CompileAndRun(gsharp, csharp))
    }

    @Fact
    func PositionalDataTypes_DeconstructInGSharpAndCSharp_WithOutMetadata() {
        const gsharp = `package Records
import System.Collections.Generic

data class Pair(A int32, B int32) {
    prop Ignored int32 { get; init; }
}
data struct StructPair(X int32, Y int32) {
    prop Ignored int32 { get; init; }
}
data struct FieldPair {
    var A int32
    var B int32
}
data class EmptyPositional() {
    var Value int32
}
class GSharpProbe {
    shared {
        func Run() int32 {
            let (a, b) = Pair(1, 2)
            let (x, y) = StructPair(3, 4)
            let fields = FieldPair{A: 7, B: 8}
            let (fa, fb) = fields
            var total = a + b + x + y + fa + fb
            var pairs = List[Pair]()
            pairs.Add(Pair(5, 6))
            for (left, right) in pairs {
                total = total + left + right
            }

            var structPairs = List[StructPair]()
            structPairs.Add(StructPair(1, 1))
            for (left, right) in structPairs {
                total = total + left + right
            }

            return total
        }
    }
}`
        const csharp = `using System.Linq;
using Records;

public static class Probe
{
    public static string Run()
    {
        var (a, b) = new Pair(10, 20) { Ignored = 99 };
        var (x, y) = new StructPair(30, 40) { Ignored = 99 };
        var fieldPair = new FieldPair { A = 50, B = 60 };
        var (fa, fb) = fieldPair;
        var pairParams = typeof(Pair).GetMethod("Deconstruct")!.GetParameters();
        var structParams = typeof(StructPair).GetMethod("Deconstruct")!.GetParameters();
        var metadata = pairParams.Concat(structParams)
            .All(p => p.IsOut && !p.IsIn);
        var noZeroArityMethod = typeof(EmptyPositional).GetMethod("Deconstruct") == null;
        return $"{a + b}|{x + y}|{fa + fb}|{GSharpProbe.Run()}|{metadata}|{pairParams.Length},{structParams.Length}|{string.Join(",", pairParams.Select(p => p.Name))}|{noZeroArityMethod}";
    }
}`
        Assert.Equal("30|70|110|38|True|2,2|A,B|True", CompileAndRun(gsharp, csharp))
    }

    shared {
        private func CompileAndRun(gsharp string, csharp string) string? {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2744-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let libraryPath = Path.Combine(directory, "Records.dll")
                let consumerPath = Path.Combine(directory, "Consumer.dll")
                let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharp))){IsLibrary = true}
                {
                    using let output = File.Create(libraryPath)
                    let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Records")
                    Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
                }
                IlVerifier.Verify(libraryPath)
                let references = (
                    (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                        Array.Empty[string]()
                )
                    .Where(File.Exists)
                    .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                    .Append(MetadataReference.CreateFromFile(libraryPath))
                let consumer = CSharpCompilation.Create(
                    "Consumer",
                    []Microsoft
                        .CodeAnalysis
                        .SyntaxTree{CSharpSyntaxTree.ParseText(csharp, CSharpParseOptions(LanguageVersion.Latest))},
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                {
                    using let output = File.Create(consumerPath)
                    let result = consumer.Emit(output)
                    Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
                }
                let loadContext = AssemblyLoadContext("Issue2744-" + Guid.NewGuid().ToString(), isCollectible: true)
                try {
                    let _ = loadContext.LoadFromAssemblyPath(libraryPath)
                    let assembly = loadContext.LoadFromAssemblyPath(consumerPath)
                    return cast[string](
                        assembly.GetType("Probe", throwOnError: true)!!.GetMethod(
                            "Run",
                            BindingFlags.Public | BindingFlags.Static
                        )!!.Invoke(nil, nil)!!
                    )
                } finally {
                    loadContext.Unload()
                }
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
