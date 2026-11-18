// <copyright file="Issue2117DefaultNullableTypeParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Nullable generic defaults require a known kind (ADR-0224).
/// Reified generic slots must not box nullable values; genuine object slots must box them.
open class Issue2117DefaultNullableTypeParamEmitTests {
    @Fact
    func DefaultNullableTypeParameter_RequiresKindAndPreservesAbsence() {
        const Source = `package Issue2117Run
import System
import System.Threading.Tasks

func Make[T]() Task[T?] -> Task.FromResult[T?](default(T?))

var a = Make[string]()
Console.WriteLine(a.Result == nil)
var c = Make[int32]()
Console.WriteLine(c.Result)
`
        SourceNullableKindAssertions.Reject(Source, "T", 3)
        let migrated = Source
            .Replace(
            "func Make[T]() Task[T?] -> Task.FromResult[T?](default(T?))",
            "func Make[T class?]() Task[T?] -> Task.FromResult[T?](default(T?))\n" +
                "func MakeValue[T struct]() Task[T?] -> Task.FromResult[T?](default(T?))"
        )
            .Replace("Make[int32]()", "MakeValue[int32]()")
            .Replace("Console.WriteLine(c.Result)", "Console.WriteLine(c.Result == nil)")
        let stdout = CompileLoadInvokeCaptureStdout(
            migrated,
            "DefaultNullableTypeParameter_RequiresKindAndPreservesAbsence"
        )
        let lines = stdout.ReplaceLineEndings(Environment.NewLine).Trim().Split(Environment.NewLine)
        Assert.Equal("True", lines[0].Trim())
        Assert.Equal("True", lines[1].Trim())
    }

    @Fact
    func DefaultNullableTypeParameter_RequiresKindAndEmitsNullableValueLoadNotBox() {
        const Source = `package Issue2117Il
import System.Threading.Tasks

func Make[T]() Task[T?] -> Task.FromResult[T?](default(T?))
`
        SourceNullableKindAssertions.Reject(Source, "T", 3)
        let il = EmitAndGetMethodIl(Source.Replace("[T]", "[T struct]"), "Make")
        // 0xFE 0x15 == initobj; the default value must be materialised in a slot.
        Assert.True(ContainsSequence(il, []uint8{0xFE, 0x15}), "Make must zero-init the default into a slot (initobj)")
        // 0x8C == box. The reified nullable slot requires its value, not a boxed reference.
        Assert.DoesNotContain(uint8(0x8C), il)
    }

    /// Control (other direction): a `default(T?)` flowing into a GENUINE
    /// `object` parameter (`Console.WriteLine(object)`) MUST still box.
    /// The #2117 fix only suppresses the box for reified generic slots, so this
    /// legitimate boxing path is unaffected.
    @Fact
    func DefaultNullableTypeParameter_IntoGenuineObjectSlot_StillBoxes() {
        const Source = `package Issue2117ObjSlot
import System

open class OB[T] {
    func W() -> Console.WriteLine(default(T?))
}
`
        SourceNullableKindAssertions.Reject(Source, "T", 1)
        let il = EmitAndGetMethodIl(Source.Replace("OB[T]", "OB[T struct]"), "W")
        Assert.Contains(uint8(0x8C), il)
    }

    /// Control (no regression): a value-type-constrained `[T struct]` —
    /// where `T?` genuinely IS `Nullable<T>` — must still emit a
    /// proper value-type nullable default and compile/emit cleanly. It is
    /// likewise reified over the real `Nullable<!T>` slot, so no box is
    /// introduced.
    @Fact
    func DefaultNullableTypeParameter_StructConstrained_EmitsNullableDefault() {
        const Source = `package Issue2117Struct
import System.Threading.Tasks

open class SB[T struct] {
    func MakeS() Task[T?] -> Task.FromResult[T?](default(T?))
}
`
        let il = EmitAndGetMethodIl(Source, "MakeS")
        Assert.True(
            ContainsSequence(il, []uint8{0xFE, 0x15}),
            "struct-constrained default must initobj Nullable<T> into a slot"
        )
        Assert.DoesNotContain(uint8(0x8C), il) // no box: reified over Nullable<!T>

    }

    shared {
        private func ContainsSequence(haystack[]uint8, needle[]uint8) bool {
            for var i = 0; i + needle.Length <= haystack.Length; i++ {
                var match = true
                for var j = 0; j < needle.Length; j++ {
                    if (haystack[i + j] != needle[j]) {
                        match = false
                        break
                    }
                }
                if match {
                    return true
                }
            }
            return false
        }

        private func EmitAndGetMethodIl(source string, methodName string)[]uint8 {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            using let pe = PEReader(peStream)
            let md = pe.GetMetadataReader()
            for th in md.TypeDefinitions {
                let type = md.GetTypeDefinition(th)
                for mh in type.GetMethods() {
                    let method = md.GetMethodDefinition(mh)
                    if md.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0 {
                        continue
                    }
                    let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                    return body.GetILBytes() ?? Array.Empty[uint8]()
                }
            }
            Assert.Fail("method '$methodName' not found in emitted assembly")
            return Array.Empty[uint8]()
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let originalOut = Console.Out
                using let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(originalOut)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
