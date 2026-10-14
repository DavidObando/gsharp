// <copyright file="Issue2714NullableDelegateConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Runtime.Loader
import Xunit

/// Issue #2714: delegate signatures ignore nullable-reference annotations.
class Issue2714NullableDelegateConversionTests {
    @Fact
    func ClrMethodGroup_NullableObliviousDelegateParameter_BindsAndRuns() {
        const source = `package Issue2714
import System

class Runner {
    private var callback (string?) -> void

    init(callback (string?) -> void) {
        this.callback = callback
    }

    func Run() {
        callback("ok")
    }
}

func Main() {
    let runner = Runner(Console.WriteLine)
    runner.Run()
}`
        using let resolver = ReferenceResolver.WithReferences([]string{})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, nil, nil, "Issue2714ClrRuntime")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        stream.Position = 0
        let context = AssemblyLoadContext("Issue2714ClrRuntime", isCollectible: true)
        try {
            let assembly = context.LoadFromStream(stream)
            let previous = Console.Out
            using let output = StringWriter()
            Console.SetOut(output)
            try {
                assembly.EntryPoint!!.Invoke(nil, nil)
            } finally {
                Console.SetOut(previous)
            }
            Assert.Equal("ok${Environment.NewLine}", output.ToString().ReplaceLineEndings(Environment.NewLine))
        } finally {
            context.Unload()
        }
    }

    @Fact
    func OahuAudibleClient_MethodGroupAndEquivalentLambda_Bind() {
        const source = `package Issue2714

interface IProfile { }

class Authorize {
    async func RefreshTokenAsync(profile IProfile) { }
    internal async func RefreshTokenAsync(profile IProfile?, automatic bool) { }
}

class AudibleApi {
    init(refreshTokenAsyncFunc async (IProfile?) -> void) { }
}

class AudibleClient {
    private var authorize Authorize?
    private var audibleApi AudibleApi?

    prop Api AudibleApi? {
        get {
            if audibleApi == nil {
                let lambdaApi = AudibleApi(
                    (profile IProfile) -> authorize!!.RefreshTokenAsync(profile))
                audibleApi = AudibleApi(authorize!!.RefreshTokenAsync)
            }
            return audibleApi!!
        }
    }
}`
        using let resolver = ReferenceResolver.WithReferences([]string{})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, nil, nil, "Issue2714AudibleClient")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func UserImportedAndNestedGenericDelegateConversions_Run() {
        const source = `package Issue2714Runtime
import System
import System.Collections.Generic

interface IProfile { }
class Profile : IProfile { }

func ProfileCode(profile IProfile) int32 -> 7
func TextLength(value string) int32 -> value.Length
func MaybeText() string? -> "ok"
func Count(values List[string]) int32 -> values.Count

func Invoke(callback (IProfile?) -> int32) int32 ->
    callback(Profile{})

func Main() {
    let userMethod = Invoke(ProfileCode)
    let userLambda = Invoke((profile IProfile) -> 8)
    let importedMethod Func[string?, int32] = TextLength
    let importedLambda Func[string?, int32] =
        (value string) -> value.Length
    let nullableReturn Func[string] = MaybeText
    let genericMethod Func[List[string?], int32] = Count
    let values = List[string?]()
    values.Add("x")

    Console.WriteLine(
        userMethod + userLambda +
        importedMethod("abc") + importedLambda("four") +
        nullableReturn().Length + genericMethod(values))
}`
        Assert.Equal("25${Environment.NewLine}", CompileAndRun(source, "Issue2714Runtime"))
    }

    @Theory
    @MemberData("TrueSignatureMismatches")
    func TrueSignatureMismatches_RemainErrors(source string, diagnosticId string) {
        using let resolver = ReferenceResolver.WithReferences([]string{})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, nil, nil, "Issue2714Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == diagnosticId)
    }

    shared {
        prop TrueSignatureMismatches TheoryData[string, string] -> TheoryData[string, string]{`package Issue2714WrongType
class Source {
    func Convert(value int32) int32 -> value
    func Convert(value bool) int32 -> 0
}
func Use(callback (string) -> int32) { }
Use(Source{}.Convert)`: "GS0218", `package Issue2714WrongArity
class Source {
    func Convert(value int32) int32 -> value
    func Convert(a int32, b int32, c int32) int32 -> a
}
func Use(callback (int32, int32) -> int32) { }
Use(Source{}.Convert)`: "GS0218", `package Issue2714ValueNullable
class Source {
    func Convert(value int32) int32 -> value
    func Convert(value string) int32 -> 0
}
func Use(callback (int32?) -> int32) { }
Use(Source{}.Convert)`: "GS0218", `package Issue2714RefKind
delegate RefCallback(ref value int32);
class Source {
    func Change(value int32) { }
    func Change(value string) { }
}
let callback RefCallback = Source{}.Change`: "GS0218", `package Issue2714LambdaType
func Use(callback (string) -> int32) { }
Use((value int32) -> value)`: "GS0154"}

        private func CompileAndRun(source string, assemblyName string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{})
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let stream = MemoryStream()
            let result = compilation.Emit(stream, nil, nil, assemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            stream.Position = 0
            let context = AssemblyLoadContext(assemblyName, isCollectible: true)
            try {
                let assembly = context.LoadFromStream(stream)
                let previous = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
                try {
                    assembly.EntryPoint!!.Invoke(nil, nil)
                } finally {
                    Console.SetOut(previous)
                }
                return output.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                context.Unload()
            }
        }
    }
}
