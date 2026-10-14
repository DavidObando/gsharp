// <copyright file="Issue2733GenericInitAccessorMemberRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #2733: init-only setter MemberRefs on constructed generic user types
/// must retain the MethodDef's IsExternalInit modreq identity.
class Issue2733GenericInitAccessorMemberRefEmitTests {
    @Fact
    func ExactOahuCliFingerprint_GenericInitSetterMemberRefs_MatchDefinitionsVerifyAndRun() {
        const Source = `package Oahu.Cli.Tui
import System

class SelectList[T] {
    private var cursorIndex int32
    private var selected T
    private var mutableIndex int32

    prop CursorIndex int32 {
        get { return cursorIndex }
        init { cursorIndex = value }
    }

    prop Selected T {
        get { return selected }
        init { selected = value }
    }

    prop MutableIndex int32 {
        get { return mutableIndex }
        set { mutableIndex = value }
    }

    init(items []T, cursorIndex int32) {
        this.CursorIndex = cursorIndex
        this.Selected = items[cursorIndex]
        this.MutableIndex = cursorIndex
    }
}

let list = SelectList[string]([]string{ "zero", "one", "two" }, 1)
Console.WriteLine(list.CursorIndex)
Console.WriteLine(list.Selected)
Console.WriteLine(list.MutableIndex)`
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2733Emit", ExactOahuCliFingerprint)
        Directory.CreateDirectory(directory)
        let outputPath = Compile(Source, directory)
        IlVerifier.Verify(outputPath)
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_CursorIndex", initOnly: true)
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_Selected", initOnly: true)
        AssertAccessorMemberRefMatchesDefinition(outputPath, "set_MutableIndex", initOnly: false)
        Assert.Equal(
            "1${Environment.NewLine}one${Environment.NewLine}1${Environment.NewLine}",
            Run(outputPath, directory)
        )
    }

    @Fact
    func InitOnlyPropertyOnConstructedGeneric_RemainsInitializationOnly() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package Oahu.Cli.Tui.Negative

class SelectList[T] {
    prop CursorIndex int32 { get; init; }
}

let list = SelectList[string]()
list.CursorIndex = 1`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2733.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0372")
    }

    shared {
        private const ExactOahuCliFingerprint string = "6e3ec0d0616a"

        private func Compile(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`Exact MissingMethod fingerprint ` + "$ExactOahuCliFingerprint" + ` must fall from 1 to 0.
`) + (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return outputPath
        }

        private func AssertAccessorMemberRefMatchesDefinition(assemblyPath string, accessorName string, initOnly bool) {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let type = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((definition TypeDefinition) -> reader.GetString(definition.Name) == "SelectList`1")
            let definition = type
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((method MethodDefinition) -> reader.GetString(method.Name) == accessorName)
            let memberRef = reader
                .MemberReferences
                .Select(reader.GetMemberReference)
                .Single(
                (reference MemberReference) -> reference
                    .Parent
                    .Kind == HandleKind.TypeSpecification &&
                    reader.GetString(reference.Name) == accessorName
            )
            Assert.Equal(reader.GetBlobBytes(definition.Signature), reader.GetBlobBytes(memberRef.Signature))
            let context = AssemblyLoadContext("issue2733-reflection-" + accessorName, isCollectible: true)
            try {
                let assembly = context.LoadFromAssemblyPath(assemblyPath)
                let reflectedType = assembly.GetType("Oahu.Cli.Tui.SelectList`1", throwOnError: true)!!
                let setter = reflectedType.GetMethods().Single((method MethodInfo) -> method.Name == accessorName)
                let modifiers = setter.ReturnParameter.GetRequiredCustomModifiers()
                Assert.Equal(
                    initOnly,
                    modifiers.Any(
                        (modifier Type) -> modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit"
                    )
                )
            } finally {
                context.Unload()
            }
        }

        private func Run(assemblyPath string, directory string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, (`Exact MissingMethod fingerprint ` + "$ExactOahuCliFingerprint" + ` still reproduces:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
