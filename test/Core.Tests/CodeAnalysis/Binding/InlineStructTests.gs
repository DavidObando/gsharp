// <copyright file="InlineStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Phase 7.4 — inline value classes / `inline struct`.
class InlineStructTests {
    @Fact
    func InlineStruct_SinglePrimaryConstructorField_BindsAndCompares() {
        let result = Evaluate(`
inline struct UserId(value string)
let a = UserId("u-1")
let b = UserId("u-1")
a == b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func InlineStruct_ToString_IncludesSingleField() {
        let result = Evaluate(`
inline struct UserId(value string) {}
let a = UserId("u-1")
a
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("UserId(value=u-1)", result.Value!!.ToString())
    }

    @Theory
    @InlineData("inline struct Bad(a string, b string) {}")
    @InlineData("inline struct Bad {}")
    @InlineData("inline struct Bad(a string) { var b string }")
    @InlineData("data inline struct Bad(value string) {}")
    @InlineData("open inline struct Bad(value string) {}")
    func InlineStruct_InvalidShapes_Diagnose(declaration string) {
        let result = Evaluate(declaration + `
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func InlineStruct_HandWrittenSynthesizedMember_Diagnoses() {
        let result = Evaluate(`
inline struct UserId(value string) {
    func Equals(other UserId) bool { return true }
}
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func InlineStruct_DistinctUnderlyingTypes_AreNotAssignableOrComparable() {
        let assign = Evaluate(`
inline struct UserId(value string) {}
inline struct OrderId(value string) {}
let user = UserId("u-1")
let order OrderId = user
0
`)
        Assert.NotEmpty(assign.Diagnostics)
        let compare = Evaluate(`
inline struct UserId(value string) {}
inline struct OrderId(value string) {}
UserId("1") == OrderId("1")
`)
        Assert.NotEmpty(compare.Diagnostics)
    }

    @Fact
    func InlineStruct_PassesByValue() {
        let result = Evaluate(`
inline struct UserId(value string) {}
func echo(id UserId) UserId { return id }
let original = UserId("u-1")
let copied = echo(original)
original == copied
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func InlineStruct_EmitsReadOnlyMetadataAndMembers() {
        const Source = `package InlineMetadata
inline struct UserId(value string) {}
let id = UserId("u-1")
`
        using let peStream = MemoryStream()
        let emit = Compile(Source, peStream)
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let reader = peReader.GetMetadataReader()
        let userId = reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single((t TypeDefinition) -> reader.GetString(t.Name) == "UserId")
        Assert.True(HasAttribute(reader, userId, "IsReadOnlyAttribute"))
        let methodNames = userId
            .GetMethods()
            .Select((h MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(h).Name))
            .ToArray()
        Assert.Contains("Equals", methodNames)
        Assert.Contains("GetHashCode", methodNames)
        Assert.Contains("ToString", methodNames)
        Assert.Contains("op_Equality", methodNames)
        Assert.Contains("op_Inequality", methodNames)
        Assert.Contains("Deconstruct", methodNames)
    }

    shared {
        private func HasAttribute(reader MetadataReader, type TypeDefinition, name string) bool {
            for handle in type.GetCustomAttributes() {
                let attribute = reader.GetCustomAttribute(handle)
                if attribute.Constructor.Kind != HandleKind.MemberReference {
                    continue
                }
                let member = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor))
                if member.Parent.Kind == HandleKind.TypeReference && reader.GetString(
                    reader.GetTypeReference(TypeReferenceHandle(member.Parent)).Name
                ) == name {
                    return true
                }
            }
            return false
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }
    }
}
