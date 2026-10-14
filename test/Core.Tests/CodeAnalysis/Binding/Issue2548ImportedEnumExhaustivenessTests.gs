// <copyright file="Issue2548ImportedEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2548: switch exhaustiveness includes enum members imported from
/// assembly metadata, including aliases.
class Issue2548ImportedEnumExhaustivenessTests {
    @Fact
    func ImportedEnum_CompleteExpressionAndStatement_CompileAndRun() {
        let libraryPath = EmitLibrary("ImportedEnum_CompleteExpressionAndStatement_CompileAndRun")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import System
import Models

func Describe(state State) string {
    return switch state {
        case State.Unknown: "unknown"
        case State.Ready: "ready"
        case State.Done: "done"
    }
}

func Print(state State) {
    switch state {
        case State.Unknown { Console.WriteLine("unknown") }
        case State.Ready { Console.WriteLine("ready") }
        case State.Done { Console.WriteLine("done") }
    }
}

func Main() {
    Console.WriteLine(Describe(State.Active))
    Print(State.Done)
}`)))
        using let stream = MemoryStream()
        let result = consumer.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2548.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        stream.Position = 0
        let context = AssemblyLoadContext("Issue2548.Consumer", isCollectible: true)
        context.Resolving += (loadContext AssemblyLoadContext, name AssemblyName) -> if string.Equals(
            name.Name,
            "Issue2548.Models",
            StringComparison.Ordinal
        ) {
            loadContext.LoadFromAssemblyPath(libraryPath)
        } else {
            default(Assembly?)
        }
        try {
            let assembly = context.LoadFromStream(stream)
            let originalOut = Console.Out
            let output = StringWriter()
            Console.SetOut(output)
            try {
                assembly.EntryPoint!!.Invoke(nil, nil)
            } finally {
                Console.SetOut(originalOut)
            }
            Assert.Equal(
                "ready${Environment.NewLine}done${Environment.NewLine}",
                output.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        } finally {
            context.Unload()
        }
    }

    @Fact
    func ImportedEnum_IncompleteExpressionAndStatement_ReportMissingMember() {
        let libraryPath = EmitLibrary("ImportedEnum_IncompleteExpressionAndStatement_ReportMissingMember")
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Models

func Describe(state State) string {
    return switch state {
        case State.Unknown: "unknown"
        case State.Ready: "ready"
    }
}

func Observe(state State) {
    switch state {
        case State.Unknown { let observed = 0 }
        case State.Active { let observed = 1 }
    }
}`)))
        Assert.Contains(
            consumer.BoundProgram.Diagnostics,
            (
                diagnostic Diagnostic
            ) -> diagnostic.Message == "Switch expression on enum 'Models.State' is not exhaustive: missing 'Done'."
        )
        Assert.Contains(
            consumer.BoundProgram.Diagnostics,
            (
                diagnostic Diagnostic
            ) -> diagnostic.Message == "Switch statement on enum 'Models.State' is not exhaustive: missing 'Done'."
        )
    }

    shared {
        private func EmitLibrary(caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2548", caseName)
            Directory.CreateDirectory(directory)
            let libraryPath = Path.Combine(directory, "Issue2548.Models.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Models

enum State {
    Unknown = -1,
    Ready = 1,
    Active = Ready,
    Done = 2,
}`))){IsLibrary = true}
            using let stream = File.Create(libraryPath)
            let result = library.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2548.Models")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
