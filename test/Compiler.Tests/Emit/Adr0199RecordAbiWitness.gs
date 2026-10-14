// <copyright file="Adr0199RecordAbiWitness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// ADR-0199: shared helpers for the Roslyn witness tests. A witness compiles
/// the equivalent C# `record` with Roslyn and renders the synthesized
/// record ABI (interface list plus every synthesized member's CLR flags and
/// signature) so a G# `data` type can be compared against it line by line.
internal shared class Adr0199RecordAbiWitness {
    private let SynthesizedNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "Equals",
        "GetHashCode",
        "ToString",
        "PrintMembers",
        "get_EqualityContract",
        "<Clone>$$",
        "op_Equality",
        "op_Inequality",
        "Deconstruct"
    }

    /// Compiles C# with Roslyn and loads the result.
    /// @param source The C# source.
    /// @returns The loaded assembly.
    func CompileCSharp(source string) Assembly {
        let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
            (path string) -> MetadataReference.CreateFromFile(path)
        )
        let compilation = CSharpCompilation.Create(
            "RoslynWitness" + Guid.NewGuid().ToString("N"),
            []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
            references,
            CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable
            )
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        return EmittedFixture.Load(stream.ToArray())
    }

    /// Compiles G# with the real driver, verifies the IL and loads the result.
    /// @param source The G# source.
    /// @returns The loaded assembly.
    func CompileGSharp(source string) Assembly {
        let tempDir = Directory.CreateTempSubdirectory("gs_adr0199_").FullName
        try {
            // EmittedFixture.Load reads the image from bytes, so the workspace can go.
            return EmittedFixture.Load(CompileGSharpToPath(source, tempDir))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Compiles G# with the real driver into [`directory`](paramref) and verifies the IL.
    /// @param source The G# source.
    /// @param directory The output directory.
    /// @returns The path of the emitted library.
    func CompileGSharpToPath(source string, directory string) string {
        let srcPath = Path.Combine(directory, "test.gs")
        let outPath = Path.Combine(directory, "test.dll")
        File.WriteAllText(srcPath, source)
        using let compileOut = StringWriter()
        using let compileErr = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(compileOut)
        Console.SetError(compileErr)
        var compileExit int32
        try {
            compileExit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            )
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
        }
        Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        IlVerifier.Verify(outPath)
        return outPath
    }

    /// Compiles several G# files (as one package) and loads the result.
    /// @param files The file names and sources.
    /// @returns The loaded assembly.
    func CompileGSharpFiles(files ...(Name string, Source string)) Assembly {
        let directory = Directory.CreateTempSubdirectory("gs_adr0199_files_").FullName
        try {
            let paths = List[string]()
            for (name, source) in files {
                let path = Path.Combine(directory, name)
                File.WriteAllText(path, source)
                paths.Add(path)
            }
            let outPath = Path.Combine(directory, "test.dll")
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}.Concat(paths).ToArray()
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Compiles G# with the real driver and returns the driver's exit code and combined output.
    /// @param source The G# source.
    /// @returns The exit code and the captured output.
    func TryCompileGSharp(source string)(ExitCode int32, Output string) {
        let directory = Directory.CreateTempSubdirectory("gs_adr0199_try_").FullName
        try {
            let srcPath = Path.Combine(directory, "test.gs")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exit = Program.Main(
                    []string{
                        "/out:" + Path.Combine(directory, "test.dll"),
                        "/target:library",
                        "/targetframework:net10.0",
                        srcPath
                    }
                )
                return (exit, compileOut.ToString() + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Invokes the parameterless static function [`name`](paramref) declared anywhere in
    /// [`assembly`](paramref).
    /// @param assembly The loaded assembly.
    /// @param name The function name.
    /// @returns The function's result.
    func Invoke(assembly Assembly, name string) object? -> assembly
        .GetTypes()
        .SelectMany(
        func (t Type) IEnumerable[MethodInfo] {
            return t.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
            )
        }
    )
        .Single((m MethodInfo) -> m.Name == name && m.GetParameters().Length == 0)
        .Invoke(nil, nil)

    /// Renders the interface list and synthesized members of a type.
    /// @param type The type to describe.
    /// @returns One line per fact, in a stable order.
    func Describe(type Type) string {
        let lines = List[string]()
        lines.Add(
            "type " +
                type.Name +
                " " +
                (
                if type.IsSealed {
                    "sealed"
                } else {
                    "open"
                }
            ) +
                (
                if type.IsValueType {
                    " struct"
                } else {
                    " class"
                }
            )
        )
        for iface in type.GetInterfaces().Select(DescribeType).OrderBy((n string) -> n, StringComparer.Ordinal) {
            lines.Add("  interface " + iface)
        }
        const All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
        for ctor in type
            .GetConstructors(All)
            .Where((c ConstructorInfo) -> !c.IsStatic)
            .Select(Describe)
            .OrderBy((n string) -> n, StringComparer.Ordinal) {
            lines.Add("  " + ctor)
        }
        for method in type
            .GetMethods(All)
            .Where((m MethodInfo) -> SynthesizedNames.Contains(m.Name))
            .Select(Describe)
            .OrderBy((n string) -> n, StringComparer.Ordinal) {
            lines.Add("  " + method)
        }
        return string.Join("\n", lines)
    }

    /// Gets the method flags that matter for the ABI.
    /// @param method The method.
    /// @returns A compact flag string.
    func Flags(method MethodBase) string {
        let sb = StringBuilder()
        sb.Append(
            if method.IsPublic {
                "public"
            } else {
                (
                    if method.IsFamily {
                        "protected"
                    } else {
                        (
                            if method.IsPrivate {
                                "private"
                            } else {
                                (
                                    if method.IsAssembly {
                                        "internal"
                                    } else {
                                        "other"
                                    }
                                )
                            }
                        )
                    }
                )
            }
        )
        if method.IsStatic {
            sb.Append(" static")
        }
        if method.IsAbstract {
            sb.Append(" abstract")
        }
        if method.IsVirtual {
            sb.Append(" virtual")
        }
        if method.IsFinal {
            sb.Append(" final")
        }
        if method.IsVirtual && (method.Attributes & MethodAttributes.NewSlot) != 0 {
            sb.Append(" newslot")
        }
        if method.IsSpecialName {
            sb.Append(" specialname")
        }
        return sb.ToString()
    }

    private func Describe(method MethodBase) string {
        let ret = if method is MethodInfo mi {
            DescribeType(mi.ReturnType)
        } else {
            "void"
        }
        let parameters = string.Join(
            ", ",
            method.GetParameters().Select((p ParameterInfo) -> DescribeType(p.ParameterType) + " " + p.Name)
        )
        return Flags(method) + " " + ret + " " + method.Name + "(" + parameters + ")"
    }

    private func DescribeType(type Type) string {
        if type.IsGenericType {
            return type.Name.Split('`')[0] + "<" + string.Join(",", type.GetGenericArguments().Select(DescribeType)) +
                ">"
        }
        return type.Name
    }
}
